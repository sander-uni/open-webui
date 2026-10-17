<script lang="ts">
	// Fork addition: what the local model manager is doing for a model.
	// - under the chat model picker (default): every state, with Load now / Cancel
	// - inline in a reply that is still waiting (inline): only while something is happening
	import { toast } from 'svelte-sonner';
	import { models, user } from '$lib/stores';
	import { cancelManagedLoad, loadManagedModel } from '$lib/apis/model-manager';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import { managedId, managerState, refreshManagerState } from './state';

	export let modelId: string = '';
	export let inline = false;

	let acting = false;

	$: model = $models.find((m) => m.id === modelId) ?? { id: modelId };
	$: state = $managerState;
	$: id = managedId(model, state);
	$: busy = !!state && (state.phase === 'loading' || state.phase === 'unloading');
	$: mine = !!state && !!id && state.target === id;
	$: admin = $user?.role === 'admin';
	// Inline (in a waiting reply): only while something is happening for this request.
	$: show =
		!inline ||
		busy ||
		(!!state && state.switch_to === id && state.inflight > 0) ||
		(!!state && state.phase === 'error' && state.error?.model === id);

	const duration = (s: number | null) => {
		if (s === null || s === undefined) return '';
		return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
	};

	const act = async (fn: () => Promise<unknown>) => {
		acting = true;
		try {
			await fn();
			refreshManagerState();
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			acting = false;
		}
	};
	const loadNow = () => id && act(() => loadManagedModel(localStorage.token, id));
	const cancel = () => act(() => cancelManagedLoad(localStorage.token));

	const btn =
		'shrink-0 rounded px-1 text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800';
</script>

{#if state && id}
	{#if show}
		<div
			class="flex max-w-full flex-col gap-0.5 text-xs text-gray-500 dark:text-gray-400 {inline
				? 'my-1.5 rounded-xl border border-gray-100 px-2.5 py-1.5 dark:border-gray-800'
				: 'px-0.5'}"
		>
			<div class="flex max-w-full items-center gap-1.5">
				{#if state.phase === 'loading' && mine}
					<Spinner className="size-3 shrink-0" />
					<span class="truncate">
						Loading {id}{state.detail ? ` · ${state.detail}` : ''} · {duration(state.elapsed_s)}
					</span>
					{#if admin}
						<button class={btn} disabled={acting} on:click={cancel} type="button">Cancel</button>
					{/if}
				{:else if state.phase === 'unloading' && mine}
					<Spinner className="size-3 shrink-0" />
					<span class="truncate">
						Unloading {id}{state.detail ? ` · ${state.detail}` : ''} · {duration(state.elapsed_s)}
					</span>
				{:else if state.switch_to === id && state.inflight > 0}
					<Spinner className="size-3 shrink-0" />
					<span class="truncate">
						Waiting for {state.inflight} running request(s) on {state.model}, then loading {id}
					</span>
				{:else if busy && state.target}
					<Spinner className="size-3 shrink-0" />
					<span class="truncate">
						{state.target} is {state.phase}{state.detail ? ` (${state.detail})` : ''}; {id} loads after
						that
					</span>
				{:else if state.phase === 'ready' && state.model === id}
					<span class="size-1.5 shrink-0 rounded-full bg-green-500"></span>
					<span class="truncate">Loaded{state.pinned ? ' · pinned' : ''}</span>
				{:else if state.error?.model === id}
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
					{#if admin}
						<button class={btn} disabled={acting} on:click={loadNow} type="button">Load now</button>
					{/if}
				{/if}
			</div>
			{#if busy && state.log_tail}
				<div
					class="max-w-full truncate pl-[1.125rem] font-mono text-[0.625rem] text-gray-400 dark:text-gray-500"
					title={state.log_tail}
				>
					{state.log_tail}
				</div>
			{/if}
		</div>
	{/if}
{/if}
