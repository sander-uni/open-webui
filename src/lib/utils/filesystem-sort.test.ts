import { describe, expect, it } from 'vitest';
import { FILESYSTEM_SORT_OPTIONS, getFilesystemSortDefault } from './custom-settings';

describe('filesystem default sort', () => {
	it('defaults to modification time descending without saved configuration', () => {
		expect(getFilesystemSortDefault()).toBe('date_desc');
		expect(getFilesystemSortDefault({})).toBe('date_desc');
	});

	it('accepts every selectable mode and direction', () => {
		for (const { value } of FILESYSTEM_SORT_OPTIONS) {
			expect(getFilesystemSortDefault({ filesystem_sort_default: value })).toBe(value);
		}
	});

	it('keeps invalid imported values from breaking the filesystem', () => {
		for (const value of ['', 'mtime', 'DATE_DESC', null, false, {}, []]) {
			expect(getFilesystemSortDefault({ filesystem_sort_default: value } as any)).toBe('date_desc');
		}
	});
});

describe('filesystem comparator with partial metadata', () => {
	it('keeps known dates ordered before files with missing dates regardless of input order', async () => {
		const { sortFileEntries } = await import('./filesystem-sort');
		const items = [
			{ name: 'c-old', type: 'file', modified: 1 },
			{ name: 'b-unknown', type: 'file' },
			{ name: 'a-new', type: 'file', modified: 3 }
		];
		for (let i = 0; i < 3; i++) {
			const input = [...items.slice(i), ...items.slice(0, i)];
			expect(sortFileEntries(input, 'date', false).map((x) => x.name)).toEqual([
				'a-new',
				'c-old',
				'b-unknown'
			]);
			expect(sortFileEntries(input, 'date', true).map((x) => x.name)).toEqual([
				'c-old',
				'a-new',
				'b-unknown'
			]);
		}
	});
	it('handles unknown sizes, zero, ties and directories without mutating input', async () => {
		const { sortFileEntries } = await import('./filesystem-sort');
		const items = [
			{ name: 'unknown', type: 'file', size: NaN },
			{ name: 'zero', type: 'file', size: 0 },
			{ name: 'z-folder', type: 'directory' },
			{ name: 'b', type: 'file', size: 10 },
			{ name: 'a', type: 'file', size: 10 }
		];
		expect(sortFileEntries(items, 'size', false).map((x) => x.name)).toEqual([
			'z-folder',
			'a',
			'b',
			'zero',
			'unknown'
		]);
		expect(sortFileEntries(items, 'size', true).map((x) => x.name)).toEqual([
			'z-folder',
			'zero',
			'a',
			'b',
			'unknown'
		]);
		expect(items[0].name).toBe('unknown');
	});
});
