"""Isolated fixture: real custom-settings router + Config model + SQLite.

Authentication is a local test dependency; this does not launch the full backend.
Only use this server with synthetic data, bound to localhost.
"""

import argparse
import asyncio
import importlib
import os
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import declarative_base

ROOT = Path(__file__).resolve().parents[2]


def create_fixture(database: Path, *, static_directory: Path | None = None) -> FastAPI:
    # Replace environment setup/auth only. Storage and router are production code.
    for package in ('open_webui', 'open_webui.models', 'open_webui.routers', 'open_webui.internal', 'open_webui.utils'):
        module = ModuleType(package)
        module.__path__ = [str(ROOT / 'backend' / package.replace('.', '/'))]
        sys.modules[package] = module

    db_module = ModuleType('open_webui.internal.db')
    db_module.Base = declarative_base()
    engine = create_async_engine(f'sqlite+aiosqlite:///{database}')
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def get_async_db():
        async with sessions() as session:
            yield session

    db_module.get_async_db = get_async_db
    sys.modules[db_module.__name__] = db_module

    auth_module = ModuleType('open_webui.utils.auth')

    async def verified(request: Request):
        token = request.headers.get('Authorization')
        if token not in ('Bearer fixture-admin', 'Bearer fixture-user'):
            raise HTTPException(401, 'Unauthorized fixture request')
        return SimpleNamespace(role='admin' if token == 'Bearer fixture-admin' else 'user')

    async def admin(user=Depends(verified)):
        if user.role != 'admin':
            raise HTTPException(403, 'Admin required')
        return user

    auth_module.get_admin_user = admin
    auth_module.get_verified_user = verified
    sys.modules[auth_module.__name__] = auth_module
    # Each fixture gets its own real model bound to the isolated Base/session.
    for name in ('open_webui.models.config', 'open_webui.routers.custom_settings'):
        sys.modules.pop(name, None)
    model = importlib.import_module('open_webui.models.config')
    router_module = importlib.import_module('open_webui.routers.custom_settings')

    @asynccontextmanager
    async def lifespan(app):
        async with engine.begin() as connection:
            await connection.run_sync(db_module.Base.metadata.create_all)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.config_model = model.Config
    app.state.custom_router = router_module
    app.include_router(router_module.router, prefix='/api/v1/custom-settings')

    @app.post('/__demo_mark')
    async def mark(request: Request):
        label = (await request.body()).decode().strip()
        if not label.isidentifier():
            raise HTTPException(400, 'Invalid checkpoint')
        print(f'DEMO-MARK {label}', flush=True)
        if log_file := os.environ.get('DEMO_LOG'):
            with Path(log_file).open('a') as log:
                log.write(f'DEMO-MARK {label}\n')
        if ack_directory := os.environ.get('DEMO_ACK_DIR'):
            ack = Path(ack_directory) / label
            for _ in range(600):
                if ack.exists():
                    break
                await asyncio.sleep(0.1)
        return {'ok': True}

    app.mount('/', StaticFiles(directory=static_directory or ROOT / 'fork/tool-chain/dist', html=True))
    return app


if __name__ == '__main__':
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5191)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='tool-chain-settings-') as temporary:
        app = create_fixture(Path(temporary) / 'config.db')
        uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='warning', loop='asyncio')
