"""Fork addition: Admin Settings > Model Manager.

Proxies the local model manager's admin API (modelmgr, started by start_webui.sh) for the
admin settings page and the chat model picker.
Kept in its own file so upstream merges only touch two lines in main.py.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import aiohttp
from fastapi import APIRouter, Depends, HTTPException, Request
from open_webui.utils.auth import get_admin_user, get_verified_user

log = logging.getLogger(__name__)

router = APIRouter()

MODEL_MANAGER_URL = os.environ.get('MODEL_MANAGER_URL', 'http://127.0.0.1:8099').rstrip('/')
_TIMEOUT = aiohttp.ClientTimeout(total=30)


async def _call(method: str, path: str, body: dict | None = None) -> Any:
    try:
        async with aiohttp.ClientSession(timeout=_TIMEOUT, trust_env=False) as session:
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
        raise HTTPException(
            status_code=503,
            detail=f'The model manager is not reachable at {MODEL_MANAGER_URL} ({e.__class__.__name__}). '
            'Is start_webui.sh running it?',
        )


@router.get('/status')
async def get_status(user=Depends(get_admin_user)):
    return await _call('GET', '/mm/status')


@router.get('/state')
async def get_state(user=Depends(get_verified_user)):
    """Small state for the chat model picker (any signed-in user): which local model is loaded or
    loading, and which model ids the manager handles."""
    return await _call('GET', '/mm/state')


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
