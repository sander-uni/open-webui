"""Fork addition: Admin Settings > Model Manager.

Proxies the local model manager's admin API (modelmgr, started by start_webui.sh) for the
admin settings page, and serves the loading-status filter that the page installs.
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
    return {
        'id': FILTER_ID,
        'name': 'Model Manager loading status',
        'description': 'Shows a status line while the model manager loads a local model.',
        'version': FILTER_VERSION,
        'content': FILTER_SOURCE,
    }


FILTER_ID = 'model_manager_status'
FILTER_VERSION = '0.1.0'
FILTER_SOURCE = '''"""
title: Model Manager loading status
description: Shows "Loading <model>..." while the local model manager loads a model.
version: 0.1.0
"""

import asyncio
import time

import aiohttp
from pydantic import BaseModel, Field


class Filter:
    class Valves(BaseModel):
        manager_url: str = Field(default="http://127.0.0.1:8099", description="Model manager address")
        max_wait_minutes: int = Field(default=30, description="Stop showing progress after this long")

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body: dict, __event_emitter__=None, __model__=None) -> dict:
        if __event_emitter__ is None:
            return body
        names = [body.get("model")]
        if isinstance(__model__, dict):
            names.append(__model__.get("id"))
            names.append((__model__.get("info") or {}).get("base_model_id"))
        names = [n for n in names if isinstance(n, str) and n]
        base = self.valves.manager_url.rstrip("/")
        timeout = aiohttp.ClientTimeout(total=5)
        try:
            async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as s:
                async with s.get(f"{base}/mm/resolve", params=[("model", n) for n in names]) as r:
                    info = await r.json()
                model = info.get("id")
                if not model or info.get("ready"):
                    return body
                if info.get("pinned_other"):
                    await self._status(__event_emitter__,
                                       f"{info['pinned_other']} is pinned; unpin it in Admin Settings > Model Manager",
                                       done=True)
                    return body
                async with s.post(f"{base}/mm/load", json={"model": model}) as r:
                    if r.status >= 400:
                        return body
                t0 = time.monotonic()
                deadline = t0 + self.valves.max_wait_minutes * 60
                while time.monotonic() < deadline:
                    async with s.get(f"{base}/mm/status") as r:
                        st = await r.json()
                    cur = (st.get("model") or {}).get("id")
                    secs = int(time.monotonic() - t0)
                    if st.get("phase") == "ready" and cur == model:
                        await self._status(__event_emitter__, f"Loaded {model} in {secs} s", done=True)
                        return body
                    err = st.get("error") or {}
                    if st.get("phase") == "error" and err.get("model") == model:
                        await self._status(__event_emitter__, err.get("message", "Loading failed")[:300], done=True)
                        return body
                    loading = st.get("loading") or {}
                    detail = loading.get("detail") or st.get("phase")
                    waiting = ""
                    if st.get("switch_to") == model and st.get("inflight"):
                        waiting = f" (waiting for {st['inflight']} running request(s) on {cur})"
                    await self._status(__event_emitter__, f"Loading {model}: {detail}{waiting}, {secs} s")
                    await asyncio.sleep(1.5)
        except Exception:
            return body
        return body

    @staticmethod
    async def _status(emit, text, done=False):
        await emit({"type": "status", "data": {"description": text, "done": done, "hidden": False}})
'''
