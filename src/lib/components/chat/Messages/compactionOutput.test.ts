// Fork 0.3.4: how a reply shows ctxproxy's context compactions.
import { describe, expect, it } from 'vitest';
import {
	applyResponseStreamEvent,
	buildOutputDisplayItems,
	COMPACTION_ITEM_TYPE,
	type OutputItem
} from './structuredOutput';
import { buildWindowDisplayItems, selectOutputWindow } from './outputWindow';
import { compactionLabel } from '../../compaction/label';

const call = (id: string): OutputItem =>
	({ type: 'function_call', id, call_id: id, name: 'run_command', status: 'completed', arguments: '{}' }) as OutputItem;
const result = (id: string): OutputItem =>
	({
		type: 'function_call_output',
		id: `o-${id}`,
		call_id: id,
		status: 'completed',
		output: [{ type: 'input_text', text: 'ok' }]
	}) as OutputItem;
const compaction = (extra: Record<string, unknown> = {}): OutputItem =>
	({ type: COMPACTION_ITEM_TYPE, id: 'cmp_1', status: 'completed', kind: 'summary', n: 3, conv: 'abc123', seconds: 41.2, ...extra }) as OutputItem;

const label = (over: Partial<Parameters<typeof compactionLabel>[0]> = {}) =>
	compactionLabel({ kind: 'summary', status: 'completed', n: 3, seconds: 41.2, dropped: null, messageDone: true, ...over });

describe('compactions in a reply', () => {
	it('is its own step between the tool steps', () => {
		const items = buildOutputDisplayItems([call('a'), result('a'), compaction(), call('b'), result('b')]);
		expect(items.map((i) => i.type)).toEqual(['detail_single', 'compaction', 'detail_single']);
		const step = items[1] as any;
		expect([step.kind, step.status, step.n, step.conv, step.seconds]).toEqual(['summary', 'completed', 3, 'abc123', 41.2]);
	});

	it('reads a cut and a failure', () => {
		const cut = buildOutputDisplayItems([compaction({ kind: 'cut', n: 4, dropped_steps: 12, seconds: undefined })])[0] as any;
		expect([cut.kind, cut.n, cut.dropped]).toEqual(['cut', 4, 12]);
		const failed = buildOutputDisplayItems([compaction({ status: 'failed', n: undefined, reason: 'HTTP 500: boom' })])[0] as any;
		expect([failed.status, failed.n, failed.reason]).toEqual(['failed', null, 'HTTP 500: boom']);
	});

	it('streams in through the same added/done events as other items', () => {
		let output: OutputItem[] = [call('a'), result('a')];
		const running = { type: COMPACTION_ITEM_TYPE, id: 'cmp_1', status: 'in_progress', kind: 'summary' };
		output = applyResponseStreamEvent(output, { type: 'response.output_item.added', output_index: 2, item: running });
		expect((buildOutputDisplayItems(output)[1] as any).status).toBe('in_progress');
		output = applyResponseStreamEvent(output, { type: 'response.output_item.done', output_index: 2, item: compaction() });
		expect(output).toHaveLength(3);
		expect((buildOutputDisplayItems(output)[1] as any).n).toBe(3);
	});

	it('counts as a step for the pager and is named when paged out', () => {
		const output: OutputItem[] = [compaction()];
		for (let i = 0; i < 12; i++) output.push(call(`c${i}`), result(`c${i}`));
		const window = selectOutputWindow(output, 10, { live: false });
		expect(window.totalSteps).toBe(13);
		expect(window.hiddenTotals.compactionCount).toBe(1);
		const all = selectOutputWindow(output, Infinity, { live: false });
		expect(buildWindowDisplayItems(all.output, all).map((i) => i.type)).toEqual(['compaction', 'detail_group']);
	});

	it('says what happened', () => {
		expect(label({ status: 'in_progress', messageDone: false })).toMatchObject({ state: 'running', title: 'Compacting context…' });
		expect(label()).toEqual({ state: 'done', title: 'Compaction #3', detail: '41 s' });
		expect(label({ kind: 'cut', n: 4, seconds: null, dropped: 12 })).toEqual({
			state: 'done',
			title: 'Compaction #4: context cut without a summary',
			detail: '12 steps removed'
		});
		expect(label({ status: 'failed', n: null }).state).toBe('failed');
		// the reply ended while the summary was still being written
		expect(label({ status: 'in_progress', messageDone: true }).state).toBe('interrupted');
		expect(label({ status: 'incomplete' }).state).toBe('interrupted');
		expect(label({ n: null }).state).toBe('interrupted');
	});
});
