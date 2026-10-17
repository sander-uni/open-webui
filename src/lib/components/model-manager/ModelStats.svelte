<script lang="ts">
	// Fork addition, 0.3.2: speed and context figures next to the model name in the chat input.
	//   prefill:   "prefilling 12s"        23k/108k
	//   decode:    "41 t/s"                23k/108k
	//   after:     "41 t/s · pp 1.9k/s"    23k/108k
	// The speed text sits in a fixed-width, right-aligned slot so the context never moves.
	// Figures come from the local model manager, per chat; chats it never served show nothing.
	import { onDestroy } from 'svelte';
	import { getChatStats, type ChatStats } from '$lib/apis/model-manager';
	import Tooltip from '$lib/components/common/Tooltip.svelte';

	export let chatId = '';
	export let active = false; // this chat is generating (Open WebUI's own flag)

	const LIVE = ['prefill', 'decode', 'compacting'];
	let stats: ChatStats | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let controller: AbortController | null = null;
	let seq = 0;
	let destroyed = false;

	const poll = async () => {
		if (timer) clearTimeout(timer);
		timer = null;
		const id = chatId;
		const mine = ++seq;
		if (!id || destroyed) return;
		const keepGoing = () => active || LIVE.includes(stats?.phase ?? '');
		if (typeof document !== 'undefined' && document.hidden) {
			if (keepGoing()) timer = setTimeout(poll, 1000);
			return;
		}
		controller?.abort();
		controller = new AbortController();
		let next: ChatStats | null = null;
		try {
			next = await getChatStats(localStorage.token, id, controller.signal);
		} catch {
			next = null;
		}
		if (mine !== seq || id !== chatId || destroyed) return;
		stats = next;
		if (keepGoing()) timer = setTimeout(poll, 1000);
	};

	let shownFor = '';
	$: if (chatId !== shownFor) {
		shownFor = chatId;
		stats = null;
		poll();
	}
	// Start polling when a reply starts, and read the final figures once when it ends.
	let wasActive = active;
	$: if (active !== wasActive) {
		wasActive = active;
		poll();
	}

	onDestroy(() => {
		destroyed = true;
		controller?.abort();
		if (timer) clearTimeout(timer);
	});

	const k = (n: number) => `${n > 0 ? Math.max(1, Math.round(n / 1000)) : 0}k`;
	const rate = (r: number) =>
		r >= 1000 ? `${(r / 1000).toFixed(1)}k/s` : `${Math.round(r)}/s`;
	const secs = (s: number | undefined) => `${Math.floor(s ?? 0)}s`;
	const exact = (n: number | undefined) => (typeof n === 'number' ? Math.round(n).toLocaleString() : '?');

	$: phase = stats?.phase ?? 'none';
	$: speed =
		phase === 'prefill'
			? `prefilling ${secs(stats?.elapsed_s)}`
			: phase === 'compacting'
				? `compacting ${secs(stats?.elapsed_s)}`
				: phase === 'decode'
					? `${stats?.decode_tps ? Math.round(stats.decode_tps) : '…'} t/s`
					: [
							stats?.decode_tps ? `${Math.round(stats.decode_tps)} t/s` : '',
							stats?.prefill_tps ? `pp ${rate(stats.prefill_tps)}` : ''
						]
							.filter(Boolean)
							.join(' · ');
	$: context =
		stats?.ctx_used || stats?.ctx_max
			? `${stats?.ctx_used ? k(stats.ctx_used) : '–'}${stats?.ctx_max ? `/${k(stats.ctx_max)}` : ''}`
			: '';
	$: help = [
		phase === 'prefill'
			? `Reading the prompt (prefill) for ${secs(stats?.elapsed_s)}.`
			: phase === 'compacting'
				? `Summarizing earlier parts of this chat to free context, for ${secs(stats?.elapsed_s)}.`
				: '',
		stats?.decode_tps
			? `Generation: ${exact(stats.decode_tps)} tokens/s${phase === 'decode' ? ' (now)' : ' (last reply)'}.`
			: '',
		phase === 'idle' && stats?.prefill_tps
			? `pp = prompt reading (prefill): ${exact(stats.prefill_tps)} tokens/s, counting only the part of the prompt that was not cached.`
			: '',
		context
			? `Context: ${exact(stats?.ctx_used)} of ${exact(stats?.ctx_max)} tokens, as of the last finished request.`
			: ''
	]
		.filter(Boolean)
		.join('<br>');
	$: visible = phase !== 'none' && !!(speed || context);
</script>

{#if visible}
	<Tooltip content={help} placement="top" className="flex shrink-0 self-center">
		<div
			class="flex items-center gap-2 whitespace-nowrap text-[0.75rem] leading-none tabular-nums text-gray-500 dark:text-gray-400"
			aria-label={help.replaceAll('<br>', ' ')}
		>
			<span class="min-w-[18ch] text-right">{speed}</span>
			{#if context}<span>{context}</span>{/if}
		</div>
	</Tooltip>
{/if}
