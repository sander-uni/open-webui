<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as I18n } from 'i18next';
	import { toast } from 'svelte-sonner';
	import { config } from '$lib/stores';
	import { getCustomSettings, setCustomSettings } from '$lib/apis/custom-settings';
	import {
		DEFAULT_TOOL_CHAIN_DISPLAY,
		getToolChainDisplaySettings,
		DEFAULT_FILESYSTEM_SORT,
		getFilesystemSortDefault,
		getCustomSettingsUpdates,
		type CustomSettings
	} from '$lib/utils/custom-settings';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import Switch from '$lib/components/common/Switch.svelte';
	import Filesystem from './CustomSettings/Filesystem.svelte';

	const i18n = getContext<Writable<I18n>>('i18n');
	let display = { ...DEFAULT_TOOL_CHAIN_DISPLAY };
	let filesystemSortDefault = DEFAULT_FILESYSTEM_SORT;
	let category: 'tool-chain' | 'filesystem' = 'tool-chain';
	let loading = true;
	let saving = false;
	let loadError = '';
	let saved = false;
	let baseline: CustomSettings;
	function setValues(value: CustomSettings) {
		display = getToolChainDisplaySettings(value);
		filesystemSortDefault = getFilesystemSortDefault(value);
		baseline = {
			tool_chain_display: { ...display },
			filesystem_sort_default: filesystemSortDefault
		};
	}

	onMount(async () => {
		try {
			const settings = await getCustomSettings(localStorage.token);
			setValues(settings);
		} catch (error) {
			loadError = String(error);
		} finally {
			loading = false;
		}
	});

	async function save() {
		saving = true;
		saved = false;
		try {
			const result = await setCustomSettings(
				localStorage.token,
				getCustomSettingsUpdates(
					{
						tool_chain_display: display,
						filesystem_sort_default: filesystemSortDefault
					},
					baseline
				)
			);
			setValues(result);
			config.update((current) => (current ? { ...current, custom_settings: result } : current));
			saved = true;
			toast.success($i18n.t('Settings saved successfully!'));
		} catch (error) {
			toast.error(String(error));
		} finally {
			saving = false;
		}
	}
</script>

<form class="flex h-full flex-col gap-4 text-sm" on:submit|preventDefault={save}>
	<h2 class="font-medium text-gray-900 dark:text-white">
		{$i18n.t('settings.admin.custom.title')}
	</h2>
	<nav
		aria-label={$i18n.t('Custom settings categories')}
		class="border-b border-gray-200 dark:border-gray-700"
	>
		<button
			type="button"
			aria-current={category === 'tool-chain' ? 'page' : undefined}
			on:click={() => (category = 'tool-chain')}
			class="px-2 py-2 {category === 'tool-chain'
				? 'border-b-2 border-gray-900 dark:border-white'
				: ''}"
		>
			{$i18n.t('settings.admin.custom.toolChainDisplay.label')}
		</button>
		<button
			type="button"
			aria-current={category === 'filesystem' ? 'page' : undefined}
			on:click={() => (category = 'filesystem')}
			class="px-2 py-2 {category === 'filesystem'
				? 'border-b-2 border-gray-900 dark:border-white'
				: ''}"
		>
			{$i18n.t('settings.admin.custom.filesystem.label')}
		</button>
	</nav>
	<div class="flex-1 min-h-0 overflow-y-auto scrollbar-hover">
		{#if loading}
			<Spinner className="size-6" />
		{:else if loadError}
			<p role="alert">{loadError}</p>
		{:else}
			<fieldset
				disabled={saving}
				class="flex flex-col gap-5"
				on:input={() => (saved = false)}
				on:change={() => (saved = false)}
			>
				{#if category === 'filesystem'}
					<Filesystem bind:value={filesystemSortDefault} />
				{:else}
					<div>
						<div class="flex items-center justify-between gap-4">
							<label id="tool-chain-enabled-label" for="tool-chain-enabled"
								>{$i18n.t('settings.admin.custom.enabled.label')}</label
							>
							<Switch
								id="tool-chain-enabled"
								ariaLabelledbyId="tool-chain-enabled-label"
								bind:state={display.enabled}
								disabled={saving}
								on:change={() => (saved = false)}
							/>
						</div>
						<p class="mt-1 text-xs text-gray-500">
							{$i18n.t(
								'Start with recent steps and load earlier steps as needed. Turning this off displays the entire chain.'
							)}
						</p>
					</div>
					<div>
						<label for="tool-chain-page-size"
							>{$i18n.t('settings.admin.custom.pageSize.label')}</label
						>
						<input
							id="tool-chain-page-size"
							type="number"
							min="10"
							max="500"
							step="1"
							required
							bind:value={display.page_size}
							class="mt-1 block w-24 rounded-lg border border-gray-200 bg-transparent px-2 py-1 dark:border-gray-700"
						/>
						<p class="mt-1 text-xs text-gray-500">
							{$i18n.t(
								'10–500 steps. Smaller pages reduce browser work. Calls keep their results and related reasoning together.'
							)}
						</p>
					</div>
					<div class="flex items-center justify-between gap-4">
						<label id="tool-chain-auto-load-label" for="tool-chain-auto-load"
							>{$i18n.t('settings.admin.custom.autoLoad.label')}</label
						>
						<Switch
							id="tool-chain-auto-load"
							ariaLabelledbyId="tool-chain-auto-load-label"
							bind:state={display.auto_load}
							disabled={saving}
							on:change={() => (saved = false)}
						/>
					</div>
					<p class="text-xs text-gray-500">
						{$i18n.t(
							'Applies to all users and existing chats when opened or refreshed. Changes apply immediately in this browser.'
						)}
					</p>
				{/if}
			</fieldset>
		{/if}
	</div>
	<div class="flex items-center justify-end gap-3">
		{#if saved}<span role="status" class="text-xs text-gray-500"
				>{$i18n.t('Settings saved successfully!')}</span
			>{/if}
		<button
			type="submit"
			disabled={loading || saving || !!loadError}
			class="rounded-lg bg-gray-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-black"
		>
			{saving ? $i18n.t('Saving...') : $i18n.t('Save')}
		</button>
	</div>
</form>
