<script lang="ts">
	// Fork addition, 0.4.0: the ChatGPT plan's usage next to the model name, while a Codex model
	// (or a workspace model on one) is selected: "5h 12% · wk 3%", the reset times in the tooltip.
	// Read from the model manager every 60 s while the tab is visible, and right after a reply.
	import { onDestroy } from 'svelte';
	import { models } from '$lib/stores';
	import { getCloudUsage, type CloudUsage } from '$lib/apis/model-manager';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import { baseIdOf, effortMeta } from './effort';

	export let selectedModels: string[] = [];
	export let active = false; // a reply is being generated

	let usage: CloudUsage | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let controller: AbortController | null = null;
	let destroyed = false;
	let seq = 0;

	$: model = selectedModels.length === 1 ? ($models ?? []).find((m) => m?.id === selectedModels[0]) : null;
	$: codexId = model && effortMeta(model, $models)?.provider === 'codex' ? baseIdOf(model) : '';

	const poll = async () => {
		if (timer) clearTimeout(timer);
		timer = null;
		const id = codexId;
		const mine = ++seq;
		if (!id || destroyed) return;
		if (typeof document === 'undefined' || !document.hidden) {
			controller?.abort();
			controller = new AbortController();
			let next: CloudUsage | null = null;
			try {
				next = await getCloudUsage(localStorage.token, id, controller.signal);
			} catch {
				next = null;
			}
			if (mine !== seq || id !== codexId || destroyed) return;
			usage = next;
		}
		timer = setTimeout(poll, 60000);
	};

	let shownFor = '';
	$: if (codexId !== shownFor) {
		shownFor = codexId;
		usage = null;
		poll();
	}
	let wasActive = active;
	$: if (active !== wasActive) {
		wasActive = active;
		if (!active) setTimeout(poll, 1500); // the reply's own headers have updated it
	}

	onDestroy(() => {
		destroyed = true;
		controller?.abort();
		if (timer) clearTimeout(timer);
	});

	const pct = (w: any) => (w && typeof w.used_percent === 'number' ? `${Math.round(w.used_percent)}%` : '–');
	const when = (t: number | null | undefined) => {
		if (!t) return '';
		const d = new Date(t * 1000);
		const sameDay = d.toDateString() === new Date().toDateString();
		return sameDay
			? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
	};
	$: five = usage?.['5h'] ?? null;
	$: week = usage?.week ?? null;
	$: full = !!usage?.limit_reached || (five?.used_percent ?? 0) >= 100 || (week?.used_percent ?? 0) >= 100;
	$: help = usage?.error
		? `ChatGPT plan usage could not be read: ${usage.error}`
		: [
				`ChatGPT ${usage?.plan ? usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1) : ''} plan usage.`,
				five ? `5-hour window: ${pct(five)} used${five.resets_at ? `, resets ${when(five.resets_at)}` : ''}.` : '',
				week ? `Week: ${pct(week)} used${week.resets_at ? `, resets ${when(week.resets_at)}` : ''}.` : '',
				full ? 'A limit is reached: requests fail until it resets.' : ''
			]
				.filter(Boolean)
				.join('<br>');
</script>

{#if codexId && usage && (five || week || usage.error)}
	<Tooltip content={help} placement="top" className="flex shrink-0 self-center">
		<div
			class="flex items-center gap-1.5 whitespace-nowrap text-[0.75rem] leading-none tabular-nums {full
				? 'text-red-600 dark:text-red-400'
				: 'text-gray-500 dark:text-gray-400'}"
			aria-label={help.replaceAll('<br>', ' ')}
		>
			{#if usage.error}
				<span>5h – · wk –</span>
			{:else}
				<span>5h {pct(five)}</span><span aria-hidden="true">·</span><span>wk {pct(week)}</span>
			{/if}
		</div>
	</Tooltip>
{/if}
