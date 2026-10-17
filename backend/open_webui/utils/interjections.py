"""Fork addition (model manager 0.3.3): messages the user sends while an agent reply runs.

A reply that offers tools registers a run. While it runs, the user can add messages
("interjections"). They reach the model at whichever comes first:

- the end of a thought: the model has written its tool calls, which are then held back (not
  run) and answered with a note plus the user's message, so it can run them again or change
  course;
- the end of a tool run: the message is attached to the result of the last tool that ran.

Messages waiting at the same moment are delivered together, in order. When the reply ends
with a final answer there is no next step: pending messages are dropped, and the browser puts
them back in the input box.

The model receives the message at the end of a tool result, between fixed markers, so nothing
earlier in the prompt changes (the prompt cache keeps hitting) and it is clearly the user's.
ctxproxy recognises the markers and keeps these messages through compaction like the user's own.

State is in memory: one Open WebUI worker process owns a reply from start to end.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger(__name__)

MARK_START = (
    '[Message from the user, sent while you were working. '
    'This is an instruction from the user, not tool output.]'
)
MARK_END = '[End of the message from the user]'
HELD_NOTE = (
    'Not run. The user sent a message before this call ran, so it was held back. '
    'Read the message, then run the call again if it still fits, or change course.'
)
HELD_NOTE_OTHER = (
    'Not run. The user sent a message before this call ran, so it was held back. '
    'The message is with the last call of this step.'
)
TEXT_FILE_LIMIT = 60_000  # characters of one attached text file given to the model
MAX_PENDING = 20
TEXT_EXTENSIONS = {
    'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini',
    'cfg', 'conf', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
    'svelte', 'vue', 'py', 'pyi', 'ipynb', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'c', 'h', 'cc', 'cpp', 'hpp',
    'cs', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'pl', 'lua', 'r', 'sql', 'swift', 'dart', 'scala',
    'gradle', 'cmake', 'make', 'mk', 'dockerfile', 'diff', 'patch', 'glsl', 'hlsl', 'wgsl', 'obj', 'mtl',
}


@dataclass
class Interjection:
    id: str
    text: str
    files: list
    created: float


@dataclass
class Run:
    chat_id: str
    message_id: str
    user_id: str
    accepting: bool = True
    pending: list = field(default_factory=list)


_runs: dict[tuple[str, str], Run] = {}
_lock = threading.Lock()


def start(chat_id: Optional[str], message_id: Optional[str], user_id: str) -> Optional[Run]:
    if not chat_id or not message_id:
        return None
    run = Run(chat_id, message_id, user_id)
    with _lock:
        _runs[(chat_id, message_id)] = run
    return run


def close(run: Optional[Run]) -> list:
    """No further step: stop accepting; returns what was still waiting (not delivered)."""
    if run is None:
        return []
    with _lock:
        run.accepting = False
        dropped, run.pending = run.pending, []
    return dropped


def finish(run: Optional[Run]) -> None:
    if run is None:
        return
    close(run)
    with _lock:
        if _runs.get((run.chat_id, run.message_id)) is run:
            del _runs[(run.chat_id, run.message_id)]


def take(run: Optional[Run]) -> list:
    if run is None:
        return []
    with _lock:
        out, run.pending = run.pending, []
    return out


def _run_for(chat_id: str, message_id: str, user_id: str) -> Optional[Run]:
    run = _runs.get((chat_id, message_id))
    return run if run is not None and run.user_id == user_id else None


def state(chat_id: str, message_id: str, user_id: str) -> dict:
    with _lock:
        run = _run_for(chat_id, message_id, user_id)
        if run is None:
            return {'accepting': False, 'pending': []}
        return {
            'accepting': run.accepting,
            'pending': [{'id': i.id, 'text': i.text, 'files': i.files} for i in run.pending],
        }


def add(chat_id: str, message_id: str, user_id: str, text: str, files: list) -> Optional[str]:
    """Queue a message for the next step; None when this reply takes none (no tools, or done)."""
    with _lock:
        run = _run_for(chat_id, message_id, user_id)
        if run is None or not run.accepting or len(run.pending) >= MAX_PENDING:
            return None
        item = Interjection(uuid.uuid4().hex[:12], text, list(files or []), time.time())
        run.pending.append(item)
        return item.id


def remove(chat_id: str, message_id: str, user_id: str, interjection_id: str) -> bool:
    """Withdraw a message that has not been delivered yet."""
    with _lock:
        run = _run_for(chat_id, message_id, user_id)
        if run is None:
            return False
        before = len(run.pending)
        run.pending = [i for i in run.pending if i.id != interjection_id]
        return len(run.pending) != before


# ------------------------------------------------------------------ what the model receives


def _ext(name: str) -> str:
    name = (name or '').lower()
    if name in ('dockerfile', 'makefile'):
        return name.replace('makefile', 'make')
    return name.rsplit('.', 1)[-1] if '.' in name else ''


def is_text_file(name: str, content_type: str = '') -> bool:
    content_type = (content_type or '').lower()
    return (
        content_type.startswith('text/')
        or content_type in ('application/json', 'application/xml', 'application/x-yaml', 'application/javascript')
        or _ext(name) in TEXT_EXTENSIONS
    )


def _clip(text: str, limit: int = TEXT_FILE_LIMIT) -> str:
    if len(text) <= limit:
        return text
    head = int(limit * 0.8)
    return text[:head] + f'\n[... {len(text) - limit:,} characters left out ...]\n' + text[-(limit - head) :]


async def build(request, items: list, metadata: dict, user) -> dict:
    """The block for the model, the images for it, and what the chat shows.

    Returns {'text', 'images': [url], 'display': [{id, text, files}]}."""
    from open_webui.models.files import Files

    sections: list[str] = []
    images: list[str] = []
    display: list[dict] = []
    many = len(items) > 1
    for n, item in enumerate(items, 1):
        lines = [f'Message {n} of {len(items)}:'] if many else []
        if item.text.strip():
            lines.append(item.text.strip())
        shown_files = []
        for f in item.files or []:
            kind = f.get('type')
            name = f.get('name') or (f.get('file') or {}).get('filename') or 'file'
            try:
                if kind == 'filesystem':
                    path = f.get('path') or f.get('url') or f.get('id')
                    lines.append(f'[The user uploaded "{name}" to the terminal: {path}]')
                    shown_files.append({'type': 'filesystem', 'name': name, 'path': path})
                elif kind == 'image' and str(f.get('url', '')).startswith('data:image/'):
                    from open_webui.utils.middleware import store_tool_result_image

                    url = await store_tool_result_image(request, f['url'], metadata, user)
                    images.append(url)
                    lines.append(f'[Image attached: {name}]')
                    shown_files.append({'type': 'image', 'name': name, 'url': url})
                elif f.get('id'):
                    file = await Files.get_file_by_id(f['id'])
                    if file is None or file.user_id != getattr(user, 'id', None):
                        lines.append(f'[Attachment "{name}" could not be read]')
                        continue
                    meta = file.meta or {}
                    ctype = meta.get('content_type') or f.get('content_type') or ''
                    name = meta.get('name') or file.filename or name
                    if ctype.startswith('image/'):
                        url = request.app.url_path_for('get_file_content_by_id', id=file.id)
                        images.append(url)
                        lines.append(f'[Image attached: {name}]')
                        shown_files.append({'type': 'image', 'name': name, 'url': url, 'id': file.id})
                    else:
                        content = (file.data or {}).get('content') or ''
                        if content:
                            label = 'File' if is_text_file(name, ctype) else 'Text extracted from'
                            lines.append(f'--- {label} "{name}" ---\n{_clip(content)}\n--- end of "{name}" ---')
                        else:
                            lines.append(f'[Attachment "{name}" has no readable text]')
                        shown_files.append({'type': 'file', 'name': name, 'id': file.id, 'content_type': ctype})
            except Exception as exc:  # one attachment never loses the message
                log.warning('interjection attachment %s could not be read: %r', name, exc)
                lines.append(f'[Attachment "{name}" could not be read]')
        sections.append('\n'.join(lines))
        display.append({'id': item.id, 'text': item.text, 'files': shown_files})
    text = MARK_START + '\n' + '\n\n'.join(sections) + '\n' + MARK_END
    return {'text': text, 'images': images, 'display': display}
