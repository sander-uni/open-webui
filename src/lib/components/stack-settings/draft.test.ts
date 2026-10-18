import { describe, expect, it } from 'vitest';
import type { StackSetting } from '$lib/apis/stack-settings';
import { changesFrom, differsFromDefault, isEditable, keepUnsent, matches, shownValue } from './draft';

const s = (over: Partial<StackSetting>): StackSetting => ({
	key: 'CTXPROXY_X',
	label: 'X',
	kind: 'int',
	group: 'general',
	help: 'Some help text here.',
	value: '5',
	default: '5',
	source: 'default',
	in_file: false,
	apply: 'live',
	...over
});

describe('stack settings drafts', () => {
	it('sends only real changes, normalised', () => {
		const list = [
			s({ key: 'A', value: '5' }),
			s({ key: 'B', kind: 'bool', value: '1', default: '1' }),
			s({ key: 'C', kind: 'bool', value: '0', default: '1', in_file: true, source: 'file' }),
			s({ key: 'D', value: '9', in_file: true, source: 'file' })
		];
		expect(changesFrom(list, { A: ' 5 ', B: 'true', C: 'on', D: null })).toEqual({ C: '1', D: null });
	});

	it('a reset of a value that is not in the file sends nothing', () => {
		expect(changesFrom([s({ key: 'A' })], { A: null })).toEqual({});
	});

	it('secrets: blank keeps the key, null clears it, a value replaces it', () => {
		const sec = s({ key: 'K', kind: 'secret', value: '', default: '', is_set: true });
		expect(changesFrom([sec], { K: '' })).toEqual({});
		expect(changesFrom([sec], { K: null })).toEqual({ K: '' });
		expect(changesFrom([{ ...sec, is_set: false }], { K: null })).toEqual({});
		expect(changesFrom([sec], { K: 'new' })).toEqual({ K: 'new' });
		expect(differsFromDefault(sec)).toBe(true);
	});

	it('launcher-owned and follower settings are never sent', () => {
		const l = s({ key: 'U', kind: 'url', apply: 'launcher', value: 'http://a' });
		const f = s({ key: 'I', kind: 'path', apply: 'follows', value: '/x' });
		expect(isEditable(l) || isEditable(f)).toBe(false);
		expect(changesFrom([l, f], { U: 'http://b', I: '/y' })).toEqual({});
	});

	it('shows the draft, the default for a reset, else the saved value', () => {
		const x = s({ key: 'A', value: '9', default: '5', in_file: true, source: 'file' });
		expect(shownValue(x, {})).toBe('9');
		expect(shownValue(x, { A: '7' })).toBe('7');
		expect(shownValue(x, { A: null })).toBe('5');
		expect(differsFromDefault(x)).toBe(true);
		expect(differsFromDefault(s({ key: 'A', value: '5', in_file: true, source: 'file' }))).toBe(false);
		// from the launcher's environment, or set by the launcher: no line to remove, no Reset
		expect(differsFromDefault(s({ key: 'P', value: '9098', default: '8098', source: 'environment' }))).toBe(false);
		expect(differsFromDefault(s({ key: 'U', value: 'x', default: 'y', in_file: true, apply: 'launcher' }))).toBe(false);
	});

	it('search matches label, key, description and value', () => {
		const x = s({ label: 'Compact at', key: 'CTXPROXY_COMPACT_AT', help: 'Estimated prompt size', value: '85000' });
		expect(['compact', 'COMPACT_AT', 'prompt size', '85000', ''].every((q) => matches(x, q))).toBe(true);
		expect(matches(x, 'images')).toBe(false);
	});

	it('text keeps edge whitespace; numbers and choices are compared trimmed (R16)', () => {
		const t = s({ key: 'T', kind: 'longtext', value: 'hello', default: 'hello' });
		expect(changesFrom([t], { T: 'hello\n' })).toEqual({ T: 'hello\n' });
		expect(changesFrom([t], { T: '  hello' })).toEqual({ T: '  hello' });
		expect(changesFrom([s({ key: 'N', value: '5' })], { N: ' 5 ' })).toEqual({});
	});

	it('after a save only the sent edits leave the draft (R15)', () => {
		expect(keepUnsent({ A: '1', B: '2', C: null }, { A: '1', C: null })).toEqual({ B: '2' });
		expect(keepUnsent({ A: '3' }, { A: '1' })).toEqual({ A: '3' }); // changed again meanwhile
	});
});
