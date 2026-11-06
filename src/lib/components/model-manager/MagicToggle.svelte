<script lang="ts">
	// Fork addition: turns the Lua magic characters on in the model search. Off by default.
	import { getContext } from 'svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import { magicSearch, setMagicSearch } from './picks';

	const i18n: any = getContext('i18n');

	export let onChange: () => void = () => {};

	$: help = $magicSearch
		? $i18n.t('Lua magic characters are on: . %a %d %w %s * + ? - ^ $ [...]')
		: $i18n.t('Plain text search. Turn on for Lua magic characters.');
</script>

<Tooltip content={help} placement="top">
	<button
		type="button"
		class="focus-ring flex h-[1.375rem] min-w-[1.625rem] shrink-0 items-center justify-center rounded-lg px-1 font-mono text-[0.6875rem] leading-none transition-colors duration-100 pointer-coarse:h-9 pointer-coarse:min-w-9 {$magicSearch
			? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
			: 'text-gray-500 hover:bg-gray-50/40 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/40 dark:hover:text-gray-100'}"
		aria-label={$i18n.t('Lua magic characters')}
		aria-pressed={$magicSearch}
		data-magic-toggle
		on:mousedown|preventDefault
		on:click|stopPropagation={() => {
			setMagicSearch(!$magicSearch);
			onChange();
		}}
	>
		%a
	</button>
</Tooltip>
