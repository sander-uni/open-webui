import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_CHAIN_DISPLAY, getToolChainDisplaySettings } from './custom-settings';

describe('custom tool-chain display settings', () => {
	it('keeps the original defaults on older servers', () => {
		expect(getToolChainDisplaySettings()).toEqual(DEFAULT_TOOL_CHAIN_DISPLAY);
	});

	it('uses valid saved settings including false toggles', () => {
		const settings = { enabled: false, page_size: 20, auto_load: false };
		expect(getToolChainDisplaySettings({ tool_chain_display: settings })).toEqual(settings);
	});

	it('rejects invalid imported sizes and toggle types without breaking chat', () => {
		for (const page_size of [0, 9, 501, 12.5, NaN, '20', null]) {
			expect(
				getToolChainDisplaySettings({
					tool_chain_display: { enabled: 'false', page_size, auto_load: 0 }
				} as any)
			).toEqual(DEFAULT_TOOL_CHAIN_DISPLAY);
		}
	});

	it('accepts both page size boundaries without changing the defaults', () => {
		for (const page_size of [10, 500]) {
			expect(
				getToolChainDisplaySettings({
					tool_chain_display: { enabled: true, page_size, auto_load: true }
				}).page_size
			).toBe(page_size);
		}
		expect(DEFAULT_TOOL_CHAIN_DISPLAY.page_size).toBe(50);
	});
});

describe('partial category saves', () => {
	it('sends only a changed filesystem preference', async () => {
		const { getCustomSettingsUpdates } = await import('./custom-settings');
		const saved = {
			tool_chain_display: { enabled: true, page_size: 50, auto_load: true },
			filesystem_sort_default: 'date_desc' as const
		};
		expect(
			getCustomSettingsUpdates({ ...saved, filesystem_sort_default: 'name_asc' }, saved)
		).toEqual({ filesystem_sort_default: 'name_asc' });
		expect(getCustomSettingsUpdates(saved, saved)).toEqual({});
	});
	it('sends edited rendering settings without sending a stale filesystem choice', async () => {
		const { getCustomSettingsUpdates } = await import('./custom-settings');
		const saved = {
			tool_chain_display: { enabled: true, page_size: 50, auto_load: true },
			filesystem_sort_default: 'date_desc' as const
		};
		expect(
			getCustomSettingsUpdates(
				{ ...saved, tool_chain_display: { ...saved.tool_chain_display, page_size: 100 } },
				saved
			)
		).toEqual({ tool_chain_display: { enabled: true, page_size: 100, auto_load: true } });
	});
});

it('rejects an invalid hidden page-size edit before saving another category', async () => {
	const { getCustomSettingsUpdates } = await import('./custom-settings');
	const saved = {
		tool_chain_display: { enabled: true, page_size: 100, auto_load: true },
		filesystem_sort_default: 'date_desc' as const
	};
	expect(() =>
		getCustomSettingsUpdates(
			{
				tool_chain_display: { ...saved.tool_chain_display, page_size: undefined as any },
				filesystem_sort_default: 'name_asc'
			},
			saved
		)
	).toThrow('Steps per page');
});
