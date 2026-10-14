"""Tail-only streaming for continued replies (backend/open_webui/utils/output_tail.py).

Simulates a continued reply the way the middleware builds it: ``prior_output`` from the
saved message, ``output`` for this request, and ``full_output()`` which may merge the first
new message into the last prior one. A client applying every tail must always end up with
exactly the full output the upstream code would have sent.
"""

import copy
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'output_tail', ROOT / 'backend' / 'open_webui' / 'utils' / 'output_tail.py'
)
output_tail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(output_tail)


def full_output(prior, output):
    # Same rule as middleware.full_output().
    if (
        prior
        and output
        and prior[-1].get('type') == output[0].get('type') == 'message'
        and prior[-1].get('role', 'assistant') == 'assistant'
        and output[0].get('role', 'assistant') == 'assistant'
    ):
        return [
            *prior[:-1],
            {
                **prior[-1],
                **output[0],
                'id': prior[-1].get('id'),
                'content': [*prior[-1].get('content', []), *output[0].get('content', [])],
            },
            *output[1:],
        ]
    return prior + output if prior else output


def prior_chain(rounds):
    items = []
    for n in range(rounds):
        items += [
            {'type': 'reasoning', 'id': f'r{n}', 'content': [{'type': 'output_text', 'text': 'x'}]},
            {'type': 'function_call', 'id': f'fc{n}', 'call_id': f'c{n}', 'name': 'run', 'arguments': '{}'},
            {
                'type': 'function_call_output',
                'call_id': f'c{n}',
                'output': [{'type': 'input_text', 'text': 'big' * 50}],
            },
        ]
    return items


class Client:
    def __init__(self, output):
        self.output = copy.deepcopy(output)
        self.bytes = 0

    def receive(self, data):
        data = copy.deepcopy(data)
        self.bytes += len(repr(data))
        if 'output' in data:
            self.output = data['output']
        else:
            merged = output_tail.apply_output_tail(self.output, data)
            assert merged is not None
            self.output = merged


def stream(prior, output, events, use_tail=True):
    """events: callables mutating ``output`` and returning a delta dict (raw index)."""
    client = Client(prior)
    for event in events:
        delta = event(output)
        full = full_output(prior, output)
        if delta is None:  # structural event: upstream sends the full output
            client.receive({'output': full})
            continue
        delta = {**delta, 'output_index': delta['output_index'] + len(prior)}
        data = use_tail and output_tail.output_tail_data(full, output, len(prior), delta)
        client.receive(data or {'output': full})
        assert client.output == full
    return client


def text_delta(index, item_id, text):
    def apply(output):
        output[index]['content'][-1]['text'] += text
        return {'type': 'response.output_text.delta', 'output_index': index, 'item_id': item_id, 'delta': text}

    return apply


def add_item(item):
    def apply(output):
        output.append(copy.deepcopy(item))
        return None

    return apply


def reasoning_delta_new_item(item_id):
    # The middleware appends a reasoning item and emits a delta for it directly.
    def apply(output):
        output.append({'type': 'reasoning', 'id': item_id, 'content': [{'type': 'output_text', 'text': 't'}]})
        return {
            'type': 'response.reasoning_text.delta',
            'output_index': len(output) - 1,
            'item_id': item_id,
            'delta': 't',
        }

    return apply


def test_continued_tool_run_matches_full_output_and_sends_far_less():
    prior = prior_chain(200)
    events = [reasoning_delta_new_item('r-new')]
    events += [text_delta(0, 'r-new', 'more ') for _ in range(50)]
    events += [add_item({'type': 'message', 'id': 'm1', 'content': [{'type': 'output_text', 'text': ''}]})]
    events += [text_delta(1, 'm1', 'word ') for _ in range(50)]
    tail = stream(prior, [], events)
    full = stream(prior, [], events, use_tail=False)
    assert tail.output == full.output
    assert tail.bytes * 20 < full.bytes


def test_merged_continuation_message_keeps_prior_id():
    prior = prior_chain(3) + [
        {'type': 'message', 'id': 'prior-msg', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Hel'}]}
    ]
    output = [
        {'type': 'message', 'id': 'new-msg', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': ''}]}
    ]
    client = stream(prior, output, [text_delta(0, 'new-msg', 'lo') for _ in range(5)])
    assert client.output[-1]['id'] == 'prior-msg'
    assert client.output[-1]['content'][-1]['text'] == 'lololololo'


def test_function_call_argument_deltas_match_by_call_id():
    prior = prior_chain(2)
    output = [{'type': 'function_call', 'id': 'fc-x', 'call_id': 'call-x', 'name': 'run', 'arguments': ''}]

    def args(output):
        output[0]['arguments'] += '{'
        return {'type': 'response.function_call_arguments.delta', 'output_index': 0, 'item_id': 'call-x', 'delta': '{'}

    client = stream(prior, output, [args, args])
    assert client.output[-1]['arguments'] == '{{'


def test_falls_back_to_full_output_when_the_item_cannot_be_found():
    full = prior_chain(1)
    assert output_tail.output_tail_data(full, [full[-1]], 2, {'output_index': 9, 'item_id': 'missing'}) is None
    assert output_tail.output_tail_data(full, [], 3, {'output_index': 3}) is None
    assert output_tail.output_tail_data(full, [full[-1]], 2, {'item_id': 'x'}) is None


def test_previous_tool_result_is_not_resent():
    prior = prior_chain(1)
    output = [{'type': 'reasoning', 'id': 'r', 'content': [{'type': 'output_text', 'text': ''}]}]
    full = full_output(prior, output)
    data = output_tail.output_tail_data(full, output, len(prior), {'output_index': len(prior), 'item_id': 'r'})
    assert data['output_start'] == len(prior)
    assert data['output_tail'] == output


def test_shared_viewer_merge_keeps_old_output_on_gap():
    assert output_tail.apply_output_tail([{'id': 'a'}], {'output_tail': [{'id': 'c'}], 'output_start': 4}) is None
    assert output_tail.apply_output_tail(None, {'output_tail': [], 'output_start': 0}) is None


def test_header_opt_in():
    class Request:
        def __init__(self, headers):
            self.headers = headers

    assert output_tail.client_accepts_output_tail(Request({'x-openwebui-output-tail': '1'}))
    assert not output_tail.client_accepts_output_tail(Request({}))
    assert not output_tail.client_accepts_output_tail(object())
