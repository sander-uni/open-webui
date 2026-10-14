export type ToolChainDisplaySettings = {
	enabled: boolean;
	page_size: number;
	auto_load: boolean;
};

export type CustomSettings = {
	tool_chain_display: ToolChainDisplaySettings;
	filesystem_sort_default?: FilesystemSortDefault;
};

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
