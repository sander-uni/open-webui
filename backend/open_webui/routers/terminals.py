"""Reverse proxy for admin-configured terminal servers.

Routes:
  GET  /                         — list terminals the user has access to
  *    /{server_id}/{path:path}  — proxy request to terminal server
"""

import asyncio
import logging
import posixpath
import re
from urllib.parse import quote, unquote, urljoin, urlsplit

import aiohttp
from fastapi import APIRouter, Depends, Request, Response, WebSocket
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from open_webui.config import TERMINAL_PROXY_HEADERS
from open_webui.env import AIOHTTP_CLIENT_SESSION_SSL, ENABLE_TOOL_SERVERS
from open_webui.events import EVENTS, publish_event
from open_webui.models.config import Config
from open_webui.models.groups import Groups
from open_webui.utils.access_control import has_connection_access
from open_webui.utils.auth import get_verified_user, get_verified_user_by_token
from open_webui.utils.headers import bearer_auth_header, normalize_bearer_token
from open_webui.utils import terminal_media_cache  # fork
from open_webui.utils.json_codec import JSONCodec
from open_webui.utils.terminals import (
    TERMINAL_CONTEXT_HEADER,
    get_terminal_server_url,
    is_terminal_orchestrator,
    terminal_chat_uploads,
    terminal_context_available,
    terminal_context_config,
    terminal_context_id,
    terminal_contexts,
)
from starlette.requests import ClientDisconnect
from yarl import URL

log = logging.getLogger(__name__)

router = APIRouter()

# fork: what a sandbox may send to the browser through the proxy. Everything else (Set-Cookie,
# CORS, CSP, HSTS, Clear-Site-Data, Refresh, ...) is dropped: the terminal is untrusted.
FORWARDED_RESPONSE_HEADERS = frozenset(
    (
        'content-type',
        'content-disposition',
        'content-language',
        'etag',
        'last-modified',
        'vary',
        'accept-ranges',
        'content-range',
        'location',  # rewritten by _proxy_location, dropped when it would leave the terminal
    )
)
# fork: whatever the sandbox sends runs as an opaque origin, even when opened directly in a tab
# (the preview iframes already use the same sandbox by default), so it can never read Open
# WebUI's storage or call its API as the user.
SANDBOX_RESPONSE_HEADERS = {
    'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
    'X-Content-Type-Options': 'nosniff',
    # Responses are per user; the sandbox cannot make them cacheable for anyone else.
    'Cache-Control': 'private, no-store',
}


def _proxy_location(
    value: str, request: Request, server_id: str, upstream_path: str, session_id: str | None
) -> str | None:
    """fork: a terminal's redirect, kept inside this terminal's proxy path and chat context.

    The browser follows same-origin redirects with the user's Authorization header and the
    original method, so a sandbox answering ``307 Location: /api/v1/chats/`` to a DELETE would
    otherwise delete the user's chats. The target is resolved as a URL on the terminal and
    mapped under /api/v1/terminals/{id}/chats/{session} (the request's own chat, whether it
    came in the path or in X-Session-Id) or /api/v1/terminals/{id}; it can never pick another
    chat. Other hosts and schemes are dropped.
    """
    if not value or any(c in value for c in '\\\r\n\t\x00'):
        return None
    parts = urlsplit(value)
    if parts.scheme or parts.netloc or value.startswith('//'):
        return None
    # The URL parser treats %2e%2e as '..': refuse dot segments in any spelling.
    if any(segment in ('.', '..') for segment in unquote(parts.path).split('/')):
        return None
    marker = f'/terminals/{server_id}/'
    index = request.url.path.find(marker)
    if index < 0:
        return None
    prefix = request.url.path[: index + len(marker) - 1]
    if session_id:
        prefix += f"/chats/{quote(session_id, safe='')}"
    current = '/' + upstream_path.lstrip('/')
    if parts.path.startswith('/'):
        # An app behind the port proxy thinks it runs at '/': its '/login' is its own.
        port = re.match(r'/proxy/(\d+)(?:/|$)', current)
        target, query, fragment = (f'/proxy/{port.group(1)}' if port else '') + parts.path, parts.query, parts.fragment
    else:
        # Relative, query-only and fragment-only references resolve against the current URL.
        base = 'http://terminal' + current + (f'?{request.url.query}' if request.url.query else '')
        joined = urlsplit(urljoin(base, value))
        target, query, fragment = joined.path or '/', joined.query, joined.fragment
    normalized = posixpath.normpath(target)
    if target.endswith('/') and not normalized.endswith('/'):
        normalized += '/'
    # The router decodes the path: judge it as decoded, and refuse encoded separators.
    if re.search(r'%(2f|5c|00)', normalized, re.IGNORECASE):
        return None
    decoded = posixpath.normpath(unquote(normalized))
    # Without a chat in the request, a redirect must not name one (in any spelling).
    if not session_id and (decoded == '/chats' or decoded.startswith('/chats/')):
        return None
    location = prefix + normalized
    if query:
        location += '?' + query
    if fragment:
        location += '#' + fragment
    return location


def _sanitize_proxy_path(path: str) -> str | None:
    """Sanitize a proxy path to prevent directory traversal / SSRF.

    Returns the cleaned path, or None if the path is invalid.
    Trailing slashes are preserved — many upstream frameworks treat
    ``/path`` and ``/path/`` differently.
    """
    # Decode until stable: a single unquote pass leaves %252e%252e as %2e%2e,
    # which the upstream then re-decodes into '..', bypassing the check below.
    decoded = path
    for _ in range(8):
        once = unquote(decoded)
        if once == decoded:
            break
        decoded = once
    # Fail closed: still encoded after the cap means the upstream would decode further into traversal.
    if unquote(decoded) != decoded:
        return None
    # posixpath splits on '/' only, so 'a/..\..\b' survives normpath as one component.
    # Upstreams that treat '\' as a separator would resolve it, so reject outright.
    # URL parsers also remove tabs/newlines, which can turn '.\t.' into '..'.
    if any(char in decoded for char in '\\\t\r\n'):
        return None
    had_trailing_slash = decoded.endswith('/')
    normalized = posixpath.normpath(decoded)
    # Remove any leading slashes that would reset the base
    cleaned = normalized.lstrip('/')
    # Reject if normpath resolved to parent traversal or current-dir only
    if cleaned.startswith('..') or cleaned == '.':
        return None
    # Restore trailing slash if the original path had one
    if had_trailing_slash and cleaned and not cleaned.endswith('/'):
        cleaned += '/'
    return cleaned


@router.get('/')
async def list_terminal_servers(request: Request, user=Depends(get_verified_user)):
    """Return terminal servers the authenticated user has access to."""
    if not ENABLE_TOOL_SERVERS:
        return []

    connections = await Config.get('terminal_server.connections', []) or []
    user_group_ids = {group.id for group in await Groups.get_groups_by_member_id(user.id, include_inherited=True)}

    return [
        {
            'id': connection.get('id', ''),
            'url': connection.get('url', ''),
            'name': connection.get('name', ''),
            'contexts': terminal_contexts(connection),
            'config': {'chat_uploads': terminal_chat_uploads(connection)},
        }
        for connection in connections
        if connection.get('enabled', True) and await has_connection_access(user, connection, user_group_ids)
    ]


PROXY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
ADMIN_API_PATHS = ('api/v1/policies', 'api/v1/status', 'api/v1/terminals')


async def _resolve_proxy_target(server_id: str, path: str, request: Request, user):
    """Access checks and upstream request parts shared by the proxy and the media cache.

    Returns (connection, base_url, target_url, headers, cookies, session_id, context_id),
    or a JSONResponse refusing the request.
    """
    if not ENABLE_TOOL_SERVERS:
        return JSONResponse({'error': 'Tool servers are disabled'}, status_code=403)

    connections = await Config.get('terminal_server.connections', []) or []
    connection = next((c for c in connections if c.get('id') == server_id), None)

    if connection is None:
        return JSONResponse({'error': f"Terminal server '{server_id}' not found"}, status_code=404)

    if not connection.get('enabled', True):
        return JSONResponse({'error': 'Terminal server disabled'}, status_code=403)

    user_group_ids = {group.id for group in await Groups.get_groups_by_member_id(user.id, include_inherited=True)}
    if not await has_connection_access(user, connection, user_group_ids):
        return JSONResponse({'error': 'Access denied'}, status_code=403)

    base_url = get_terminal_server_url(connection)
    if not base_url:
        return JSONResponse({'error': 'Terminal server URL not configured'}, status_code=503)

    safe_path = _sanitize_proxy_path(path)
    if safe_path is None:
        return JSONResponse({'error': 'Invalid path'}, status_code=400)

    target_url = f'{base_url}/{safe_path}'

    # Check the path aiohttp will send, relative to the configured server root.
    base_path = URL(str(connection.get('url') or '')).path.rstrip('/')
    target_path = URL(target_url).path
    if any(
        target_path == f'{base_path}/{prefix}' or target_path.startswith(f'{base_path}/{prefix}/')
        for prefix in ADMIN_API_PATHS
    ):
        return JSONResponse({'error': 'Path not allowed'}, status_code=403)

    headers = {'X-User-Id': user.id}
    context_id = None
    # Forward per-session cwd tracking header
    session_id = request.path_params.get('chat_id') or request.headers.get('x-session-id')
    if session_id:
        headers['X-Session-Id'] = session_id
        if not terminal_context_available(connection, 'chat'):
            return JSONResponse({'error': 'Terminal server is not available in chats'}, status_code=403)
        context_id = terminal_context_id(connection, {'chat_id': session_id}, 'chat')
        if terminal_context_config(connection, 'chat').get('context_id') == 'chat_id' and not context_id:
            return JSONResponse({'error': 'A saved chat is required for this terminal'}, status_code=409)
        if context_id:
            headers[TERMINAL_CONTEXT_HEADER] = context_id
    cookies = getattr(request, 'cookies', {}) if connection.get('forward_cookies', False) else {}
    auth_type = connection.get('auth_type', 'bearer')

    if auth_type == 'bearer':
        headers.update(bearer_auth_header(connection.get('key', '')))
    elif auth_type == 'session':
        token = getattr(getattr(request.state, 'token', None), 'credentials', None) or request.cookies.get('token')
        if token:
            headers.update(bearer_auth_header(token))
    elif auth_type == 'system_oauth':
        # Resolve the token server-side from the caller's OAuth session; never trust a client header.
        oauth_token = None
        try:
            if request.cookies.get('oauth_session_id', None):
                oauth_token = await request.app.state.oauth_manager.get_oauth_token(
                    user.id,
                    request.cookies.get('oauth_session_id', None),
                )
        except Exception as e:
            log.error(f'Error getting OAuth token: {e}')
        if oauth_token:
            headers.update(bearer_auth_header(oauth_token.get('access_token', '')))
    # auth_type == "none": no Authorization header

    return connection, base_url, target_url, headers, cookies, session_id, context_id


# fork: registered before the catch-all proxy so these paths never reach the terminal.
@router.get('/{server_id}/cached-media')
@router.get('/{server_id}/chats/{chat_id}/cached-media')
async def cached_terminal_media(
    server_id: str,
    request: Request,
    path: str,
    prepare: bool = False,
    user=Depends(get_verified_user),
):
    """Play a terminal's audio/video with seeking: a local copy, served with byte ranges.

    ``prepare=true`` starts the copy and returns its progress as JSON; without it the
    response is the file (waiting for the copy if needed).
    """
    # Cookie-authenticated: only Open WebUI's own pages may start copies or read them.
    if request.headers.get('sec-fetch-site', 'same-origin') not in ('same-origin', 'none'):
        return JSONResponse({'error': 'Not allowed from another site'}, status_code=403)
    resolved = await _resolve_proxy_target(server_id, 'files/view', request, user)
    if isinstance(resolved, Response):
        return resolved
    _connection, base_url, _target, headers, cookies, session_id, context_id = resolved
    if not path.startswith('/') or '\x00' in path or len(path) > 4096:
        return JSONResponse({'error': 'Invalid path'}, status_code=400)
    key = terminal_media_cache.cache_key(
        user_id=user.id,
        server_id=server_id,
        base_url=base_url,
        context=context_id or '',
        session=session_id or '',
        path=path,
    )
    try:
        # A player that gives up stops waiting (and holding the entry) at once.
        entry = await _until_disconnect(
            request,
            terminal_media_cache.prepare(
                key=key,
                base_url=base_url,
                headers=headers,
                cookies=cookies,
                path=path,
                wait=not prepare,
                owner=user.id,
                lease=not prepare,
            ),
            None,
        )
    except terminal_media_cache.MediaCacheError as error:
        return JSONResponse({'error': str(error)}, status_code=error.status)
    except ClientDisconnect:
        return Response(status_code=499)
    except (aiohttp.ClientError, TimeoutError) as error:
        log.error('Terminal media cache error: %s', str(error) or type(error).__name__)
        return JSONResponse({'error': 'The terminal could not be reached'}, status_code=502)
    if prepare:
        return JSONResponse(terminal_media_cache.progress(entry), headers={'Cache-Control': 'no-store'})
    # prepare(lease=True) counted this reader; the response releases it however it ends
    # (seeking aborts requests all the time).
    try:
        return _LeasedFileResponse(
            entry.file,
            on_close=lambda: terminal_media_cache.release(entry),
            media_type=entry.media_type,
            headers=dict(terminal_media_cache.SECURITY_HEADERS),
            content_disposition_type='inline',
            filename=posixpath.basename(path),
        )
    except Exception:
        terminal_media_cache.release(entry)
        raise


class _LeasedFileResponse(FileResponse):
    def __init__(self, *args, on_close, **kwargs):
        super().__init__(*args, **kwargs)
        self._on_close = on_close

    async def __call__(self, scope, receive, send):
        # FileResponse keeps reading the file after the browser leaves (the server drops the
        # sends), which a seek does all the time: stop serving on the disconnect.
        async def disconnected():
            while (await receive())['type'] != 'http.disconnect':
                pass

        serve = asyncio.ensure_future(super().__call__(scope, receive, send))
        watch = asyncio.ensure_future(disconnected())
        try:
            done, _ = await asyncio.wait({serve, watch}, return_when=asyncio.FIRST_COMPLETED)
            if serve in done:
                serve.result()
        finally:
            for task in (serve, watch):
                if not task.done():
                    task.cancel()
                    try:
                        await task
                    except BaseException:
                        pass
            self._on_close()


@router.api_route('/{server_id}/{path:path}', methods=PROXY_METHODS)
# Register the chat route before the catch-all.
@router.api_route('/{server_id}/chats/{chat_id}/{path:path}', methods=PROXY_METHODS)
async def proxy_terminal(
    server_id: str,
    path: str,
    request: Request,
    user=Depends(get_verified_user),
):
    """Proxy a request to the admin terminal server identified by *server_id*."""
    resolved = await _resolve_proxy_target(server_id, path, request, user)
    if isinstance(resolved, Response):
        return resolved
    _connection, _base_url, target_url, headers, cookies, session_id, _context_id = resolved

    if request.query_params:
        target_url += f'?{request.query_params}'

    content_type = request.headers.get('content-type')
    if content_type:
        headers['Content-Type'] = content_type

    # fork: no total limit; a large download only fails when the terminal stops sending.
    session = aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=None, connect=10, sock_read=300),
        trust_env=True,
    )

    upstream_response = None
    try:
        body = await request.body()

        # fork: the wait for the terminal's headers has its own deadline and ends when the
        # browser leaves (the server does not cancel this handler on a disconnect).
        upstream_response = await _until_disconnect(
            request,
            session.request(
                method=request.method,
                url=target_url,
                headers=headers,
                cookies=cookies,
                data=body or None,
                ssl=AIOHTTP_CLIENT_SESSION_SSL,
                allow_redirects=False,
            ),
            HEADER_SECONDS,
        )

        # fork: only known-safe headers pass; a redirect stays inside this terminal's proxy path.
        filtered_headers = {}
        for key, value in upstream_response.headers.items():
            name = key.lower()
            if name not in FORWARDED_RESPONSE_HEADERS:
                continue
            if name == 'location':
                value = _proxy_location(value, request, server_id, path, session_id)
                if value is None:
                    continue
            filtered_headers[key] = value
        if TERMINAL_PROXY_HEADERS:
            filtered_headers.update(TERMINAL_PROXY_HEADERS)
        filtered_headers.update(SANDBOX_RESPONSE_HEADERS)

        # fork: stream every response (video, audio, archives, JSON too): nothing the sandbox
        # sends is held in memory here, and the length passes through so the browser can show
        # download progress. aiohttp decodes a compressed body, so the length is only kept
        # when the upstream sent it uncompressed.
        length = upstream_response.headers.get('content-length')
        if length and length.isdigit() and not upstream_response.headers.get('content-encoding'):
            filtered_headers['Content-Length'] = length

        response = _ClosingStreamingResponse(
            upstream_response,
            session,
            status_code=upstream_response.status,
            headers=filtered_headers,
        )
        upstream_response = None  # the response owns closing from here on
        return response

    except ClientDisconnect:
        await session.close()
        return Response(status_code=499)
    except (aiohttp.ClientConnectionError, TimeoutError) as error:
        await session.close()
        log.error('Terminal proxy error: %s', str(error) or type(error).__name__)
        return JSONResponse({'error': f'Terminal proxy error: {error}'}, status_code=502)
    except Exception as error:
        await session.close()
        log.exception('Terminal proxy error: %s', error)
        return JSONResponse({'error': f'Terminal proxy error: {error}'}, status_code=502)
    except BaseException:
        # Cancelled (the browser left) before a response existed: close here.
        if upstream_response is not None:
            upstream_response.release()
        await session.close()
        raise


HEADER_SECONDS = 300


async def _until_disconnect(request: Request, awaitable, deadline: float | None):
    """fork: await while the browser is still connected (checked every second) and, with a
    deadline, at most that long. A disconnect raises ClientDisconnect, a deadline TimeoutError;
    the work is cancelled either way."""
    task = asyncio.ensure_future(awaitable)
    loop = asyncio.get_running_loop()
    end = None if deadline is None else loop.time() + deadline
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=1)
            if done:
                return task.result()
            if await request.is_disconnected():
                raise ClientDisconnect()
            if end is not None and loop.time() > end:
                raise TimeoutError('The terminal did not answer in time')
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except BaseException:
                pass


class _ClosingStreamingResponse(StreamingResponse):
    """fork: streams an upstream response and always closes it and its session when the ASGI
    response ends: finished, failed while sending headers, or abandoned mid-body."""

    def __init__(self, upstream, session, **kwargs):
        super().__init__(content=upstream.content.iter_any(), **kwargs)
        self._upstream = upstream
        self._session = session

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._upstream.release()
            await asyncio.shield(self._session.close())


# ---------------------------------------------------------------------------
# WebSocket proxy for interactive terminal sessions
# ---------------------------------------------------------------------------


async def _resolve_authenticated_connection(ws: WebSocket, server_id: str):
    """Authenticate a WebSocket via first-message auth and resolve the terminal server.

    The client must send ``{"type": "auth", "token": "<jwt>"}`` as its first
    message after connecting.

    Returns ``(user, connection, chat_id, token)`` on success, or ``None`` after
    closing *ws* with an appropriate error code.
    """
    # First-message authentication
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10.0)
        payload = JSONCodec.loads(raw)
        if payload.get('type') != 'auth':
            await ws.close(code=4001, reason='Expected auth message')
            return None
        token = payload.get('token', '')
    except (TimeoutError, JSONCodec.JSONDecodeError):
        await ws.close(code=4001, reason='Auth timeout or invalid payload')
        return None
    except Exception:
        await ws.close(code=4001, reason='Invalid token')
        return None

    result = await _resolve_terminal_access(ws, server_id, token)
    if result is None:
        return None
    user, connection = result
    chat_id = payload.get('chat_id', '')
    return user, connection, chat_id if isinstance(chat_id, str) else '', token


async def _resolve_terminal_access(ws: WebSocket, server_id: str, token: str):
    """Resolve current access for both the handshake and an open terminal session."""
    if not ENABLE_TOOL_SERVERS:
        await ws.close(code=4003, reason='Tool servers are disabled')
        return None

    try:
        user = await get_verified_user_by_token(token, getattr(ws.app.state, 'redis', None))
        if user is None:
            await ws.close(code=4001, reason='Invalid token')
            return None
    except Exception:
        await ws.close(code=4001, reason='Invalid token')
        return None

    # Resolve terminal server
    connections = await Config.get('terminal_server.connections', []) or []
    connection = next((c for c in connections if c.get('id') == server_id), None)

    if connection is None:
        await ws.close(code=4004, reason='Terminal server not found')
        return None

    if not connection.get('enabled', True):
        await ws.close(code=4003, reason='Terminal server disabled')
        return None

    if not await has_connection_access(user, connection):
        await ws.close(code=4003, reason='Access denied')
        return None

    if not terminal_context_available(connection, 'chat'):
        await ws.close(code=4003, reason='Terminal server is not available in chats')
        return None
    return user, connection


@router.websocket('/{server_id}/api/terminals/{session_id}')
async def ws_terminal(
    ws: WebSocket,
    server_id: str,
    session_id: str,
):
    """Proxy an interactive WebSocket terminal session to a terminal server.

    Uses first-message auth: the client sends ``{"type": "auth", "token": "<jwt>"}``
    as its first message. The proxy validates the JWT, then connects to the
    upstream terminal server using the configured terminal auth mode.
    """
    await ws.accept()

    result = await _resolve_authenticated_connection(ws, server_id)
    if result is None:
        return
    user, connection, chat_id, token = result

    base_url = get_terminal_server_url(connection)
    if not base_url:
        await ws.close(code=4003, reason='Terminal server URL not configured')
        return

    # Build upstream WebSocket URL (no token in URL)
    ws_base = base_url.replace('https://', 'wss://').replace('http://', 'ws://')

    upstream_params = {}
    # For orchestrator-backed servers, pass user_id
    upstream_params['user_id'] = user.id
    context_id = terminal_context_id(connection, {'chat_id': chat_id}, 'chat')
    upstream_headers = {'X-User-Id': user.id, 'X-Session-Id': chat_id}
    if terminal_context_config(connection, 'chat').get('context_id') == 'chat_id' and not context_id:
        await ws.close(code=4003, reason='A saved chat is required for this terminal')
        return
    if context_id:
        upstream_headers[TERMINAL_CONTEXT_HEADER] = context_id

    import urllib.parse

    # Encode session_id as an opaque path segment so it cannot smuggle '?'/'#'/'&' (at any
    # decode depth) and inject an attacker-chosen user_id ahead of the one appended below.
    safe_session_id = urllib.parse.quote(session_id, safe='')

    upstream_url = f'{ws_base}/api/terminals/{safe_session_id}'
    if upstream_params:
        upstream_url += f'?{urllib.parse.urlencode(upstream_params)}'

    app = ws.scope.get('app')
    opened = False
    session = aiohttp.ClientSession()
    try:
        async with session.ws_connect(
            upstream_url,
            headers=upstream_headers,
            ssl=AIOHTTP_CLIENT_SESSION_SSL,
        ) as upstream:
            import json as _json

            # First-message auth to upstream terminal server
            auth_type = connection.get('auth_type', 'bearer')
            if auth_type == 'bearer':
                key = normalize_bearer_token(connection.get('key', ''))
                await upstream.send_str(_json.dumps({'type': 'auth', 'token': key}))
            elif auth_type == 'session' and is_terminal_orchestrator(connection):
                await upstream.send_str(_json.dumps({'type': 'auth', 'token': token}))
            else:
                await upstream.send_str(_json.dumps({'type': 'auth', 'token': ''}))

            await publish_event(
                app,
                EVENTS.TERMINAL_SESSION_OPENED,
                actor=user,
                subject_id=session_id,
                subject_type='terminal.session',
                data={'server_id': server_id},
            )
            opened = True

            async def _client_to_upstream():
                """Forward client → upstream."""
                try:
                    while True:
                        msg = await ws.receive()
                        if msg['type'] == 'websocket.disconnect':
                            break
                        elif 'bytes' in msg and msg['bytes']:
                            await upstream.send_bytes(msg['bytes'])
                        elif 'text' in msg and msg['text']:
                            await upstream.send_str(msg['text'])
                except Exception:
                    pass

            async def _upstream_to_client():
                """Forward upstream → client."""
                try:
                    async for msg in upstream:
                        if msg.type == aiohttp.WSMsgType.BINARY:
                            await ws.send_bytes(msg.data)
                        elif msg.type == aiohttp.WSMsgType.TEXT:
                            await ws.send_text(msg.data)
                        elif msg.type in (
                            aiohttp.WSMsgType.CLOSE,
                            aiohttp.WSMsgType.ERROR,
                        ):
                            break
                except Exception:
                    pass

            async def _watch_access():
                try:
                    while True:
                        # Poll current state so revocation also works across workers.
                        await asyncio.sleep(10)
                        if await _resolve_terminal_access(ws, server_id, token) is None:
                            return
                except Exception:
                    log.exception('Terminal access recheck failed')

            # End the proxy as soon as any task finishes (e.g. a
            # graceful upstream CLOSE) and cancel the rest, which would
            # otherwise hang on a blocked ws.receive() until the browser leaves.
            tasks = [
                asyncio.create_task(_client_to_upstream()),
                asyncio.create_task(_upstream_to_client()),
                asyncio.create_task(_watch_access()),
            ]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except Exception as e:
        log.exception('Terminal WebSocket proxy error: %s', e)
    finally:
        await session.close()
        if opened:
            await publish_event(
                app,
                EVENTS.TERMINAL_SESSION_CLOSED,
                actor=user,
                subject_id=session_id,
                subject_type='terminal.session',
                data={'server_id': server_id},
            )
        try:
            await ws.close()
        except Exception:
            pass
