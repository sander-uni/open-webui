export type FilesystemSortMode = 'name' | 'size' | 'date';
type SortableFile = { name: string; type: string; modified?: number; size?: number };

/** Keep directories first and missing metadata last, in either numeric direction. */
export function sortFileEntries<T extends SortableFile>(
	items: T[],
	mode: FilesystemSortMode,
	asc: boolean
): T[] {
	return [...items].sort((a, b) => {
		if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
		if (mode !== 'name') {
			const key = mode === 'date' ? 'modified' : 'size';
			const x = a[key],
				y = b[key];
			const hasX = typeof x === 'number' && Number.isFinite(x);
			const hasY = typeof y === 'number' && Number.isFinite(y);
			if (hasX !== hasY) return hasX ? -1 : 1;
			if (hasX && hasY && x !== y) return asc ? x - y : y - x;
			// Equal/unknown values need a deterministic, transitive tie-breaker.
			return a.name.localeCompare(b.name);
		}
		const name = a.name.localeCompare(b.name);
		return asc ? name : -name;
	});
}
