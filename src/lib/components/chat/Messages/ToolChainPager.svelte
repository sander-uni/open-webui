<script lang="ts">
	import { getContext, onMount, tick } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as I18n } from 'i18next';
	import { OUTPUT_PAGE_SIZE } from './outputWindow';

	const i18n = getContext<Writable<I18n>>('i18n');
	export let totalSteps = 0;
	export let hiddenSteps = 0;
	export let visibleSteps = OUTPUT_PAGE_SIZE;

	let marker: HTMLDivElement;
	let scrollRoot: HTMLElement | null = null;
	let loading = false;
	let following = true;
	let previousTotal = totalSteps;
	let previousScroll = 0;

	// Keep already-loaded history in place while new tool rounds are appended.
	$: if (totalSteps !== previousTotal) {
		if (!following || visibleSteps > OUTPUT_PAGE_SIZE) {
			visibleSteps += Math.max(0, totalSteps - previousTotal);
		}
		previousTotal = totalSteps;
	}

	function findScrollRoot(element: HTMLElement): HTMLElement {
		for (let parent = element.parentElement; parent; parent = parent.parentElement) {
			if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
		}
		return document.scrollingElement as HTMLElement;
	}

	async function loadEarlier() {
		if (loading || hiddenSteps === 0) return;
		loading = true;
		following = false;
		const root = scrollRoot;
		const height = root?.scrollHeight ?? 0;
		const top = root?.scrollTop ?? 0;
		visibleSteps += OUTPUT_PAGE_SIZE;
		await tick();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		if (root) {
			// Absolute assignment also works when native scroll anchoring ran first.
			root.scrollTop = top + root.scrollHeight - height;
			previousScroll = root.scrollTop;
		}
		loading = false;
	}

	async function showRecent() {
		visibleSteps = OUTPUT_PAGE_SIZE;
		following = true;
		await tick();
		if (scrollRoot) scrollRoot.scrollTop = scrollRoot.scrollHeight;
	}

	onMount(() => {
		scrollRoot = findScrollRoot(marker);
		previousScroll = scrollRoot.scrollTop;
		const target = scrollRoot === document.scrollingElement ? window : scrollRoot;
		const onScroll = () => {
			if (!scrollRoot || loading) return;
			const top = scrollRoot.scrollTop;
			const upward = top < previousScroll;
			previousScroll = top;
			following = scrollRoot.scrollHeight - top - scrollRoot.clientHeight < 40;
			if (!upward || hiddenSteps === 0) return;
			const rootTop =
				scrollRoot === document.scrollingElement ? 0 : scrollRoot.getBoundingClientRect().top;
			const bounds = marker.getBoundingClientRect();
			if (bounds.top <= rootTop + 140 && bounds.bottom >= rootTop - 140) void loadEarlier();
		};
		target.addEventListener('scroll', onScroll, { passive: true });
		return () => target.removeEventListener('scroll', onScroll);
	});
</script>

<div class="tool-chain-window" data-total-steps={totalSteps} data-hidden-steps={hiddenSteps}>
	<div bind:this={marker} class="tool-chain-page-boundary">
		{#if totalSteps > OUTPUT_PAGE_SIZE}
			<div class="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-gray-500">
				<span aria-live="polite">
					{$i18n.t('Showing {{COUNT}} of {{TOTAL}} steps', {
						COUNT: totalSteps - hiddenSteps,
						TOTAL: totalSteps
					})}
				</span>
				<div class="flex gap-3">
					{#if hiddenSteps > 0}
						<button
							type="button"
							class="hover:text-gray-700 dark:hover:text-gray-300 underline"
							disabled={loading}
							on:click={loadEarlier}
						>
							{$i18n.t('Load earlier steps')}
						</button>
					{/if}
					{#if visibleSteps > OUTPUT_PAGE_SIZE}
						<button
							type="button"
							class="hover:text-gray-700 dark:hover:text-gray-300 underline"
							on:click={showRecent}>{$i18n.t('Show recent steps')}</button
						>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>
