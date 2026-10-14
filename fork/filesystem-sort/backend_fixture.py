"""Real custom settings router/storage, with a synthetic terminal filesystem."""

import argparse
import importlib.util
import os
import tempfile
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('tool_chain_backend_fixture', ROOT / 'fork/tool-chain/backend_fixture.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def create_app(database: Path, files: Path, initial_sort: str = 'date_desc', missing_metadata: bool = False):
    files.mkdir(exist_ok=True)
    for name, modified, size in [('oldest.txt', 1700000000, 100), ('middle.txt', 1710000000, 50), ('newest.txt', 1720000000, 30)]:
        target = files / name
        target.write_text('x' * size)
        os.utime(target, (modified, modified))
    (files / 'folder').mkdir(exist_ok=True)
    os.utime(files / 'folder', (1650000000, 1650000000))

    app = shared.create_fixture(database, static_directory=Path(__file__).parent / 'dist')
    app.state.config_model.DEFAULTS['custom.filesystem_sort_default'] = initial_sort
    static = app.router.routes.pop()

    @app.get('/terminal/api/config')
    async def terminal_config():
        return {'features': {'terminal': False}}

    @app.get('/terminal/files/cwd')
    async def cwd():
        return {'cwd': '/', 'home': '/'}

    @app.post('/terminal/files/cwd')
    async def set_cwd(request: Request):
        return {'cwd': (await request.json()).get('path', '/')}

    @app.get('/terminal/files/list')
    async def list_files(directory: str = '/'):
        target = (files / directory.lstrip('/')).resolve()
        if not target.is_relative_to(files.resolve()) or not target.is_dir():
            return JSONResponse({'detail': 'Fixture directory not found'}, status_code=404)
        entries = [
            {'name': entry.name, 'type': 'directory' if entry.is_dir() else 'file',
             'modified': entry.stat().st_mtime, 'size': entry.stat().st_size, 'writable': False}
            for entry in target.iterdir()
        ]
        if missing_metadata:
            for entry in entries:
                if entry['name'] == 'middle.txt': entry.pop('modified', None)
        return {'writable': False, 'entries': entries}

    @app.get('/terminal/ports')
    async def ports():
        return {'ports': []}

    app.router.routes.append(static)
    return app


if __name__ == '__main__':
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5195)
    parser.add_argument('--sort', default='date_desc')
    parser.add_argument('--missing-metadata', action='store_true')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='filesystem-sort-') as temporary:
        path = Path(temporary)
        uvicorn.run(create_app(path / 'config.db', path / 'files', args.sort, args.missing_metadata), host='127.0.0.1', port=args.port, log_level='warning', loop='asyncio')
