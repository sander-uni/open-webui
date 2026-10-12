import {
	buildOutputDisplayItems,
	type OutputDetailToken,
	type OutputItem
} from './structuredOutput';

const outputKeys = new WeakMap<OutputItem, string>();
const detailKeys = new WeakMap<OutputDetailToken, string>();

/** UI-only paging. Never replace the message's stored output with this window. */
export const OUTPUT_PAGE_SIZE = 50;

export type OutputWindow = {
	output: OutputItem[];
	totalSteps: number;
	hiddenSteps: number;
};

/**
 * Scan metadata, not result bodies. Only the selected tail (and unresolved calls)
 * reaches the existing renderer. Results may follow their calls non-contiguously,
 * as happens with parallel tools, so selecting a plain array suffix is unsafe.
 */
export function selectOutputWindow(
	output: OutputItem[] = [],
	limit = OUTPUT_PAGE_SIZE
): OutputWindow {
	const steps: number[] = [];
	const results = new Map<string, number>();
	for (let index = 0; index < output.length; index++) {
		const item = output[index];
		if (!item) continue;
		if (item.type === 'function_call_output') {
			if (item.call_id) results.set(item.call_id, index);
		} else {
			steps.push(index);
		}
	}

	const count = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : OUTPUT_PAGE_SIZE;
	const selected = new Set(steps.slice(-count));
	for (const index of steps) {
		const item = output[index];
		if (item.type !== 'function_call') continue;
		const resultIndex = results.get(item.call_id ?? item.id ?? '');
		// A completed call with no result is still executing in OpenWebUI.
		if (
			item.status === 'pending' ||
			item.status === 'in_progress' ||
			(item.status === 'completed' && resultIndex === undefined)
		) {
			selected.add(index);
		}
	}

	for (const index of [...selected]) {
		const item = output[index];
		if (item.type !== 'function_call') continue;
		const resultIndex = results.get(item.call_id ?? item.id ?? '');
		if (resultIndex !== undefined) selected.add(resultIndex);
		// Retain the immediately preceding reasoning, including at a page boundary.
		let previous = index - 1;
		while (
			previous >= 0 &&
			['function_call_output', 'function_call'].includes(output[previous]?.type ?? '')
		)
			previous--;
		if (output[previous]?.type === 'reasoning') selected.add(previous);
	}

	const visibleSteps = steps.reduce((count, index) => count + Number(selected.has(index)), 0);
	return {
		output: [...selected]
			.sort((a, b) => a - b)
			.map((index) => {
				const item = output[index];
				// The upstream renderer otherwise uses the local slice index as a key.
				const view = item.id ? item : { ...item, id: `output-window-${index}` };
				outputKeys.set(view, `${item.type}:${item.id ?? item.call_id ?? index}:${index}`);
				return view;
			}),
		totalSteps: steps.length,
		hiddenSteps: steps.length - visibleSteps
	};
}

/** Preserve expansion/focus when a page is prepended to a detail group. */
export function buildWindowDisplayItems(output: OutputItem[]) {
	const items = buildOutputDisplayItems(output);
	const detailTypes = new Set([
		'reasoning',
		'function_call',
		'open_webui:code_interpreter',
		'web_search_call',
		'file_search_call',
		'computer_call'
	]);
	const details = output.filter(
		(item) =>
			detailTypes.has(item.type ?? '') &&
			!(
				item.type === 'function_call' &&
				item.name === 'ask_user' &&
				['pending', 'in_progress'].includes(item.status ?? '')
			)
	);
	let index = 0;
	for (const item of items) {
		const tokens =
			item.type === 'detail_group'
				? item.tokens
				: item.type === 'detail_single'
					? [item.token]
					: [];
		for (const token of tokens) {
			const source = details[index++];
			const key = source && outputKeys.get(source);
			if (key) detailKeys.set(token, key);
		}
	}
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
