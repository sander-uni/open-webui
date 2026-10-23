import { describe, expect, it } from 'vitest';
import { budgetText, effortMeta, effortParams, nearestLevel, pickedEffort } from './effort';

const codex = { id: 'codex/gpt-6.1-sol', modelmgr: { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_effort: 'low', provider: 'codex' } };
const qwen = {
	id: 'qwen3.8-flash-next-iq3_s',
	openai: { modelmgr: { engine: 'strata', efforts: ['low', 'medium', 'xhigh'], default_effort: 'xhigh', effort_budgets: { low: 4096, medium: 8192, xhigh: 24576 } } }
};
const preset = { id: 'plab-v12sol', info: { base_model_id: 'codex/gpt-6.1-sol' } };
const ninfer = { id: 'qwen3.8-27b', modelmgr: { engine: 'ninfer' } };
const models = [codex, qwen, preset, ninfer];

describe('effort levels', () => {
	it('reads the levels from the model or its base model', () => {
		expect(effortMeta(codex, models)?.efforts).toHaveLength(6);
		expect(effortMeta(qwen, models)?.engine).toBe('strata');
		expect(effortMeta(preset, models)?.provider).toBe('codex');
		expect(effortMeta(ninfer, models)).toBeNull();
	});

	it('picks the nearest level as modelmgr does', () => {
		const q = effortMeta(qwen, models)!;
		expect(nearestLevel('high', q)).toBe('xhigh'); // the template's alias
		expect(nearestLevel('max', q)).toBe('xhigh');
		expect(nearestLevel(null, q)).toBe('xhigh');
		expect(nearestLevel('minimal', q)).toBe('low');
		const luna = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' };
		expect(nearestLevel('ultra', luna)).toBe('max');
		expect(nearestLevel('bogus', luna)).toBe('medium');
	});

	it('sends the remembered pick only', () => {
		const settings = { modelEfforts: { 'plab-v12sol': 'xhigh', 'codex/gpt-6.1-sol': 'gone-level' } };
		expect(effortParams(preset, models, settings)).toEqual({ reasoning_effort: 'xhigh' });
		expect(effortParams(codex, models, settings)).toEqual({}); // not one of its levels any more
		expect(effortParams(ninfer, models, settings)).toEqual({});
		expect(pickedEffort('plab-v12sol', null, settings)).toBeNull();
	});

	it('describes budgets', () => {
		expect(budgetText(0)).toBe('no thinking budget');
		expect(budgetText(24576)).toBe('thinks up to 24K tokens');
		expect(budgetText(null)).toBe('');
	});
});
