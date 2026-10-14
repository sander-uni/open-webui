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
