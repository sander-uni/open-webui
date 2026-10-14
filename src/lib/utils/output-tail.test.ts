import { expect, it } from 'vitest';
import { applyOutputTail } from './output-tail';

it('replaces the changed end and keeps the shared prefix', () => {
	const prefix = [{ id: 'a' }, { id: 'b' }];
	const current = [...prefix, { id: 'c', text: 'old' }];
	const next = applyOutputTail(current, {
		output_tail: [{ id: 'c', text: 'new' }],
		output_start: 2
	});
	expect(next).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c', text: 'new' }]);
	expect(next?.[0]).toBe(prefix[0]);
	expect(current[2]).toEqual({ id: 'c', text: 'old' });
});

it('appends a new item and ignores events it cannot apply', () => {
	expect(applyOutputTail([{ id: 'a' }], { output_tail: [{ id: 'b' }], output_start: 1 })).toEqual([
		{ id: 'a' },
		{ id: 'b' }
	]);
	expect(applyOutputTail([{ id: 'a' }], { output_tail: [{ id: 'c' }], output_start: 3 })).toBe(
		undefined
	);
	expect(applyOutputTail([], { output: [] } as never)).toBe(undefined);
	expect(applyOutputTail(undefined, { output_tail: [{ id: 'a' }], output_start: 0 })).toEqual([
		{ id: 'a' }
	]);
});

it('rejects tail events whose declared length does not match their payload', () => {
	const current = [{ id: 'keep' }, { id: 'old' }];
	expect(
		applyOutputTail(current, {
			output_tail: [{ id: 'new' }],
			output_start: 1,
			output_length: 100
		} as any)
	).toBeUndefined();
	expect(current).toEqual([{ id: 'keep' }, { id: 'old' }]);
});
