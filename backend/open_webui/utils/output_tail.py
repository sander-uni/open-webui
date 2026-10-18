"""Fork: send only the changed end of a continued reply's output while it streams.

When a reply is continued (the Continue button, or a resumed tool approval), Open WebUI
sends the *whole* output list with every streamed chunk. On a long agent run that is
megabytes per token: serialized here, deep-copied for shared viewers and parsed by the
browser. A delta only ever changes one item, so a client that supports it receives
``output[start:]`` instead and keeps the unchanged prefix it already has.

Clients opt in with a request header, so other clients keep the upstream behavior.
Structural events (new items, tool results, completion) still send the full output,
which re-synchronizes the client.
"""

from typing import Any

OUTPUT_TAIL_HEADER = 'x-openwebui-output-tail'


def client_accepts_output_tail(request: Any) -> bool:
    try:
        return request.headers.get(OUTPUT_TAIL_HEADER) == '1'
    except Exception:
        return False


def _matches(item: Any, item_id: Any) -> bool:
    return isinstance(item, dict) and item_id is not None and item_id in (item.get('id'), item.get('call_id'))


def output_tail_data(full: list, output: list, prior_length: int, delta_data: dict | None) -> dict | None:
    """Return a tail payload for this delta, or None to send the full output instead.

    ``output`` is this request's own items; ``full`` is the prior output followed by
    ``output``, where the first new message may be merged into the last prior one.
    ``delta_data['output_index']`` already includes ``prior_length``.
    """
    if not delta_data or not output or not isinstance(full, list):
        return None
    index = delta_data.get('output_index')
    if not isinstance(index, int) or isinstance(index, bool):
        return None
    index -= prior_length
    item_id = delta_data.get('item_id')
    if not 0 <= index < len(output) or (item_id is not None and not _matches(output[index], item_id)):
        # Fall back to the item id; give up (full output) if it is not found.
        index = next((i for i in range(len(output) - 1, -1, -1) if _matches(output[i], item_id)), -1)
        if index < 0:
            return None
    # Items after output[0] map one-to-one onto the end of full, merged first item or not.
    start = len(full) - len(output) + index
    if not 0 <= start < len(full):
        return None
    # Also resend the previous item: it may have just finished (status, reasoning duration)
    # without a full update. Tool results are skipped, as they can hold large images.
    if start > 0 and isinstance(full[start - 1], dict) and full[start - 1].get('type') != 'function_call_output':
        start -= 1
    return {'output_tail': full[start:], 'output_start': start, 'output_length': len(full)}


def apply_output_tail(output: list | None, data: dict) -> list | None:
    """Merge a tail payload into a previously received full output (shared viewers)."""
    tail = data.get('output_tail')
    start = data.get('output_start')
    if not isinstance(tail, list) or type(start) is not int or not isinstance(output, list):
        return None
    if not 0 <= start <= len(output):
        return None
    length = data.get('output_length')
    if 'output_length' in data and (type(length) is not int or length != start + len(tail)):
        return None
    return output[:start] + tail
