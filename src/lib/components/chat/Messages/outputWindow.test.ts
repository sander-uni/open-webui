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
		expect(window.output.map((item) => item.type)).toEqual([
			'reasoning',
			'function_call',
			'function_call_output'
		]);
		expect(JSON.stringify(buildOutputDisplayItems(window.output))).toContain('two-result');
		expect(window.output).not.toContain(output[4]);
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
		expect(selectOutputWindow([])).toEqual({ output: [], totalSteps: 0, hiddenSteps: 0 });
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
