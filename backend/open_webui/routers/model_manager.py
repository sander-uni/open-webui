"""Fork addition: Admin Settings > Model Manager.

Proxies the local model manager's admin API (modelmgr, started by start_webui.sh) for the
admin settings page and the chat model picker.
Kept in its own file so upstream merges only touch two lines in main.py.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from urllib.parse import quote

import aiohttp
from fastapi import APIRouter, Depends, HTTPException, Request
from open_webui.utils.auth import get_admin_user, get_verified_user

log = logging.getLogger(__name__)

router = APIRouter()

MODEL_MANAGER_URL = os.environ.get('MODEL_MANAGER_URL', 'http://127.0.0.1:8099').rstrip('/')
_TIMEOUT = aiohttp.ClientTimeout(total=30)
# Cancel/Unload wait for the engine stop plus its port and RAM release (Strata: minutes).
# Status calls keep the short budget.
try:
    _OPERATION_S = float(os.environ.get('MODEL_MANAGER_OPERATION_TIMEOUT_S') or 600)
except ValueError:
    log.warning('MODEL_MANAGER_OPERATION_TIMEOUT_S is not a number; using 600')
    _OPERATION_S = 600.0
_OPERATION_TIMEOUT = aiohttp.ClientTimeout(total=_OPERATION_S, sock_connect=10)
_SLOW_PATHS = ('/mm/cancel', '/mm/unload')


async def _call(method: str, path: str, body: dict | None = None) -> Any:
    try:
        timeout = _OPERATION_TIMEOUT if path in _SLOW_PATHS else _TIMEOUT
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as session:
            async with session.request(method, f'{MODEL_MANAGER_URL}{path}', json=body) as resp:
                try:
                    data = await resp.json(content_type=None)
                except Exception:
                    data = {'error': {'message': (await resp.text())[:500]}}
                if resp.status >= 400:
                    message = (data.get('error') or {}).get('message') if isinstance(data, dict) else None
                    raise HTTPException(status_code=resp.status, detail=message or f'HTTP {resp.status}')
                return data
    except HTTPException:
        raise
    except (aiohttp.ClientError, TimeoutError) as e:
        log.warning('model manager at %s not reachable for %s: %r', MODEL_MANAGER_URL, path, e)
        raise HTTPException(
            status_code=503,
            detail='The model service is not reachable. Check your connection and try again in a minute. '
            'If this continues, ask the admin to check the launcher in Admin Settings > Model Manager.',
        )


@router.get('/status')
async def get_status(user=Depends(get_admin_user)):
    return await _call('GET', '/mm/status')


@router.get('/state')
async def get_state(user=Depends(get_verified_user)):
    """Small state for the chat model picker (any signed-in user): which local model is loaded or
    loading, and which model ids the manager handles."""
    return await _call('GET', '/mm/state')


# Temporary chats are never saved; their ids name a browser session (utils/chatId.ts).
_TEMPORARY_PREFIXES = ('temporary:', 'local:')


@router.get('/chat-stats/{chat_id}')
async def get_chat_stats(chat_id: str, user=Depends(get_verified_user)):
    """0.3.2: speed and context figures of one chat, for the chat input. The chat's owner and
    admins only; the manager keeps them per chat id."""
    if user.role != 'admin' and not chat_id.startswith(_TEMPORARY_PREFIXES):
        from open_webui.models.chats import Chats  # here, so this router imports on its own

        if await Chats.get_chat_by_id_and_user_id(chat_id, user.id) is None:
            raise HTTPException(status_code=404, detail='Chat not found')
    return await _call('GET', f'/mm/chat-stats?chat_id={quote(chat_id, safe="")}')


@router.post('/load')
async def load_model(request: Request, user=Depends(get_admin_user)):
    return await _call('POST', '/mm/load', await request.json())


@router.post('/cancel')
async def cancel_load(user=Depends(get_admin_user)):
    return await _call('POST', '/mm/cancel', {})


@router.post('/unload')
async def unload_model(request: Request, user=Depends(get_admin_user)):
    return await _call('POST', '/mm/unload', await request.json())


@router.post('/pin')
async def pin_model(request: Request, user=Depends(get_admin_user)):
    return await _call('POST', '/mm/pin', await request.json())


@router.post('/settings')
async def save_settings(request: Request, user=Depends(get_admin_user)):
    return await _call('POST', '/mm/settings', await request.json())


@router.get('/filter')
async def get_filter(user=Depends(get_admin_user)):
    """The loading-status filter function from earlier versions of this page is retired: a reply
    that waits for its model now shows the manager's progress itself, and the filter's pre-load
    (a separate short request) could let another chat swap the model out before the real request
    ran. The page offers to remove the installed function with this id."""
    return {'id': FILTER_ID, 'retired': True}


FILTER_ID = 'model_manager_status'
