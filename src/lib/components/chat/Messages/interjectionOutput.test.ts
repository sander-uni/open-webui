// Fork 0.3.3: how a reply shows the user's interjections.
import { describe, expect, it } from 'vitest';
import { buildOutputDisplayItems, type OutputItem } from './structuredOutput';
import { buildWindowDisplayItems } from './outputWindow';

const call = (id: string): OutputItem =>
	({ type: 'function_call', id, call_id: id, name: 'run_command', status: 'completed', arguments: '{}' }) as OutputItem;
const result = (id: string, extra: Record<string, unknown> = {}): OutputItem =>
	({
		type: 'function_call_output',
		id: `o-${id}`,
		call_id: id,
		status: 'completed',
		output: [{ type: 'input_text', text: 'waited 1.5s' }],
		...extra
	}) as OutputItem;
const block = {
	type: 'input_text',
	text: '\n\n[Message from the user, sent while you were working. ...]\nUse port 9000.\n[End of the message from the user]',
	interjection: true
};

describe('interjections in a reply', () => {
	it('shows the message after the step it was delivered with, outside the tool result', () => {
		const output = [
			call('a'),
			result('a', {
				output: [{ type: 'input_text', text: 'waited 1.5s' }, block],
				interjections: [{ id: 'i1', text: 'Use port 9000.', files: [] }]
			}),
			call('b'),
			result('b')
		];
		const items = buildOutputDisplayItems(output);
		expect(items.map((i) => i.type)).toEqual(['detail_single', 'interjection', 'detail_single']);
		const first = items[0] as any;
		expect(first.token.text).toBe('waited 1.5s'); // the user's text is not in the tool result
		expect((items[1] as any).entries[0].text).toBe('Use port 9000.');
		expect((items[1] as any).held).toBe(false);
	});

	it('marks a held call as not run', () => {
		const items = buildOutputDisplayItems([
			call('a'),
			result('a', {
				held: true,
				output: [{ type: 'input_text', text: 'Not run. The user sent a message...' }, block],
				interjections: [{ id: 'i1', text: 'stop', files: [] }]
			})
		]);
		expect((items[0] as any).token.summary).toBe('Not run: waited for your message');
		expect((items[1] as any).held).toBe(true);
	});

	it('keeps working with the paged tool-chain window', () => {
		const output: OutputItem[] = [];
		for (let i = 0; i < 5; i++) output.push(call(`c${i}`), result(`c${i}`));
		(output[3] as any).interjections = [{ id: 'i1', text: 'hi', files: [] }];
		const items = buildWindowDisplayItems(output);
		expect(items.filter((i) => i.type === 'interjection')).toHaveLength(1);
		expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
	});
});

// fork 0.3.5 (review C11): the paged view splits groups where the full view does.
import { selectOutputWindow } from './outputWindow';

describe('paging around a delivered message', () => {
	const noted = (id: string): OutputItem =>
		({
			type: 'function_call_output',
			id: `o-${id}`,
			call_id: id,
			status: 'completed',
			output: [{ type: 'input_text', text: 'ok' }],
			interjections: [{ id: 'i1', text: 'Use port 9000.', files: [] }]
		}) as OutputItem;
	const output = [call('a'), noted('a'), call('b'), result('b')];

	it('the note is a step and a boundary: the hidden call does not join the visible group', () => {
		const one = selectOutputWindow(output, 1, { live: false });
		expect(one.totalSteps).toBe(3);
		expect(one.hiddenRun).toBeNull();
		expect(one.hiddenTotals.toolCallCount).toBe(1);
		expect(one.hiddenTotals.interjectionCount).toBe(1);
		expect(buildWindowDisplayItems(one.output, one).map((i) => i.type)).toEqual(['detail_single']);
	});

	it('when the note is in view it shows between the groups, as in the full view', () => {
		const two = selectOutputWindow(output, 2, { live: false });
		expect(buildWindowDisplayItems(two.output, two).map((i) => i.type)).toEqual(['interjection', 'detail_single']);
		const all = selectOutputWindow(output, Infinity, { live: false });
		expect(buildWindowDisplayItems(all.output, all).map((i) => i.type)).toEqual(
			buildOutputDisplayItems(output).map((i) => i.type)
		);
	});
});
