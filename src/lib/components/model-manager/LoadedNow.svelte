<script lang="ts">
	// Fork addition: what holds the GPU now, at the top of the model picker and of the More models
	// window, with Unload. The same row for ComfyUI (which is not in the model list) and local models.
	// Unloading stops the engine's process, so its VRAM, RAM and caches go with it.
	import { getContext } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { models, user } from '$lib/stores';
	import { pinManagedModel, unloadManagedModel } from '$lib/apis/model-manager';
	import ConfirmDialog from '$lib/components/common/ConfirmDialog.svelte';
	import { managedId, managerState, refreshManagerState } from './state';

	const i18n: any = getContext('i18n');

	export let showConfirm = false;

	const COMFY = 'comfyui';

	$: state = $managerState;
	$: phase = state?.phase ?? 'idle';
	$: id = phase === 'ready' ? state?.model : phase === 'loading' || phase === 'unloading' ? state?.target : null;
	$: visible = $user?.role === 'admin' && !!id;
	$: name =
		id === COMFY
			? 'ComfyUI'
			: (($models ?? []).find((m) => m.id === id) ??
					($models ?? []).find((m) => !m?.info?.base_model_id && managedId(m, state) === id))?.name ??
				id;
	$: running = state?.inflight ?? 0;
	$: waiting = state?.jobs_waiting ?? 0;
	$: canUnload = phase === 'ready' && !busy;

	const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

	const away = (s: number | null | undefined, pinned: boolean) => {
		if (typeof s === 'number') {
			return s < 90
				? $i18n.t('away in {{n}} s', { n: Math.round(s) })
				: $i18n.t('away in {{n}} min', { n: minutes(s) });
		}
		return pinned ? $i18n.t('pinned') : $i18n.t('stays loaded');
	};

	$: status = !state
		? ''
		: phase === 'loading'
			? $i18n.t('starting')
			: phase === 'unloading'
				? $i18n.t('being put away')
				: running
					? id === COMFY
						? $i18n.t('running a job')
						: $i18n.t('answering')
					: waiting
						? $i18n.t('job waiting')
						: `${$i18n.t('idle')} · ${away(state.unload_in_s, state.pinned)}`;

	let busy = false;

	const unload = async (force: boolean, target: string) => {
		busy = true;
		const pending = toast.loading($i18n.t('Putting {{model}} away…', { model: name }));
		try {
			await unloadManagedModel(localStorage.token, force, target);
			toast.success($i18n.t('{{model}} was put away.', { model: name }), { id: pending });
		} catch (error) {
			toast.error(String(error), { id: pending });
		}
		busy = false;
		refreshManagerState();
	};

	// A pinned model away for ComfyUI: pinned again on its next message, and others stay out until then.
	$: pinAway = $user?.role === 'admin' ? (state?.pin_away ?? null) : null;
	$: pinAwayName =
		(($models ?? []).find((m) => m.id === pinAway) ??
			($models ?? []).find((m) => !m?.info?.base_model_id && managedId(m, state) === pinAway))?.name ??
		pinAway;

	const unpin = async () => {
		busy = true;
		try {
			await pinManagedModel(localStorage.token, false);
		} catch (error) {
			toast.error(String(error));
		}
		busy = false;
		refreshManagerState();
	};

	let confirmFor: { id: string; force: boolean } | null = null;

	const onUnload = () => {
		if (!id) return;
		if (running) {
			confirmFor = { id, force: true };
			showConfirm = true;
		} else {
			unload(false, id);
		}
	};
</script>

<ConfirmDialog
	bind:show={showConfirm}
	title={$i18n.t('Unload {{model}}?', { model: name })}
	message={id === COMFY
		? $i18n.t('A job is running. Unloading now cuts it off.')
		: $i18n.t('A reply is running. Unloading now cuts it off.')}
	confirmLabel={$i18n.t('Unload')}
	on:confirm={() => {
		if (confirmFor) unload(confirmFor.force, confirmFor.id);
		confirmFor = null;
	}}
	on:cancel={() => {
		confirmFor = null;
	}}
/>

{#if pinAway}
	<div
		class="mb-1 flex shrink-0 items-center gap-2 rounded-xl bg-gray-50/70 px-2 py-1 text-[0.75rem] text-gray-700 dark:bg-gray-800/50 dark:text-gray-200"
		data-pin-away
	>
		<div class="min-w-0 flex-1 truncate" title={pinAwayName}>
			<span>{pinAwayName}</span>
			<span class="text-gray-500 dark:text-gray-400"> · {$i18n.t('pinned, back on its next message')}</span>
		</div>
		<button
			type="button"
			class="focus-ring shrink-0 rounded-lg border border-gray-200/70 px-2 py-0.5 text-[0.75rem] transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:hover:bg-white/[0.05] pointer-coarse:px-3 pointer-coarse:py-1.5"
			disabled={busy}
			on:click|stopPropagation={unpin}
		>
			{$i18n.t('Unpin')}
		</button>
	</div>
{/if}

{#if visible}
	<div
		class="flex shrink-0 items-center gap-2 rounded-xl bg-gray-50/70 px-2 py-1 text-[0.75rem] text-gray-700 dark:bg-gray-800/50 dark:text-gray-200"
		data-loaded-now
	>
		<span class="relative flex size-1.5 shrink-0" aria-hidden="true">
			<span
				class="relative inline-flex size-1.5 rounded-full {phase === 'ready'
					? 'bg-green-500'
					: 'bg-amber-400 animate-pulse'}"
			/>
		</span>
		<div class="min-w-0 flex-1 truncate" title="{name} · {status}">
			<span>{name}</span>
			<span class="text-gray-500 dark:text-gray-400"> · {status}</span>
		</div>
		{#if phase === 'ready'}
			<button
				type="button"
				class="focus-ring shrink-0 rounded-lg border border-gray-200/70 px-2 py-0.5 text-[0.75rem] transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:hover:bg-white/[0.05] pointer-coarse:px-3 pointer-coarse:py-1.5"
				disabled={!canUnload}
				on:click|stopPropagation={onUnload}
			>
				{$i18n.t('Unload')}
			</button>
		{/if}
	</div>
{/if}
