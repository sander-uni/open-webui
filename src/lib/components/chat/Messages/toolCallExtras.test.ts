import { describe, expect, it } from 'vitest';
import type { OutputItem, ToolFile } from './structuredOutput';
import { buildOutputDisplayItems } from './structuredOutput';
import { buildWindowDisplayItems, selectOutputWindow } from './outputWindow';
import {
	buildToolCallExtras,
	cleanStatus,
	isDisplayableFile,
	isDisplayableStatus,
	embedsPlayer,
	isShownWithToolStep,
	localMediaPath,
	mergeToolFiles,
	toolCallIds
} from './toolCallExtras';

function step(id: string, withResult = true, name = 'run_command'): OutputItem[] {
	const items: OutputItem[] = [
		{ type: 'reasoning', id: `r${id}`, status: 'completed', content: [{ text: `why ${id}` }] },
		{ type: 'function_call', id, call_id: id, name, status: 'completed', arguments: '{}' }
	];
	if (withResult) {
		items.push({
			type: 'function_call_output',
			id: `o${id}`,
			call_id: id,
			status: 'completed',
			output: [{ type: 'input_text', text: 'ok' }]
		});
	}
	return items;
}
const picture = (id: string, call?: string): ToolFile => ({
	type: 'image',
	id,
	url: `/api/v1/files/${id}/content`,
	content_type: 'image/png',
	...(call ? { call_id: call } : {})
});
const types = (items: { type: string }[]) => items.map((item) => item.type);

describe('tool media and progress after their step', () => {
	it('puts media right after the step that made it, for each of several tools', () => {
		const output = [...step('a'), ...step('b', true, 'make_image'), ...step('c'), ...step('d', true, 'make_video')];
		const extras = buildToolCallExtras(output, [picture('new', 'd'), picture('old', 'b')], []);
		const items = buildOutputDisplayItems(output, extras);
		expect(types(items)).toEqual(['detail_group', 'tool_media', 'detail_group', 'tool_media']);
		expect((items[1] as any).files[0].id).toBe('old');
		expect((items[3] as any).files[0].id).toBe('new');
	});

	it('keeps files without a call, or of an unknown call, above the reply', () => {
		const output = step('a');
		const ids = toolCallIds(output, [picture('x', 'a')], []);
		expect(isShownWithToolStep(picture('x', 'a'), ids)).toBe(true);
		expect(isShownWithToolStep(picture('y'), ids)).toBe(false);
		expect(isShownWithToolStep(picture('z', 'gone'), ids)).toBe(false);
		expect(toolCallIds(output, [picture('y')], [])).toBeNull();
		expect(buildToolCallExtras(output, [picture('y'), picture('z', 'gone')], []).media.size).toBe(0);
	});

	it('shows the latest progress only while the call runs and the reply is live', () => {
		const running = [...step('a'), ...step('b', false, 'make_image')];
		const statuses = [
			{ call_id: 'b', description: 'first', done: false },
			{ call_id: 'b', description: 'latest', done: false }
		];
		const live = buildToolCallExtras(running, [], statuses, true);
		expect(live.progress.get('b')).toBe('latest');
		const items = buildOutputDisplayItems(running, live);
		expect(types(items)).toEqual(['detail_group', 'tool_progress']);
		expect((items[1] as any).text).toBe('latest');

		expect(buildToolCallExtras(running, [], statuses, false).progress.size).toBe(0);
		expect(
			buildToolCallExtras(running, [], [...statuses, { call_id: 'b', description: 'done', done: true }], true)
				.progress.size
		).toBe(0);
		const finished = [...step('a'), ...step('b', true, 'make_image')];
		expect(buildToolCallExtras(finished, [], statuses, true).progress.size).toBe(0);
	});

	it('shows both when a tool attaches files before its last status', () => {
		const output = step('b', false, 'make_image');
		const extras = buildToolCallExtras(output, [picture('p', 'b')], [{ call_id: 'b', description: 'saving' }], true);
		expect(types(buildOutputDisplayItems(output, extras))).toEqual(['detail_group', 'tool_progress', 'tool_media']);
	});

	it('keeps groups the same while a progress line comes and goes', () => {
		const call = (id: string): OutputItem => ({ type: 'function_call', id, call_id: id, name: 'make_image', status: 'completed', arguments: '{}' });
		const result = (id: string): OutputItem => ({ type: 'function_call_output', id: `o${id}`, call_id: id, status: 'completed', output: [] });
		const parallel = [call('a'), call('b')];
		const running = buildToolCallExtras(parallel, [], [{ call_id: 'a', description: 'a runs' }], true);
		expect(types(buildOutputDisplayItems(parallel, running))).toEqual(['detail_group', 'tool_progress']);
		expect(types(buildOutputDisplayItems(parallel))).toEqual(['detail_group']);
		// a running call followed by the next step: the group just goes on when the line is gone
		const then = [...step('x'), ...step('y')];
		const none = buildToolCallExtras(then, [], [{ call_id: 'y', description: 'old' }], true);
		expect(types(buildOutputDisplayItems(then, none))).toEqual(['detail_group']);
		// parallel media stays behind the whole block, each call in order
		const both = [call('a'), call('b'), result('a'), result('b'), ...step('z')];
		const media = buildToolCallExtras(both, [picture('pa', 'a'), picture('pb', 'b')], []);
		const items = buildOutputDisplayItems(both, media);
		expect(types(items)).toEqual(['detail_group', 'tool_media', 'tool_media', 'detail_group']);
		expect((items[1] as any).files[0].id).toBe('pa');
		// a new turn's call right after a result does not join the block before the media
		const turns = [call('a'), result('a'), call('b'), result('b')];
		const first = buildToolCallExtras(turns, [picture('pa', 'a')], []);
		expect(types(buildOutputDisplayItems(turns, first))).toEqual(['detail_single', 'tool_media', 'detail_single']);
	});

	it('keeps a group id when paging reveals the media before it', () => {
		const output = Array.from({ length: 30 }, (_, i) => step(`s${i}`)).flat();
		const extras = buildToolCallExtras(output, [picture('p', 's20')], []);
		const ids = (limit: number) => {
			const window = selectOutputWindow(output, limit, { live: false, extras });
			return buildWindowDisplayItems(window.output, window, extras).map((item) => item.id);
		};
		const last = ids(18).at(-1);
		expect(ids(Infinity).at(-1)).toBe(last);
	});

	it('shows a file once per call, and for each call that attached it', () => {
		const output = [...step('a'), ...step('b')];
		const extras = buildToolCallExtras(output, [picture('same', 'b'), picture('same', 'b'), picture('same', 'a')], []);
		expect(extras.media.get('b')?.length).toBe(1);
		expect(extras.media.get('a')?.length).toBe(1);
		const live = mergeToolFiles([picture('same', 'a')], [picture('same', 'b')]);
		expect(live.map((f) => f.call_id)).toEqual(['b', 'a']);
	});

	it('lets players load only from this server', () => {
		const origin = 'https://chat.example';
		expect(localMediaPath('/api/v1/files/x/content', origin)).toBe('/api/v1/files/x/content');
		for (const url of ['//evil.example/a.mp4', '/\\evil.example/a.mp4', 'https://evil.example/a.mp4', '/a\nb', undefined]) {
			expect(localMediaPath(url, origin)).toBe('');
		}
	});

	it('merges a later tool\'s files instead of replacing them', () => {
		const merged = mergeToolFiles([picture('one', 'a')], [picture('two', 'b')]);
		expect(merged.map((f) => f.id)).toEqual(['two', 'one']);
		expect(mergeToolFiles(merged, [picture('one', 'a')]).map((f) => f.id)).toEqual(['one', 'two']);
		expect(mergeToolFiles(undefined, [picture('a')]).length).toBe(1);
	});
});

describe('paging with tool media', () => {
	const long = () => Array.from({ length: 30 }, (_, i) => step(`s${i}`, true, i === 10 ? 'make_image' : 'run_command')).flat();

	it('media inside a cluster brought in whole sits right after its step', () => {
		const note: OutputItem = { type: 'message', id: 'n', content: [{ type: 'output_text', text: 'note' }] };
		const cluster = Array.from({ length: 100 }, (_, i) => step(`k${i}`)).flat();
		const output = [...long(), note, ...cluster, note];
		const extras = buildToolCallExtras(output, [picture('p', 'k95')], []);
		// the cut lands before k95's media ends its group, which is cut, so it comes in whole
		const window = selectOutputWindow(output, 20, { live: false, extras });
		const items = buildWindowDisplayItems(window.output, window, extras);
		expect(window.keptGroupSize).toBe(192);
		expect(types(items)).toEqual(['detail_group', 'tool_media', 'detail_group', 'message']);
		expect((items[0] as any).tokens.at(-1).attributes.id).toBe('k95');
		expect(window.hiddenTotals.mediaCount).toBe(0);
	});

	it('counts media of hidden steps and shows it again with its step', () => {
		const output = long();
		const extras = buildToolCallExtras(output, [picture('p', 's10')], []);
		const hidden = selectOutputWindow(output, 10, { live: false, extras });
		expect(hidden.hiddenTotals.mediaCount).toBe(1);
		const items = buildWindowDisplayItems(hidden.output, hidden, extras);
		expect(types(items)).not.toContain('tool_media');

		const all = selectOutputWindow(output, Infinity, { live: false, extras });
		expect(all.hiddenTotals.mediaCount).toBe(0);
		expect(types(buildWindowDisplayItems(all.output, all, extras))).toEqual(['detail_group', 'tool_media', 'detail_group']);
	});

	it('does not count steps before a media step into the first visible group', () => {
		const output = long();
		const extras = buildToolCallExtras(output, [picture('p', 's20')], []);
		// the window starts right after s20's step: the group above ends at the picture
		const window = selectOutputWindow(output, 18, { live: false, extras });
		expect(window.output[0].id).toBe('rs21');
		expect(window.hiddenRun).toBeNull();
		expect(window.runStart).toBe(output.findIndex((item) => item.id === 'rs21'));
	});

	it('keeps a first visible call with media from taking in later hidden steps', () => {
		const output = long();
		const extras = buildToolCallExtras(output, [picture('p', 's29')], []);
		const window = selectOutputWindow(output, 1, { live: false, extras });
		const items = buildWindowDisplayItems(window.output, window, extras);
		expect(types(items)).toContain('tool_media');
		expect(items[items.length - 1].type).toBe('tool_media');
	});

	it('leaves replies without stamped files exactly as before', () => {
		const output = long();
		const extras = buildToolCallExtras(output, [picture('p')], [{ description: 'x' }], true);
		const { extras: _with, ...withExtras } = selectOutputWindow(output, 10, { live: false, extras });
		const { extras: _without, ...plain } = selectOutputWindow(output, 10, { live: false });
		expect(withExtras).toEqual(plain);
		expect(buildOutputDisplayItems(output, extras)).toEqual(buildOutputDisplayItems(output));
	});
});

describe('robustness', () => {
	it('survives odd saved data', () => {
		const odd: any = [null, 'x', 3, {}, { call_id: 'a' }, { call_id: 'a', type: 'image' }, { call_id: 5, type: 'image', url: 7 }];
		for (const files of [odd, 'x', {}, null, undefined, 5] as any[]) {
			for (const statuses of [odd, 'x', {}, null, undefined, 5] as any[]) {
				const output = step('a', false);
				const extras = buildToolCallExtras(output, files, statuses, true);
				buildOutputDisplayItems(output, extras);
				const window = selectOutputWindow(output, 50, { extras });
				buildWindowDisplayItems(window.output, window, extras);
				mergeToolFiles(files, statuses);
				toolCallIds(output, files, statuses);
			}
		}
	});

	it('tells an embedded player from a mention of its url', () => {
		const url = '/api/v1/files/a.b/content';
		expect(embedsPlayer(`Look:\n\n<video>\n${url}\n</video>\n`, url)).toBe(true);
		expect(embedsPlayer(`<audio>\n${url}\n</audio>`, url)).toBe(true);
		expect(embedsPlayer(`See ${url} or [here](${url})`, url)).toBe(false);
		expect(embedsPlayer(`<video>\n${url}`, url)).toBe(false);
		expect(embedsPlayer(`<video>/api/v1/files/aXb/content</video>`, url)).toBe(false);
		expect(embedsPlayer(undefined, url)).toBe(false);
		expect(embedsPlayer('x', undefined)).toBe(false);
	});

	it('keeps every group id through paging, also with pinned approvals', () => {
		const pending = (id: string): OutputItem => ({ type: 'function_call', id, call_id: id, name: 'run', status: 'pending', arguments: '{}' });
		const output: OutputItem[] = [...step('a'), pending('pin'), ...Array.from({ length: 12 }, (_, i) => step(`s${i}`)).flat()];
		const extras = buildToolCallExtras(output, [picture('p', 's3')], []);
		const full = selectOutputWindow(output, Infinity, { live: false, extras });
		const fullIds = new Set(buildWindowDisplayItems(full.output, full, extras).map((item) => item.id));
		for (const limit of [1, 2, 3, 5, 8, 12, 20]) {
			const window = selectOutputWindow(output, limit, { live: false, extras });
			for (const item of buildWindowDisplayItems(window.output, window, extras)) {
				expect(fullIds.has(item.id), `${item.id} at limit ${limit}`).toBe(true);
			}
		}
	});

	it('counts a hidden media step in the group summary', () => {
		const pending = (id: string): OutputItem => ({ type: 'function_call', id, call_id: id, name: 'run', status: 'pending', arguments: '{}' });
		const output: OutputItem[] = [pending('pin'), ...step('b'), ...step('c')];
		const extras = buildToolCallExtras(output, [picture('p', 'b')], []);
		// live: a finished reply brings the pin's whole cluster in (below)
		const window = selectOutputWindow(output, 2, { live: true, extras });
		expect(window.hiddenSteps).toBeGreaterThan(0);
		expect(window.hiddenRun?.steps).toBe(window.hiddenSteps);
		const done = selectOutputWindow(output, 2, { live: false, extras });
		expect(types(buildWindowDisplayItems(done.output, done, extras))).toEqual(['detail_group', 'tool_media', 'detail_group']);
	});
});

describe('reused call ids', () => {
	it('shows media once, at the first call with that id', () => {
		const output = [...step('same'), ...step('other'), ...step('same')];
		const extras = buildToolCallExtras(output, [picture('p', 'same')], []);
		const items = buildOutputDisplayItems(output, extras);
		expect(items.filter((item) => item.type === 'tool_media').length).toBe(1);
		const window = selectOutputWindow(output, Infinity, { live: false, extras });
		const ids = buildWindowDisplayItems(window.output, window, extras).map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('shows one progress line for a call id running twice', () => {
		const output = [...step('same', false), ...step('same', false)];
		const extras = buildToolCallExtras(output, [], [{ call_id: 'same', description: 'x' }], true);
		expect(buildOutputDisplayItems(output, extras).filter((item) => item.type === 'tool_progress').length).toBe(1);
	});
});

describe('round 3', () => {
	const triple = (id: string, callId = id): OutputItem[] => [
		{ type: 'reasoning', id: `r${id}`, status: 'completed', content: [{ text: 'x' }] },
		{ type: 'function_call', id, call_id: callId, name: 'run', status: 'completed', arguments: '{}' },
		{ type: 'function_call_output', id: `o${id}`, call_id: callId, status: 'completed', output: [] }
	];
	const ids = (output: OutputItem[], files: ToolFile[], limit: number) => {
		const extras = buildToolCallExtras(output, files, []);
		const window = selectOutputWindow(output, limit, { live: false, extras });
		return buildWindowDisplayItems(window.output, window, extras).map((item) => item.id);
	};

	it('never gives two items the same id, at any page size, with reused call ids', () => {
		const output = [...triple('a', 'same'), ...triple('b', 'other'), ...triple('c', 'same'), ...triple('d', 'tail')];
		for (let limit = 1; limit <= 9; limit++) {
			const list = ids(output, [picture('p', 'same')], limit);
			expect(new Set(list).size, `limit ${limit}: ${list}`).toBe(list.length);
		}
	});

	it('media of a reused id stays with its first call, or hides with it', () => {
		const output = [...triple('a', 'same'), ...triple('b', 'other'), ...triple('c', 'same')];
		const extras = buildToolCallExtras(output, [picture('p', 'same')], []);
		const hidden = selectOutputWindow(output, 2, { live: false, extras });
		expect(buildWindowDisplayItems(hidden.output, hidden, extras).some((i) => i.type === 'tool_media')).toBe(false);
		const all = selectOutputWindow(output, Infinity, { live: false, extras });
		const items = buildWindowDisplayItems(all.output, all, extras);
		expect(types(items)).toEqual(['detail_group', 'tool_media', 'detail_group']);
	});

	it('keeps groups apart when the media between them is hidden', () => {
		const pending: OutputItem = { type: 'function_call', id: 'A', call_id: 'A', name: 'run', status: 'pending', arguments: '{}' };
		const output: OutputItem[] = [pending, ...triple('B'), ...triple('C')];
		const extras = buildToolCallExtras(output, [picture('p', 'B')], []);
		// live: only then can the media between them still be hidden
		const window = selectOutputWindow(output, 2, { live: true, extras });
		const paged = buildWindowDisplayItems(window.output, window, extras).map((i) => i.id);
		const full = selectOutputWindow(output, Infinity, { live: false, extras });
		const fullIds = buildWindowDisplayItems(full.output, full, extras).map((i) => i.id);
		for (const id of paged) expect(fullIds).toContain(id);
		expect(paged.length).toBe(2);
	});

	it('refuses file fields a renderer would choke on', () => {
		const ok = { type: 'file', url: '/x' };
		expect(isDisplayableFile(ok)).toBe(true);
		for (const bad of [{ ...ok, content_type: 7 }, { ...ok, name: 7 }, { ...ok, size: 'big' }, { ...ok, url: 7 }, { type: 'x', url: '/x' }, null, 'x'] as any[]) {
			expect(isDisplayableFile(bad)).toBe(false);
		}
	});

	it('cleans repeated or odd queries', () => {
		expect(cleanStatus({ action: 'queries_generated', queries: ['x', 'x', 3, 'y'] }).queries).toEqual(['x', 'y']);
		expect(cleanStatus({ queries: 'x' }).queries).toEqual([]);
		const plain = { description: 'x' };
		expect(cleanStatus(plain)).toBe(plain);
	});

	it('does not count an example in code, or one line, as an embedded player', () => {
		const url = '/api/v1/files/a/content';
		expect(embedsPlayer('```html\n<video>\n' + url + '\n</video>\n```', url)).toBe(false);
		expect(embedsPlayer('<audio>' + url + '</audio>', url)).toBe(false);
		expect(embedsPlayer('Look\n\n<audio>\n' + url + '\n</audio>\n', url)).toBe(true);
	});

	it('does not confuse ids that look alike when joined', () => {
		const merged = mergeToolFiles([{ id: 'b:c', call_id: 'a', type: 'image' }], [{ id: 'c', call_id: 'a:b', type: 'image' }]);
		expect(merged.length).toBe(2);
	});
});

describe('round 4', () => {
	const call = (id: string, name = 'run'): OutputItem => ({ type: 'function_call', id, call_id: id, name, status: 'completed', arguments: '{"path":"x"}' });
	const result = (id: string, text = 'ok'): OutputItem => ({ type: 'function_call_output', id: `o${id}`, call_id: id, status: 'completed', output: [{ type: 'input_text', text }] });
	const paged = (output: OutputItem[]) => {
		const window = selectOutputWindow(output, Infinity, { live: false });
		return buildWindowDisplayItems(window.output, window);
	};

	it('groups exactly as the plain renderer does when nothing is stamped', () => {
		const message = (text: string): OutputItem => ({ type: 'message', id: `m${text}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
		const cases: OutputItem[][] = [
			[call('a', 'display_file'), result('a', 'Error: no such file'), call('b'), result('b')],
			[call('a'), result('a'), { type: 'image_generation_call', id: 'i' } as OutputItem, call('b'), result('b')],
			[call('a'), result('a'), { type: 'something_new', id: 'n' } as OutputItem, call('b'), result('b')],
			[call('a'), result('a'), message(''), call('b'), result('b')],
			[call('a'), result('a'), message('text'), call('b'), result('b')],
			[call('a'), { type: 'function_call_output', id: 'oa', call_id: 'a', status: 'completed', output: [], interjections: [{ id: 'x', text: 'hi' }] } as OutputItem, call('b'), result('b')],
			[call('a'), result('a'), { type: 'function_call', id: 'q', call_id: 'q', name: 'ask_user', status: 'pending', arguments: '{}' }, call('b'), result('b')]
		];
		for (const output of cases) {
			expect(types(paged(output)), JSON.stringify(output.map((o) => o.type))).toEqual(types(buildOutputDisplayItems(output)));
		}
	});

	it('never leaves a duplicate id, even when a new id collides with an old one', () => {
		const m = (id: string): OutputItem => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: id }] });
		for (const ids of [['a-3~3', 'a-3', 'a', 'a'], ['a', 'a', 'a', 'a'], ['a~1', 'a', 'a', 'a~2', 'a']]) {
			const list = paged(ids.map(m)).map((item) => item.id);
			expect(new Set(list).size, list.join()).toBe(list.length);
		}
	});
});

describe('round 5', () => {
	it('keeps a plain attachment that opens by id, and refuses a picture without a url', () => {
		expect(isDisplayableFile({ type: 'file', id: 'x', name: 'report.pdf' })).toBe(true);
		expect(isDisplayableFile({ type: 'image', id: 'x' })).toBe(false);
		expect(isDisplayableFile({ type: 'file' })).toBe(false);
		expect(isDisplayableFile({ type: 'file', id: 'x', url: 7 } as any)).toBe(false);
	});

	it('keeps the status that hides the line', () => {
		expect(isDisplayableStatus({ done: true, hidden: true })).toBe(true);
		expect(isDisplayableStatus({})).toBe(false);
	});

	it('does not split a group on an image item that renders nothing', () => {
		const call = (id: string): OutputItem => ({ type: 'function_call', id, call_id: id, name: 'run', status: 'completed', arguments: '{}' });
		const output = [call('a'), { type: 'image_generation_call', id: 'i', result: {} } as any, call('b')];
		const window = selectOutputWindow(output, Infinity, { live: false });
		expect(types(buildWindowDisplayItems(window.output, window))).toEqual(types(buildOutputDisplayItems(output)));
	});

	it('counts hidden media once for a reused call id', () => {
		const output = [...step('same'), ...step('same'), ...step('same'), ...step('tail')];
		const extras = buildToolCallExtras(output, [picture('p', 'same')], []);
		expect(selectOutputWindow(output, 2, { live: false, extras }).hiddenTotals.mediaCount).toBe(1);
	});
});
