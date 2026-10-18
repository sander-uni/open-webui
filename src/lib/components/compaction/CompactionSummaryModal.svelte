<script lang="ts">
	// Fork addition (0.3.4): the note the model received in place of the compacted steps.
	import { getContext } from 'svelte';
	import { toast } from 'svelte-sonner';

	import Modal from '$lib/components/common/Modal.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';
	import { getCompactionNote } from '$lib/apis/model-manager';
	import { copyToClipboard } from '$lib/utils';

	const i18n: any = getContext('i18n');

	export let show = false;
	export let chatId = '';
	export let messageId = '';
	export let n = 0;
	export let conv: string | null = null;
	export let kind: 'summary' | 'cut' = 'summary';

	let note: string | null = null;
	let error = '';
	let loadedKey = '';

	const load = async (key: string) => {
		note = null;
		error = '';
		try {
			const res = await getCompactionNote(localStorage.token, chatId, messageId, n, conv ?? '');
			if (key === loadedKey) note = res.note;
		} catch (e) {
			if (key === loadedKey) error = String(e);
		}
	};

	$: key = `${chatId}:${messageId}:${n}`;
	$: if (show && key !== loadedKey) {
		loadedKey = key;
		load(key);
	}

	const copy = async () => {
		if (note !== null && (await copyToClipboard(note))) {
			toast.success($i18n.t('Copied to clipboard'));
		}
	};
</script>

<Modal size="lg" bind:show>
	<div class="flex max-h-[85vh] flex-col">
		<div class="flex items-start justify-between gap-3 px-4 pt-3 pb-2 dark:text-gray-300">
			<div class="flex flex-col gap-0.5">
				<div class="text-sm font-medium">
					{kind === 'cut'
						? $i18n.t('Compaction #{{n}}: context cut without a summary', { n })
						: $i18n.t('Compaction #{{n}}', { n })}
				</div>
				<div class="text-xs text-gray-500 dark:text-gray-400">
					{$i18n.t(
						'Exactly what the model received in place of the earlier steps. Later compactions replace it.'
					)}
				</div>
			</div>
			<div class="flex shrink-0 items-center gap-1">
				{#if note !== null}
					<button
						type="button"
						class="rounded-lg px-2 py-1 text-xs text-gray-600 transition hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
						on:click={copy}>{$i18n.t('Copy')}</button
					>
				{/if}
				<button
					type="button"
					aria-label={$i18n.t('Close')}
					class="rounded-lg p-1 text-gray-500 transition hover:bg-gray-50 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
					on:click={() => (show = false)}
				>
					<XMark className="size-4" />
				</button>
			</div>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
			{#if note !== null}
				<pre
					class="whitespace-pre-wrap break-words rounded-xl bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-800 dark:bg-gray-850 dark:text-gray-200">{note}</pre>
				<div class="mt-1.5 text-right text-xs text-gray-400 dark:text-gray-500">
					{$i18n.t('{{COUNT}} characters', { COUNT: note.length.toLocaleString() })}
				</div>
			{:else if error}
				<div class="rounded-xl bg-gray-50 p-3 text-sm text-gray-700 dark:bg-gray-850 dark:text-gray-300">
					{error}
				</div>
			{:else}
				<div class="flex items-center gap-2 py-6 text-sm text-gray-500">
					<Spinner className="size-4" />
					{$i18n.t('Loading…')}
				</div>
			{/if}
		</div>
	</div>
</Modal>
