"""Fork addition (0.3.4): context compactions shown as steps in a reply.

ctxproxy (0.22+) sends stream events with empty ``choices`` and a ``ctxproxy`` key when it
compacts the conversation before a model request:

    {"compaction": "start"}
    {"compaction": "done", "n": 3, "conv": "<key>", "seconds": 41.2}
    {"compaction": "failed", "reason": "..."}
    {"compaction": "cut", "n": 4, "conv": "<key>", "dropped_steps": 12}   # no summary written

They become output items of type ``open_webui:ctxproxy_compaction`` in the reply's stored output.
``convert_output_to_messages`` skips this type, so the model never sees it and the rebuilt
history is byte-identical. The note itself stays in ctxproxy; ``conv`` + ``n`` find it.
"""

from __future__ import annotations

import re
import threading
import time
from collections import OrderedDict
from typing import Callable, Optional

ITEM_TYPE = 'open_webui:ctxproxy_compaction'
_CONV = re.compile(r'^[0-9a-f]{1,64}$')
_TEMPORARY_PREFIXES = ('temporary:', 'local:')

# 0.3.5 (review C1): temporary chats are never stored, so the summary viewer can't read the key
# from the database. The key is recorded here when ctxproxy reports it, for that user and chat,
# and only a recorded key opens a summary. In memory (one worker); the newest chats are kept.
_TEMP_KEYS: 'OrderedDict[tuple[str, str], set[str]]' = OrderedDict()
_TEMP_KEYS_MAX = 500
_temp_lock = threading.Lock()


def remember_temporary_key(user_id, chat_id, conv) -> None:
    if not user_id or not isinstance(chat_id, str) or not chat_id.startswith(_TEMPORARY_PREFIXES):
        return
    if not _conv(conv):
        return
    with _temp_lock:
        keys = _TEMP_KEYS.pop((user_id, chat_id), set())
        keys.add(conv)
        _TEMP_KEYS[(user_id, chat_id)] = keys
        while len(_TEMP_KEYS) > _TEMP_KEYS_MAX:
            _TEMP_KEYS.popitem(last=False)


def temporary_key_allowed(user_id, chat_id, conv) -> bool:
    with _temp_lock:
        return conv in _TEMP_KEYS.get((user_id, chat_id), ())


def _int(value) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _conv(value) -> Optional[str]:
    return value if isinstance(value, str) and _CONV.match(value) else None


def _running(output: list) -> Optional[dict]:
    for item in reversed(output):
        if item.get('type') == ITEM_TYPE and item.get('status') == 'in_progress':
            return item
    return None


def split(output: list) -> tuple[list, list]:
    """(compaction steps, everything else), each in order."""
    steps = [item for item in output if item.get('type') == ITEM_TYPE]
    if not steps:
        return [], output
    return steps, [item for item in output if item.get('type') != ITEM_TYPE]


def _place(output: list, item: dict, insert_at: Optional[int]) -> int:
    if insert_at is None or not 0 <= insert_at <= len(output):
        output.append(item)
        return len(output) - 1
    output.insert(insert_at, item)
    return insert_at


def apply(
    output: list, event, new_id: Callable[[str], str], insert_at: Optional[int] = None
) -> Optional[tuple[int, dict, bool]]:
    """Apply one ctxproxy event to `output` (in place): this round's output, or during Continue the
    earlier output with `insert_at` just before the continued message.
    Returns (index in output, item, added) for the item that changed, or None."""
    if not isinstance(event, dict):
        return None
    phase = event.get('compaction')
    now = time.time()
    if phase == 'start':
        item = {'type': ITEM_TYPE, 'id': new_id('cmp'), 'status': 'in_progress', 'kind': 'summary',
                'started_at': now}
        return _place(output, item, insert_at), item, True
    if phase == 'cut':
        item = {'type': ITEM_TYPE, 'id': new_id('cmp'), 'status': 'completed', 'kind': 'cut',
                'started_at': now, 'ended_at': now, 'n': _int(event.get('n')), 'conv': _conv(event.get('conv'))}
        dropped = _int(event.get('dropped_steps'))
        if dropped:
            item['dropped_steps'] = dropped
        return _place(output, item, insert_at), item, True
    if phase not in ('done', 'failed'):
        return None
    item = _running(output)
    added = item is None
    if added:   # a done/failed without its start (should not happen): still show it
        item = {'type': ITEM_TYPE, 'id': new_id('cmp'), 'kind': 'summary', 'started_at': now}
        _place(output, item, insert_at)
    item['ended_at'] = now
    if isinstance(event.get('seconds'), (int, float)) and not isinstance(event.get('seconds'), bool):
        item['seconds'] = round(float(event['seconds']), 1)
    if phase == 'done' and _int(event.get('n')):
        item.update(status='completed', n=_int(event.get('n')), conv=_conv(event.get('conv')))
    else:
        reason = event.get('reason')
        item.update(status='failed', reason=str(reason)[:300] if reason else 'the summary could not be written')
    return output.index(item), item, added


def close(output: list) -> int:
    """A compaction the reply never heard back from (the stream ended early): incomplete,
    never "completed" without a number. Returns how many items changed."""
    changed = 0
    for item in output:
        if item.get('type') == ITEM_TYPE and item.get('status') == 'in_progress':
            item['status'] = 'incomplete'
            item.setdefault('ended_at', time.time())
            changed += 1
    return changed

