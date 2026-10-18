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
	// 0.3.2: the input row only appears while the model is not ready (the stats next to the
	// model name cover a ready one); the under-reply card only while something is happening.
	$: show = !!id && !!view && (!!op || !!error || !!view.waiting || (!inline && !ready));
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
	// min-h-8: a usable touch target on iOS.
	const btn =
		'min-h-8 rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs disabled:opacity-50 dark:border-white/[0.08]';
	$: tech = [state?.detail, state?.log_tail].filter(Boolean).join('\n');
	$: offlineHelp = admin
		? 'Check your connection, then open Admin Settings > Model Manager and check the launcher.'
		: 'Check your connection and try again in a minute. If this continues, ask the admin.';
</script>

<!-- The live region stays mounted (and unstyled while empty) so changes are announced. -->
{#if inline}
	<div
		class={visible
			? 'my-2 min-w-0 max-w-full break-words rounded-xl border border-gray-200 p-3 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300'
			: ''}
	>
		<div role="status" aria-live="polite" aria-atomic="true">
			{#if offlineId}
				<p>The model service is not reachable. Progress cannot be checked; an existing load may still be running.</p>
				<p>{offlineHelp}</p>
			{:else if show && (!op || op.model !== id) && !error}
				<p class="font-medium">{view.primary}</p>
				<p>{admin ? (view.admin_why ?? view.why) : view.why}</p>
			{/if}
		</div>
		{#if !offlineId && show}
			{#if op || error}
				<OperationPlan operation={op} problem={error} {admin} technical={tech} technicalOpen showSteps={false} />
			{/if}
			{#if op || view.waiting}
				<p class="mt-1">{state?.ux?.waiting_action}</p>
				{#if !admin}<p>Only an admin can cancel shared preparation. You can stop waiting in this chat.</p>{/if}
			{/if}
			{#if admin && state?.phase === 'loading'}
				<div class="mt-1 flex flex-wrap gap-2">
					<button type="button" class={btn} disabled={acting || !state?.ux?.actions?.can_cancel} on:click={cancel}
						>Cancel loading for everyone</button
					>
				</div>
			{/if}
		{/if}
		{#if offlineId}
			<button type="button" class="mt-1 {btn}" on:click={refreshManagerState}>Check again</button>
		{/if}
	</div>
{:else}
	{#snippet actions()}
		{#if show && admin && (state?.phase === 'loading' || !ready)}
			<div class="flex shrink-0 flex-wrap gap-2">
				{#if state?.phase === 'loading'}
					<button type="button" class={btn} disabled={acting || !state?.ux?.actions?.can_cancel} on:click={cancel}
						>Cancel loading for everyone</button
					>
				{/if}
				<!-- Not while this same model is already being prepared. Disabled when refused;
				     the reason is the status text. -->
				{#if !ready && op?.model !== id}
					<button
						type="button"
						class={btn}
						disabled={acting || !view.can_load}
						on:click={() => act(() => loadManagedModel(localStorage.token, id ?? ''))}
						>{error ? 'Retry preparation' : 'Prepare now'}</button
					>
				{/if}
			</div>
		{/if}
	{/snippet}
	<!-- fork, 0.12 layout: compact row inside the chat input. The parent sets @container, so
	     "narrow" means the input itself is narrow: a phone, or the Files panel taking width.
	     The height cap keeps a long plan from covering the input on a phone keyboard. -->
	<div
		class={visible
			? 'min-w-0 max-w-full max-h-[30dvh] overflow-y-auto overscroll-contain break-words pt-1.5 pb-0.5 text-left text-xs text-gray-600 @2xl:max-h-[40dvh] dark:text-gray-300'
			: ''}
	>
		<div class="flex flex-wrap items-start gap-x-3 gap-y-1">
			<div class="min-w-0 flex-1 basis-56" role="status" aria-live="polite" aria-atomic="true">
				{#if offlineId}
					<p class="font-medium">The model service is not reachable.</p>
					<p>Progress cannot be checked; an existing load may still be running. {offlineHelp}</p>
				{:else if show && (!op || op.model !== id) && !error}
					<p class="font-medium">{view.primary}</p>
				{/if}
			</div>
			{#if offlineId}
				<button type="button" class={btn} on:click={refreshManagerState}>Check again</button>
			{:else if !op && !error}
				{@render actions()}
			{/if}
		</div>
		{#if !offlineId && show}
			{#if op || error}
				<OperationPlan operation={op} problem={error} {admin} technical={tech} technicalOpen showSteps={false} />
			{/if}
			{#if op || view.waiting}
				<p class="mt-1">{state?.ux?.waiting_action}</p>
				{#if !admin}<p>Only an admin can cancel shared preparation. You can stop waiting in this chat.</p>{/if}
			{/if}
			{#if op || error}<div class="mt-1.5">{@render actions()}</div>{/if}
		{:else if !offlineId && legacy}
			<p>The model manager needs an update to show preparation steps. Ask the admin.</p>
		{/if}
	</div>
{/if}
