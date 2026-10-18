<script lang="ts">
	// Fork addition (0.3.3): above the chat input, the messages waiting for the model's next
	// step (each can be withdrawn), and a notice when a message came back because the reply
	// ended first. Returned messages go back into the input box via onRestore.
	import { onDestroy } from 'svelte';
	import { toast } from 'svelte-sonner';
	import {
		pendingInterjections,
		returnedInterjections,
		takeReturned,
		withdrawInterjection,
		type PendingInterjection
	} from './state';

	export let chatId = '';
	export let onRestore: (text: string, files: any[]) => void = () => {};

	let notice = '';
	let busy = new Set<string>();
	$: pending = ($pendingInterjections[chatId] ?? []) as PendingInterjection[];

	const restore = () => {
		const items = takeReturned(chatId);
		if (!items.length) return;
		const text = items.map((i) => i.text).filter((t) => t.trim()).join('\n\n');
		onRestore(text, items.flatMap((i) => i.files ?? []));
		let next = '';
		if (items.some((i) => i.reason === 'not_sent')) {
			next = 'Not sent: your message is back in the input.'; // fork 0.3.5
		} else if (items.some((i) => i.reason === 'not_delivered')) {
			next =
				items.length > 1
					? 'Not delivered: the reply finished before its next step. Your messages are back in the input.'
					: 'Not delivered: the reply finished before its next step. Your message is back in the input.';
		}
		if (next) {
			notice = next;
			toast.info(next);
		}
	};
	const unsubscribe = returnedInterjections.subscribe((all) => {
		if ((all[chatId] ?? []).length) queueMicrotask(restore);
	});
	onDestroy(unsubscribe);

	const withdraw = async (item: PendingInterjection) => {
		busy = new Set([...busy, item.id]);
		const removed = await withdrawInterjection(item);
		busy.delete(item.id);
		busy = new Set(busy);
		if (!removed) toast.info('Already on its way: the model has it, or the reply ended.');
	};
	const label = (item: PendingInterjection) =>
		item.text.trim() || `${item.files.length} attachment${item.files.length === 1 ? '' : 's'}`;
</script>

{#if pending.length}
	<div
		class="mb-1 mx-2 rounded-2xl border border-gray-100 bg-white px-3 py-1.5 text-xs dark:border-gray-800/50 dark:bg-gray-900/60"
		role="status"
		aria-live="polite"
	>
		<p class="mb-0.5 text-gray-500 dark:text-gray-400">Reaches the model at its next step:</p>
		{#each pending as item (item.id)}
			<div class="flex items-start gap-2 py-0.5">
				<span class="min-w-0 flex-1 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-200"
					>{label(item)}{#if item.text.trim() && item.files.length}<span class="text-gray-500">
							· {item.files.length} attachment{item.files.length === 1 ? '' : 's'}</span
						>{/if}</span
				>
				<button
					type="button"
					class="shrink-0 rounded-lg px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-200"
					disabled={busy.has(item.id)}
					aria-label="Take back this message"
					on:click={() => withdraw(item)}>Take back</button
				>
			</div>
		{/each}
	</div>
{/if}
{#if notice}
	<div
		class="mb-1 mx-2 flex items-start gap-2 rounded-2xl border border-amber-200/60 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200"
		role="status"
	>
		<span class="min-w-0 flex-1">{notice}</span>
		<button type="button" class="shrink-0 opacity-70 hover:opacity-100" on:click={() => (notice = '')}
			>Dismiss</button
		>
	</div>
{/if}
