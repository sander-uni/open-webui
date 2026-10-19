"""Fork 0.3.8: hold the toolbox PC's miner while an agent run uses the toolbox's tools.

The first call of an agent run to a toolbox tool server (Blender MCP, and whatever else is listed
in Admin Settings > Miner) asks the local model manager (modelmgr) to pause the toolbox miner and
waits until the toolbox confirmed it; if it can't, the call is not made and the agent gets the
reason and is told to stop and ask the user. The pause lasts until the run is over:
toolbox_run_end() (main.py, after every run) tells modelmgr, and while runs hold the miner they
are reported to modelmgr every 30 s, so a crashed Open WebUI lets go after 2 minutes.

Which servers are toolbox tools is modelmgr's list. This file keeps a copy of it on disk
(DATA_DIR/toolbox_tools.json, refreshed from every modelmgr answer), so the decision never waits
for modelmgr: calls to any other server (the file relay, web search) go ahead at once, and a
toolbox call fails closed even when modelmgr is down. Servers compare by scheme, host and port.

Kept in its own file so upstream merges only touch a few lines in middleware.py and main.py.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import uuid
from urllib.parse import urlsplit

import aiohttp

from open_webui.models.config import Config

log = logging.getLogger(__name__)

MODEL_MANAGER_URL = os.environ.get('MODEL_MANAGER_URL', 'http://127.0.0.1:8099').rstrip('/')
# modelmgr waits up to MODELMGR_TOOLBOX_WAIT_S (30 s) for the toolbox, plus the SSH connect.
_BEGIN_TIMEOUT = aiohttp.ClientTimeout(total=90, sock_connect=5)
_SHORT_TIMEOUT = aiohttp.ClientTimeout(total=10, sock_connect=5)
BEAT_S = 30
# Until modelmgr has answered once: the Blender MCP on the toolbox.
DEFAULT_TOOLS = ['http://192.168.10.52:8000']


def _cache_path() -> str:
    if os.environ.get('TOOLBOX_TOOLS_CACHE'):
        return os.environ['TOOLBOX_TOOLS_CACHE']
    try:
        from open_webui.env import DATA_DIR

        data_dir = str(DATA_DIR)
    except Exception:
        data_dir = os.environ.get('DATA_DIR', '.')
    return os.path.join(data_dir, 'toolbox_tools.json')


_tools: list[str] | None = None
_runs: set[str] = set()
_beat_task: asyncio.Task | None = None

REFUSED_UNREACHABLE = (
    'This tool was not run. It uses the toolbox PC, whose background GPU job must be paused first, '
    'and the model manager that pauses it is not reachable. Stop working on this task and ask the '
    'user to check that start_webui.sh is running (Admin Settings > Miner). Do not call this tool '
    'again until the user says it is fixed.'
)
REFUSED_UNCONFIRMED = (
    'This tool was not run. It uses the toolbox PC, and the model manager did not confirm that the '
    "toolbox's background GPU job is paused. Stop working on this task and ask the user to check "
    'Admin Settings > Miner. Do not call this tool again until the user says it is fixed.'
)


class ToolboxHoldRefused(Exception):
    """The tool was not run; the message is meant for the agent."""


def tool_origin(url: str) -> str:
    """Scheme, host and port (default port filled in): the path doesn't make another server."""
    try:
        parts = urlsplit(str(url or '').strip())
        port = parts.port
    except ValueError:
        return ''
    scheme = parts.scheme.lower()
    if scheme not in ('http', 'https') or not parts.hostname:
        return ''
    return f'{scheme}://{parts.hostname.lower()}:{port or (443 if scheme == "https" else 80)}'


def toolbox_tools() -> list[str]:
    global _tools
    if _tools is None:
        try:
            with open(_cache_path(), encoding='utf-8') as f:
                data = json.load(f)
            tools = data.get('tools') if isinstance(data, dict) else None
            _tools = [str(t) for t in tools] if isinstance(tools, list) else list(DEFAULT_TOOLS)
        except FileNotFoundError:
            _tools = list(DEFAULT_TOOLS)
        except (OSError, ValueError) as e:
            log.warning('toolbox tool list %s unreadable (%r); using the default', _cache_path(), e)
            _tools = list(DEFAULT_TOOLS)
    return _tools


def remember_tools(tools) -> None:
    """Keep modelmgr's current list (every answer carries it)."""
    global _tools
    if not isinstance(tools, list) or not all(isinstance(t, str) for t in tools):
        return
    if tools == toolbox_tools() and os.path.exists(_cache_path()):
        return
    _tools = list(tools)
    path = _cache_path()
    try:
        tmp = f'{path}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'tools': _tools}, f)
        os.replace(tmp, path)
    except OSError as e:
        log.warning('could not save the toolbox tool list to %s: %r', path, e)


def is_toolbox_tool(url: str) -> bool:
    key = tool_origin(url)
    return bool(key) and key in {tool_origin(t) for t in toolbox_tools()}


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


def _run_id(metadata: dict) -> str:
    run = metadata.get('toolbox_run')
    if not run:
        run = metadata['toolbox_run'] = uuid.uuid4().hex[:16]
    return run


async def _beat_loop() -> None:
    while _runs:
        await asyncio.sleep(BEAT_S)
        if not _runs:
            break
        try:
            _, data = await _post('/mm/toolbox/beat', {'runs': sorted(_runs)}, _SHORT_TIMEOUT)
            remember_tools(data.get('tools'))
        except Exception as e:
            log.warning('could not report the running toolbox runs to the model manager: %r', e)


@contextlib.asynccontextmanager
async def toolbox_hold(server_id: str, tool: str, metadata: dict):
    global _beat_task
    url = await _server_url(server_id)
    if not url or not is_toolbox_tool(url):
        yield
        return
    run = _run_id(metadata)
    try:
        status, data = await _post(
            '/mm/toolbox/begin',
            {'url': url, 'run': run, 'tool': tool, 'chat_id': metadata.get('chat_id') or ''},
            _BEGIN_TIMEOUT,
        )
    except Exception as e:
        log.warning('model manager not reachable to pause the toolbox miner for %s: %r', tool, e)
        raise ToolboxHoldRefused(REFUSED_UNREACHABLE)
    remember_tools(data.get('tools'))
    if status == 200 and data.get('counted') is False:
        # modelmgr: not a toolbox tool (any more), or the toolbox hold is switched off.
        yield
        return
    if status == 200 and data.get('counted') is True and data.get('state') == 'held':
        _runs.add(run)
        if _beat_task is None or _beat_task.done():
            _beat_task = asyncio.create_task(_beat_loop())
        yield
        return
    error = data.get('error') if isinstance(data.get('error'), dict) else {}
    log.warning('the model manager did not confirm the toolbox hold for %s: %s %r', tool, status, data)
    if error.get('code') == 'toolbox_hold_failed' and error.get('message'):
        raise ToolboxHoldRefused(str(error['message']))
    raise ToolboxHoldRefused(REFUSED_UNCONFIRMED)


async def toolbox_run_end(metadata: dict | None) -> None:
    """After every agent run (main.py): let the toolbox miner go if this run held it."""
    run = (metadata or {}).get('toolbox_run')
    if not run or run not in _runs:
        return
    _runs.discard(run)
    try:
        _, data = await _post('/mm/toolbox/end', {'run': run}, _SHORT_TIMEOUT)
        remember_tools(data.get('tools'))
    except BaseException as e:
        # Called from a cleanup block: never break the cleanup that follows (like the MCP client
        # cleanup there). modelmgr lets go by itself once this run is no longer reported (2 min).
        log.warning('could not tell the model manager that toolbox run %s is over: %r', run, e)
