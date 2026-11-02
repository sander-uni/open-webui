"""fork: separate file, so it merges easily with upstream."""

import asyncio
from contextlib import asynccontextmanager
from typing import Callable


def tool_call_event_emitter(emitter: Callable, call_id: str) -> Callable:
    """fork: a workspace tool's status lines and files carry the call that made them, so the chat can show its
    progress and its media right after that step (Messages/toolCallExtras.ts)."""

    async def tagged(event):
        data = event.get('data') if isinstance(event, dict) else None
        if isinstance(data, dict):
            if event.get('type') == 'status':
                event = {**event, 'data': {**data, 'call_id': call_id}}
            # Only `files` adds new files and is saved. `chat:message:files` is a snapshot of all of them, not saved.
            elif event.get('type') == 'files' and isinstance(data.get('files'), list):
                files = [{**f, 'call_id': f.get('call_id') or call_id} if isinstance(f, dict) else f for f in data['files']]
                event = {**event, 'data': {**data, 'files': files}}
        return await emitter(event)

    return tagged


_file_locks: dict[tuple, list] = {}  # (chat, message) -> [lock, users]


@asynccontextmanager
async def message_files_lock(chat_id, message_id):
    """One read-add-write of a message's file list at a time. Only held while a save runs, so no entry stays."""
    key = (chat_id, message_id)
    entry = _file_locks.setdefault(key, [asyncio.Lock(), 0])
    entry[1] += 1
    try:
        async with entry[0]:
            yield
    finally:
        entry[1] -= 1
        if not entry[1]:
            _file_locks.pop(key, None)
