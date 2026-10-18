"""Fork addition: Admin Settings > Model Manager.

Proxies the local model manager's admin API (modelmgr, started by start_webui.sh) for the
admin settings page and the chat model picker.
Kept in its own file so upstream merges only touch two lines in main.py.
"""

from __future__ import annotations

import logging
import os
import re
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


def _error_message(data: Any) -> str | None:
    """The readable message of a service error body, whatever its shape (0.3.5: a string or a
    malformed `error` no longer raises)."""
    if not isinstance(data, dict):
        return None
    error = data.get('error')
    if isinstance(error, dict):
        error = error.get('message')
    if isinstance(error, str) and error.strip():
        return error.strip()[:500]
    detail = data.get('detail')
    return detail.strip()[:500] if isinstance(detail, str) and detail.strip() else None


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
                    raise HTTPException(status_code=resp.status, detail=_error_message(data) or f'HTTP {resp.status}')
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


def _temporary_chat_owner(chat_id: str) -> str | None:
    """0.3.5: the user whose browser session a temporary chat id names (upstream's own check for
    temporary chats, as in /api/tasks/chat/{id}); None when that session is unknown."""
    try:
        from open_webui.socket.main import get_user_id_from_session_pool
        from open_webui.utils.chat_id import get_temporary_chat_session_id
    except Exception:  # pragma: no cover - always present in Open WebUI
        return None
    session_id = get_temporary_chat_session_id(chat_id)
    return get_user_id_from_session_pool(session_id) if session_id else None


@router.get('/chat-stats/{chat_id}')
async def get_chat_stats(chat_id: str, user=Depends(get_verified_user)):
    """0.3.2: speed and context figures of one chat, for the chat input. The chat's owner and
    admins only; the manager keeps them per chat id."""
    if user.role != 'admin':
        if chat_id.startswith(_TEMPORARY_PREFIXES):
            # 0.3.5: a temporary chat is its owner's browser session, not anyone's (review C1)
            if _temporary_chat_owner(chat_id) != user.id:
                raise HTTPException(status_code=404, detail='Chat not found')
        else:
            from open_webui.models.chats import Chats  # here, so this router imports on its own

            if await Chats.get_chat_by_id_and_user_id(chat_id, user.id) is None:
                raise HTTPException(status_code=404, detail='Chat not found')
    return await _call('GET', f'/mm/chat-stats?chat_id={quote(chat_id, safe="")}')


# fork 0.3.4: the notes ctxproxy gave the model when it compacted a chat ("View summary").
CTXPROXY_URL = os.environ.get('CTXPROXY_URL', 'http://127.0.0.1:8100').rstrip('/')
_COMPACTION_TYPE = 'open_webui:ctxproxy_compaction'  # utils/compaction_steps.py
_CONV_KEY = re.compile(r'^[0-9a-f]{1,64}$')


def _compaction_key(output, n: int) -> str | None:
    """The ctxproxy conversation key of compaction #n in a stored reply's output."""
    for item in reversed(output if isinstance(output, list) else []):
        if isinstance(item, dict) and item.get('type') == _COMPACTION_TYPE and item.get('n') == n:
            conv = item.get('conv')
            if isinstance(conv, str) and _CONV_KEY.match(conv):
                return conv
    return None


@router.get('/compactions/{chat_id}/{message_id}/{n}')
async def get_compaction(chat_id: str, message_id: str, n: int, conv: str = '', user=Depends(get_verified_user)):
    """The note the model received in place of the steps compaction #n replaced, exactly as sent.
    The chat's owner and admins only. The conversation key comes from the stored reply (ctxproxy
    reported it when it compacted). Temporary chats are never stored: the key the browser passes
    must be one this server recorded for that user and chat when the compaction happened (0.3.5,
    review C1: before, any well-formed key was accepted)."""
    if chat_id.startswith(_TEMPORARY_PREFIXES):
        from open_webui.utils.compaction_steps import temporary_key_allowed

        key = conv if _CONV_KEY.match(conv) and temporary_key_allowed(user.id, chat_id, conv) else None
    else:
        from open_webui.models.chats import Chats  # here, so this router imports on its own

        if user.role != 'admin' and await Chats.get_chat_by_id_and_user_id(chat_id, user.id) is None:
            raise HTTPException(status_code=404, detail='Chat not found')
        message = await Chats.get_message_by_id_and_message_id(chat_id, message_id)
        key = _compaction_key((message or {}).get('output'), n)
    if not key:
        raise HTTPException(status_code=404, detail=f'This reply has no compaction #{n}.')
    try:
        async with aiohttp.ClientSession(timeout=_TIMEOUT, trust_env=False) as session:
            async with session.get(f'{CTXPROXY_URL}/proxy/compactions', params={'conv': key, 'n': str(n)}) as resp:
                data = await resp.json(content_type=None)
                status = resp.status
    except (aiohttp.ClientError, TimeoutError, ValueError) as e:
        log.warning('ctxproxy at %s not reachable for compaction %s: %r', CTXPROXY_URL, n, e)
        raise HTTPException(
            status_code=503,
            detail='The context proxy is not reachable, so the summary cannot be shown right now. '
            'Try again in a minute; if this continues, ask the admin to check the launcher.',
        )
    if status >= 400 or not isinstance(data, dict) or not isinstance(data.get('note'), str):
        raise HTTPException(status_code=404, detail=_error_message(data) or f'Compaction #{n} is no longer stored.')
    return {'n': n, 'note': data['note'], 'created': data.get('created')}


@router.post('/load')
async def load_model(request: Request, user=Depends(get_admin_user)):
    return await _call('POST', '/mm/load', await request.json())


@router.post('/cancel')
async def cancel_load(request: Request, user=Depends(get_admin_user)):
    # 0.3.5 (review C14): {"model": id} cancels only that preparation
    try:
        body = await request.json()
    except Exception:
        body = {}
    return await _call('POST', '/mm/cancel', body if isinstance(body, dict) else {})


@router.post('/unload')
async def unload_model(request: Request, user=Depends(get_admin_user)):
    return await _call('POST', '/mm/unload', await request.json())


@router.post('/pin')
async def pin_model(request: Request, user=Depends(get_admin_user)):
    return await _call('POST', '/mm/pin', await request.json())


@router.post('/visibility')
async def set_visibility(request: Request, user=Depends(get_admin_user)):
    """0.3.5 (review C15): show or hide a model in the picker by changing only its live `hidden`
    flag, in one transaction that fails on a concurrent edit, instead of writing back a whole
    model configuration read earlier. Upstream keeps `hidden` out of model history as well.
    {"exists": false} when the model has no saved settings yet (the page then creates them)."""
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict) or not isinstance(body.get('id'), str) or not isinstance(body.get('hidden'), bool):
        raise HTTPException(status_code=400, detail='Send {"id": "<model id>", "hidden": true|false}.')
    import time

    from open_webui.internal.db import get_async_db_context
    from open_webui.models.models import Model
    from sqlalchemy import select, update

    for _attempt in range(3):
        async with get_async_db_context() as session:
            current = (await session.execute(select(Model).filter_by(id=body['id']))).scalar_one_or_none()
            if current is None:
                return {'exists': False}
            meta = dict(current.meta or {})
            meta['hidden'] = body['hidden']
            result = await session.execute(
                update(Model)
                .where(Model.id == current.id, Model.version_id == current.version_id)
                .values(meta=meta, updated_at=int(time.time()))
                .execution_options(synchronize_session=False)
            )
            if result.rowcount == 1:
                await session.commit()
                return {'exists': True, 'hidden': body['hidden']}
            await session.rollback()
    raise HTTPException(status_code=409, detail='The model was being changed at the same moment. Try again.')


@router.post('/settings')
async def save_settings(request: Request, user=Depends(get_admin_user)):
    return await _call('POST', '/mm/settings', await request.json())


@router.get('/miner')
async def get_miner(user=Depends(get_admin_user)):
    """fork 0.3.7: Admin Settings > Miner (the Windows and the toolbox miner, and their settings)."""
    return await _call('GET', '/mm/miner')


@router.get('/filter')
async def get_filter(user=Depends(get_admin_user)):
    """The loading-status filter function from earlier versions of this page is retired: a reply
    that waits for its model now shows the manager's progress itself, and the filter's pre-load
    (a separate short request) could let another chat swap the model out before the real request
    ran. The page offers to remove the installed function with this id."""
    return {'id': FILTER_ID, 'retired': True}


FILTER_ID = 'model_manager_status'
