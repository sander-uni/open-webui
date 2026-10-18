// Fork addition (0.3.4): what a compaction step says. Kept apart from the component so it can be tested.

export type CompactionLabel = {
	state: 'running' | 'done' | 'failed' | 'interrupted';
	title: string;
	detail: string;
};

const seconds = (value: number | null) =>
	value === null ? '' : value < 60 ? `${Math.max(1, Math.round(value))} s` : `${Math.round(value / 60)} min`;

export function compactionLabel({
	kind,
	status,
	n,
	seconds: took,
	dropped,
	messageDone
}: {
	kind: 'summary' | 'cut';
	status: string;
	n: number | null;
	seconds: number | null;
	dropped: number | null;
	messageDone: boolean;
}): CompactionLabel {
	if (status === 'in_progress' && !messageDone) {
		return { state: 'running', title: 'Compacting context…', detail: '' };
	}
	if (status === 'failed') {
		return {
			state: 'failed',
			title: "Compaction didn't finish; the reply continued without it",
			detail: ''
		};
	}
	if (status !== 'completed' || n === null) {
		// The reply stopped while the summary was being written.
		return { state: 'interrupted', title: 'Compaction interrupted', detail: '' };
	}
	if (kind === 'cut') {
		return {
			state: 'done',
			title: `Compaction #${n}: context cut without a summary`,
			detail: dropped ? `${dropped} ${dropped === 1 ? 'step' : 'steps'} removed` : ''
		};
	}
	return { state: 'done', title: `Compaction #${n}`, detail: seconds(took) };
}
