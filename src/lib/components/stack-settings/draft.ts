// Fork 0.3.6: the editing logic of Admin Settings > Context Proxy / Run Logger (kept out of the
// component so it can be tested).
import type { StackSetting } from '$lib/apis/stack-settings';

/** Pending edits: a value, or null = back to the default. */
export type Draft = Record<string, string | null>;

const TRUE = ['1', 'true', 'yes', 'on'];

export const isTrue = (v: string | null | undefined) => TRUE.includes(String(v ?? '').trim().toLowerCase());

export const isEditable = (s: StackSetting) => s.apply !== 'launcher' && s.apply !== 'follows';

/** What the page shows for a setting: the pending edit if there is one, else the saved value. */
export const shownValue = (s: StackSetting, draft: Draft) => {
	if (!(s.key in draft)) return s.value;
	const v = draft[s.key];
	return v === null ? s.default : v;
};

const same = (s: StackSetting, a: string, b: string) =>
	s.kind === 'bool' ? isTrue(a) === isTrue(b) : a.trim() === b.trim();

/** The edits that change something, ready for saveStackSettings. */
export const changesFrom = (settings: StackSetting[], draft: Draft) => {
	const out: Record<string, string | null> = {};
	for (const s of settings) {
		if (!(s.key in draft) || !isEditable(s)) continue;
		const v = draft[s.key];
		if (v === null) {
			if (s.in_file || (s.kind === 'secret' && s.is_set)) out[s.key] = null;
			continue;
		}
		if (s.kind === 'secret') {
			if (v !== '') out[s.key] = v; // blank = keep the current key
			continue;
		}
		if (!same(s, v, s.value)) out[s.key] = s.kind === 'bool' ? (isTrue(v) ? '1' : '0') : v;
	}
	return out;
};

/** Saved in the settings file with a value other than the default (the page offers "Reset", which
 * removes the line). Values the launcher sets, or that come from its environment, have no line to remove. */
export const differsFromDefault = (s: StackSetting) =>
	isEditable(s) && (s.kind === 'secret' ? !!s.is_set : s.in_file && !same(s, s.value, s.default));

export const matches = (s: StackSetting, query: string) => {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return [s.label, s.key, s.help, s.value].some((t) => (t ?? '').toLowerCase().includes(q));
};

/** The label of where a value comes from, for the row's hover text. */
export const sourceText = (s: StackSetting) =>
	s.apply === 'launcher'
		? 'Set by the launcher at every start.'
		: s.apply === 'follows'
			? (s.readonly_reason ?? 'Follows another setting.')
			: s.source === 'file'
				? 'Saved in the settings file.'
				: s.source === 'environment'
					? 'Set in the launcher environment (not in the settings file).'
					: 'Default value.';
