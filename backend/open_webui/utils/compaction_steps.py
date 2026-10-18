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
import time
from typing import Callable, Optional

ITEM_TYPE = 'open_webui:ctxproxy_compaction'
_CONV = re.compile(r'^[0-9a-f]{1,64}$')


def _int(value) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _conv(value) -> Optional[str]:
    return value if isinstance(value, str) and _CONV.match(value) else None


def _running(output: list) -> Optional[dict]:
    for item in reversed(output):
        if item.get('type') == ITEM_TYPE and item.get('status') == 'in_progress':
            return item
    return None


def apply(output: list, event, new_id: Callable[[str], str]) -> Optional[tuple[int, dict, bool]]:
    """Apply one ctxproxy event to this round's output (in place).
    Returns (index in output, item, added) for the item that changed, or None."""
    if not isinstance(event, dict):
        return None
    phase = event.get('compaction')
    now = time.time()
    if phase == 'start':
        item = {'type': ITEM_TYPE, 'id': new_id('cmp'), 'status': 'in_progress', 'kind': 'summary',
                'started_at': now}
        output.append(item)
        return len(output) - 1, item, True
    if phase == 'cut':
        item = {'type': ITEM_TYPE, 'id': new_id('cmp'), 'status': 'completed', 'kind': 'cut',
                'started_at': now, 'ended_at': now, 'n': _int(event.get('n')), 'conv': _conv(event.get('conv'))}
        dropped = _int(event.get('dropped_steps'))
        if dropped:
            item['dropped_steps'] = dropped
        output.append(item)
        return len(output) - 1, item, True
    if phase not in ('done', 'failed'):
        return None
    item = _running(output)
    added = item is None
    if added:   # a done/failed without its start (should not happen): still show it
        item = {'type': ITEM_TYPE, 'id': new_id('cmp'), 'kind': 'summary', 'started_at': now}
        output.append(item)
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

