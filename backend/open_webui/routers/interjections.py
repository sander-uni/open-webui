"""Fork addition (model manager 0.3.3): add, list and withdraw messages for a running agent reply.

See utils/interjections.py. Only the user who started the reply can see or change its messages.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from open_webui.utils import interjections
from open_webui.utils.auth import get_verified_user

router = APIRouter()


class InterjectionForm(BaseModel):
    text: str = Field(default='', max_length=200_000)
    files: list[dict] = Field(default_factory=list, max_length=20)


@router.get('/{chat_id}/{message_id}')
async def get_state(chat_id: str, message_id: str, user=Depends(get_verified_user)):
    return interjections.state(chat_id, message_id, user.id)


@router.post('/{chat_id}/{message_id}')
async def add_interjection(chat_id: str, message_id: str, form: InterjectionForm, user=Depends(get_verified_user)):
    if not form.text.strip() and not form.files:
        raise HTTPException(status_code=400, detail='Empty message')
    if sum(len(f.get('content') or '') for f in form.files if isinstance(f.get('content'), str)) > 2_000_000:
        raise HTTPException(status_code=413, detail='The attached text is too large for a message to the running reply.')
    interjection_id = interjections.add(chat_id, message_id, user.id, form.text, form.files)
    if interjection_id is None:
        raise HTTPException(status_code=409, detail='This reply takes no more messages')
    if interjection_id == interjections.FULL:
        # 0.3.5 (review C10): not "this reply takes none": the browser keeps the message
        raise HTTPException(
            status_code=429,
            detail=f'{interjections.MAX_PENDING} messages are already waiting for the next step. '
            'Wait until they are delivered, or take one back.',
        )
    return {'id': interjection_id}


class AckForm(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=200)


@router.post('/{chat_id}/{message_id}/returned/ack')
async def ack_returned(chat_id: str, message_id: str, form: AckForm, user=Depends(get_verified_user)):
    """0.3.5: the browser put these undelivered messages back in the input box."""
    return {'acknowledged': interjections.ack_returned(chat_id, message_id, user.id, form.ids)}


@router.delete('/{chat_id}/{message_id}/{interjection_id}')
async def remove_interjection(chat_id: str, message_id: str, interjection_id: str, user=Depends(get_verified_user)):
    return {'removed': interjections.remove(chat_id, message_id, user.id, interjection_id)}
