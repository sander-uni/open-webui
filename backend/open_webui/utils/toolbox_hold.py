"""Fork 0.3.7: hold the toolbox PC's miner while one of its GPU tools (Blender MCP) runs.

Before every MCP tool call Open WebUI asks the local model manager (modelmgr) whether that tool
server is one of the GPU tools listed in Admin Settings > Miner. If it is, modelmgr pauses the
toolbox's miner first and the call waits for that; if the miner can't be paused, the call is not
made and the agent gets modelmgr's message instead (why, stop, ask the user). Calls to every
other tool server go ahead at once.

Kept in its own file so upstream merges only touch a few lines in middleware.py.
"""

from __future__ import annotations

import contextlib
import logging
import os

import aiohttp

from open_webui.models.config import Config

log = logging.getLogger(__name__)

MODEL_MANAGER_URL = os.environ.get('MODEL_MANAGER_URL', 'http://127.0.0.1:8099').rstrip('/')
# modelmgr waits up to MODELMGR_TOOLBOX_WAIT_S (30 s) for the toolbox, plus the SSH connect.
_BEGIN_TIMEOUT = aiohttp.ClientTimeout(total=90, sock_connect=5)
_END_TIMEOUT = aiohttp.ClientTimeout(total=10, sock_connect=5)

# Tool servers modelmgr said count. If modelmgr is unreachable, these still fail closed;
# a server it never counted goes ahead (no local model answers without modelmgr anyway).
_counted: set[str] = set()


class ToolboxHoldRefused(Exception):
    """The tool was not run; the message is meant for the agent."""


def _key(url: str) -> str:
    return (url or '').strip().rstrip('/').lower()


async def _server_url(server_id: str) -> str:
    for connection in await Config.get('tool_server.connections', []):
        if connection.get('type', '') == 'mcp' and (connection.get('info') or {}).get('id') == server_id:
            return connection.get('url', '') or ''
    return ''


async def _post(path: str, body: dict, timeout: aiohttp.ClientTimeout) -> tuple[int, dict]:
    async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
        async with session.post(f'{MODEL_MANAGER_URL}{path}', json=body) as resp:
            try:
                data = await resp.json(content_type=None)
            except Exception:
                data = {}
            return resp.status, data if isinstance(data, dict) else {}


@contextlib.asynccontextmanager
async def toolbox_hold(server_id: str, tool: str, chat_id: str | None):
    url = await _server_url(server_id)
    if not url:
        yield
        return
    call = None
    try:
        status, data = await _post(
            '/mm/toolbox/begin', {'url': url, 'tool': tool, 'chat_id': chat_id or ''}, _BEGIN_TIMEOUT
        )
    except (aiohttp.ClientError, TimeoutError) as e:
        if _key(url) in _counted:
            log.warning('model manager not reachable to pause the toolbox miner for %s: %r', tool, e)
            raise ToolboxHoldRefused(
                'This tool was not run. The model manager, which pauses the background GPU job on the '
                'toolbox PC before this tool may use its graphics card, is not reachable. Stop working on '
                'this task and ask the user to check that start_webui.sh is running (Admin Settings > '
                'Miner). Do not call this tool again until the user says it is fixed.'
            )
        yield
        return
    error = data.get('error') if isinstance(data.get('error'), dict) else {}
    if status >= 400 and error.get('code') == 'toolbox_hold_failed':
        _counted.add(_key(url))
        raise ToolboxHoldRefused(
            error.get('message')
            or 'This tool was not run: the background GPU job on the toolbox PC could not be paused. '
            'Stop working on this task and ask the user to sort it out.'
        )
    if status >= 400:
        # Not an answer from the toolbox hold (a modelmgr older than 0.3.7, say): only a server
        # that counted before fails closed.
        log.warning('unexpected answer %s from the model manager for %s: %r', status, tool, data)
        if _key(url) in _counted:
            raise ToolboxHoldRefused(
                'This tool was not run. The model manager did not confirm that the background GPU job '
                'on the toolbox PC is paused. Stop working on this task and ask the user to check '
                'Admin Settings > Miner. Do not call this tool again until the user says it is fixed.'
            )
        yield
        return
    if data.get('counted'):
        _counted.add(_key(url))
        call = data.get('call')
    else:
        _counted.discard(_key(url))
    try:
        yield
    finally:
        if call:
            try:
                await _post('/mm/toolbox/end', {'call': call}, _END_TIMEOUT)
            except (aiohttp.ClientError, TimeoutError) as e:
                # modelmgr expires a call that never ends; the miner just stays off longer.
                log.warning('could not tell the model manager that %s ended: %r', tool, e)
