import { describe, expect, it } from 'vitest';
import { findPattern, findPlain, matchModel, searchItems } from './modelSearch';

const hit = (text: string, p: string) => {
	const m = findPattern(text, p);
	return m ? text.slice(m.start, m.end) : null;
};

describe('Lua patterns', () => {
	it('classes and their complements', () => {
		expect(hit('gpt-6-luna', '%d')).toBe('6');
		expect(hit('gpt-6-luna', '%a+')).toBe('gpt');
		expect(hit('abc 12', '%s')).toBe(' ');
		expect(hit('abc', '%D+')).toBe('abc');
		expect(hit('a_b', '%W')).toBe('_');
		expect(hit('Ab', '%u')).toBe('A');
		expect(hit('Ab', '%l')).toBe('b');
		expect(hit('fF9g', '%x+')).toBe('fF9');
		expect(hit('a.b', '%p')).toBe('.');
	});
	it('. and % as escape', () => {
		expect(hit('qwen3.8', 'n3.8')).toBe('n3.8');
		expect(hit('qwen3x8', 'n3%.8')).toBe(null);
		expect(hit('qwen3.8', 'n3%.8')).toBe('n3.8');
		expect(hit('a-b', 'a%-b')).toBe('a-b');
		expect(hit('100%', '0%%')).toBe('0%');
	});
	it('quantifiers', () => {
		expect(hit('aaab', 'a*b')).toBe('aaab');
		expect(hit('b', 'a*b')).toBe('b');
		expect(hit('aaab', 'a+b')).toBe('aaab');
		expect(hit('b', 'a+b')).toBe(null);
		expect(hit('colour', 'colou?r')).toBe('colour');
		expect(hit('color', 'colou?r')).toBe('color');
		expect(hit('<a><b>', '<.->')).toBe('<a>');
		expect(hit('<a><b>', '<.*>')).toBe('<a><b>');
	});
	it('anchors', () => {
		expect(hit('gpt-6', '^gpt')).toBe('gpt');
		expect(hit('my gpt', '^gpt')).toBe(null);
		expect(hit('free:free', 'free$')).toBe('free');
		expect(hit('free now', 'free$')).toBe(null);
		expect(hit('a$b', 'a$b')).toBe('a$b');
	});
	it('sets, ranges, negation', () => {
		expect(hit('v12', '[0-9]+')).toBe('12');
		expect(hit('abc', '[^a]+')).toBe('bc');
		expect(hit('a]b', '[]]')).toBe(']');
		expect(hit('x-1', '[%d]')).toBe('1');
		expect(hit('a-b', '[a%-]+')).toBe('a-');
		expect(hit('a^b', '[a^]+')).toBe('a^');
	});
	it('is case-insensitive for letters, not for %u', () => {
		expect(hit('GPT', 'gpt')).toBe('GPT');
		expect(hit('GPT', '[g]')).toBe('G');
		expect(hit('GPT', '[a-z]+')).toBe('GPT');
		expect(hit('gpt', '%u')).toBe(null);
	});
	it('unfinished patterns give null, never an error', () => {
		for (const p of ['[', '[a', '[^', '%', 'a%', '(a', 'a)', '%b', '%f', '%1', '[%']) {
			expect(findPattern('anything [a]', p)).toBe(null);
		}
	});
	it('empty matches do not count', () => {
		expect(findPattern('anything', 'z-')).toBe(null);
		expect(findPattern('anything', 'z*')).toBe(null);
	});
	it('stops a pattern that nests too deep', () => {
		expect(findPattern('gpt-6', 'z*'.repeat(6000) + 'g')).toBe(null);
	});
	it('stops a pathological pattern', () => {
		const text = 'a'.repeat(300);
		expect(findPattern(text, '.-.-.-.-.-.-.-.-.-.-b')).toBe(null);
	});
});

describe('model search', () => {
	const items = [
		{ label: 'GPT-6-Luna', value: 'codex/gpt-6-luna' },
		{ label: 'big boi', value: 'qwen3.8-flash-next-iq3_s' },
		{ label: 'plab v12', value: 'plab-v12' }
	];
	it('finds names that a pure pattern would not', () => {
		expect(findPattern('gpt-6-luna', 'gpt-6')).toBe(null);
		expect(matchModel('GPT-6-Luna', 'x', 'gpt-6', true)).toMatchObject({ field: 'label', plain: true });
	});
	it('falls back to the id, and to plain text for a broken pattern', () => {
		expect(matchModel('big boi', 'qwen3.8', 'qwen')).toMatchObject({ field: 'value', plain: true });
		expect(matchModel('a[b', 'x', '[b', true)).toMatchObject({ field: 'label', start: 1, end: 3 });
	});
	it('lists plain matches first', () => {
		const list = [
			{ label: 'x1', value: 'x1' },
			{ label: 'v1', value: 'v1' }
		];
		expect(searchItems(list, 'v1').map((i) => i.label)).toEqual(['v1']);
		expect(searchItems(items, '%d%d', true).map((i) => i.label)).toEqual(['plab v12']);
		expect(searchItems([{ label: 'a3x8', value: 'p' }, { label: 'b3.8', value: 'q' }], '3.8', true).map((i) => i.label)).toEqual(['b3.8', 'a3x8']);
	});
	it('plain text only until the toggle is on', () => {
		expect(searchItems(items, '%d%d')).toEqual([]);
		expect(searchItems([{ label: 'a3x8', value: 'p' }, { label: 'b3.8', value: 'q' }], '3.8').map((i) => i.label)).toEqual(['b3.8']);
		expect(matchModel('a', 'b', '.', false)).toBe(null);
	});
	it('one search over many models stays quick, and plain text still works then', () => {
		const many = Array.from({ length: 500 }, (_, i) => ({ label: `model name number ${i} `.repeat(4), value: `vendor/model-${i}-long-identifier` }));
		const t = performance.now();
		searchItems(many, '.*.*.*.*.*.*.*.*.*.*ZZZ', true);
		expect(performance.now() - t).toBeLessThan(1500);
		expect(searchItems(many, 'number 7 ', true).length).toBeGreaterThan(0);
	});
	it('an ordinary pattern finds every match in a long list', () => {
		const many = Array.from({ length: 500 }, (_, i) => ({ label: `hf.co/org/qwen-${i}-${i % 4 ? 'base' : 'instruct'}-${i % 2 ? 'gguf' : 'fp8'}`, value: `id-${i}` }));
		expect(searchItems(many, '.*instruct.*fp8', true).length).toBe(125);
	});
	it('an empty search matches nothing', () => {
		expect(matchModel('a', 'b', '  ')).toBe(null);
	});
	it('highlight span of a plain match', () => {
		expect(findPlain('GPT-6', 'pt-')).toEqual({ start: 1, end: 4 });
	});
});
