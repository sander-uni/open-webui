<script lang="ts">
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as I18n } from 'i18next';
	import {
		DEFAULT_FILESYSTEM_SORT,
		FILESYSTEM_SORT_OPTIONS,
		type FilesystemSortDefault
	} from '$lib/utils/custom-settings';

	const i18n = getContext<Writable<I18n>>('i18n');
	export let value: FilesystemSortDefault = DEFAULT_FILESYSTEM_SORT;
</script>

<div class="flex flex-col gap-2">
	<label for="filesystem-sort-default"
		>{$i18n.t('settings.admin.custom.filesystemSortDefault.label')}</label
	>
	<select
		id="filesystem-sort-default"
		bind:value
		class="w-full rounded-lg border border-gray-200 bg-transparent px-2 py-2 dark:border-gray-700"
	>
		{#each FILESYSTEM_SORT_OPTIONS as option}
			<option value={option.value}>{$i18n.t(option.label)}</option>
		{/each}
	</select>
	<p class="text-xs text-gray-500">
		{$i18n.t(
			'Choose the initial sorting for the terminal filesystem. Folders stay before files. The filesystem Sort menu can still change the order temporarily.'
		)}
	</p>
</div>
