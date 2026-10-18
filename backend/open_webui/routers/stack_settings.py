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

import ipaddress
import json
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
             help='The address ctxproxy listens on. Keep 127.0.0.1: only Open WebUI and the run logger talk to it.'),
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
             help='The address the run logger listens on. Must stay a local address (not 0.0.0.0): only Open WebUI '
             'and ctxproxy talk to it.'),
        dict(key='AGENTLOG_PORT', label='Port', kind='port', default='8098', replaces='AGENTLOG_PORT',
             help='The port the run logger listens on (tap A for Open WebUI, tap B for ctxproxy). Open WebUI\'s model '
             'connection is switched to it at the next start.'),
        dict(key='AGENTLOG_LOG_MAX_MIB', label='Service log size', kind='int', default='50', min=1, unit='MiB',
             help='logs/agentlog.log is rotated at start once it is larger than this.'),
    ],
}
RUNTIME_KEYS = {s['key']: s for specs in RUNTIME.values() for s in specs}


def launch_values() -> dict[str, str]:
    """What the running stack was started with (STACK_LAUNCH, exported by start_webui.sh 0.3.6)."""
    out = {}
    for part in os.environ.get('STACK_LAUNCH', '').split(';'):
        if '=' in part:
            k, v = part.split('=', 1)
            out[k.strip()] = v.strip()
    return out


def runtime_file() -> str | None:
    return os.environ.get('STACK_RUNTIME_FILE') or None


def switch_file() -> str:
    from open_webui.env import DATA_DIR

    return os.path.join(str(DATA_DIR), 'stack-connection-switch.json')


def _saved_runtime() -> dict[str, str]:
    path = runtime_file()
    return envfile.parse(envfile.read(path)) if path else {}


def _value(values: dict, key: str) -> str:
    return values[key] if key in values else RUNTIME_KEYS[key]['default']


def model_api_url(values: dict, launch: dict) -> str | None:
    """The address start_webui.sh gives Open WebUI for the model, for these launcher values."""
    proxy_on = _value(values, 'PROXY_ENABLED').lower() in TRUE
    agentlog_on = proxy_on and _value(values, 'AGENTLOG_ENABLED').lower() in TRUE
    if agentlog_on:
        return f"http://{_value(values, 'AGENTLOG_HOST')}:{_value(values, 'AGENTLOG_PORT')}/a/v1"
    if proxy_on:
        return f"http://{_value(values, 'PROXY_HOST')}:{_value(values, 'PROXY_PORT')}/v1"
    mm = launch.get('MODELMGR_URL') or os.environ.get('MODEL_MANAGER_URL')
    return f'{mm.rstrip("/")}/v1' if mm else None


def _check_runtime(key: str, value: str, merged: dict, launch: dict) -> str | None:
    spec = RUNTIME_KEYS[key]
    v = value.strip()
    kind = spec['kind']
    if kind == 'bool':
        return None if v.lower() in TRUE + ('0', 'false', 'no', 'off') else 'use on or off'
    if kind in ('int', 'port'):
        try:
            n = int(v)
        except ValueError:
            return 'a whole number'
        if kind == 'port':
            if not 1024 <= n <= 65535:
                return 'a port from 1024 to 65535'
            others = {
                name: launch.get(f'{name}_PORT')
                for name in ('OPENWEBUI', 'NINFER', 'MODELMGR', 'RELAY', 'STRATA', 'OLLAMA')
                if launch.get(f'{name}_PORT')
            }
            other_service = 'AGENTLOG_PORT' if key == 'PROXY_PORT' else 'PROXY_PORT'
            others['the other service'] = _value(merged, other_service)
            for name, port in others.items():
                if str(port) == str(n):
                    label = name.lower() if name != 'the other service' else (
                        'the run logger' if key == 'PROXY_PORT' else 'the context proxy')
                    return f'{n} is already used by {label}'
        elif n < spec.get('min', 0):
            return f"at least {spec['min']}"
        return None
    if kind == 'host':
        if v in ('0.0.0.0', '::') and key == 'AGENTLOG_HOST':
            return 'must be a local address such as 127.0.0.1 (the launcher refuses 0.0.0.0)'
        try:
            ipaddress.ip_address(v)
            return None
        except ValueError:
            return None if re.fullmatch(r'[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?', v) else 'an address like 127.0.0.1'
    return None


def _runtime_items(service: str) -> list[dict]:
    saved, launch = _saved_runtime(), launch_values()
    items = []
    for spec in RUNTIME[service]:
        k = spec['key']
        value = _value(saved, k)
        running = launch.get(k)
        item = {key: spec[key] for key in spec if key != 'replaces'}
        item.update(group='connection', apply='start', value=value, source='file' if k in saved else 'default',
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
    out = {
        'service': service,
        'name': SERVICES[service]['name'],
        'running': status == 200 and isinstance(data, dict),
        'runtime_file': runtime_file(),
        'restart_needed': any(i['pending'] for i in runtime),
        'model_api_url': {'now': launch.get('MODEL_API_URL'), 'next': model_api_url(_saved_runtime(), launch)},
    }
    if out['running']:
        settings = [s for s in data.get('settings', []) if s.get('key') not in replaced]
        out.update({k: data.get(k) for k in ('version', 'file', 'groups', 'ignored', 'error')})
        out['settings'] = runtime + settings
    else:
        out.update(version=None, file=None, ignored=[], error=None, settings=runtime,
                   groups=[{'id': 'connection', 'title': 'Connection',
                            'help': 'On/off, host and port apply at the next stack start.'}])
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


@router.put('/{service}')
async def put_settings(service: str, request: Request, user=Depends(get_admin_user)):
    """{"changes": {"KEY": "value" | null}, "remove_lines": ["KEY", ...]}. null = back to the default (removes
    the line). remove_lines removes lines the service doesn't use from the service's own file (agentlog.env
    repeats AGENTLOG_HOST/PORT, which here otherwise mean the launcher's settings)."""
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
    own_runtime = {s['key'] for s in RUNTIME[service]}
    runtime_changes = {k: v for k, v in changes.items() if k in own_runtime}
    service_changes = {k: v for k, v in changes.items() if k not in own_runtime}
    service_changes.update({k: None for k in remove_lines})
    for k, v in list(runtime_changes.items()):
        if v is not None and not isinstance(v, str):
            runtime_changes[k] = '1' if v is True else '0' if v is False else str(v)

    errors: dict[str, str] = {}
    path = runtime_file()
    if runtime_changes and not path:
        errors.update({k: 'the launcher did not say where its settings file is (start the stack with start_webui.sh '
                       '0.3.6 or later)' for k in runtime_changes})
    saved, launch = _saved_runtime(), launch_values()
    merged = {**saved, **{k: v for k, v in runtime_changes.items() if v is not None}}
    for k in runtime_changes:
        if runtime_changes[k] is None:
            merged.pop(k, None)
    if not errors:
        for k, v in runtime_changes.items():
            if v is not None:
                msg = _check_runtime(k, v, merged, launch)
                if msg:
                    errors[k] = msg
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

    if runtime_changes:
        for k, v in runtime_changes.items():
            if v is not None:
                spec = RUNTIME_KEYS[k]
                v = v.strip()
                runtime_changes[k] = ('1' if v.lower() in TRUE else '0') if spec['kind'] == 'bool' else v
        text = envfile.read(path)
        new_text = envfile.edit(text, runtime_changes)
        if new_text != text:
            envfile.write(path, new_text)
        _note_connection_switch(launch)

    status, data = await _relay(service, 'GET')
    return _merge(service, status, data)


def _note_connection_switch(launch: dict) -> None:
    """If the next start gives Open WebUI a different model address, remember the switch."""
    now = launch.get('MODEL_API_URL')
    nxt = model_api_url(_saved_runtime(), launch)
    path = switch_file()
    if not now or not nxt or now == nxt:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'from': now, 'to': nxt}, f)


async def apply_connection_switch() -> None:
    """At startup: replace the old stack address in Open WebUI's saved model connections with the one the
    launcher uses now. Only that entry changes (its key and settings stay). Never raises."""
    try:
        path = switch_file()
        if not os.path.exists(path):
            return
        with open(path, encoding='utf-8') as f:
            note = json.load(f)
        target = launch_values().get('MODEL_API_URL') or note.get('to')
        old = note.get('from')
        if not old or not target or target == old:
            return          # the stack hasn't been restarted with the new layout yet: keep the note
        from open_webui.models.config import Config

        urls = (await Config.get('openai.api_base_urls')) or []
        if old in urls:
            new_urls = [target if u == old else u for u in urls]
            await Config.upsert({'openai.api_base_urls': new_urls})
            log.info('model connection switched from %s to %s (Run Logger / Context Proxy settings)', old, target)
        os.unlink(path)
    except Exception:
        log.exception('could not switch the model connection; set it in Admin Settings > Connections')
