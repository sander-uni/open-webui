export type ToolChainDisplaySettings = {
	enabled: boolean;
	page_size: number;
	auto_load: boolean;
};

export type CustomSettings = {
	tool_chain_display: ToolChainDisplaySettings;
	filesystem_sort_default?: FilesystemSortDefault;
};

/** Send only edited categories, so stale forms cannot overwrite unrelated admin changes. */
export function getCustomSettingsUpdates(
	current: CustomSettings,
	saved: CustomSettings
): Partial<CustomSettings> {
	const updates: Partial<CustomSettings> = {};
	const a = current.tool_chain_display,
		b = saved.tool_chain_display;
	if (a.enabled !== b.enabled || a.page_size !== b.page_size || a.auto_load !== b.auto_load) {
		if (!Number.isInteger(a.page_size) || a.page_size < 10 || a.page_size > 500) {
			throw new Error('Steps per page must be an integer between 10 and 500.');
		}
		updates.tool_chain_display = { ...a };
	}
	if (current.filesystem_sort_default !== saved.filesystem_sort_default) {
		updates.filesystem_sort_default = current.filesystem_sort_default;
	}
	return updates;
}

export const FILESYSTEM_SORT_OPTIONS = [
	{ value: 'date_desc', label: 'Date modified — newest first' },
	{ value: 'date_asc', label: 'Date modified — oldest first' },
	{ value: 'name_asc', label: 'Name — A to Z' },
	{ value: 'name_desc', label: 'Name — Z to A' },
	{ value: 'size_desc', label: 'Size — largest first' },
	{ value: 'size_asc', label: 'Size — smallest first' }
] as const;

export type FilesystemSortDefault = (typeof FILESYSTEM_SORT_OPTIONS)[number]['value'];
export const DEFAULT_FILESYSTEM_SORT: FilesystemSortDefault = 'date_desc';

export function getFilesystemSortDefault(custom?: Partial<CustomSettings>): FilesystemSortDefault {
	return (
		FILESYSTEM_SORT_OPTIONS.find((option) => option.value === custom?.filesystem_sort_default)
			?.value ?? DEFAULT_FILESYSTEM_SORT
	);
}

export const DEFAULT_TOOL_CHAIN_DISPLAY: Readonly<ToolChainDisplaySettings> = {
	enabled: true,
	page_size: 50,
	auto_load: true
};

// Older servers and missing settings retain the fork's original behavior.
export function getToolChainDisplaySettings(
	custom?: Partial<CustomSettings>
): ToolChainDisplaySettings {
	const value = custom?.tool_chain_display;
	return {
		enabled:
			typeof value?.enabled === 'boolean' ? value.enabled : DEFAULT_TOOL_CHAIN_DISPLAY.enabled,
		page_size:
			Number.isInteger(value?.page_size) && value!.page_size >= 10 && value!.page_size <= 500
				? value!.page_size
				: DEFAULT_TOOL_CHAIN_DISPLAY.page_size,
		auto_load:
			typeof value?.auto_load === 'boolean' ? value.auto_load : DEFAULT_TOOL_CHAIN_DISPLAY.auto_load
	};
}
