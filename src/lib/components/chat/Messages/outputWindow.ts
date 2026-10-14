import {
	buildOutputDisplayItems,
	type OutputDetailToken,
	type OutputDisplayItem,
	type OutputItem
} from './structuredOutput';
import { DEFAULT_TOOL_CHAIN_DISPLAY } from '../../../utils/custom-settings';

const outputKeys = new WeakMap<OutputItem, string>();
const sourceIndexes = new WeakMap<OutputItem, number>();
const detailKeys = new WeakMap<OutputDetailToken, string>();

/** UI-only paging. Never replace the message's stored output with this window. */
export const OUTPUT_PAGE_SIZE = DEFAULT_TOOL_CHAIN_DISPLAY.page_size;

// Mirrors structuredOutput.ts: these types are grouped into one collapsible chain.
const DETAIL_TYPES = new Set([
	'reasoning',
	'function_call',
	'open_webui:code_interpreter',
	'web_search_call',
	'file_search_call',
	'computer_call'
]);
const OPENAI_TOOL_NAMES: Record<string, string> = {
	web_search_call: 'Web Search',
	file_search_call: 'File Search',
	computer_call: 'Computer Use'
};
// Open WebUI's pending_tool_calls(): waiting for the user, not for the model.
const AWAITING_USER = new Set(['pending', 'queued', 'requires_approval']);

export type HiddenEmbed = { name: string; embed: unknown; args: string };

/** Hidden steps that belong to the same collapsible group as the first visible step. */
export type HiddenRunSummary = {
	steps: number;
	toolCallCount: number;
	toolCounts: Record<string, number>;
	codeInterpreterCount: number;
	embeds: HiddenEmbed[];
	rejected: boolean;
	failed: boolean;
};

/** Everything paged out of view, across all groups and messages. */
export type HiddenTotals = {
	toolCallCount: number;
	/** Tool name -> hidden calls, in order of first use. */
	toolCounts: Record<string, number>;
	reasoningCount: number;
	messageCount: number;
	codeInterpreterCount: number;
	failedCount: number;
};

export type OutputWindow = {
	output: OutputItem[];
	totalSteps: number;
	hiddenSteps: number;
	/** Counts for all hidden steps, for the paging line. */
	hiddenTotals: HiddenTotals;
	/** Present only when hidden steps continue the first visible detail group. */
	hiddenRun: HiddenRunSummary | null;
	/** Index where the first visible detail group starts in the full output. */
	runStart: number;
};

export type OutputWindowOptions = {
	/** The reply is still streaming. Only then can a call without a result still be running. */
	live?: boolean;
};

function hasText(item: OutputItem): boolean {
	const parts = Array.isArray(item.content) ? item.content : [];
	return parts.some((part) => typeof part?.text === 'string' && part.text.trim() !== '');
}

/** An empty message (for example Open WebUI's tool continuation) renders nothing. */
function isEmptyMessage(item: OutputItem | undefined): boolean {
	return item?.type === 'message' && !hasText(item);
}

function isStep(item: OutputItem | undefined): boolean {
	return !!item && item.type !== 'function_call_output' && !isEmptyMessage(item);
}

/** True for items that stay inside one consecutive details group when rendered. */
function continuesRun(item: OutputItem | undefined, calls: Map<string, OutputItem>): boolean {
	if (!item) return true;
	if (DETAIL_TYPES.has(item.type ?? '')) return true;
	if (item.type === 'function_call_output') {
		// display_file results may render as an inline file, which splits the group.
		return calls.get(item.call_id ?? '')?.name !== 'display_file';
	}
	return isEmptyMessage(item);
}

// Mirrors buildToolCallToken's display name, so hidden counts match visible ones.
function toolName(item: OutputItem): string {
	if (item.type !== 'function_call') return OPENAI_TOOL_NAMES[item.type ?? ''] ?? item.type ?? '';
	const name = item.name ?? '';
	if (name !== 'delegate_task') return name || 'tool';
	try {
		const args =
			typeof item.arguments === 'string'
				? JSON.parse(item.arguments || '{}')
				: (item.arguments ?? {});
		const task = typeof args.task === 'string' && args.task ? args.task : '?';
		const label = args.background ? 'Background sub-agent' : 'Sub-agent';
		return `${label}: "${task.length > 60 ? `${task.slice(0, 60)}...` : task}"`;
	} catch {
		return 'Sub-agent';
	}
}

function parseEmbeds(value: unknown): unknown[] {
	let parsed = value;
	for (let depth = 0; typeof parsed === 'string' && depth < 3; depth++) {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			return [];
		}
	}
	return Array.isArray(parsed) ? parsed : [];
}

function emptySummary(): HiddenRunSummary {
	return {
		steps: 0,
		toolCallCount: 0,
		toolCounts: {},
		codeInterpreterCount: 0,
		embeds: [],
		rejected: false,
		failed: false
	};
}

/**
 * Scan metadata, not result or reasoning bodies. Only the selected tail (and calls that
 * still need attention) reaches the existing renderer. Results may follow their calls
 * non-contiguously, as happens with parallel tools, so a plain array suffix is unsafe.
 */
export function selectOutputWindow(
	output: OutputItem[] = [],
	limit = OUTPUT_PAGE_SIZE,
	{ live = true }: OutputWindowOptions = {}
): OutputWindow {
	const steps: number[] = [];
	const results = new Map<string, number>();
	const calls = new Map<string, OutputItem>();
	for (let index = 0; index < output.length; index++) {
		const item = output[index];
		if (!item) continue;
		if (item.type === 'function_call_output') {
			if (item.call_id) results.set(item.call_id, index);
		} else {
			if (item.type === 'function_call') calls.set(item.call_id ?? item.id ?? '', item);
			if (isStep(item)) steps.push(index);
		}
	}

	const count =
		limit === Infinity
			? steps.length
			: Number.isFinite(limit)
				? Math.max(1, Math.floor(limit))
				: OUTPUT_PAGE_SIZE;
	const selected = new Set(steps.slice(-count));

	for (const index of steps) {
		const item = output[index];
		if (item.type !== 'function_call') continue;
		const status = item.status ?? '';
		const hasResult = results.has(item.call_id ?? item.id ?? '');
		// Approvals wait for the user, so they stay visible. A call without a result is
		// only still running while the reply streams; after a crash it is just history.
		if (
			(!hasResult && AWAITING_USER.has(status)) ||
			(live && !hasResult && (status === 'in_progress' || status === 'completed'))
		) {
			selected.add(index);
		}
	}

	// One model turn's parallel calls are consecutive call items (their results follow
	// later), so select the whole block together with the reasoning that produced it.
	for (const index of [...selected]) {
		if (output[index]?.type !== 'function_call') continue;
		let start = index;
		while (output[start - 1]?.type === 'function_call') start--;
		let end = index;
		while (output[end + 1]?.type === 'function_call') end++;
		for (let call = start; call <= end; call++) {
			selected.add(call);
			const result = results.get(output[call].call_id ?? output[call].id ?? '');
			if (result !== undefined) selected.add(result);
		}
		let previous = start - 1;
		while (previous >= 0 && isEmptyMessage(output[previous])) previous--;
		if (output[previous]?.type === 'reasoning') selected.add(previous);
	}

	const indexes = [...selected].sort((a, b) => a - b);
	const visibleSteps = steps.reduce((total, index) => total + Number(selected.has(index)), 0);

	// Totals for everything hidden. Only names and statuses are read, never bodies.
	const hiddenTotals: HiddenTotals = {
		toolCallCount: 0,
		toolCounts: {},
		reasoningCount: 0,
		messageCount: 0,
		codeInterpreterCount: 0,
		failedCount: 0
	};
	for (const index of steps) {
		if (selected.has(index)) continue;
		const item = output[index];
		if (item.type === 'reasoning') hiddenTotals.reasoningCount++;
		else if (item.type === 'message') hiddenTotals.messageCount++;
		else if (item.type === 'open_webui:code_interpreter') hiddenTotals.codeInterpreterCount++;
		else if (item.type === 'function_call' || OPENAI_TOOL_NAMES[item.type ?? '']) {
			const name = toolName(item);
			hiddenTotals.toolCallCount++;
			hiddenTotals.toolCounts[name] = (hiddenTotals.toolCounts[name] ?? 0) + 1;
			if (item.status === 'failed' || item.status === 'rejected') hiddenTotals.failedCount++;
		}
	}

	// Hidden steps directly before the first visible step that would render in the same
	// group. Their counts and embeds keep the collapsed group header accurate.
	let hiddenRun: HiddenRunSummary | null = null;
	let runStart = indexes[0] ?? 0;
	if (indexes.length && DETAIL_TYPES.has(output[indexes[0]]?.type ?? '')) {
		const summary = emptySummary();
		const earliest: Record<string, number> = {};
		const embeds: Array<[number, HiddenEmbed]> = [];
		const addTool = (name: string, at: number) => {
			summary.toolCallCount++;
			summary.toolCounts[name] = (summary.toolCounts[name] ?? 0) + 1;
			earliest[name] = Math.min(earliest[name] ?? at, at);
		};
		const addHidden = (index: number) => {
			const item = output[index];
			if (!item || selected.has(index) || !continuesRun(item, calls)) return;
			if (isStep(item)) summary.steps++;
			if (item.type === 'open_webui:code_interpreter') {
				summary.codeInterpreterCount++;
			} else if (item.type === 'function_call') {
				if (item.name === 'ask_user' && AWAITING_USER.has(item.status ?? '')) return;
				const name = toolName(item);
				addTool(name, index);
				summary.rejected ||= item.status === 'rejected';
				summary.failed ||= item.status === 'failed';
				const result = output[results.get(item.call_id ?? item.id ?? '') ?? -1];
				const args =
					typeof item.arguments === 'string'
						? item.arguments
						: JSON.stringify(item.arguments ?? '');
				for (const embed of parseEmbeds(result?.embeds))
					embeds.push([index, { name, embed, args }]);
			} else if (OPENAI_TOOL_NAMES[item.type ?? '']) {
				addTool(toolName(item), index);
			}
		};
		// Hidden steps before the first visible one, back to where its group starts.
		let index = indexes[0] - 1;
		for (; index >= 0 && continuesRun(output[index], calls); index--) addHidden(index);
		runStart = index + 1;
		// Hidden steps between visible ones (for example after a pinned approval) render
		// merged into the same group, up to the first visible step that ends it.
		for (let next = indexes[0] + 1; next < output.length; next++) {
			if (selected.has(next) && !continuesRun(output[next], calls)) break;
			addHidden(next);
		}
		// The full view lists tool names and embeds in chain order; match it.
		summary.toolCounts = Object.fromEntries(
			Object.entries(summary.toolCounts).sort(([a], [b]) => earliest[a] - earliest[b])
		);
		summary.embeds = embeds.sort(([a], [b]) => a - b).map(([, embed]) => embed);
		if (summary.steps > 0) hiddenRun = summary;
	}

	return {
		output: indexes.map((index) => {
			const item = output[index];
			// The upstream renderer otherwise uses the local slice index as a key.
			const view = item.id ? item : { ...item, id: `output-window-${index}` };
			outputKeys.set(view, `${item.type}:${item.id ?? item.call_id ?? index}:${index}`);
			sourceIndexes.set(view, index);
			return view;
		}),
		totalSteps: steps.length,
		hiddenSteps: steps.length - visibleSteps,
		hiddenTotals,
		hiddenRun,
		runStart
	};
}

/**
 * Build display items for a window. Detail groups get ids from where they start in the
 * full output, so prepending a page or sliding the window keeps each group's component
 * (and its open/closed state) instead of reusing it for different content.
 */
export function buildWindowDisplayItems(
	output: OutputItem[],
	window?: Pick<OutputWindow, 'hiddenRun' | 'runStart'>
): OutputDisplayItem[] {
	const items = buildOutputDisplayItems(output);
	const details = output.filter(
		(item) =>
			DETAIL_TYPES.has(item.type ?? '') &&
			!(
				item.type === 'function_call' &&
				item.name === 'ask_user' &&
				['pending', 'in_progress'].includes(item.status ?? '')
			)
	);
	let index = 0;
	items.forEach((item, position) => {
		const tokens =
			item.type === 'detail_group'
				? item.tokens
				: item.type === 'detail_single'
					? [item.token]
					: [];
		let first: number | undefined;
		for (const token of tokens) {
			const source = details[index++];
			const key = source && outputKeys.get(source);
			if (key) detailKeys.set(token, key);
			if (first === undefined && source) first = sourceIndexes.get(source);
		}
		if (!tokens.length) return;
		const start = position === 0 && window ? window.runStart : first;
		if (start !== undefined) item.id = `detail-${start}`;
		// A group that continues into hidden steps renders as a group, as in the full view.
		if (position === 0 && window?.hiddenRun && item.type === 'detail_single') {
			items[0] = { type: 'detail_group', id: item.id, tokens: [item.token] };
		}
	});
	return items;
}

export function getOutputDetailKey(token: OutputDetailToken, index: number): string {
	return detailKeys.get(token) ?? `${token.attributes.type}:${token.attributes.id ?? ''}:${index}`;
}

/**
 * ResponseMessage renders output read-only; its edit path already deep-clones
 * output explicitly. Keep that shared output reference here, while preserving
 * isolation of annotations, files, status history and other mutable UI fields.
 */
export function snapshotResponseMessage<T extends { output?: OutputItem[] }>(message: T): T {
	const { output, ...rest } = message;
	const snapshot = structuredClone(rest) as T;
	if ('output' in message) snapshot.output = output;
	return snapshot;
}
