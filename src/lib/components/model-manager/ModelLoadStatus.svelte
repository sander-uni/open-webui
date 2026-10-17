<script lang="ts">
	// Fork addition: one line under the chat model picker saying whether the picked local model
	// is loaded, loading (with progress), waiting for another model, or failed to load.
	import { toast } from 'svelte-sonner';
	import { models, user } from '$lib/stores';
	import { loadManagedModel } from '$lib/apis/model-manager';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import { managedId, managerState, refreshManagerState } from './state';

	export let modelId: string = '';

	let starting = false;

	$: model = $models.find((m) => m.id === modelId);
	$: state = $managerState;
	$: id = managedId(model, state);

	const duration = (s: number | null) => {
		if (s === null || s === undefined) return '';
		return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
	};

	const loadNow = async () => {
		if (!id) return;
		starting = true;
		try {
			await loadManagedModel(localStorage.token, id);
			refreshManagerState();
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			starting = false;
		}
	};
</script>

{#if state && id}
	<div class="flex max-w-full items-center gap-1.5 px-0.5 text-xs text-gray-500 dark:text-gray-400">
		{#if state.phase === 'loading' && state.target === id}
			<Spinner className="size-3 shrink-0" />
			<span class="truncate">
				Loading {id}{state.detail ? ` · ${state.detail}` : ''} · {duration(state.elapsed_s)}
			</span>
		{:else if state.switch_to === id && state.inflight > 0}
			<Spinner className="size-3 shrink-0" />
			<span class="truncate">
				Waiting for {state.inflight} running request(s) on {state.model}, then loading {id}
			</span>
		{:else if (state.phase === 'loading' || state.phase === 'unloading') && state.target}
			<Spinner className="size-3 shrink-0" />
			<span class="truncate">
				{state.target} is {state.phase}; {id} can load after that
			</span>
		{:else if state.phase === 'ready' && state.model === id}
			<span class="size-1.5 shrink-0 rounded-full bg-green-500"></span>
			<span class="truncate">Loaded{state.pinned ? ' · pinned' : ''}</span>
		{:else if state.phase === 'error' && state.error?.model === id}
			<span class="size-1.5 shrink-0 rounded-full bg-red-500"></span>
			<span class="truncate text-red-600 dark:text-red-400" title={state.error.message}>
				{state.error.message}
			</span>
		{:else if state.pinned && state.model}
			<span class="size-1.5 shrink-0 rounded-full bg-amber-400"></span>
			<span class="truncate">{state.model} is pinned; unpin it to use {id}</span>
		{:else}
			<span class="size-1.5 shrink-0 rounded-full bg-gray-400"></span>
			<span class="truncate">Not loaded · loads when you send a message</span>
			{#if $user?.role === 'admin'}
				<button
					class="shrink-0 rounded px-1 text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800"
					disabled={starting}
					on:click={loadNow}
					type="button">Load now</button
				>
			{/if}
		{/if}
	</div>
{/if}
