<script lang="ts">
	// Fork addition, round 4: same manager presentation in picker and waiting reply.
	// It is mounted under every reply that has no text yet, for every model (cloud ones too),
	// so it draws nothing unless the manager has something to say about this model.
	import { toast } from 'svelte-sonner';
	import { models, user } from '$lib/stores';
	import { cancelManagedLoad, loadManagedModel } from '$lib/apis/model-manager';
	import OperationPlan from './OperationPlan.svelte';
	import {
		knownManagedId,
		managedId,
		managerState,
		managerConnection,
		refreshManagerState
	} from './state';
	export let modelId = '';
	export let inline = false;
	let acting = false;
	$: model = $models.find((m) => m.id === modelId) ?? { id: modelId };
	$: state = $managerState;
	$: id = managedId(model, state);
	// While the service can't be reached, only models it managed before get the notice.
	$: offlineId = $managerConnection === 'offline' ? knownManagedId(model) : null;
	$: view = id ? state?.ux?.models?.[id] : null;
	$: op = state?.ux?.operation?.outcome === 'running' ? state.ux.operation : null;
	$: admin = $user?.role === 'admin';
	$: error = view?.error;
	$: show = !!id && !!view && (!inline || !!op || !!error || !!view.waiting);
	$: ready = !!id && state?.phase === 'ready' && state?.model === id;
	$: legacy = !!id && !!state && !state.ux && !inline;
	$: visible = !!offlineId || show || legacy;
	const act = async (fn: () => Promise<unknown>) => {
		if (acting) return;
		acting = true;
		try {
			await fn();
			refreshManagerState();
		} catch {
			toast.error('The action did not finish. Check the Model Manager status before trying again.');
		} finally {
			acting = false;
		}
	};
	const cancel = () => {
		if (window.confirm(state?.ux?.cancel_help ?? 'Cancel loading for everyone waiting for this model?')) {
			act(() => cancelManagedLoad(localStorage.token));
		}
	};
	const btn = 'rounded-lg border border-gray-200/70 px-2 py-1 disabled:opacity-50 dark:border-white/[0.08]';
</script>

<!-- The live region stays mounted (and unstyled while empty) so changes are announced. -->
<div
	class={visible
		? `min-w-0 max-w-full break-words text-xs text-gray-600 dark:text-gray-300 ${inline ? 'my-2 rounded-xl border border-gray-200 p-3 dark:border-gray-700' : 'py-1'}`
		: ''}
>
	<div role="status" aria-live="polite" aria-atomic="true">
		{#if offlineId}
			<p>The model service is not reachable. Progress cannot be checked; an existing load may still be running.</p>
			<p>
				{admin
					? 'Check your connection, then open Admin Settings > Model Manager and check the launcher.'
					: 'Check your connection and try again in a minute. If this continues, ask the admin.'}
			</p>
		{:else if show && (!op || op.model !== id) && !error}
			<p class="font-medium">{view.primary}</p>
			<p>{admin ? (view.admin_why ?? view.why) : view.why}</p>
		{/if}
	</div>
	{#if !offlineId && show}
		{#if op || error}
			<OperationPlan
				operation={op}
				problem={error}
				{admin}
				technical={[state?.detail, state?.log_tail].filter(Boolean).join('\n')}
			/>
		{/if}
		{#if op || view.waiting}
			<p class="mt-1">{state?.ux?.waiting_action}</p>
			{#if !admin}<p>Only an admin can cancel shared preparation. You can stop waiting in this chat.</p>{/if}
		{/if}
		{#if admin && (state?.phase === 'loading' || (!inline && !ready))}
			<div class="mt-1 flex flex-wrap gap-2">
				{#if state?.phase === 'loading'}
					<button type="button" class={btn} disabled={acting || !state?.ux?.actions?.can_cancel} on:click={cancel}
						>Cancel loading for everyone</button
					>
				{/if}
				{#if !inline && !ready}
					<!-- Disabled when refused; the reason is the status text above. -->
					<button
						type="button"
						class={btn}
						disabled={acting || !view.can_load}
						on:click={() => act(() => loadManagedModel(localStorage.token, id))}
						>{error ? 'Retry preparation' : 'Prepare now'}</button
					>
				{/if}
			</div>
		{/if}
	{:else if !offlineId && legacy}
		<p>The model manager needs an update to show preparation steps. Ask the admin.</p>
	{/if}
	{#if offlineId}
		<button type="button" class="mt-1 {btn}" on:click={refreshManagerState}>Check again</button>
	{/if}
</div>
