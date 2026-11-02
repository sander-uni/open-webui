"""Fork: the real terminal proxy router against a fake terminal (aiohttp), with Open WebUI's
database, auth and settings modules stubbed. Covers what the cache-only tests cannot: access
resolution, response headers, redirects, the cached-media route.

Run: cd ~/owui-update; <venv python> -m pytest -q -p no:cacheprovider fork/terminal-media/
"""

import asyncio
import importlib.util
import sys
import types
from pathlib import Path

import httpx
import pytest
from aiohttp import web
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parents[2]
SID = 'term-1'
VIDEO = b'V' * 200_000


def stub(name, **attrs):
    m = types.ModuleType(name)
    m.__path__ = []
    m.__dict__.update(attrs)
    sys.modules[name] = m
    return m


def load_router(tmp_path, base_url):
    async def config_get(key, default=None):
        return [{'id': SID, 'url': base_url, 'key': 'k', 'enabled': True}] if key == 'terminal_server.connections' else default

    async def groups(_uid, include_inherited=True):
        return []

    async def access(*_a, **_k):
        return True

    user = types.SimpleNamespace(id='u1', role='admin')

    async def verified_user():
        return user

    stub('open_webui')
    stub('open_webui.config', TERMINAL_PROXY_HEADERS={}, CACHE_DIR=tmp_path / 'cache')
    stub('open_webui.env', AIOHTTP_CLIENT_SESSION_SSL=None, ENABLE_TOOL_SERVERS=True)
    stub('open_webui.events', EVENTS=types.SimpleNamespace(), publish_event=None)
    stub('open_webui.models')
    stub('open_webui.models.config', Config=types.SimpleNamespace(get=config_get))
    stub('open_webui.models.groups', Groups=types.SimpleNamespace(get_groups_by_member_id=groups))
    stub('open_webui.utils')
    stub('open_webui.utils.access_control', has_connection_access=access)
    stub('open_webui.utils.auth', get_verified_user=verified_user, get_verified_user_by_token=None)
    stub('open_webui.utils.headers', bearer_auth_header=lambda k: {'Authorization': f'Bearer {k}'}, normalize_bearer_token=None)
    stub('open_webui.utils.json_codec', JSONCodec=None)
    stub(
        'open_webui.utils.terminals',
        TERMINAL_CONTEXT_HEADER='X-Terminal-Context',
        get_terminal_server_url=lambda c: c['url'],
        is_terminal_orchestrator=lambda c: False,
        terminal_chat_uploads=lambda c: False,
        terminal_context_available=lambda c, kind: True,
        terminal_context_config=lambda c, kind: {},
        terminal_context_id=lambda c, ctx, kind: None,
        terminal_contexts=lambda c: [],
    )
    for name, rel in (
        ('open_webui.utils.terminal_media_cache', 'backend/open_webui/utils/terminal_media_cache.py'),
        ('terminals_under_test', 'backend/open_webui/routers/terminals.py'),
    ):
        spec = importlib.util.spec_from_file_location(name, ROOT / rel)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        if name.endswith('terminal_media_cache'):
            sys.modules['open_webui.utils'].terminal_media_cache = module
    app = FastAPI()
    app.include_router(module.router, prefix='/api/v1/terminals')
    return app, module


class Terminal:
    def __init__(self):
        self.seen = []

    async def view(self, request):
        self.seen.append((request.method, request.path_qs, dict(request.headers)))
        path = request.query.get('path', '')
        if path.endswith('.html'):
            return web.Response(text='<script>steal()</script>', content_type='text/html',
                                headers={'Set-Cookie': 'token=evil; Path=/', 'Cache-Control': 'public, max-age=86400',
                                         'Access-Control-Allow-Origin': '*', 'Refresh': '0; url=https://evil.example'})
        if path.endswith('.mp4'):
            return web.Response(body=VIDEO, content_type='video/mp4')
        return web.json_response({'detail': 'not found'}, status=404)

    async def listing(self, request):
        return web.json_response({'entries': [{'name': 'clip.mp4', 'type': 'file', 'size': len(VIDEO), 'modified': 5.0}]})

    async def redirect(self, request):
        self.seen.append((request.method, request.path_qs, dict(request.headers)))
        raise web.HTTPTemporaryRedirect(request.query['to'])


async def start(t):
    app = web.Application()
    app.router.add_get('/files/view', t.view)
    app.router.add_get('/files/list', t.listing)
    app.router.add_route('*', '/r', t.redirect)
    app.router.add_route('*', '/proxy/3000/login', t.redirect)
    runner = web.AppRunner(app, shutdown_timeout=0.5)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    return runner, f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'


def with_app(tmp_path, fn):
    async def go():
        t = Terminal()
        runner, base = await start(t)
        app, module = load_router(tmp_path, base)
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://owui') as client:
                await fn(client, t, module)
        finally:
            await runner.cleanup()

    asyncio.run(go())


def test_video_streams_with_length_and_safe_headers(tmp_path):
    async def fn(client, t, module):
        r = await client.get(f'/api/v1/terminals/{SID}/files/view', params={'path': '/home/user/clip.mp4'})
        assert r.status_code == 200 and r.content == VIDEO
        assert r.headers['content-length'] == str(len(VIDEO))
        assert r.headers['content-security-policy'].startswith('sandbox')
        assert 'allow-same-origin' not in r.headers['content-security-policy']
        assert r.headers['cache-control'] == 'private, no-store' and r.headers['x-content-type-options'] == 'nosniff'
        assert t.seen[-1][2]['Authorization'] == 'Bearer k'  # the terminal key, not the user's

    with_app(tmp_path, fn)


def test_sandbox_html_cannot_set_cookies_or_caching(tmp_path):
    async def fn(client, t, module):
        r = await client.get(f'/api/v1/terminals/{SID}/files/view', params={'path': '/home/user/page.html'})
        assert r.status_code == 200 and 'sandbox' in r.headers['content-security-policy']
        for h in ('set-cookie', 'access-control-allow-origin', 'refresh'):
            assert h not in r.headers
        assert r.headers['cache-control'] == 'private, no-store'

    with_app(tmp_path, fn)


def test_admin_paths_refused(tmp_path):
    async def fn(client, t, module):
        for p in ('api/v1/terminals', 'api/v1/terminals/x', 'api/v1/policies', 'api/v1/status'):
            r = await client.get(f'/api/v1/terminals/{SID}/{p}')
            assert r.status_code == 403, p

    with_app(tmp_path, fn)


@pytest.mark.parametrize(
    'url,headers,to,expect',
    [
        (f'/api/v1/terminals/{SID}/r', {}, '/api/v1/chats/', f'/api/v1/terminals/{SID}/api/v1/chats/'),
        (f'/api/v1/terminals/{SID}/r', {}, 'https://evil.example/x', None),
        (f'/api/v1/terminals/{SID}/r', {}, '//evil.example/x', None),
        (f'/api/v1/terminals/{SID}/r', {}, '/a/%2e%2e/%2e%2e/b', None),
        (f'/api/v1/terminals/{SID}/r', {}, '/chats/B/files/delete', None),
        (f'/api/v1/terminals/{SID}/r', {}, '/%63hats/B/files/delete', None),
        (f'/api/v1/terminals/{SID}/r', {}, '/%63%68%61%74%73/B/files/delete', None),
        (f'/api/v1/terminals/{SID}/r', {}, '/chats%2fB/files/delete', None),
        (f'/api/v1/terminals/{SID}/r', {}, '/files%5c..%5cx', None),
        (f'/api/v1/terminals/{SID}/r', {'X-Session-Id': 'A'}, '/chats/B/files/delete', f'/api/v1/terminals/{SID}/chats/A/chats/B/files/delete'),
        (f'/api/v1/terminals/{SID}/chats/A/r', {}, '/files/x', f'/api/v1/terminals/{SID}/chats/A/files/x'),
        (f'/api/v1/terminals/{SID}/proxy/3000/login', {}, '/dashboard', f'/api/v1/terminals/{SID}/proxy/3000/dashboard'),
        (f'/api/v1/terminals/{SID}/proxy/3000/login', {}, '?next=1', f'/api/v1/terminals/{SID}/proxy/3000/login?next=1'),
    ],
)
def test_redirects_stay_in_the_terminal_and_chat(tmp_path, url, headers, to, expect):
    async def fn(client, t, module):
        r = await client.request('DELETE', url, params={'to': to}, headers=headers)
        assert r.status_code == 307
        assert r.headers.get('location') == (expect if expect is None else expect), r.headers.get('location')

    with_app(tmp_path, fn)


def test_cached_media_route(tmp_path):
    async def fn(client, t, module):
        u = f'/api/v1/terminals/{SID}/cached-media'
        r = await client.get(u, params={'path': '/home/user/clip.mp4', 'prepare': 'true'})
        assert r.status_code == 200 and r.json()['total'] == len(VIDEO)
        for _ in range(50):
            r = await client.get(u, params={'path': '/home/user/clip.mp4', 'prepare': 'true'})
            if r.json()['status'] == 'ready':
                break
            await asyncio.sleep(0.05)
        r = await client.get(u, params={'path': '/home/user/clip.mp4'}, headers={'Range': 'bytes=100-199'})
        assert r.status_code == 206 and r.content == VIDEO[100:200]
        assert r.headers['content-type'] == 'video/mp4' and r.headers['x-content-type-options'] == 'nosniff'
        cache = sys.modules['open_webui.utils.terminal_media_cache']
        entry = next(iter(cache._entries.values()))
        assert entry.readers == 0  # the response released its reader
        r = await client.get(u, params={'path': '/home/user/clip.mp4'}, headers={'Sec-Fetch-Site': 'cross-site'})
        assert r.status_code == 403
        r = await client.get(u, params={'path': '/home/user/page.html'})
        assert r.status_code == 415
        r = await client.get(u, params={'path': 'relative.mp4'})
        assert r.status_code == 400

    with_app(tmp_path, fn)


def test_cached_file_stops_serving_when_the_player_leaves(tmp_path):
    async def go():
        t = Terminal()
        runner, base = await start(t)
        try:
            _app, module = load_router(tmp_path, base)
            f = tmp_path / 'big.bin'
            f.write_bytes(b'x' * (8 * 1024**2))
            closed = asyncio.Event()
            resp = module._LeasedFileResponse(f, on_close=closed.set, media_type='video/mp4')
            blocked = asyncio.Event()

            async def send(message):  # a client that stopped reading: every body send hangs
                if message['type'] == 'http.response.body':
                    await blocked.wait()

            gone = asyncio.Event()

            async def receive():
                await gone.wait()
                return {'type': 'http.disconnect'}

            scope = {'type': 'http', 'method': 'GET', 'path': '/', 'headers': [], 'http_version': '1.1'}
            task = asyncio.ensure_future(resp(scope, receive, send))
            await asyncio.sleep(0.2)
            assert not closed.is_set()
            gone.set()
            await asyncio.wait_for(task, 2)
            assert closed.is_set()
        finally:
            await runner.cleanup()

    asyncio.run(go())


def test_cancelled_waits_leave_no_tasks(tmp_path):
    async def go():
        t = Terminal()
        runner, base = await start(t)
        try:
            _app, _module = load_router(tmp_path, base)
            cache = sys.modules['open_webui.utils.terminal_media_cache']
            entry = cache.Entry(key='k', file=tmp_path / 'f.bin', media_type='video/mp4', size=1, modified=1.0)
            cache._entries['k'] = entry
            cache._start_once()
            before = len(asyncio.all_tasks())
            waiters = [asyncio.ensure_future(cache.prepare(key='k', base_url=base, headers={}, path='/a/clip.mp4', wait=True)) for _ in range(20)]
            await asyncio.sleep(0.1)
            assert entry.waiters == 20
            for w in waiters:
                w.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)
            await asyncio.sleep(0.05)
            assert entry.waiters == 0 and len(asyncio.all_tasks()) == before
        finally:
            await runner.cleanup()

    asyncio.run(go())
