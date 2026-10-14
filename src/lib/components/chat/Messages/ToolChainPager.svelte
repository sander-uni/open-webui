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
		return parts;
	})();

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
				{#if summaryParts.length}
					<!-- prettier-ignore -->
					<div class="tool-chain-hidden-summary basis-full text-gray-400 dark:text-gray-500">{#each summaryParts as part, index}<span class={part.error ? 'text-red-500 dark:text-red-400' : ''}>{index > 0 ? ' · ' : ''}{part.text}</span>{/each}</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
