<script lang="ts">
	import { getContext, onMount, tick } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as I18n } from 'i18next';
	import { OUTPUT_PAGE_SIZE } from './outputWindow';

	const i18n = getContext<Writable<I18n>>('i18n');
	export let totalSteps = 0;
	export let hiddenSteps = 0;
	export let visibleSteps = OUTPUT_PAGE_SIZE;
	export let pageSize = OUTPUT_PAGE_SIZE;
	export let autoLoad = true;

	let marker: HTMLDivElement;
	let scrollRoot: HTMLElement | null = null;
	let loading = false;
	let following = true;
	let previousTotal = totalSteps;
	let previousScroll = 0;
	let previousHeight = 0;
	// Steps added only because new tool rounds arrived while scrolled away from the bottom.
	let autoGrown = 0;

	// While you read above the bottom, new rounds are added without removing the steps you
	// are looking at, for at most one extra page; after that the window slides as usual.
	// Returning to the bottom (or "Show recent steps") drops that extra growth again.
	$: if (totalSteps !== previousTotal) {
		const added = Math.max(0, totalSteps - previousTotal);
		previousTotal = totalSteps;
		if (!following && added > 0) {
			const grow = Math.min(added, Math.max(0, pageSize - autoGrown));
			visibleSteps += grow;
			autoGrown += grow;
		}
	}

	function setFollowing(value: boolean) {
		if (value && !following && autoGrown > 0) {
			visibleSteps = Math.max(pageSize, visibleSteps - autoGrown);
			autoGrown = 0;
		}
		following = value;
	}

	function nearBottom(root: HTMLElement) {
		return root.scrollHeight - root.scrollTop - root.clientHeight < 40;
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
		autoGrown = 0;
		const root = scrollRoot;
		const height = root?.scrollHeight ?? 0;
		const top = root?.scrollTop ?? 0;
		visibleSteps += pageSize;
		await tick();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		if (root) {
			// Absolute assignment also works when native scroll anchoring ran first.
			root.scrollTop = top + root.scrollHeight - height;
			previousScroll = root.scrollTop;
			previousHeight = root.scrollHeight;
		}
		loading = false;
	}

	async function showRecent() {
		visibleSteps = pageSize;
		autoGrown = 0;
		following = true;
		await tick();
		if (scrollRoot) scrollRoot.scrollTop = scrollRoot.scrollHeight;
	}

	onMount(() => {
		scrollRoot = findScrollRoot(marker);
		previousScroll = scrollRoot.scrollTop;
		previousHeight = scrollRoot.scrollHeight;
		following = nearBottom(scrollRoot);
		const target = scrollRoot === document.scrollingElement ? window : scrollRoot;
		const onScroll = () => {
			if (!scrollRoot || loading) return;
			const top = scrollRoot.scrollTop;
			// Content that shrinks (the window sliding) pulls scrollTop up without the user
			// scrolling; that must not count as scrolling up to load more.
			const shrank = scrollRoot.scrollHeight < previousHeight;
			previousHeight = scrollRoot.scrollHeight;
			const upward = top < previousScroll && !shrank;
			previousScroll = top;
			setFollowing(nearBottom(scrollRoot));
			if (!autoLoad || !upward || hiddenSteps === 0) return;
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
		{#if totalSteps > pageSize}
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
					{#if visibleSteps > pageSize}
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
