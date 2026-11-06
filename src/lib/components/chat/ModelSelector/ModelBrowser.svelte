<script lang="ts">
	// Fork addition: the "More models" window. Floating on a PC or iPad (drag the title bar, resize
	// at any edge, the size is remembered), the whole screen on a narrow one. One dropdown per
	// inference engine, ChatGPT, cloud and presets; typing replaces them with a flat result list.
	import { getContext, onDestroy, onMount, tick } from 'svelte';
	import { mobile } from '$lib/stores';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import ChevronRight from '$lib/components/icons/ChevronRight.svelte';
	import Search from '$lib/components/icons/Search.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';
	import Switch from '$lib/components/common/Switch.svelte';
	import LoadedNow from '$lib/components/model-manager/LoadedNow.svelte';
	import MagicToggle from '$lib/components/model-manager/MagicToggle.svelte';
	import { managerState } from '$lib/components/model-manager/state';
	import { searchItems } from '$lib/components/model-manager/modelSearch';
	import {
		GROUPS,
		groupLabel,
		groupOf,
		isExperimental,
		isPreset,
		experimentalShown,
		loadOpenGroups,
		magicSearch,
		loadSize,
		saveOpenGroups,
		saveSize,
		setExperimentalShown,
		toggleFavorite
	} from '$lib/components/model-manager/picks';
	import ModelItem from './ModelItem.svelte';

	const i18n: any = getContext('i18n');

	export let items: any[] = [];
	export let value = '';
	export let selectedValues: string[] = [];
	export let compareEnabled = false;
	export let selectionOnly = false;
	export let favorites: string[] = [];
	export let pinModelHandler: (id: string) => void = () => {};
	export let unloadModelHandler: (model: any) => void = () => {};
	export let managerUnloadHandler: (model: any) => void = () => {};
	export let deleteModelHandler: (model: any) => void = () => {};
	export let onPick: (item: any) => void = () => {};
	export let onClose: () => void = () => {};

	const MIN_W = 380;
	const MIN_H = 320;
	const NARROW = 640;
	const MARGIN = 8;

	let root: HTMLElement;
	let list: HTMLElement;
	let search = '';
	let open = loadOpenGroups();
	let confirmUnload = false;
	let cursor = 0;
	let keyed = false; // the header outline shows only once the arrow keys are in use

	let vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
	let vh = typeof window !== 'undefined' ? window.innerHeight : 800;
	$: narrow = vw < NARROW;

	let box = { x: 0, y: 0, w: 640, h: 560 };

	const clamp = (b: typeof box) => {
		const w = Math.min(Math.max(b.w, MIN_W), vw - 2 * MARGIN);
		const h = Math.min(Math.max(b.h, MIN_H), vh - 2 * MARGIN);
		return {
			w,
			h,
			x: Math.min(Math.max(b.x, MARGIN), Math.max(MARGIN, vw - w - MARGIN)),
			y: Math.min(Math.max(b.y, MARGIN), Math.max(MARGIN, vh - h - MARGIN))
		};
	};

	const center = () => {
		const size = loadSize() ?? { w: 640, h: Math.min(620, vh - 80) };
		const b = clamp({ ...size, x: 0, y: 0 });
		box = clamp({ ...b, x: (vw - b.w) / 2, y: (vh - b.h) / 2 });
	};

	const onViewport = () => {
		vw = window.innerWidth;
		vh = window.innerHeight;
		box = clamp(box);
	};

	// One pointer at a time: move or resize. Works the same for mouse, pen and touch.
	let gesture: { id: number; dir: string; px: number; py: number; from: typeof box } | null = null;

	const start = (e: PointerEvent, dir: string) => {
		if (narrow || e.button !== 0) return;
		e.preventDefault();
		gesture = { id: e.pointerId, dir, px: e.clientX, py: e.clientY, from: { ...box } };
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
	};

	const move = (e: PointerEvent) => {
		if (!gesture || e.pointerId !== gesture.id) return;
		const dx = e.clientX - gesture.px;
		const dy = e.clientY - gesture.py;
		const { dir, from } = gesture;
		if (dir === 'move') {
			box = clamp({ ...from, x: from.x + dx, y: from.y + dy });
			return;
		}
		let { x, y, w, h } = from;
		if (dir.includes('e')) w = Math.min(from.w + dx, vw - MARGIN - from.x);
		if (dir.includes('s')) h = Math.min(from.h + dy, vh - MARGIN - from.y);
		if (dir.includes('w')) {
			w = Math.min(from.w - dx, from.x + from.w - MARGIN);
			w = Math.max(w, MIN_W);
			x = from.x + from.w - w;
		}
		if (dir.includes('n')) {
			h = Math.min(from.h - dy, from.y + from.h - MARGIN);
			h = Math.max(h, MIN_H);
			y = from.y + from.h - h;
		}
		box = clamp({ x, y, w, h });
	};

	const end = (e: PointerEvent) => {
		if (!gesture || e.pointerId !== gesture.id) return;
		if (gesture.dir !== 'move') saveSize({ w: box.w, h: box.h });
		gesture = null;
	};

	$: visible = items.filter(
		(item) => !(item.model?.info?.meta?.hidden ?? false) && ($experimentalShown || !isExperimental(item))
	);
	$: experimentalCount = items.filter(
		(item) => !(item.model?.info?.meta?.hidden ?? false) && isExperimental(item)
	).length;
	$: searching = search.trim() !== '';
	$: withEngine = (item: any) => {
		const key = groupOf(item, $managerState);
		return { ...item, engineLabel: isPreset(item) ? $i18n.t('Preset') : groupLabel(key) };
	};
	$: results = searching ? searchItems(visible, search, $magicSearch).map(withEngine) : [];
	$: groups = GROUPS.map((group) => ({
		...group,
		items: visible.filter((item) => groupOf(item, $managerState) === group.key)
	})).filter((group) => group.items.length > 0);

	// Rows the arrow keys walk through: group headers and the models under open ones.
	$: rows = searching
		? results.map((item) => ({ item }))
		: groups.flatMap((group) => [
				{ group },
				...(open[group.key] ? group.items.map((item) => ({ item })) : [])
			]);
	$: if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);

	const scrollToCursor = async () => {
		await tick();
		root?.querySelector('[data-row-cursor="true"], [data-arrow-selected="true"]')?.scrollIntoView({
			block: 'nearest',
			inline: 'nearest',
			behavior: 'instant'
		});
	};

	const toggle = (key: string) => {
		open = { ...open, [key]: !open[key] };
		saveOpenGroups(open);
	};

	const activate = (row: any) => {
		if (row?.group) toggle(row.group.key);
		else if (row?.item) onPick(row.item);
	};

	const onKeydown = (e: KeyboardEvent) => {
		const target = e.target as HTMLElement;
		// A dialog, the picker or a row's menu above this window answers its own keys.
		if (confirmUnload || document.querySelector('.modal, [data-model-picker]')) return;
		if (target?.closest?.('.model-selector-child-menu')) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (search) {
				search = '';
				cursor = 0;
			} else {
				onClose();
			}
			return;
		}
		if (!root?.contains(target)) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			keyed = true;
			cursor = Math.min(Math.max(cursor + (e.key === 'ArrowDown' ? 1 : -1), 0), rows.length - 1);
			scrollToCursor();
		} else if (
			e.key === 'Enter' ||
			(e.key === ' ' && target?.tagName !== 'INPUT')
		) {
			// The highlighted row counts, not the one that has focus. The star, a row's menu and the
			// window's own buttons are left alone.
			if (target?.matches?.('input, [data-value], [data-group]')) {
				e.preventDefault();
				activate(rows[cursor]);
			}
		}
	};

	// A click on the background closes the window like its X. It has to start out there too, so a
	// drag or resize that ends outside doesn't count, and whatever sits above the window goes first:
	// a dialog, a row's menu (that click only closes the menu), a tooltip or a toast.
	let pressedOutside = false;

	const onPointerDown = (e: PointerEvent) => {
		const target = e.target as HTMLElement;
		pressedOutside =
			!root?.contains(target) &&
			!confirmUnload &&
			!document.querySelector('.modal, .model-selector-child-menu') &&
			!target?.closest?.('[data-tippy-root], [data-sonner-toaster], [data-model-picker]');
	};

	const onPointerCancel = () => (pressedOutside = false); // a scroll on a touch screen

	const onWindowClick = (e: MouseEvent) => {
		// detail 0 = not a pointer: a shortcut clicking a button
		const close = pressedOutside && e.detail !== 0 && !root?.contains(e.target as Node);
		pressedOutside = false;
		if (close) onClose();
	};

	const onInput = () => {
		cursor = 0;
		if (list) list.scrollTop = 0;
	};

	const portal = (node: HTMLElement) => {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	};

	onMount(() => {
		center();
		window.addEventListener('resize', onViewport);
		window.addEventListener('keydown', onKeydown, true);
		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('pointercancel', onPointerCancel, true);
		window.addEventListener('click', onWindowClick, true);
		// Not on touch: the keyboard would cover the list before anything is asked of it.
		if (!$mobile && !window.matchMedia?.('(pointer: coarse)')?.matches) {
			tick().then(() => document.getElementById('model-browser-search')?.focus());
		}
	});
	onDestroy(() => {
		if (typeof window === 'undefined') return;
		window.removeEventListener('resize', onViewport);
		window.removeEventListener('keydown', onKeydown, true);
		window.removeEventListener('pointerdown', onPointerDown, true);
		window.removeEventListener('pointercancel', onPointerCancel, true);
		window.removeEventListener('click', onWindowClick, true);
	});

	const EDGES = [
		['n', 'left-3 right-3 -top-1 h-2 cursor-ns-resize'],
		['s', 'left-3 right-3 -bottom-1 h-2 cursor-ns-resize'],
		['w', 'top-3 bottom-3 -left-1 w-2 cursor-ew-resize'],
		['e', 'top-3 bottom-3 -right-1 w-2 cursor-ew-resize'],
		['nw', '-left-1 -top-1 size-4 cursor-nwse-resize'],
		['ne', '-right-1 -top-1 size-4 cursor-nesw-resize'],
		['sw', '-left-1 -bottom-1 size-4 cursor-nesw-resize'],
		['se', '-right-1 -bottom-1 size-6 cursor-nwse-resize pointer-coarse:size-9']
	];
</script>

<div use:portal>
	<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
	<div
		bind:this={root}
		role="dialog"
		aria-label={$i18n.t('More models')}
		data-model-browser
		class="fixed z-[9999] flex flex-col bg-white text-gray-800 shadow-2xl outline-hidden dark:bg-gray-850 dark:text-gray-100 {narrow
			? 'inset-0'
			: 'rounded-xl border border-gray-200 dark:border-gray-700'}"
		style={narrow ? '' : `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;`}
	>
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			class="flex h-10 shrink-0 select-none items-center gap-2 pl-3.5 pr-1.5 {narrow
				? ''
				: 'cursor-move touch-none'}"
			data-title-bar
			on:pointerdown={(e) => start(e, 'move')}
			on:pointermove={move}
			on:pointerup={end}
			on:pointercancel={end}
		>
			<div class="min-w-0 flex-1 truncate text-sm font-medium">{$i18n.t('More models')}</div>
			<button
				type="button"
				class="focus-ring flex size-8 items-center justify-center rounded-lg text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 pointer-coarse:size-10"
				aria-label={$i18n.t('Close')}
				on:pointerdown|stopPropagation
				on:click={onClose}
			>
				<XMark className="size-4" />
			</button>
		</div>

		<div class="flex shrink-0 flex-col gap-1.5 px-2.5 pb-1.5">
			<LoadedNow bind:showConfirm={confirmUnload} />
			<div
				class="flex h-9 items-center gap-2 rounded-xl border border-gray-100 px-2.5 dark:border-gray-800"
			>
				<Search className="size-3.5 shrink-0" strokeWidth="2" />
				<input
					id="model-browser-search"
					bind:value={search}
					on:input={onInput}
					class="w-full bg-transparent text-sm outline-hidden placeholder:text-gray-400 dark:placeholder:text-gray-500"
					placeholder={$i18n.t('Search a model')}
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					aria-label={$i18n.t('Search In Models')}
				/>
				<MagicToggle onChange={onInput} />
			</div>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5" bind:this={list}>
			{#if searching}
				<div class="sr-only" aria-live="polite">{$i18n.t('{{count}} items', { count: results.length })}</div>
				{#if results.length === 0}
					<div class="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
						{$i18n.t('No results found')}
					</div>
				{/if}
				{#each results as item, index (item.value)}
					<ModelItem
						bind:selectedModelIdx={cursor}
						{item}
						{index}
						{value}
						{selectedValues}
						{compareEnabled}
						{selectionOnly}
						{pinModelHandler}
						{unloadModelHandler}
						{managerUnloadHandler}
						{deleteModelHandler}
						favorite={favorites.includes(item.value)}
						onToggleFavorite={() => toggleFavorite(item.value)}
						onClick={() => onPick(item)}
						onEdit={onClose}
					/>
				{/each}
			{:else}
				{#each rows as row, index (row.group ? `group:${row.group.key}` : row.item.value)}
					{#if row.group}
						<button
							type="button"
							class="focus-ring sticky top-0 z-[1] flex min-h-8 w-full items-center gap-1.5 rounded-lg bg-white px-2 text-left text-[0.8125rem] font-medium text-gray-600 transition hover:bg-gray-50 dark:bg-gray-850 dark:text-gray-300 dark:hover:bg-gray-800 pointer-coarse:min-h-11 {keyed && cursor === index
								? 'outline-2 -outline-offset-2 outline-blue-500'
								: ''}"
							aria-expanded={!!open[row.group.key]}
							data-row-cursor={cursor === index}
							data-group={row.group.key}
							on:focus={() => (cursor = index)}
							on:click={() => {
								cursor = index;
								toggle(row.group.key);
							}}
						>
							{#if open[row.group.key]}
								<ChevronDown className="size-3" strokeWidth="2.5" />
							{:else}
								<ChevronRight className="size-3" strokeWidth="2.5" />
							{/if}
							<span>{$i18n.t(row.group.label)}</span>
							<span class="text-[0.6875rem] font-normal tabular-nums text-gray-400 dark:text-gray-500"
								>{row.group.items.length}</span
							>
						</button>
					{:else}
						<ModelItem
							bind:selectedModelIdx={cursor}
							item={row.item}
							{index}
							{value}
							{selectedValues}
							{compareEnabled}
							{selectionOnly}
							{pinModelHandler}
							{unloadModelHandler}
							{managerUnloadHandler}
							{deleteModelHandler}
							favorite={favorites.includes(row.item.value)}
							onToggleFavorite={() => toggleFavorite(row.item.value)}
							onClick={() => onPick(row.item)}
							onEdit={onClose}
						/>
					{/if}
				{/each}
			{/if}
		</div>

		{#if experimentalCount > 0}
			<div
				class="flex shrink-0 items-center justify-end gap-2 border-t border-gray-100 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400"
			>
				<span>{$i18n.t('Show experimental')} ({experimentalCount})</span>
				<Switch
					ariaLabel={$i18n.t('Show experimental')}
					state={$experimentalShown}
					on:change={(e) => {
						setExperimentalShown(e.detail);
						cursor = 0;
					}}
				/>
			</div>
		{/if}

		{#if !narrow}
			{#each EDGES as [dir, cls]}
				<!-- svelte-ignore a11y-no-static-element-interactions -->
				<div
					class="absolute z-[2] touch-none {cls}"
					data-resize={dir}
					on:pointerdown={(e) => start(e, dir)}
					on:pointermove={move}
					on:pointerup={end}
					on:pointercancel={end}
				/>
			{/each}
		{/if}
	</div>
</div>
