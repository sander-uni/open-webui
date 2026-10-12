export type ToolChainDisplaySettings = {
	enabled: boolean;
	page_size: number;
	auto_load: boolean;
};

export type CustomSettings = {
	tool_chain_display: ToolChainDisplaySettings;
};

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
