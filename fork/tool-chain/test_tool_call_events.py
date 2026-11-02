"""fork: a workspace tool's status lines and files carry the call that made them."""
import asyncio

from open_webui.utils.tool_call_events import tool_call_event_emitter


def run(event):
    seen = []

    async def emitter(e):
        seen.append(e)
        return 'r'

    assert asyncio.run(tool_call_event_emitter(emitter, 'c1')(event)) == 'r'
    return seen[0]


def test_status_gets_the_call_id():
    event = {'type': 'status', 'data': {'description': 'x', 'done': False}}
    out = run(event)
    assert out['data'] == {'description': 'x', 'done': False, 'call_id': 'c1'}
    assert 'call_id' not in event['data']  # the tool's own dict stays as it was


def test_files_get_the_call_id():
    out = run({'type': 'files', 'data': {'files': [{'id': 'f', 'url': 'u'}, {'id': 'g', 'call_id': 'c0'}, 'odd']}})
    assert out['data']['files'] == [{'id': 'f', 'url': 'u', 'call_id': 'c1'}, {'id': 'g', 'call_id': 'c0'}, 'odd']


def test_a_snapshot_of_all_files_is_not_stamped():
    event = {'type': 'chat:message:files', 'data': {'files': [{'id': 'f'}]}}
    assert run(event) == event


def test_other_events_pass_untouched():
    for event in (
        {'type': 'message', 'data': {'content': 'x'}},
        {'type': 'status'},
        {'type': 'files', 'data': {'files': 'odd'}},
        'odd',
    ):
        assert run(event) == event


def test_file_saves_run_one_at_a_time_and_leave_no_lock_behind():
    from open_webui.utils.tool_call_events import _file_locks, message_files_lock

    async def main():
        saved, inside, most = [], 0, 0

        async def save(name):
            nonlocal inside, most
            async with message_files_lock('c', 'm'):
                inside += 1
                most = max(most, inside)
                existing = list(saved)
                await asyncio.sleep(0.01)
                saved[:] = [name, *existing]
                inside -= 1

        await asyncio.gather(*(save(i) for i in range(5)))
        return saved, most

    saved, most = asyncio.run(main())
    assert sorted(saved) == [0, 1, 2, 3, 4] and most == 1 and not _file_locks
