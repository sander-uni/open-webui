"""Fork: a short-lived local copy of a terminal's audio/video file, so the browser can seek.

Terminal servers (Open Terminal 0.14) answer ``files/view`` with the whole file and no byte
ranges, and generated mp4s keep their index at the end. A ``<video>`` element then has to
fetch everything before it can play, and every seek starts over. The proxy copies the file
once into this cache and serves it with ranges.

Security rules (the terminal is a sandbox; everything it sends is untrusted):
- Callers pass the request only after the proxy's own access checks.
- Entries are keyed by user, terminal, chat context and path; cache files are named by a
  random id, never by the sandbox path.
- Only audio and video extensions; the content type comes from our own table, never from
  the sandbox. Served with nosniff and a sandbox CSP (the caller adds the headers).
- Sizes and times from the terminal are validated; listings are read with a byte limit.
- Limits on bytes, entries, waiting copies, copy time (minimum rate) and folder listings.
  A copy nobody asks about any more is cancelled. Files being served are never deleted
  under a reader; they keep counting against the limit until the reader is done.
- A failed copy is reported to every poller for a while instead of being retried.
- Per-process folder, wiped at start; nothing is trusted across restarts.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import posixpath
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import aiohttp

from open_webui.config import CACHE_DIR
from open_webui.env import AIOHTTP_CLIENT_SESSION_SSL

log = logging.getLogger(__name__)

MEDIA_TYPES = {
    'mp4': 'video/mp4',
    'm4v': 'video/mp4',
    'webm': 'video/webm',
    'mov': 'video/quicktime',
    'mkv': 'video/x-matroska',
    'ogv': 'video/ogg',
    'avi': 'video/x-msvideo',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'oga': 'audio/ogg',
    'opus': 'audio/ogg',
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'wma': 'audio/x-ms-wma',
}

GiB = 1024**3
MiB = 1024**2
MAX_TOTAL_BYTES = int(float(os.getenv('TERMINAL_MEDIA_CACHE_MAX_GB', '20')) * GiB)
MAX_FILE_BYTES = min(int(float(os.getenv('TERMINAL_MEDIA_CACHE_MAX_FILE_GB', '8')) * GiB), MAX_TOTAL_BYTES)
MAX_IDLE_SECONDS = int(float(os.getenv('TERMINAL_MEDIA_CACHE_MAX_IDLE_HOURS', '24')) * 3600)
MAX_ENTRIES = 64
MAX_LOADING = 8
MAX_LOADING_PER_OWNER = 4
MAX_PENDING_CHECKS = 16
CHECK_SECONDS = 30
MAX_PARALLEL_FILLS = 2
MAX_PARALLEL_CHECKS = 4
# Every entry counts at least this much, so many empty files cannot pile up for free.
MIN_ACCOUNTED_BYTES = MiB
# How long a check against the terminal's listing stays good; a seek inside this window
# does not ask the terminal again.
FRESH_SECONDS = 30
# A copy must keep up this average rate (after a grace period) or it is stopped.
MIN_RATE_BYTES = int(float(os.getenv('TERMINAL_MEDIA_CACHE_MIN_RATE_MB', '2')) * MiB)
FILL_GRACE_SECONDS = 60
QUEUE_SECONDS = 300
# A copy nobody polled or waited for in this long is cancelled.
ABANDON_SECONDS = 60
# A failure is reported to pollers this long before a new attempt is allowed.
FAILURE_SECONDS = 30
LISTING_LIMIT_BYTES = 16 * MiB
CHUNK = MiB

ROOT = CACHE_DIR / 'terminal-media'
PROCESS_DIR = ROOT / str(os.getpid())

SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
}


class MediaCacheError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def media_type_for(path: str) -> str | None:
    name = posixpath.basename(path or '')
    if '.' not in name:
        return None
    return MEDIA_TYPES.get(name.rsplit('.', 1)[1].lower())


# eq=False: entries are compared and hashed by identity (they live in a set).
@dataclass(eq=False)
class Entry:
    key: str
    file: Path
    media_type: str
    size: int
    modified: float
    status: str = 'loading'  # loading | ready | error
    received: int = 0
    error: str = ''
    error_status: int = 502
    failed_at: float = 0.0
    owner: str = ''
    readers: int = 0
    # Requests waiting for this copy: like readers, they keep a finished file from eviction.
    waiters: int = 0
    retired: bool = False
    last_used: float = field(default_factory=time.monotonic)
    checked_at: float = field(default_factory=time.monotonic)
    task: asyncio.Task | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)

    @property
    def accounted(self) -> int:
        return max(self.size, MIN_ACCOUNTED_BYTES)

    @property
    def in_use(self) -> bool:
        return self.readers > 0 or self.waiters > 0


_entries: dict[str, Entry] = {}
# Dropped entries whose file is still being served; they count until the last reader ends.
_retired: set[Entry] = set()
_checks: dict[str, asyncio.Future] = {}
_lock = asyncio.Lock()
_fills = asyncio.Semaphore(MAX_PARALLEL_FILLS)
_check_slots = asyncio.Semaphore(MAX_PARALLEL_CHECKS)
_started = False


def _start_once():
    global _started
    if _started:
        return
    _started = True
    ROOT.mkdir(parents=True, exist_ok=True)
    # Drop folders of processes that are gone (and our own leftovers from a reused pid).
    for child in ROOT.iterdir():
        try:
            pid = int(child.name)
        except ValueError:
            shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)
            continue
        alive = pid != os.getpid()
        if alive:
            try:
                os.kill(pid, 0)
            except OSError:
                alive = False
        if not alive:
            shutil.rmtree(child, ignore_errors=True)
    PROCESS_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)


def cache_key(*, user_id: str, server_id: str, base_url: str, context: str, session: str, path: str) -> str:
    raw = json.dumps([user_id, server_id, base_url, context, session, path], separators=(',', ':'))
    return hashlib.sha256(raw.encode()).hexdigest()


def _valid_size(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _valid_time(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


async def _stat(base_url: str, headers: dict, cookies: dict, path: str) -> tuple[int, float]:
    try:
        # One deadline for the whole check, including the wait for a free slot.
        return await asyncio.wait_for(_stat_inner(base_url, headers, cookies, path), CHECK_SECONDS)
    except asyncio.TimeoutError:
        raise MediaCacheError('The terminal did not answer in time', 504)


async def _stat_inner(base_url: str, headers: dict, cookies: dict, path: str) -> tuple[int, float]:
    parent, name = posixpath.split(path)
    timeout = aiohttp.ClientTimeout(total=None, connect=10)
    async with _check_slots:
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True, cookies=cookies or None) as session:
            async with session.get(
                f'{base_url}/files/list',
                params={'directory': parent or '/'},
                headers=headers,
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
                allow_redirects=False,
            ) as response:
                if response.status != 200:
                    raise MediaCacheError(
                        'The terminal could not list the file', 404 if response.status == 404 else 502
                    )
                body = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    body += chunk
                    if len(body) > LISTING_LIMIT_BYTES:
                        raise MediaCacheError('The folder is too large to check', 502)
    try:
        data = json.loads(bytes(body))
    except ValueError:
        raise MediaCacheError('The terminal sent an invalid listing', 502)
    entries = data.get('entries') if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise MediaCacheError('The terminal sent an invalid listing', 502)
    for item in entries:
        if isinstance(item, dict) and item.get('name') == name and item.get('type') == 'file':
            size, modified = _valid_size(item.get('size')), _valid_time(item.get('modified', 0))
            if size is None or modified is None:
                raise MediaCacheError('The terminal sent an invalid file size or time', 502)
            return size, modified
    raise MediaCacheError('File not found', 404)


_check_interest: dict[str, int] = {}


async def _stat_once(key: str, base_url: str, headers: dict, cookies: dict, path: str) -> tuple[int, float]:
    """Simultaneous checks of the same entry share one listing request. The number of checks
    is capped before any work starts, and a check nobody waits for any more is cancelled."""
    pending = _checks.get(key)
    if pending is None:
        if len(_checks) >= MAX_PENDING_CHECKS:
            raise MediaCacheError('Too many files are being checked; try again shortly', 503)
        pending = asyncio.ensure_future(_stat(base_url, headers, cookies, path))
        _checks[key] = pending
        pending.add_done_callback(lambda _f: _checks.pop(key, None) if _checks.get(key) is _f else None)
    _check_interest[key] = _check_interest.get(key, 0) + 1
    try:
        return await asyncio.shield(pending)
    finally:
        left = _check_interest.get(key, 1) - 1
        if left > 0:
            _check_interest[key] = left
        else:
            _check_interest.pop(key, None)
            if not pending.done():
                pending.cancel()


def _total_bytes() -> int:
    live = sum(e.accounted for e in _entries.values() if e.status != 'error')
    return live + sum(e.accounted for e in _retired)


def _unlink(entry: Entry):
    for p in (entry.file, entry.file.with_suffix('.part')):
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def _drop(entry: Entry):
    if _entries.get(entry.key) is entry:
        del _entries[entry.key]
    if entry.task and not entry.task.done():
        entry.task.cancel()
    if entry.in_use:
        entry.retired = True
        _retired.add(entry)
    else:
        _unlink(entry)


def _settle(entry: Entry):
    if entry.retired and not entry.in_use:
        _retired.discard(entry)
        _unlink(entry)


def release(entry: Entry):
    """The reader that prepare(lease=True) admitted is done with the file."""
    entry.readers = max(0, entry.readers - 1)
    _settle(entry)


def _evict(need: int, owner: str):
    now = time.monotonic()
    for e in list(_entries.values()):
        if e.status == 'error' and now - e.failed_at > FAILURE_SECONDS:
            _drop(e)
        elif e.status == 'ready' and not e.in_use and now - e.last_used > MAX_IDLE_SECONDS:
            _drop(e)
    loading = [e for e in _entries.values() if e.status == 'loading']
    if len(loading) >= MAX_LOADING or sum(1 for e in loading if e.owner == owner) >= MAX_LOADING_PER_OWNER:
        raise MediaCacheError('Too many files are loading; try again shortly', 503)
    for e in sorted(_entries.values(), key=lambda e: e.last_used):
        if _total_bytes() + need <= MAX_TOTAL_BYTES and len(_entries) < MAX_ENTRIES:
            break
        if e.status == 'ready' and not e.in_use:
            _drop(e)
    if _total_bytes() + need > MAX_TOTAL_BYTES or len(_entries) >= MAX_ENTRIES:
        raise MediaCacheError('The media cache is busy with other files; try again shortly', 503)


def _fail(entry: Entry, message: str, status: int = 502):
    entry.status, entry.error, entry.error_status = 'error', message, status
    entry.failed_at = time.monotonic()


async def _transfer(entry: Entry, base_url: str, headers: dict, cookies: dict, path: str, part: Path):
    timeout = aiohttp.ClientTimeout(total=None, connect=10, sock_read=60)
    # No compression: the bytes counted are the bytes stored, and an encoded stream of empty
    # blocks cannot keep the connection busy without delivering data.
    headers = {**headers, 'Accept-Encoding': 'identity'}
    async with aiohttp.ClientSession(
        timeout=timeout, trust_env=True, cookies=cookies or None, auto_decompress=False
    ) as session:
        async with session.get(
            f'{base_url}/files/view',
            params={'path': path},
            headers=headers,
            ssl=AIOHTTP_CLIENT_SESSION_SSL,
            allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise MediaCacheError(f'The terminal answered {response.status}', 502)
            if response.headers.get('content-encoding', 'identity').lower() != 'identity':
                raise MediaCacheError('The terminal sent the file compressed', 502)
            upstream_type = response.headers.get('content-type', '')
            if upstream_type.startswith(('application/json', 'text/')):
                raise MediaCacheError('The terminal did not send a media file', 502)
            fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'wb') as out:
                async for chunk in response.content.iter_chunked(CHUNK):
                    entry.received += len(chunk)
                    if entry.received > entry.size:
                        raise MediaCacheError('The file changed while it was loading', 409)
                    await asyncio.to_thread(out.write, chunk)
    if entry.received != entry.size:
        raise MediaCacheError('The file changed while it was loading', 409)


async def _fill(entry: Entry, base_url: str, headers: dict, cookies: dict, path: str):
    part = entry.file.with_suffix('.part')
    try:
        try:
            await asyncio.wait_for(_fills.acquire(), QUEUE_SECONDS)
        except asyncio.TimeoutError:
            raise MediaCacheError('The media cache is busy with other files; try again shortly', 503)
        try:
            deadline = time.monotonic() + FILL_GRACE_SECONDS + entry.size / MIN_RATE_BYTES
            transfer = asyncio.create_task(_transfer(entry, base_url, headers, cookies, path, part))
            # The watchdog runs on its own clock: headers, body and end of stream all count,
            # whether or not any data arrives.
            while not transfer.done():
                await asyncio.wait({transfer}, timeout=2)
                if transfer.done():
                    break
                now = time.monotonic()
                reason = None
                if now > deadline:
                    reason = MediaCacheError('The terminal sent the file too slowly', 504)
                elif now - entry.last_used > ABANDON_SECONDS and entry.waiters == 0:
                    reason = MediaCacheError('Nobody is waiting for this file any more', 499)
                if reason:
                    transfer.cancel()
                    try:
                        await transfer
                    except BaseException:
                        pass
                    raise reason
            transfer.result()
            os.replace(part, entry.file)
            entry.status = 'ready'
        except asyncio.CancelledError:
            if 'transfer' in locals() and not transfer.done():
                transfer.cancel()
            raise
        finally:
            _fills.release()
    except asyncio.CancelledError:
        _fail(entry, 'Cancelled', 499)
        raise
    except MediaCacheError as error:
        _fail(entry, str(error), error.status)
    except Exception as error:  # network trouble; the message stays generic
        log.warning('Terminal media cache fill failed: %s', type(error).__name__)
        _fail(entry, 'Loading from the terminal failed')
    finally:
        if entry.status != 'ready':
            try:
                part.unlink()
            except FileNotFoundError:
                pass
        entry.ready.set()


def _raise_failure(entry: Entry):
    raise MediaCacheError(entry.error or 'Loading from the terminal failed', entry.error_status)


async def prepare(
    *,
    key: str,
    base_url: str,
    headers: dict,
    cookies: dict | None = None,
    path: str,
    wait: bool,
    owner: str = '',
    lease: bool = False,
) -> Entry:
    """Start (or reuse) the local copy. With wait=True, return once it is ready or failed.

    With lease=True the entry comes back with a reader counted (atomically, no await between
    the ready check and the count), so it cannot be evicted before it is served; the caller
    must call release() when the response ends.
    """
    media_type = media_type_for(path)
    if not media_type:
        raise MediaCacheError('Only audio and video files can be played this way', 415)
    _start_once()
    cookies = cookies or {}
    entry = _entries.get(key)
    now = time.monotonic()
    if entry and entry.status == 'error' and now - entry.failed_at <= FAILURE_SECONDS:
        _raise_failure(entry)
    if entry and entry.status != 'error' and now - entry.checked_at < FRESH_SECONDS:
        entry.last_used = now
    else:
        size, modified = await _stat_once(key, base_url, headers, cookies, path)
        async with _lock:
            entry = _entries.get(key)
            now = time.monotonic()
            if entry and entry.status == 'error' and now - entry.failed_at <= FAILURE_SECONDS:
                _raise_failure(entry)
            if entry and entry.status != 'error' and (entry.size, entry.modified) == (size, modified):
                entry.checked_at = entry.last_used = now
            else:
                if entry:
                    _drop(entry)
                if size > MAX_FILE_BYTES:
                    raise MediaCacheError('The file is too large to cache', 413)
                _evict(max(size, MIN_ACCOUNTED_BYTES), owner)
                entry = Entry(
                    key=key,
                    file=PROCESS_DIR / f'{uuid.uuid4().hex}.bin',
                    media_type=media_type,
                    size=size,
                    modified=modified,
                    owner=owner,
                )
                _entries[key] = entry
                entry.task = asyncio.create_task(_fill(entry, base_url, dict(headers), dict(cookies), path))
    if wait and entry.status == 'loading':
        # A waiting request keeps the copy alive (no abandonment) and the finished file on
        # disk (no eviction) until it has taken its reader count below.
        entry.waiters += 1
        finished = False
        try:
            while entry.status == 'loading':
                entry.last_used = time.monotonic()
                try:
                    # Cancelling this wait (timeout or the request leaving) cancels only this
                    # waiter, never the shared event or the copy.
                    await asyncio.wait_for(entry.ready.wait(), 10)
                except asyncio.TimeoutError:
                    pass
            finished = True
        finally:
            entry.waiters -= 1
            # Count the reader before giving up the waiter's hold (a cancelled wait takes none).
            if finished and entry.status == 'ready' and lease:
                entry.readers += 1
                lease = False
            _settle(entry)
    if entry.status == 'error':
        _raise_failure(entry)
    if lease:
        entry.readers += 1
    entry.last_used = time.monotonic()
    return entry


def progress(entry: Entry) -> dict:
    return {
        'status': entry.status,
        'received': entry.received,
        'total': entry.size,
    }
