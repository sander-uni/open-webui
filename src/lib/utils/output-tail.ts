// Fork: continued replies stream only the changed end of the output (see
// backend/open_webui/utils/output_tail.py). The chat requests this with a header.
export const OUTPUT_TAIL_HEADER = 'X-OpenWebUI-Output-Tail';

type TailEvent = { output_tail?: unknown; output_start?: unknown; output_length?: unknown };

/** Merge a tail update into the output already shown, or undefined if it cannot apply. */
export function applyOutputTail<T>(
	current: T[] | null | undefined,
	data: TailEvent | null | undefined
) {
	const tail = data?.output_tail;
	const start = data?.output_start;
	if (!Array.isArray(tail) || typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
		return undefined;
	}
	const previous = Array.isArray(current) ? current : [];
	// A gap means an update was missed; wait for the next full output instead.
	if (start > previous.length) return undefined;
	if (data?.output_length !== undefined && data.output_length !== start + tail.length)
		return undefined;
	return [...previous.slice(0, start), ...(tail as T[])];
}
