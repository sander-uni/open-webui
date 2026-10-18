"""Fork addition (model manager 0.3.3): messages the user sends while an agent reply runs.

A reply that offers tools registers a run. While it runs, the user can add messages
("interjections"). They reach the model at whichever comes first:

- the end of a thought: the model has written its tool calls, which are then held back (not
  run) and answered with a note plus the user's message, so it can run them again or change
  course;
- the end of a tool run: the message is attached to the result of the last tool that ran.

Messages waiting at the same moment are delivered together, in order. When the reply ends
with a final answer there is no next step: pending messages are kept here as "returned" (0.3.5)
until the browser takes them back into the input box, also after a reload.

A reply that pauses (an ask_user question, a tool approval) keeps its run: it goes on accepting
messages, and the run of the resumed reply takes over everything still waiting (0.3.5). A new
run for the same reply always takes over the old run's waiting messages, so none are lost.

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
RETURNED_TTL_S = 24 * 3600  # undelivered messages kept for the browser to take back
PAUSED_TTL_S = 7 * 24 * 3600  # a paused reply nobody resumes
MAX_RETURNED = 200
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
    paused: bool = False
    since: float = field(default_factory=time.time)


@dataclass
class Returned:
    user_id: str
    items: list
    at: float


_runs: dict[tuple[str, str], Run] = {}
_returned: dict[tuple[str, str], Returned] = {}
_lock = threading.Lock()


def _expire(now: float) -> None:
    """Drop old returned messages and paused runs nobody resumed (called with the lock held)."""
    for key in [k for k, r in _returned.items() if now - r.at > RETURNED_TTL_S]:
        del _returned[key]
    while len(_returned) > MAX_RETURNED:
        del _returned[min(_returned, key=lambda k: _returned[k].at)]
    for key in [k for k, r in _runs.items() if r.paused and now - r.since > PAUSED_TTL_S]:
        _keep_returned(_runs.pop(key), now)


def _keep_returned(run: Run, now: float) -> None:
    """Undelivered messages of an ended run, for the browser to take back (lock held)."""
    items, run.pending = run.pending, []
    run.accepting = False
    if not items:
        return
    key = (run.chat_id, run.message_id)
    kept = _returned.get(key)
    if kept is not None and kept.user_id == run.user_id:
        kept.items.extend(items)
        kept.at = now
    else:
        _returned[key] = Returned(run.user_id, items, now)


def start(chat_id: Optional[str], message_id: Optional[str], user_id: str) -> Optional[Run]:
    if not chat_id or not message_id:
        return None
    run = Run(chat_id, message_id, user_id)
    with _lock:
        now = time.time()
        _expire(now)
        old = _runs.get((chat_id, message_id))
        if old is not None and old.user_id == user_id:
            # 0.3.5 (review C4, C6): the resumed reply after a pause, or a second handler for the
            # same reply, takes over what is waiting; the old run accepts nothing more.
            run.pending, old.pending = old.pending, []
            old.accepting = False
        _runs[(chat_id, message_id)] = run
    return run


def pause(run: Optional[Run]) -> None:
    """The reply stops for an ask_user question or a tool approval and will resume: keep the run
    (it goes on accepting messages) so the resumed reply delivers them (0.3.5, review C4)."""
    if run is not None:
        with _lock:
            run.paused = True
            run.since = time.time()


def close(run: Optional[Run]) -> list:
    """No further step: stop accepting. What was still waiting is kept as returned for the
    browser (0.3.5); also returned here."""
    if run is None:
        return []
    with _lock:
        if run.paused:
            return []
        dropped = list(run.pending)
        _keep_returned(run, time.time())
    return dropped


def finish(run: Optional[Run]) -> None:
    if run is None:
        return
    with _lock:
        if run.paused and run.accepting:
            return  # resumes later; start() of the resumed reply takes it over
        _keep_returned(run, time.time())
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


def _item(i: Interjection) -> dict:
    return {'id': i.id, 'text': i.text, 'files': i.files}


def state(chat_id: str, message_id: str, user_id: str) -> dict:
    """accepting, pending (waiting for the next step) and returned (the reply ended first; the
    browser puts them back in the input box and then acknowledges them)."""
    with _lock:
        _expire(time.time())
        run = _run_for(chat_id, message_id, user_id)
        kept = _returned.get((chat_id, message_id))
        returned = [_item(i) for i in kept.items] if kept is not None and kept.user_id == user_id else []
        return {
            'accepting': bool(run and run.accepting),
            'paused': bool(run and run.paused),
            'pending': [_item(i) for i in run.pending] if run else [],
            'returned': returned,
        }


def ack_returned(chat_id: str, message_id: str, user_id: str, ids: list) -> int:
    """The browser took these back into the input box: forget them."""
    with _lock:
        kept = _returned.get((chat_id, message_id))
        if kept is None or kept.user_id != user_id:
            return 0
        before = len(kept.items)
        kept.items = [i for i in kept.items if i.id not in set(ids or [])]
        if not kept.items:
            del _returned[(chat_id, message_id)]
        return before - len(kept.items)


FULL = 'full'


def add(chat_id: str, message_id: str, user_id: str, text: str, files: list) -> Optional[str]:
    """Queue a message for the next step. None when this reply takes none (no tools, or done);
    FULL when MAX_PENDING messages are already waiting (0.3.5, review C10: told apart)."""
    with _lock:
        run = _run_for(chat_id, message_id, user_id)
        if run is None or not run.accepting:
            return None
        if len(run.pending) >= MAX_PENDING:
            return FULL
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
            name = 'file'
            try:
                # 0.3.5 (review C9): nothing about one attachment may stop the others or the message
                if not isinstance(f, dict):
                    raise ValueError('attachment is not an object')
                kind = f.get('type')
                nested = f.get('file') if isinstance(f.get('file'), dict) else {}
                name = str(f.get('name') or nested.get('filename') or 'file')[:200]
                if kind == 'text' and isinstance(f.get('content'), str):
                    # 0.3.5 (review C5): a temporary chat's text file is never uploaded; the browser
                    # sends its extracted text (bounded) instead of an id there is no file for.
                    lines.append(f'--- File "{name}" ---\n{_clip(f["content"])}\n--- end of "{name}" ---')
                    shown_files.append({'type': 'file', 'name': name})
                    continue
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
                else:
                    raise ValueError('attachment without a usable reference')
            except Exception as exc:  # one attachment never loses the message
                log.warning('interjection attachment %s could not be read: %r', name, exc)
                lines.append(f'[Attachment "{name}" could not be read]')
        sections.append('\n'.join(lines))
        display.append({'id': item.id, 'text': item.text, 'files': shown_files})
    text = MARK_START + '\n' + '\n\n'.join(sections) + '\n' + MARK_END
    return {'text': text, 'images': images, 'display': display}
