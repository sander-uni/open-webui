"""Fork 0.3.6: Admin Settings > Context Proxy and > Run Logger.

Every setting of ctxproxy and agentlog, changed from Open WebUI:
- Their own settings are read and written by the services themselves (GET/PUT /proxy/settings and
  /agentlog/settings). They write ctxproxy.env / agentlog.env, keeping comments, and apply the change
  from the next request. This router only relays (admins only).
- On/off, listen host and port belong to the launcher (start_webui.sh reads them from
  openwebui/.runtime.env). They apply at the next stack start; this router edits that file directly
  (stack_envfile keeps everything else in it), and when they change which address Open WebUI must use
  for the model, it notes the switch so the next start updates Open WebUI's connection by itself
  (`apply_connection_switch`, called once at startup).

Kept in its own file so upstream merges only touch main.py's include and one startup line.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import tempfile
import logging
import os
import re
from typing import Any

import aiohttp
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from open_webui.utils import stack_envfile as envfile
from open_webui.utils.auth import get_admin_user

log = logging.getLogger(__name__)
router = APIRouter()

_TIMEOUT = aiohttp.ClientTimeout(total=20)
TRUE = ('1', 'true', 'yes', 'on')

SERVICES = {
    'ctxproxy': {
        'name': 'Context proxy',
        'url': lambda: os.environ.get('CTXPROXY_URL', 'http://127.0.0.1:8100').rstrip('/'),
        'path': '/proxy/settings',
    },
    'agentlog': {
        'name': 'Run logger',
        'url': lambda: os.environ.get('AGENTLOG_URL', 'http://127.0.0.1:8098').rstrip('/'),
        'path': '/agentlog/settings',
    },
}

# The launcher's own settings for each service (openwebui/.runtime.env), with the launcher's defaults.
RUNTIME = {
    'ctxproxy': [
        dict(key='PROXY_ENABLED', label='Context proxy', kind='bool', default='1',
             help='Run the context proxy between Open WebUI and the model manager. Off: requests go straight to the '
             'model manager (no shaping, compaction or budget notes), and the run logger is off too (it needs the '
             'proxy). Open WebUI\'s model connection is switched for you at the next start.'),
        dict(key='PROXY_HOST', label='Listen address', kind='host', default='127.0.0.1', replaces='CTXPROXY_HOST',
             help='The local address ctxproxy listens on (127.0.0.1 or another 127.x address, or localhost). Only '
             'Open WebUI and the run logger talk to it, and its settings API has no login of its own.'),
        dict(key='PROXY_PORT', label='Port', kind='port', default='8100', replaces='CTXPROXY_PORT',
             help='The port ctxproxy listens on. Open WebUI\'s model connection is switched to it at the next start.'),
        dict(key='PROXY_LOG_MAX_MIB', label='Service log size', kind='int', default='50', min=1, unit='MiB',
             help='logs/ctxproxy.log is rotated at start once it is larger than this.'),
    ],
    'agentlog': [
        dict(key='AGENTLOG_ENABLED', label='Run logger', kind='bool', default='1',
             help='Run the run logger around the context proxy (it records every model call per run). Needs the '
             'context proxy. Open WebUI\'s model connection is switched for you at the next start.'),
        dict(key='AGENTLOG_HOST', label='Listen address', kind='host', default='127.0.0.1', replaces='AGENTLOG_HOST',
             help='The local address the run logger listens on (127.0.0.1 or another 127.x address, or localhost). '
             'Only Open WebUI and ctxproxy talk to it, and its settings API has no login of its own.'),
        dict(key='AGENTLOG_PORT', label='Port', kind='port', default='8098', replaces='AGENTLOG_PORT',
             help='The port the run logger listens on (tap A for Open WebUI, tap B for ctxproxy). Open WebUI\'s model '
             'connection is switched to it at the next start.'),
        dict(key='AGENTLOG_LOG_MAX_MIB', label='Service log size', kind='int', default='50', min=1, unit='MiB',
             help='logs/agentlog.log is rotated at start once it is larger than this.'),
    ],
}
RUNTIME_KEYS = {s['key']: s for specs in RUNTIME.values() for s in specs}


def _parse_pairs(raw: str) -> dict[str, str]:
    out = {}
    for part in raw.split(';'):
        if '=' in part:
            k, v = part.split('=', 1)
            out[k.strip()] = v.strip()
    return out


def launch_values() -> dict[str, str]:
    """What the running stack was started with (STACK_LAUNCH, exported by start_webui.sh 0.3.6)."""
    return _parse_pairs(os.environ.get('STACK_LAUNCH', ''))


def inherited_values() -> dict[str, str]:
    """What the launcher's own environment set before it read .runtime.env (STACK_INHERITED): the next
    start falls back to these, then to the launcher's defaults, when a line is removed (review R08)."""
    return _parse_pairs(os.environ.get('STACK_INHERITED', ''))


def runtime_file() -> str | None:
    return os.environ.get('STACK_RUNTIME_FILE') or None


def switch_file() -> str:
    from open_webui.env import DATA_DIR

    return os.path.join(str(DATA_DIR), 'stack-connection-switch.json')


def _saved_runtime() -> dict[str, str]:
    path = runtime_file()
    return envfile.parse(envfile.read(path)) if path else {}


def _value(values: dict, key: str, inherited: dict | None = None) -> str:
    """What the launcher will use at the next start for `key`: the file's value, else the launcher's own
    environment, else its default (exactly the launcher's `${KEY:-default}` after sourcing the file)."""
    if values.get(key, '') != '':
        return values[key]
    if inherited and inherited.get(key, '') != '':
        return inherited[key]
    return RUNTIME_KEYS[key]['default']


def model_api_url(values: dict, launch: dict, inherited: dict | None = None) -> str | None:
    """The address start_webui.sh gives Open WebUI for the model, for these launcher values."""
    v = lambda key: _value(values, key, inherited)  # noqa: E731
    proxy_on = v('PROXY_ENABLED').lower() in TRUE
    agentlog_on = proxy_on and v('AGENTLOG_ENABLED').lower() in TRUE
    if agentlog_on:
        return f"http://{v('AGENTLOG_HOST')}:{v('AGENTLOG_PORT')}/a/v1"
    if proxy_on:
        return f"http://{v('PROXY_HOST')}:{v('PROXY_PORT')}/v1"
    mm = launch.get('MODELMGR_URL') or os.environ.get('MODEL_MANAGER_URL')
    return f'{mm.rstrip("/")}/v1' if mm else None


def _loopback(v: str) -> bool:
    if v == 'localhost':
        return True
    try:
        ip = ipaddress.ip_address(v)
    except ValueError:
        return False
    return ip.version == 4 and ip.is_loopback


def _check_runtime(key: str, value: str, nxt: dict, launch: dict) -> str | None:
    """Why `value` can't be the launcher's next-start value for `key`, given all next-start values `nxt`
    (the launcher's own rules, review R10)."""
    spec = RUNTIME_KEYS[key]
    v = value.strip()
    kind = spec['kind']
    if kind == 'bool':
        return None if v.lower() in TRUE + ('0', 'false', 'no', 'off') else 'use on or off'
    if kind in ('int', 'port'):
        if not re.fullmatch(r'[1-9][0-9]*', v):
            return 'a whole number without leading zeros'
        n = int(v)
        if kind == 'port':
            if not 1024 <= n <= 65535:
                return 'a port from 1024 to 65535'
            others = {name.lower(): launch.get(f'{name}_PORT')
                      for name in ('OPENWEBUI', 'NINFER', 'MODELMGR', 'RELAY', 'STRATA', 'OLLAMA')
                      if launch.get(f'{name}_PORT')}
            other_key, other_name = (('AGENTLOG_PORT', 'the run logger') if key == 'PROXY_PORT'
                                     else ('PROXY_PORT', 'the context proxy'))
            others[other_name] = nxt.get(other_key)
            for name, port in others.items():
                if port and re.fullmatch(r'\d+', str(port)) and int(port) == n:
                    return f'{n} is already used by {name}'
        elif n < spec.get('min', 0):
            return f"at least {spec['min']}"
        return None
    if kind == 'host':
        if not _loopback(v):
            return ('must be a local address: 127.0.0.1 (or another 127.x address) or localhost. Its settings '
                    'API has no login of its own, so it must not be reachable from the network.')
        return None
    return None


def _runtime_items(service: str) -> list[dict]:
    saved, launch, inherited = _saved_runtime(), launch_values(), inherited_values()
    items = []
    for spec in RUNTIME[service]:
        k = spec['key']
        value = _value(saved, k, inherited)
        running = launch.get(k)
        source = 'file' if saved.get(k, '') != '' else 'environment' if inherited.get(k, '') != '' else 'default'
        item = {key: spec[key] for key in spec if key != 'replaces'}
        item.update(group='connection', apply='start', value=value, source=source,
                    in_file=k in saved, running=running,
                    pending=running is not None and value.strip().lower() != running.strip().lower())
        items.append(item)
    return items


async def _relay(service: str, method: str, body: dict | None = None) -> tuple[int, Any]:
    svc = SERVICES[service]
    url = svc['url']() + svc['path']
    try:
        async with aiohttp.ClientSession(timeout=_TIMEOUT, trust_env=False) as session:
            async with session.request(method, url, json=body) as resp:
                try:
                    data = await resp.json(content_type=None)
                except Exception:
                    data = {'error': {'message': (await resp.text())[:500]}}
                return resp.status, data
    except (aiohttp.ClientError, TimeoutError) as e:
        log.info('%s settings at %s not reachable: %r', service, url, e)
        return 503, None


def _merge(service: str, status: int, data: Any) -> dict:
    """The service's own settings (if it runs) with the launcher's on/off, host and port in front."""
    runtime = _runtime_items(service)
    replaced = {s['replaces'] for s in RUNTIME[service] if s.get('replaces')}
    launch = launch_values()
    running = status == 200 and isinstance(data, dict)
    out = {
        'service': service,
        'name': SERVICES[service]['name'],
        'running': running,
        'runtime_file': runtime_file(),
        'restart_needed': any(i['pending'] for i in runtime) or bool(running and data.get('restart_needed')),
        'model_api_url': {'now': launch.get('MODEL_API_URL'),
                          'next': model_api_url(_saved_runtime(), launch, inherited_values())},
    }
    if running:
        settings = [s for s in data.get('settings', []) if s.get('key') not in replaced]
        out.update({k: data.get(k) for k in ('version', 'file', 'groups', 'ignored', 'error')})
        out['settings'] = runtime + settings
    else:
        out.update(version=None, file=None, ignored=[], error=None, settings=runtime,
                   groups=[{'id': 'connection', 'title': 'Connection',
                            'help': 'On/off, address, port and service log size apply at the next stack start.'}])
        if status != 503 and isinstance(data, dict):
            out['error'] = {'message': (data.get('error') or {}).get('message') if isinstance(data.get('error'), dict)
                            else 'The service answered with an error.'}
    return out


@router.get('/{service}')
async def get_settings(service: str, user=Depends(get_admin_user)):
    if service not in SERVICES:
        raise HTTPException(404, 'Unknown service')
    status, data = await _relay(service, 'GET')
    return _merge(service, status, data)


_SAVE_LOCK = asyncio.Lock()


def _writable(path: str) -> str | None:
    """None, or why `path` (a file, maybe not there yet) can't be replaced."""
    target = os.path.realpath(path)
    folder = os.path.dirname(target) or '.'
    if os.path.isdir(target):
        return f'{target} is a folder'
    if not os.access(folder, os.W_OK | os.X_OK):
        return f"can't write in {folder}"
    if os.path.exists(target) and not os.access(target, os.R_OK):
        return f"can't read {target}"
    return None


def _write_json_atomic(path: str, obj: dict) -> None:
    folder = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix='.stack-switch.', dir=folder)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(obj, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


@router.put('/{service}')
async def put_settings(service: str, request: Request, user=Depends(get_admin_user)):
    """{"changes": {"KEY": "value" | null}, "remove_lines": ["KEY", ...]}. null = back to the default (removes
    the line). remove_lines removes lines the service doesn't use from the service's own file (agentlog.env
    repeats AGENTLOG_HOST/PORT, which here otherwise mean the launcher's settings).
    Saves are serialized; both local files are checked before anything is written (review R09)."""
    if service not in SERVICES:
        raise HTTPException(404, 'Unknown service')
    try:
        body = await request.json()
        changes = body.get('changes') or {}
        remove_lines = body.get('remove_lines') or []
        assert isinstance(changes, dict) and all(isinstance(k, str) for k in changes)
        assert isinstance(remove_lines, list) and all(isinstance(k, str) for k in remove_lines)
    except Exception:
        raise HTTPException(400, 'expected {"changes": {...}}')
    async with _SAVE_LOCK:
        return await _save(service, changes, remove_lines)


async def _save(service: str, changes: dict, remove_lines: list) -> Any:
    own_runtime = {s['key'] for s in RUNTIME[service]}
    runtime_changes = {k: v for k, v in changes.items() if k in own_runtime}
    service_changes = {k: v for k, v in changes.items() if k not in own_runtime}
    service_changes.update({k: None for k in remove_lines})
    for k, v in list(runtime_changes.items()):
        if v is not None and not isinstance(v, str):
            runtime_changes[k] = '1' if v is True else '0' if v is False else str(v)

    errors: dict[str, str] = {}
    path = runtime_file()
    saved, launch, inherited = _saved_runtime(), launch_values(), inherited_values()
    if runtime_changes and not path:
        errors.update({k: 'the launcher did not say where its settings file is (start the stack with start_webui.sh '
                       '0.3.6 or later)' for k in runtime_changes})
    # canonical values (a port without leading zeros etc.), then every next-start value checked as the
    # launcher will see it, resets included
    clean: dict[str, str | None] = {}
    for k, v in runtime_changes.items():
        if v is None:
            clean[k] = None
            continue
        msg = envfile.check_value(v)
        if msg:
            errors[k] = msg
            continue
        v = v.strip()
        if RUNTIME_KEYS[k]['kind'] == 'bool':
            v = '1' if v.lower() in TRUE else '0' if v.lower() in ('0', 'false', 'no', 'off') else v
        clean[k] = v
    after = {**saved, **{k: v for k, v in clean.items() if v is not None}}
    for k, v in clean.items():
        if v is None:
            after.pop(k, None)
    nxt = {k: _value(after, k, inherited) for k in RUNTIME_KEYS}
    if not errors:
        for k in clean:
            msg = _check_runtime(k, nxt[k], nxt, launch)
            if msg:
                errors[k] = msg if clean[k] is not None else f'back to {nxt[k]}: {msg}'
    switch = None
    if not errors and clean:
        now, to = launch.get('MODEL_API_URL'), model_api_url(after, launch, inherited)
        switch = (now, to) if now and to and now != to else None
        problem = _writable(path)
        if not problem and (switch or os.path.exists(switch_file())):
            problem = _writable(switch_file())
        if problem:
            errors.update({k: f'not saved: {problem}' for k in clean})
    if errors:
        return JSONResponse({'errors': errors}, 422)

    if service_changes:
        status, data = await _relay(service, 'PUT', {'changes': service_changes})
        if status == 422 and isinstance(data, dict):
            return JSONResponse({'errors': data.get('errors') or {}}, 422)
        if status == 503:
            return JSONResponse({'errors': {k: f"{SERVICES[service]['name']} isn't running; only on/off, address and "
                                            'port can be changed now' for k in service_changes}}, 422)
        if status != 200:
            raise HTTPException(502, f"{SERVICES[service]['name']} refused the change (HTTP {status}).")

    if clean:
        try:
            text = envfile.read(path)
            new_text = envfile.edit(text, clean)
            if new_text != text:
                envfile.write(path, new_text)
        except (OSError, ValueError) as e:
            saved_keys = sorted(service_changes)
            return JSONResponse({'errors': {k: f'not saved: {e}' for k in clean},
                                 'partial': {'saved': saved_keys}}, 500 if saved_keys else 422)
        try:
            if switch:
                _write_json_atomic(switch_file(), {'from': switch[0], 'to': switch[1]})
            else:
                os.unlink(switch_file())
        except FileNotFoundError:
            pass
        except OSError as e:
            log.error('could not note the model connection switch: %r', e)
            return JSONResponse({'errors': {k: f'saved, but the connection switch for the next start could not be '
                                            f'noted ({e}); set Admin Settings > Connections after the restart'
                                            for k in clean}, 'partial': {'saved': sorted(clean) + sorted(service_changes)}},
                                500)

    status, data = await _relay(service, 'GET')
    return _merge(service, status, data)


async def apply_connection_switch() -> None:
    """At startup: once the stack runs the new layout (STACK_LAUNCH says so), replace the old stack address
    in Open WebUI's saved model connections with the new one. Every saved connection with exactly the old
    address is switched (they all point at the stack, which no longer listens there); their keys and
    per-connection settings stay. Without launcher information the note waits (review R11). Never raises."""
    try:
        path = switch_file()
        if not os.path.exists(path):
            return
        try:
            with open(path, encoding='utf-8') as f:
                note = json.load(f)
            old = note['from']
            assert isinstance(old, str)
        except (OSError, ValueError, KeyError, AssertionError, TypeError):
            log.error('the model connection switch note %s is unreadable; removed. Check Admin Settings > '
                      'Connections.', path)
            os.unlink(path)
            return
        target = launch_values().get('MODEL_API_URL')
        if not target or target == old:
            return          # no launcher information, or the stack hasn't restarted with the new layout yet
        from open_webui.models.config import Config

        urls = (await Config.get('openai.api_base_urls')) or []
        if old in urls:
            new_urls = [target if u == old else u for u in urls]
            await Config.upsert({'openai.api_base_urls': new_urls})
            log.info('model connection switched from %s to %s (Run Logger / Context Proxy settings)', old, target)
        os.unlink(path)
    except Exception:
        log.exception('could not switch the model connection; set it in Admin Settings > Connections')
