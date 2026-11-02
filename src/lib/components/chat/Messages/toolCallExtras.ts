import type { OutputItem, ToolCallExtras, ToolFile } from './structuredOutput';

/**
 * fork: a tool's progress line and media belong right after its step, not above the whole reply.
 * The backend stamps them with the call id (utils/tool_call_events.py); files without
 * one (older chats, other sources) and files of a call that is not in the output stay above the reply.
 */
type Status = { call_id?: string; description?: string; done?: boolean; hidden?: boolean };

const callIdOf = (item: OutputItem) => item.call_id ?? item.id ?? '';
const fileKey = (file: ToolFile) => file?.id ?? file?.url;
// Saved chats and tools can hold anything: never let odd data take the page down.
const list = <T>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : []);

/** Call ids in the output; null without anything stamped, so plain replies never scan their output. */
export function toolCallIds(
	output: OutputItem[] | undefined,
	files: ToolFile[] | undefined,
	statusHistory: Status[] | undefined
): Set<string> | null {
	if (!list(files).some((f) => f?.call_id) && !list(statusHistory).some((s) => s?.call_id)) return null;
	const ids = new Set<string>();
	for (const item of list(output)) {
		if (item?.type === 'function_call') ids.add(callIdOf(item));
	}
	return ids;
}

/** Saved chats and tools can hold anything; Image and FileItem expect strings. */
export function isDisplayableFile(file: ToolFile | null | undefined): boolean {
	if (!file || typeof file !== 'object' || !['image', 'file'].includes(file.type ?? '')) return false;
	const optional = (value: unknown) => value == null || typeof value === 'string';
	// A picture needs its url; a plain attachment can open by id.
	const located = file.type === 'image' ? !!file.url : !!file.url || (typeof file.id === 'string' && !!file.id);
	return (
		located &&
		optional(file.url) &&
		optional(file.name) &&
		optional(file.content_type) &&
		(file.size == null || typeof file.size === 'number')
	);
}

/** The status list expects objects with a text; an empty line above the reply helps nobody. */
export function isDisplayableStatus(status: any): boolean {
	if (!status || typeof status !== 'object') return false;
	if (status.hidden === true) return true; // hides the status line: it must stay last in the list
	return typeof status.description === 'string' ? true : status.description == null && !!status.action;
}

/** The status list keys queries by their text: a repeated query would take the page down. */
export function cleanStatus(status: any): any {
	if (!('queries' in status)) return status;
	const queries = Array.isArray(status.queries) ? status.queries.filter((q: any) => typeof q === 'string') : [];
	return { ...status, queries: [...new Set(queries)] };
}

export function isShownWithToolStep(entry: { call_id?: string }, ids: Set<string> | null): boolean {
	return !!ids && !!entry?.call_id && ids.has(entry.call_id);
}

export function buildToolCallExtras(
	output: OutputItem[] = [],
	files: ToolFile[] = [],
	statusHistory: Status[] = [],
	live = false
): ToolCallExtras {
	files = list(files);
	statusHistory = list(statusHistory);
	output = list(output);
	const extras: ToolCallExtras = { media: new Map(), progress: new Map() };
	const ids = toolCallIds(output, files, statusHistory);
	if (!ids) return extras;

	for (const file of files) {
		if (!isDisplayableFile(file) || !isShownWithToolStep(file, ids)) continue;
		const files = extras.media.get(file.call_id as string);
		if (!files) extras.media.set(file.call_id as string, [file]);
		// The same file attached twice by one call shows once (and the list is keyed by it).
		else if (!files.some((other) => fileKey(other) === fileKey(file))) files.push(file);
	}

	if (live) {
		// A call with a result is finished, whatever its last status said (a tool may return early).
		const finished = new Set<string>();
		for (const item of output) {
			if (item?.type === 'function_call_output' && item.call_id) finished.add(item.call_id);
		}
		const latest = new Map<string, Status>();
		for (const status of statusHistory) {
			if (status && isShownWithToolStep(status, ids)) latest.set(status.call_id as string, status);
		}
		for (const [callId, status] of latest) {
			if (!status.done && !status.hidden && typeof status.description === 'string' && status.description && !finished.has(callId)) {
				extras.progress.set(callId, status.description);
			}
		}
	}
	return extras;
}

/** The newest first, as the server saves them. A file is one attachment per call. */
export function mergeToolFiles(existing: ToolFile[] | undefined, incoming: ToolFile[] = []): ToolFile[] {
	const key = (file: ToolFile) => JSON.stringify([file?.call_id ?? '', fileKey(file) ?? '']);
	const fresh = list(incoming);
	const seen = new Set(fresh.map(key));
	return [...fresh, ...list(existing).filter((file) => !fileKey(file) || !seen.has(key(file)))];
}

/**
 * Tool output decides the url, and players must only load from this server. A browser reads
 * "/\\host/x" as another host, so compare the parsed origin and refuse backslashes and control characters.
 */
export function localMediaPath(url: string | undefined, origin: string): string {
	// eslint-disable-next-line no-control-regex
	if (!url?.startsWith('/') || /[\\\u0000-\u001f]/.test(url)) return '';
	try {
		return new URL(url, origin).origin === origin ? url : '';
	} catch {
		return '';
	}
}

/**
 * An older reply embeds its own player as a three-line <video> or <audio> block (the only form the
 * Markdown renderer plays). A mention of the url, one line, or an example in code does not count.
 */
export function embedsPlayer(content: unknown, url: string | undefined): boolean {
	if (typeof content !== 'string' || !url) return false;
	const text = content.replace(/```[\s\S]*?(```|$)|~~~[\s\S]*?(~~~|$)/g, '');
	const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^ {0,3}<(video|audio)\\b[^>]*>[ \\t]*\\n\\s*${escaped}\\s*\\n\\s*</\\1>`, 'm').test(text);
}
