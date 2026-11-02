"""Fork: tests for backend/open_webui/utils/terminal_media_cache.py against a fake terminal.

Run: cd ~/owui-update; <venv python> -m pytest -q -p no:cacheprovider fork/terminal-media/
The module is loaded by file path with stubbed open_webui.config/env, so no database starts.
"""

import asyncio
import importlib.util
import os
import sys
import types
from pathlib import Path

import pytest
from aiohttp import web

ROOT = Path(__file__).resolve().parents[2]


def load_cache(tmp_path, **env):
    for key, value in env.items():
        os.environ[key] = value
    pkg = types.ModuleType('open_webui')
    pkg.__path__ = []
    config = types.ModuleType('open_webui.config')
    config.CACHE_DIR = tmp_path / 'cache'
    envmod = types.ModuleType('open_webui.env')
    envmod.AIOHTTP_CLIENT_SESSION_SSL = None
    sys.modules.update({'open_webui': pkg, 'open_webui.config': config, 'open_webui.env': envmod})
    spec = importlib.util.spec_from_file_location(
        'terminal_media_cache_under_test', ROOT / 'backend/open_webui/utils/terminal_media_cache.py'
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    for key in env:
        del os.environ[key]
    return module


class FakeTerminal:
    """files/list + files/view for one folder; behaviour switches per test."""

    def __init__(self):
        self.files = {'/home/user/v/clip.mp4': (b'A' * 300_000, 1000.0)}
        self.view_calls = 0
        self.list_status = 200
        self.view_mode = 'ok'  # ok | json | grow | slow | 500
        self.seen_headers = []

    async def list(self, request):
        self.seen_headers.append(dict(request.headers))
        if self.list_status != 200:
            return web.json_response({'detail': 'no'}, status=self.list_status)
        folder = request.query['directory'].rstrip('/')
        entries = [
            {'name': p.rsplit('/', 1)[1], 'type': 'file', 'size': len(data), 'modified': mtime}
            for p, (data, mtime) in self.files.items()
            if p.rsplit('/', 1)[0] == folder
        ]
        return web.json_response({'dir': folder, 'entries': entries})

    async def view(self, request):
        self.view_calls += 1
        data, _ = self.files.get(request.query['path'], (None, 0))
        if data is None:
            return web.json_response({'detail': 'not found'}, status=404)
        if self.view_mode == 'json':
            return web.json_response({'detail': 'nope'})
        if self.view_mode == '500':
            return web.Response(status=500, text='boom')
        if self.view_mode == 'stall_headers':
            await asyncio.sleep(3600)
        if self.view_mode == 'gzip':
            return web.Response(body=b'x', headers={'Content-Type': 'video/mp4', 'Content-Encoding': 'gzip'})
        response = web.StreamResponse(headers={'Content-Type': 'video/mp4'})
        await response.prepare(request)
        if self.view_mode == 'stall_body':
            await response.write(data[:10])
            await asyncio.sleep(3600)
        payload = data + (b'B' * 5000 if self.view_mode == 'grow' else b'')
        for i in range(0, len(payload), 65536):
            await response.write(payload[i : i + 65536])
            if self.view_mode == 'slow':
                await asyncio.sleep(0.05)
        await response.write_eof()
        return response


async def start(terminal):
    app = web.Application()
    app.router.add_get('/files/list', terminal.list)
    app.router.add_get('/files/view', terminal.view)
    runner = web.AppRunner(app, shutdown_timeout=0.5)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return runner, f'http://127.0.0.1:{port}'


def run(coro):
    return asyncio.run(coro)


def key(cache, user='u1', path='/home/user/v/clip.mp4', context='', session=''):
    return cache.cache_key(user_id=user, server_id='s', base_url='b', context=context, session=session, path=path)


def test_copy_serves_exact_bytes_and_reuses(tmp_path):
    cache = load_cache(tmp_path)

    async def go():
        t = FakeTerminal()
        runner, base = await start(t)
        try:
            e = await cache.prepare(key=key(cache), base_url=base, headers={'X-User-Id': 'u1'}, path='/home/user/v/clip.mp4', wait=True)
            assert e.status == 'ready' and e.file.read_bytes() == t.files['/home/user/v/clip.mp4'][0]
            assert e.media_type == 'video/mp4'
            # cache file name is a hash, never the sandbox name; folder is private
            assert 'clip' not in e.file.name and e.file.parent == cache.PROCESS_DIR
            assert oct(e.file.parent.stat().st_mode & 0o777) == '0o700'
            again = await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=True)
            assert again is e and t.view_calls == 1
        finally:
            await runner.cleanup()

    run(go())


def test_changed_file_is_copied_again(tmp_path):
    cache = load_cache(tmp_path)

    async def go():
        t = FakeTerminal()
        runner, base = await start(t)
        try:
            e1 = await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=True)
            t.files['/home/user/v/clip.mp4'] = (b'C' * 1000, 2000.0)
            e1.checked_at -= 60  # past the freshness window
            e2 = await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=True)
            assert e2 is not e1 and e2.file.read_bytes() == b'C' * 1000
            assert not e1.file.exists()
        finally:
            await runner.cleanup()

    run(go())


@pytest.mark.parametrize('mode,expect', [('json', 'did not send a media file'), ('grow', 'changed while'), ('500', 'answered 500')])
def test_bad_upstream_fails_and_leaves_nothing(tmp_path, mode, expect):
    cache = load_cache(tmp_path)

    async def go():
        t = FakeTerminal()
        t.view_mode = mode
        runner, base = await start(t)
        try:
            with pytest.raises(cache.MediaCacheError) as err:
                await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=True)
            assert expect in str(err.value)
            assert list(cache.PROCESS_DIR.iterdir()) == []
            # The failure is reported to the next poll too, without another download.
            calls = t.view_calls
            with pytest.raises(cache.MediaCacheError) as again:
                await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=False)
            assert str(again.value) == str(err.value) and t.view_calls == calls
            # After the failure window a new attempt is allowed.
            next(iter(cache._entries.values())).failed_at -= cache.FAILURE_SECONDS + 1
            t.view_mode = 'ok'
            e = await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=True)
            assert e.status == 'ready'
        finally:
            await runner.cleanup()

    run(go())


def test_refusals(tmp_path):
    cache = load_cache(tmp_path, TERMINAL_MEDIA_CACHE_MAX_FILE_GB=str(100_000 / 1024**3))

    async def go():
        t = FakeTerminal()
        t.files['/home/user/v/page.html'] = (b'<script>', 1.0)
        t.files['/home/user/v/x.mp4.html'] = (b'<script>', 1.0)
        runner, base = await start(t)
        try:
            for path in ('/home/user/v/page.html', '/home/user/v/x.mp4.html', '/home/user/v/noext'):
                with pytest.raises(cache.MediaCacheError) as err:
                    await cache.prepare(key=key(cache, path=path), base_url=base, headers={}, path=path, wait=True)
                assert err.value.status == 415
            with pytest.raises(cache.MediaCacheError) as err:  # 300 kB file over a 100 kB limit
                await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=True)
            assert err.value.status == 413
            with pytest.raises(cache.MediaCacheError) as err:
                await cache.prepare(key=key(cache, path='/home/user/v/gone.mp4'), base_url=base, headers={}, path='/home/user/v/gone.mp4', wait=True)
            assert err.value.status == 404
            assert t.view_calls == 0
        finally:
            await runner.cleanup()

    run(go())


def test_keys_separate_users_and_contexts(tmp_path):
    cache = load_cache(tmp_path)
    assert len({key(cache), key(cache, user='u2'), key(cache, context='c1'), key(cache, session='chat1'),
                key(cache, path='/home/user/v/clip2.mp4')}) == 5


def test_progress_while_copying_and_parallel_prepare(tmp_path):
    cache = load_cache(tmp_path)

    async def go():
        t = FakeTerminal()
        t.view_mode = 'slow'
        runner, base = await start(t)
        try:
            first = await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=False)
            assert cache.progress(first)['status'] == 'loading' and cache.progress(first)['total'] == 300_000
            others = await asyncio.gather(*[
                cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=True) for _ in range(5)
            ])
            assert all(o is first for o in others) and first.status == 'ready' and t.view_calls == 1
        finally:
            await runner.cleanup()

    run(go())


def test_eviction_keeps_total_under_limit(tmp_path):
    cache = load_cache(tmp_path, TERMINAL_MEDIA_CACHE_MAX_GB=str(5 / 1024))  # 5 MiB

    async def go():
        t = FakeTerminal()
        for i in range(4):
            t.files[f'/home/user/v/c{i}.mp4'] = (bytes([65 + i]) * (2 * 1024**2), 1.0)
        runner, base = await start(t)
        try:
            for i in range(4):
                p = f'/home/user/v/c{i}.mp4'
                await cache.prepare(key=key(cache, path=p), base_url=base, headers={}, path=p, wait=True)
                assert cache._total_bytes() <= 5 * 1024**2
            on_disk = sum(f.stat().st_size for f in cache.PROCESS_DIR.iterdir())
            assert on_disk <= 5 * 1024**2 and len(cache._entries) == 2
        finally:
            await runner.cleanup()

    run(go())


def test_start_removes_dead_process_folders(tmp_path):
    root = tmp_path / 'cache' / 'terminal-media'
    (root / '999999999').mkdir(parents=True)
    (root / '999999999' / 'old.bin').write_bytes(b'x')
    (root / 'junk').mkdir()
    cache = load_cache(tmp_path)
    cache._start_once()
    assert sorted(p.name for p in root.iterdir()) == [str(os.getpid())]


def test_hostile_listings_and_limits(tmp_path):
    cache = load_cache(tmp_path)

    async def go():
        t = FakeTerminal()
        runner, base = await start(t)
        try:
            # negative, fractional, boolean and NaN-like sizes/times are refused before any copy
            for size, mtime in ((-10, 1.0), (1.5, 1.0), (True, 1.0), (10, float('nan'))):
                orig = t.list

                async def bad(request, size=size, mtime=mtime):
                    return web.json_response({'entries': [{'name': 'clip.mp4', 'type': 'file', 'size': size, 'modified': mtime}]}, dumps=lambda o: __import__('json').dumps(o, allow_nan=True))

                t.list = bad
                runner2, base2 = await start(t)
                with pytest.raises(cache.MediaCacheError):
                    await cache.prepare(key=key(cache, user=str(size)), base_url=base2, headers={}, path='/home/user/v/clip.mp4', wait=True)
                await runner2.cleanup()
                t.list = orig
            assert t.view_calls == 0 and cache._total_bytes() == 0
            # zero-byte files still count, so the entry cap holds
            assert cache.Entry(key='k', file=tmp_path / 'x', media_type='video/mp4', size=0, modified=0).accounted == cache.MIN_ACCOUNTED_BYTES
        finally:
            await runner.cleanup()

    run(go())


def test_reader_lease_keeps_file_and_counts_it(tmp_path):
    cache = load_cache(tmp_path, TERMINAL_MEDIA_CACHE_MAX_GB=str(3 / 1024))  # 3 MiB: one 2 MiB file at a time

    async def go():
        t = FakeTerminal()
        t.files = {f'/home/user/v/c{i}.mp4': (bytes([65 + i]) * (2 * 1024**2), 1.0) for i in range(2)}
        runner, base = await start(t)
        try:
            a = await cache.prepare(key=key(cache, path='/home/user/v/c0.mp4'), base_url=base, headers={}, path='/home/user/v/c0.mp4', wait=True, lease=True)
            assert a.readers == 1
            # the only file is being read: there is no room and it must not be deleted
            with pytest.raises(cache.MediaCacheError) as err:
                await cache.prepare(key=key(cache, path='/home/user/v/c1.mp4'), base_url=base, headers={}, path='/home/user/v/c1.mp4', wait=True)
            assert err.value.status == 503 and a.file.exists()
            # once the source changes the entry is replaced, but the reader keeps its file
            t.files['/home/user/v/c0.mp4'] = (b'Z' * 1000, 2.0)
            a.checked_at -= 60
            await cache.prepare(key=key(cache, path='/home/user/v/c0.mp4'), base_url=base, headers={}, path='/home/user/v/c0.mp4', wait=True)
            assert a.retired and a.file.exists() and a in cache._retired
            cache.release(a)
            assert not a.file.exists() and a not in cache._retired
        finally:
            await runner.cleanup()

    run(go())


def test_abandoned_copy_stops(tmp_path):
    cache = load_cache(tmp_path)

    async def go():
        t = FakeTerminal()
        t.view_mode = 'slow'
        t.files['/home/user/v/clip.mp4'] = (b'A' * (8 * 1024**2), 1000.0)  # ~6 s at the slow rate
        runner, base = await start(t)
        try:
            e = await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=False)
            await asyncio.sleep(0.1)
            e.last_used -= cache.ABANDON_SECONDS + 1
            await e.ready.wait()
            assert e.status == 'error' and 'Nobody is waiting' in e.error
            assert list(cache.PROCESS_DIR.iterdir()) == []
        finally:
            await runner.cleanup()

    run(go())



@pytest.mark.parametrize('mode', ['stall_headers', 'stall_body'])
def test_stalled_copy_is_stopped_by_the_watchdog(tmp_path, mode):
    cache = load_cache(tmp_path)
    cache.FILL_GRACE_SECONDS = 1
    cache.MIN_RATE_BYTES = 10**12

    async def go():
        t = FakeTerminal()
        t.view_mode = mode
        runner, base = await start(t)
        try:
            e = await asyncio.wait_for(cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=False), 5)
            await asyncio.wait_for(e.ready.wait(), 10)
            assert e.status == 'error' and 'too slowly' in e.error
            assert list(cache.PROCESS_DIR.iterdir()) == []
            assert cache._fills._value == cache.MAX_PARALLEL_FILLS  # slot given back
        finally:
            await runner.cleanup()

    run(go())


def test_compressed_upstream_is_refused(tmp_path):
    cache = load_cache(tmp_path)

    async def go():
        t = FakeTerminal()
        t.view_mode = 'gzip'
        runner, base = await start(t)
        try:
            with pytest.raises(cache.MediaCacheError) as err:
                await cache.prepare(key=key(cache), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=True)
            assert 'compressed' in str(err.value)
        finally:
            await runner.cleanup()

    run(go())


def test_check_queue_is_capped_and_cancelled(tmp_path):
    cache = load_cache(tmp_path)

    async def go():
        t = FakeTerminal()

        async def slow_list(request):
            await asyncio.sleep(3600)

        t.list = slow_list
        runner, base = await start(t)
        try:
            callers = [asyncio.create_task(cache.prepare(key=key(cache, user=f'u{i}'), base_url=base, headers={}, path='/home/user/v/clip.mp4', wait=False)) for i in range(cache.MAX_PENDING_CHECKS + 5)]
            await asyncio.sleep(0.3)
            refused = [c for c in callers if c.done() and isinstance(c.exception(), cache.MediaCacheError) and c.exception().status == 503]
            assert len(refused) == 5 and len(cache._checks) == cache.MAX_PENDING_CHECKS
            for c in callers:
                c.cancel()
            await asyncio.gather(*callers, return_exceptions=True)
            await asyncio.sleep(0.1)
            assert len(cache._checks) == 0  # nobody waits: the checks were cancelled
        finally:
            await runner.cleanup()

    run(go())


def test_waiting_reader_is_not_evicted(tmp_path):
    """The moment between 'copy finished' and 'waiting request resumes': the entry is ready,
    nobody reads it yet, and another file asks for the space."""
    cache = load_cache(tmp_path, TERMINAL_MEDIA_CACHE_MAX_GB=str(3 / 1024))

    async def go():
        t = FakeTerminal()
        t.files = {'/home/user/v/c0.mp4': (b'A' * (2 * 1024**2), 1.0)}
        t.view_mode = 'slow'
        runner, base = await start(t)
        try:
            k0 = key(cache, path='/home/user/v/c0.mp4')
            waiter = asyncio.create_task(cache.prepare(key=k0, base_url=base, headers={}, path='/home/user/v/c0.mp4', wait=True, lease=True))
            for _ in range(100):
                await asyncio.sleep(0.01)
                if k0 in cache._entries and cache._entries[k0].waiters == 1:
                    break
            e0 = cache._entries[k0]
            e0.status = 'ready'  # as if the copy had just finished
            Path(e0.file).write_bytes(b'x')
            with pytest.raises(cache.MediaCacheError):
                cache._evict(2 * 1024**2, 'someone')
            assert cache._entries.get(k0) is e0 and e0.file.exists()
            e0.status = 'loading'
            got = await waiter
            assert got is e0 and got.readers == 1
            cache.release(got)
        finally:
            await runner.cleanup()

    run(go())
