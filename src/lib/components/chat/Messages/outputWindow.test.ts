import { describe, expect, it } from 'vitest';
import {
	applyResponseStreamEvent,
	buildOutputDisplayItems,
	getOutputText,
	type OutputItem
} from './structuredOutput';
import {
	OUTPUT_PAGE_SIZE,
	selectOutputWindow,
	snapshotResponseMessage,
	buildWindowDisplayItems,
	getOutputDetailKey
} from './outputWindow';

function chain(count: number): OutputItem[] {
	return Array.from({ length: count }, (_, index) => [
		{
			type: 'reasoning',
			id: `r${index}`,
			status: 'completed',
			content: [{ text: `Reason ${index}` }]
		},
		{
			type: 'function_call',
			id: `c${index}`,
			call_id: `c${index}`,
			name: 'run_command',
			status: 'completed',
			arguments: `{"step":${index}}`
		},
		{
			type: 'function_call_output',
			id: `o${index}`,
			call_id: `c${index}`,
			output: [{ type: 'input_text', text: `Result ${index}` }]
		}
	]).flat();
}

it('supports disabling pagination without dropping any stored items', () => {
	const output = chain(2000);
	const full = selectOutputWindow(output, Infinity);
	expect(full.hiddenSteps).toBe(0);
	expect(full.output).toEqual(output);
	expect(full.totalSteps).toBe(4000);
});

it('uses configurable recent page sizes and includes paired results', () => {
	const output = chain(2000);
	for (const limit of [10, 20, 100, 500]) {
		const view = selectOutputWindow(output, limit);
		expect(view.totalSteps - view.hiddenSteps).toBe(limit);
		expect(view.output.filter((item) => item.type === 'function_call').length).toBe(limit / 2);
		expect(view.output.filter((item) => item.type === 'function_call_output').length).toBe(
			limit / 2
		);
	}
});

describe('tool-chain output window', () => {
	it('keeps detail keys stable across prepended pages, including repeated provider ids', () => {
		const output = chain(100).map((item) => ({ ...item, id: 'repeated-provider-id' }));
		const first = buildWindowDisplayItems(selectOutputWindow(output).output);
		const second = buildWindowDisplayItems(selectOutputWindow(output, 100).output);
		const keys = (items: ReturnType<typeof buildWindowDisplayItems>) =>
			items.flatMap((item) =>
				item.type === 'detail_group' ? item.tokens.map(getOutputDetailKey) : []
			);
		const a = keys(first),
			b = keys(second);
		expect(new Set(a).size).toBe(a.length);
		for (const key of a) expect(b).toContain(key);
	});
	it('shows a bounded tail of a 2,000-call chain without changing retained history', () => {
		const output = chain(2000);
		const before = JSON.stringify(output);
		const window = selectOutputWindow(output);
		expect(window.totalSteps).toBe(4000);
		expect(window.hiddenSteps).toBe(3950);
		expect(window.output).toHaveLength(75);
		expect(window.output[0].id).toBe('r1975');
		expect(window.output.at(-1)?.id).toBe('o1999');
		expect(JSON.stringify(output)).toBe(before);
	});

	it('loads the immediately previous page and eventually reconstructs the full display', () => {
		const output = chain(100);
		const first = selectOutputWindow(output);
		const second = selectOutputWindow(output, OUTPUT_PAGE_SIZE * 2);
		expect(second.hiddenSteps).toBe(first.hiddenSteps - OUTPUT_PAGE_SIZE);
		expect(second.output).toContain(first.output[0]);
		expect(buildOutputDisplayItems(selectOutputWindow(output, 1000).output)).toEqual(
			buildOutputDisplayItems(output)
		);
	});

	it('pairs calls with non-adjacent parallel results and retains boundary reasoning', () => {
		const output: OutputItem[] = [
			{
				type: 'reasoning',
				id: 'reason',
				status: 'completed',
				content: [{ text: 'Parallel work' }]
			},
			{ type: 'function_call', id: 'first', call_id: 'first', name: 'one', status: 'completed' },
			{ type: 'function_call', id: 'last', call_id: 'last', name: 'two', status: 'completed' },
			{ type: 'function_call_output', call_id: 'last', output: [{ text: 'two-result' }] },
			{ type: 'function_call_output', call_id: 'first', output: [{ text: 'one-result' }] }
		];
		const window = selectOutputWindow(output, 1);
		// Both parallel calls of the turn stay together with their results and reasoning.
		expect(window.output.map((item) => item.call_id ?? item.id)).toEqual([
			'reason',
			'first',
			'last',
			'last',
			'first'
		]);
		expect(JSON.stringify(buildOutputDisplayItems(window.output))).toContain('two-result');
	});

	it('pins old approvals and executing calls while still paging completed history', () => {
		const output = chain(100);
		output[1] = { ...output[1], status: 'pending' };
		output.splice(2, 1);
		output[3] = { ...output[3], status: 'completed' };
		output.splice(4, 1);
		const window = selectOutputWindow(output);
		expect(window.output).toContain(output[1]);
		expect(window.output).toContain(output[3]);
		expect(window.hiddenSteps).toBeGreaterThan(100);
		expect(JSON.stringify(buildOutputDisplayItems(window.output))).toContain(
			'Tool Approval Needed'
		);
	});

	it('does not read, parse or copy hidden result or reasoning bodies', () => {
		const output = chain(2000);
		Object.defineProperty(output[0], 'content', {
			get: () => {
				throw new Error('hidden reasoning read');
			}
		});
		Object.defineProperty(output[2], 'output', {
			get: () => {
				throw new Error('hidden result read');
			}
		});
		const snapshot = snapshotResponseMessage({ id: 'm', output, annotation: { rating: 1 } });
		expect(snapshot.output).toBe(output);
		expect(() => buildOutputDisplayItems(selectOutputWindow(snapshot.output).output)).not.toThrow();
		// Negative controls: the original full clone and full renderer hit these guards.
		expect(() => structuredClone({ output })).toThrow('hidden reasoning read');
		expect(() => buildOutputDisplayItems(output)).toThrow('hidden reasoning read');
	});

	it('preserves UI metadata isolation and explicit edit isolation', () => {
		const source = {
			output: chain(30),
			annotation: { rating: 1 },
			statusHistory: [{ done: false }],
			files: [{ url: 'original' }]
		};
		const snapshot = snapshotResponseMessage(source);
		snapshot.annotation.rating = 2;
		snapshot.files[0].url = 'changed';
		snapshot.statusHistory[0].done = true;
		expect(source.annotation.rating).toBe(1);
		expect(source.files[0].url).toBe('original');
		expect(source.statusHistory[0].done).toBe(false);
		const editedOutput = structuredClone(snapshot.output);
		editedOutput[1].arguments = 'edited';
		expect(source.output[1].arguments).not.toBe('edited');
	});

	it('preserves every streamed token and tool argument through paging and completion', () => {
		let output = chain(2000);
		const originalLength = output.length;
		output = applyResponseStreamEvent(output, {
			type: 'response.output_item.added',
			output_index: output.length,
			item: { id: 'new-message', type: 'message', content: [] }
		});
		for (let index = 0; index < 100; index++) {
			output = applyResponseStreamEvent(output, {
				type: 'response.output_text.delta',
				item_id: 'new-message',
				content_index: 0,
				delta: `token-${index} `
			});
			buildOutputDisplayItems(selectOutputWindow(output).output);
		}
		expect(getOutputText(output)).toBe(
			Array.from({ length: 100 }, (_, i) => `token-${i} `).join('')
		);
		expect(output).toHaveLength(originalLength + 1);
		expect(output[1].arguments).toBe('{"step":0}');
		expect(JSON.parse(JSON.stringify(output))).toEqual(output);
	});

	it('renders terminal display_file results without cutting off their call', () => {
		const output = chain(80);
		output.push({
			type: 'function_call',
			id: 'file-call',
			call_id: 'file-call',
			name: 'display_file',
			status: 'completed',
			arguments: '{}'
		});
		output.push({
			type: 'function_call_output',
			call_id: 'file-call',
			output: [
				{
					text: JSON.stringify({
						type: 'file',
						source: 'open_terminal',
						path: '/tmp/image.png',
						terminal_selector: 'terminal'
					})
				}
			]
		});
		expect(
			buildOutputDisplayItems(selectOutputWindow(output).output).some(
				(item) => item.type === 'file'
			)
		).toBe(true);
	});

	it('handles missing ids, empty outputs, snapshots and message replacements', () => {
		expect(selectOutputWindow([])).toEqual({
			output: [],
			totalSteps: 0,
			hiddenSteps: 0,
			hiddenTotals: {
				toolCallCount: 0,
				toolCounts: {},
				reasoningCount: 0,
				messageCount: 0,
				codeInterpreterCount: 0,
				failedCount: 0
			},
			hiddenRun: null,
			runStart: 0
		});
		const output = [
			{ type: 'message', content: [{ text: 'one' }] },
			...chain(30),
			{ type: 'message', content: [{ text: 'last' }] }
		];
		const id = selectOutputWindow(output).output.at(-1)?.id;
		expect(selectOutputWindow(output, 100).output.at(-1)?.id).toBe(id);
		expect(selectOutputWindow(JSON.parse(JSON.stringify(output))).output.at(-1)?.id).toBe(id);
		expect(
			selectOutputWindow([{ type: 'message', content: [{ text: 'replacement' }] }]).hiddenSteps
		).toBe(0);
	});
});

describe('tool-chain window fixes', () => {
	const call = (id: string, extra: Partial<OutputItem> = {}): OutputItem => ({
		type: 'function_call',
		id,
		call_id: id,
		name: 'run_command',
		status: 'completed',
		arguments: '{}',
		...extra
	});
	const result = (id: string, extra: Partial<OutputItem> = {}): OutputItem => ({
		type: 'function_call_output',
		id: `out-${id}`,
		call_id: id,
		output: [{ type: 'input_text', text: `result ${id}` }],
		...extra
	});
	const reason = (id: string): OutputItem => ({
		type: 'reasoning',
		id,
		status: 'completed',
		content: [{ text: id }]
	});
	const continuation = (id: string): OutputItem => ({
		type: 'message',
		id,
		status: 'in_progress',
		role: 'assistant',
		content: [{ type: 'output_text', text: '' }]
	});

	it('does not split parallel calls at a page edge', () => {
		const output = [
			reason('r0'),
			call('a'),
			call('b'),
			result('a'),
			result('b'),
			continuation('m0'),
			reason('r1'),
			call('c'),
			result('c')
		];
		// Page of 3 steps: r1, c and one of the parallel calls.
		const ids = selectOutputWindow(output, 3).output.map((item) => item.id);
		expect(ids).toEqual(['r0', 'a', 'b', 'out-a', 'out-b', 'r1', 'c', 'out-c']);
	});

	it('does not attach reasoning from an earlier round to a later call', () => {
		// Rounds without reasoning: r0 belongs to a only.
		const output = [reason('r0'), call('a'), result('a'), call('b'), result('b')];
		const ids = selectOutputWindow(output, 1).output.map((item) => item.id);
		expect(ids).toEqual(['b', 'out-b']);
	});

	it('does not count empty continuation messages as steps', () => {
		const output = [reason('r0'), call('a'), result('a'), continuation('m0')];
		const window = selectOutputWindow(output, 50);
		expect(window.totalSteps).toBe(2);
		expect(window.hiddenSteps).toBe(0);
	});

	it('pins approvals always, but unfinished calls only while the reply is live', () => {
		const output = chain(100);
		output.splice(5, 1); // c1 lost its result, as after a crash
		output[1] = { ...output[1], status: 'requires_approval' };
		output.splice(2, 1); // c0 waits for approval, no result
		const live = selectOutputWindow(output, 10, { live: true }).output.map((item) => item.id);
		const done = selectOutputWindow(output, 10, { live: false }).output.map((item) => item.id);
		expect(live).toContain('c0');
		expect(live).toContain('c1');
		expect(done).toContain('c0');
		expect(done).not.toContain('c1');
	});

	it('summarizes hidden steps of the first group for the collapsed header', () => {
		const output = chain(300);
		output[2] = result('c0', { embeds: ['<b>chart</b>'] });
		output[4] = call('c1', { name: 'read_file', status: 'rejected' });
		const window = selectOutputWindow(output, 50);
		const run = window.hiddenRun!;
		expect(run.steps).toBe(window.hiddenSteps);
		expect(run.toolCallCount).toBe(275);
		expect(run.toolCounts).toEqual({ run_command: 274, read_file: 1 });
		expect(Object.keys(run.toolCounts)[0]).toBe('run_command');
		expect(run.rejected).toBe(true);
		expect(run.embeds).toEqual([
			{ name: 'run_command', embed: '<b>chart</b>', args: '{"step":0}' }
		]);
		expect(window.runStart).toBe(0);
	});

	it('stops the hidden summary at a message with text', () => {
		const output = [
			...chain(10),
			{ type: 'message', id: 'text', content: [{ text: 'progress note' }] },
			...chain(60).map((item) => ({ ...item, id: `late-${item.id}` }))
		];
		const window = selectOutputWindow(output, 50);
		expect(window.hiddenRun?.toolCallCount).toBe(35);
		expect(window.runStart).toBe(31);
	});

	it('keeps the first group id stable when a page is prepended or the window slides', () => {
		const output = chain(200);
		const idOf = (limit: number, items = output) => {
			const window = selectOutputWindow(items, limit);
			return buildWindowDisplayItems(window.output, window)[0].id;
		};
		expect(idOf(50)).toBe('detail-0');
		expect(idOf(100)).toBe('detail-0');
		expect(idOf(50, [...output, ...chain(5).map((item) => ({ ...item, id: `n${item.id}` }))])).toBe(
			'detail-0'
		);
	});

	it('renders a lone first step that continues hidden steps as a group', () => {
		const output = chain(30);
		const window = selectOutputWindow(output, 1);
		const items = buildWindowDisplayItems(window.output, window);
		expect(items[0].type).toBe('detail_group');
		expect(window.hiddenRun?.steps).toBe(window.hiddenSteps);
	});

	it('still never reads hidden reasoning or result bodies while summarizing', () => {
		const output = chain(500);
		for (const index of [0, 3, 30]) {
			Object.defineProperty(output[index], 'content', {
				get: () => {
					throw new Error('hidden reasoning read');
				}
			});
		}
		Object.defineProperty(output[2], 'output', {
			get: () => {
				throw new Error('hidden result read');
			}
		});
		const window = selectOutputWindow(output);
		expect(() => buildWindowDisplayItems(window.output, window)).not.toThrow();
		expect(window.hiddenRun?.toolCallCount).toBe(475);
	});

	it('counts hidden steps between a pinned approval and the recent page', () => {
		const output = chain(200);
		output[1] = { ...output[1], status: 'pending' };
		output.splice(2, 1);
		const window = selectOutputWindow(output, 50, { live: false });
		expect(window.output[1].id).toBe('c0');
		// Everything not shown belongs to the one group the window renders.
		expect(window.hiddenRun?.steps).toBe(window.hiddenSteps);
		expect(window.hiddenRun?.toolCallCount).toBe(200 - 1 - 25);
	});

	it('totals every hidden step when text lines split the chain into many groups', () => {
		// Like a real agent run: a short note after every tool call.
		const output: OutputItem[] = [];
		for (let n = 0; n < 400; n++) {
			output.push(
				reason(`r${n}`),
				call(`c${n}`, { name: n % 4 === 0 ? 'read_file' : 'run_command' }),
				result(`c${n}`),
				{ type: 'message', id: `m${n}`, content: [{ type: 'output_text', text: `note ${n}` }] }
			);
		}
		output[1] = { ...output[1], status: 'failed' };
		const window = selectOutputWindow(output, 50, { live: false });
		const totals = window.hiddenTotals;
		const visibleCalls = window.output.filter((item) => item.type === 'function_call').length;
		expect(totals.toolCallCount).toBe(400 - visibleCalls);
		expect(totals.toolCounts.read_file + totals.toolCounts.run_command).toBe(totals.toolCallCount);
		expect(Object.keys(totals.toolCounts)[0]).toBe('read_file');
		expect(totals.reasoningCount + totals.messageCount + totals.toolCallCount).toBe(
			window.hiddenSteps
		);
		expect(totals.failedCount).toBe(1);
		// The first group's own hidden run is tiny; the totals are not.
		expect(window.hiddenRun?.toolCallCount ?? 0).toBeLessThan(2);
	});
});
