<script lang="ts">
	import { getContext, onMount, tick } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as I18n } from 'i18next';
	import { OUTPUT_PAGE_SIZE, type HiddenTotals } from './outputWindow';

	const i18n = getContext<Writable<I18n>>('i18n');
	export let totalSteps = 0;
	export let hiddenSteps = 0;
	export let visibleSteps = OUTPUT_PAGE_SIZE;
	export let pageSize = OUTPUT_PAGE_SIZE;
	export let autoLoad = true;
	export let hiddenTotals: HiddenTotals | null = null;
	// Steps added only because new rounds arrived while you were scrolled away from the
	// bottom. Bound by the parent so it survives this component being re-created.
	export let autoGrown = 0;

	// Show the most used tools by name; fold the rest into "other".
	const MAX_TOOL_NAMES = 4;
	const number = (value: number) => value.toLocaleString();
	const plural = (count: number, one: string, other: string) =>
		$i18n.t(count === 1 ? one : other, { COUNT: number(count) });
	$: summaryParts = (() => {
		if (!hiddenTotals || hiddenSteps === 0) return [];
		const entries = Object.entries(hiddenTotals.toolCounts).sort((a, b) => b[1] - a[1]);
		const tools = entries
			.slice(0, MAX_TOOL_NAMES)
			.map(([name, count]) => `${number(count)} ${name}`);
		const other = entries.slice(MAX_TOOL_NAMES).reduce((total, [, count]) => total + count, 0);
		if (other > 0) tools.push($i18n.t('{{COUNT}} other', { COUNT: number(other) }));
		const calls = plural(
			hiddenTotals.toolCallCount,
			'Hidden above: {{COUNT}} tool call',
			'Hidden above: {{COUNT}} tool calls'
		);
		const parts: Array<{ text: string; error?: boolean }> = [
			{ text: tools.length ? `${calls} (${tools.join(', ')})` : calls }
		];
		if (hiddenTotals.failedCount > 0) {
			parts.push({
				text: $i18n.t('{{COUNT}} failed or rejected', { COUNT: number(hiddenTotals.failedCount) }),
				error: true
			});
		}
		if (hiddenTotals.messageCount > 0) {
			parts.push({
				text: plural(hiddenTotals.messageCount, '{{COUNT}} message', '{{COUNT}} messages')
			});
		}
		if (hiddenTotals.reasoningCount > 0) {
			parts.push({
				text: plural(hiddenTotals.reasoningCount, '{{COUNT}} thought', '{{COUNT}} thoughts')
			});
		}
		if (hiddenTotals.codeInterpreterCount > 0) {
			parts.push({
				text: plural(hiddenTotals.codeInterpreterCount, '{{COUNT}} analysis', '{{COUNT}} analyses')
			});
		}
		if (hiddenTotals.compactionCount > 0) {
			// fork 0.3.4
			parts.push({
				text: plural(hiddenTotals.compactionCount, '{{COUNT}} compaction', '{{COUNT}} compactions')
			});
		}
		return parts;
	})();

	let marker: HTMLDivElement;
	let scrollRoot: HTMLElement | null = null;
	let loading = false;
	let following = true;
	let previousTotal = totalSteps;
	let previousScroll = 0;
	let previousHeight = 0;
	// Auto-loading waits until scrolling has come to rest (iOS momentum included), loads one
	// page, and is then disarmed until the paging line leaves the top of the screen. A fling
	// through the boundary therefore never loads a chain of pages.
	const REST_MS = 250;
	let restTimer: ReturnType<typeof setTimeout> | undefined;
	let movedUp = false;
	let armed = true;

	// While you are scrolled away from the bottom, the window never drops steps from its
	// top: new rounds are only added at the end, so what you are reading (and pages you
	// loaded) stays put while the model generates. Returning to the bottom (or "Show
	// recent steps") drops that extra growth again.
	$: if (totalSteps !== previousTotal) {
		const added = Math.max(0, totalSteps - previousTotal);
		previousTotal = totalSteps;
		if (!following && added > 0) {
			visibleSteps += added;
			autoGrown += added;
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

	// Adds steps below the paging line and keeps what is on screen in place.
	async function reveal(amount: number) {
		if (loading || hiddenSteps === 0) return;
		loading = true;
		following = false;
		autoGrown = 0;
		armed = false;
		const root = scrollRoot;
		const height = root?.scrollHeight ?? 0;
		const top = root?.scrollTop ?? 0;
		visibleSteps = amount === Infinity ? Infinity : visibleSteps + amount;
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

	const loadEarlier = () => reveal(pageSize);
	const showAll = () => reveal(Infinity);

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
		const nearTop = () => {
			if (!scrollRoot || !marker) return false;
			const rootTop =
				scrollRoot === document.scrollingElement ? 0 : scrollRoot.getBoundingClientRect().top;
			const bounds = marker.getBoundingClientRect();
			return bounds.top <= rootTop + 140 && bounds.bottom >= rootTop - 140;
		};
		const onRest = () => {
			restTimer = undefined;
			const wasUp = movedUp;
			movedUp = false;
			if (loading || !autoLoad || !armed || !wasUp || hiddenSteps === 0) return;
			if (nearTop()) void loadEarlier();
		};
		const onScroll = () => {
			if (!scrollRoot || loading) return;
			const top = scrollRoot.scrollTop;
			// Content that shrinks (the window sliding) pulls scrollTop up without the user
			// scrolling; that must not count as scrolling up to load more.
			const shrank = scrollRoot.scrollHeight < previousHeight;
			previousHeight = scrollRoot.scrollHeight;
			if (top < previousScroll && !shrank) movedUp = true;
			else if (top > previousScroll) movedUp = false;
			previousScroll = top;
			setFollowing(nearBottom(scrollRoot));
			if (!nearTop()) armed = true;
			clearTimeout(restTimer);
			restTimer = setTimeout(onRest, REST_MS);
		};
		target.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			clearTimeout(restTimer);
			target.removeEventListener('scroll', onScroll);
		};
	});
</script>

<div class="tool-chain-window" data-total-steps={totalSteps} data-hidden-steps={hiddenSteps}>
	<div bind:this={marker} class="tool-chain-page-boundary">
		{#if totalSteps > pageSize}
			<div class="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-gray-500">
				<span aria-live="polite">
					{$i18n.t('Showing {{COUNT}} of {{TOTAL}} steps', {
						COUNT: number(totalSteps - hiddenSteps),
						TOTAL: number(totalSteps)
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
							{$i18n.t('Load {{COUNT}} earlier steps', {
								COUNT: number(Math.min(pageSize, hiddenSteps))
							})}
						</button>
					{/if}
					{#if hiddenSteps > pageSize}
						<button
							type="button"
							class="hover:text-gray-700 dark:hover:text-gray-300 underline"
							disabled={loading}
							on:click={showAll}
						>
							{$i18n.t('Show all {{COUNT}} steps', { COUNT: number(totalSteps) })}
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
				{#if summaryParts.length}
					<!-- prettier-ignore -->
					<div class="tool-chain-hidden-summary basis-full text-gray-400 dark:text-gray-500">{#each summaryParts as part, index}<span class={part.error ? 'text-red-500 dark:text-red-400' : ''}>{index > 0 ? ' · ' : ''}{part.text}</span>{/each}</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
