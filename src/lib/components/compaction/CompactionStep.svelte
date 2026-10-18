<script lang="ts">
	// Fork addition (0.3.4): a context compaction by ctxproxy, shown as a step in the reply.
	import { getContext } from 'svelte';

	import Spinner from '$lib/components/common/Spinner.svelte';
	import ArchiveBox from '$lib/components/icons/ArchiveBox.svelte';
	import CompactionSummaryModal from './CompactionSummaryModal.svelte';
	import { compactionLabel } from './label';

	const i18n: any = getContext('i18n');

	export let kind: 'summary' | 'cut' = 'summary';
	export let status = '';
	export let n: number | null = null;
	export let conv: string | null = null;
	export let reason = '';
	export let seconds: number | null = null;
	export let dropped: number | null = null;
	export let chatId = '';
	export let messageId = '';
	export let messageDone = true;
	export let compact = false;

	let showNote = false;

	$: label = compactionLabel({ kind, status, n, seconds, dropped, messageDone });
	$: canView = label.state === 'done' && n !== null && !!chatId && !!messageId;
</script>

<div
	class="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5 {compact
		? 'text-xs'
		: 'text-[0.9375rem]'} text-gray-500 dark:text-gray-400"
	data-compaction-state={label.state}
>
	{#if label.state === 'running'}
		<Spinner className="size-4" />
		<span class="shimmer">{$i18n.t('Compacting context…')}</span>
	{:else}
		<ArchiveBox className="size-3.5 shrink-0" strokeWidth="1.75" />
		<span class={label.state === 'failed' ? 'text-gray-600 dark:text-gray-300' : ''}>{label.title}</span>
		{#if canView}
			<button
				type="button"
				class="rounded-lg border border-gray-200/70 px-2 py-0.5 text-xs text-gray-700 transition hover:bg-gray-100 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]"
				on:click={() => (showNote = true)}
			>
				{kind === 'cut' ? $i18n.t('View note') : $i18n.t('View summary')}
			</button>
		{/if}
		{#if label.detail}
			<span class="text-xs text-gray-400 dark:text-gray-500">{label.detail}</span>
		{/if}
	{/if}
	{#if label.state === 'failed' && reason}
		<span class="basis-full text-xs text-gray-400 dark:text-gray-500 break-words">{reason}</span>
	{/if}
</div>

{#if showNote && n !== null}
	<CompactionSummaryModal bind:show={showNote} {chatId} {messageId} {n} {conv} {kind} />
{/if}
