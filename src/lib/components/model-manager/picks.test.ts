import { describe, expect, it } from 'vitest';
import { groupOf, isExperimental, nextFavorites, nextRecents, quickPicks } from './picks';

const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((value) => ({ value }));
const ids = (list: { value: string }[]) => list.map((i) => i.value);

describe('quick picks', () => {
	it('favourites last used first, never used ones after them as starred, then 5 other recents', () => {
		const out = quickPicks(items, ['h', 'c', 'g', 'a'], ['a', 'b', 'c', 'd', 'e', 'f']);
		expect(ids(out)).toEqual(['a', 'c', 'h', 'g', 'b', 'd', 'e', 'f']);
		expect(ids(quickPicks(items, ['c', 'a'], ['c', 'x', 'a']))).toEqual(['c', 'a']);
	});
	it('a model saved twice ranks by its newest use', () => {
		expect(ids(quickPicks(items, ['a', 'b'], ['a', 'b', 'a']))).toEqual(['a', 'b']);
	});
	it('marks the sections', () => {
		const out = quickPicks(items, ['c', 'a'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
		expect(ids(out)).toEqual(['a', 'c', 'b', 'd', 'e', 'f', 'g']);
		expect(out.map((i) => i.section)).toEqual(['favorites', 'favorites', 'recent', 'recent', 'recent', 'recent', 'recent']);
	});
	it('a model that is gone drops out quietly and does not use up a recent place', () => {
		expect(ids(quickPicks(items, ['zz', 'a'], ['yy', 'b', 'c', 'd', 'e', 'f', 'g']))).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
	});
});

describe('lists', () => {
	it('recents: newest first, no doubles, bounded', () => {
		expect(nextRecents(['a', 'b'], ['b'])).toEqual(['b', 'a']);
		expect(nextRecents(['a'], ['b', 'c'])).toEqual(['b', 'c', 'a']);
		expect(nextRecents(Array.from({ length: 260 }, (_, i) => `m${i}`), ['x'])).toHaveLength(200);
	});
	it('favourites toggle, new ones last', () => {
		expect(nextFavorites(['a'], 'b')).toEqual(['a', 'b']);
		expect(nextFavorites(['a', 'b'], 'a')).toEqual(['b']);
	});
});

describe('groups', () => {
	const state: any = {
		managed: ['q', 'f'],
		ux: { models: { q: { engine: 'ollama' }, f: { engine: 'strata' } } }
	};
	it('by engine, ChatGPT and cloud apart, presets on their own', () => {
		expect(groupOf({ value: 'q', model: { id: 'q' } }, state)).toBe('ollama');
		expect(groupOf({ value: 'f', model: { id: 'f' } }, state)).toBe('strata');
		expect(groupOf({ value: 'codex/gpt-6', model: { id: 'codex/gpt-6' } }, state)).toBe('chatgpt');
		expect(groupOf({ value: 'google/x', model: { id: 'google/x' } }, state)).toBe('cloud');
		expect(groupOf({ value: 'p', model: { id: 'p', info: { base_model_id: 'q' } } }, state)).toBe('presets');
	});
	it('experimental = a preset named __', () => {
		const preset = (label: string) => ({ label, model: { info: { base_model_id: 'q' } } });
		expect(isExperimental(preset('__plab v1'))).toBe(true);
		expect(isExperimental(preset('plab v1'))).toBe(false);
		expect(isExperimental({ label: '__x', model: {} })).toBe(false);
	});
});
