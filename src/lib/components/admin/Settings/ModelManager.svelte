<script lang="ts">
	// Fork addition: Admin Settings > Model Manager. Talks to the local model manager
	// (modelmgr, started by start_webui.sh) through /api/v1/model-manager.
	import { getContext, onDestroy, onMount } from 'svelte';
	import { toast } from 'svelte-sonner';

	import {
		cancelManagedLoad,
		getModelManagerFilter,
		getModelManagerStatus,
		loadManagedModel,
		pinManagedModel,
		saveModelManagerSettings,
		unloadManagedModel
	} from '$lib/apis/model-manager';
	import { deleteFunctionById, getFunctionById } from '$lib/apis/functions';
	import ConfirmDialog from '$lib/components/common/ConfirmDialog.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import OperationPlan from '$lib/components/model-manager/OperationPlan.svelte';
	import Switch from '$lib/components/common/Switch.svelte';
	import { refreshManagerState, requestModelSelection } from '$lib/components/model-manager/state';

	const i18n = getContext('i18n');

	type ManagedModel = {
		id: string;
		engine: string;
		key: string;
		ref: string;
		default: boolean;
		hidden: boolean;
		loaded: boolean;
	};

	let status: any = null;
	let unreachable = '';
	let loadingFirst = true;
	let busy = false;
	let idleMinutes: number | string = 60;
	let idleDirty = false;
	let savingIdle = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;

	let filterInfo: any = null;
	let filterFn: any = null;
	let filterBusy = false;

	let confirmShow = false;
	let confirmTitle = '';
	let confirmMessage = '';
	let confirmAction: () => void = () => {};

	const ask = (title: string, message: string, action: () => void) => {
		confirmTitle = title;
		confirmMessage = message;
		confirmAction = action;
		confirmShow = true;
	};

	const refresh = async () => {
		try {
			status = await getModelManagerStatus(localStorage.token);
			unreachable = '';
			if (!idleDirty) {
				idleMinutes = status?.settings?.idle_minutes ?? 60;
			}
		} catch (error) {
			unreachable = 'The model service is not reachable. Progress cannot be checked. Check the connection, start_webui.sh and logs/modelmgr.log before retrying messages.';
		} finally {
			loadingFirst = false;
		}
	};

	const poll = async () => {
		if (typeof document === 'undefined' || !document.hidden) await refresh();
		if (destroyed) return;
		const fast = status && ['loading', 'unloading'].includes(status.phase);
		timer = setTimeout(poll, fast ? 1000 : 3000);
	};

	const refreshFilter = async () => {
		try {
			filterInfo = await getModelManagerFilter(localStorage.token);
		} catch (error) {
			filterInfo = null;
			return;
		}
		try {
			filterFn = await getFunctionById(localStorage.token, filterInfo.id);
		} catch {
			filterFn = null;
		}
	};

	const wake = () => { if (!document.hidden) refresh(); };
	onMount(async () => {
		document.addEventListener('visibilitychange', wake);
		window.addEventListener('online', wake);
		window.addEventListener('pageshow', wake);
		await poll();
		await refreshFilter();
	});

	onDestroy(() => {
		destroyed = true;
		document.removeEventListener('visibilitychange', wake);
		window.removeEventListener('online', wake);
		window.removeEventListener('pageshow', wake);
		if (timer) clearTimeout(timer);
	});

	const run = async (fn: () => Promise<any>, success?: string) => {
		busy = true;
		try {
			await fn();
			if (success) toast.success(success);
		} catch (error) {
			toast.error($i18n.t('The action did not finish. Refresh the status before trying again.'));
		} finally {
			busy = false;
			await refresh();
		}
	};

	const load = (model: ManagedModel, pin = false) => {
		const current = status?.model;
		if (status?.pinned && current && current.ref !== model.ref) {
			ask(
				$i18n.t('Replace the pinned model?'),
				$i18n.t('{{pinned}} is pinned. Unpin it and load {{model}} instead?', {
					pinned: current.id,
					model: model.id
				}),
				() => startLoad(model, pin, true)
			);
			return;
		}
		startLoad(model, pin, false);
	};

	// The chat's model picker switches to the model being loaded here.
	const startLoad = (model: ManagedModel, pin: boolean, force: boolean) =>
		run(async () => {
			await loadManagedModel(localStorage.token, model.id, pin, force);
			requestModelSelection(model.id);
			refreshManagerState();
		});

	const cancelLoad = () => ask(
		$i18n.t('Cancel loading for everyone?'),
		status?.ux?.cancel_help ?? '',
		() => run(async () => { await cancelManagedLoad(localStorage.token); refreshManagerState(); })
	);

	const unload = () => {
		if (status?.inflight > 0) {
			ask(
				$i18n.t('Unload while a request is running?'),
				$i18n.t(
					'{{count}} request(s) are still running on {{model}}. Unloading now cuts them off.',
					{ count: status.inflight, model: status.model?.id }
				),
				() => run(() => unloadManagedModel(localStorage.token, true))
			);
			return;
		}
		ask($i18n.t('Put this model away?'),
			`${status?.ux?.models?.[status?.model?.id]?.reload_text ?? 'The next message will need a fresh start, which can take several minutes.'} ${status?.pinned ? 'This also removes its pin.' : ''}`,
			() => run(() => unloadManagedModel(localStorage.token, false)));

	};

	const dismissError = () => run(() => unloadManagedModel(localStorage.token, false));

	const setPin = (pinned: boolean) => run(() => pinManagedModel(localStorage.token, pinned));

	const saveIdle = async () => {
		const value = Number(idleMinutes);
		if (!Number.isInteger(value) || value < 0) {
			toast.error($i18n.t('Enter a whole number of minutes (0 = never).'));
			return;
		}
		savingIdle = true;
		try {
			await saveModelManagerSettings(localStorage.token, { idle_minutes: value });
			idleDirty = false;
			toast.success($i18n.t('Settings saved successfully!'));
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			savingIdle = false;
			await refresh();
		}
	};

	const setListed = (model: ManagedModel, listed: boolean) => {
		const hidden = new Set<string>(status?.settings?.hidden ?? []);
		if (listed) hidden.delete(model.id);
		else hidden.add(model.id);
		run(() => saveModelManagerSettings(localStorage.token, { hidden: [...hidden] }));
	};

	// The old loading-status filter is retired (replies show loading status themselves); this
	// removes it if an earlier version of this page installed it.
	const removeFilter = async () => {
		if (!filterInfo) return;
		filterBusy = true;
		try {
			await deleteFunctionById(localStorage.token, filterInfo.id);
			toast.success($i18n.t('Removed the old loading-status filter.'));
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			filterBusy = false;
			await refreshFilter();
		}
	};

	const duration = (s: number | null | undefined) => {
		if (s === null || s === undefined) return '';
		if (s < 60) return `${Math.round(s)} s`;
		const m = Math.round(s / 60);
		if (m < 60) return `${m} min`;
		return `${Math.floor(m / 60)} h ${m % 60} min`;
	};

	const gib = (mib: number) => (mib / 1024).toFixed(1);

	const time = (ts: string) => {
		try {
			return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		} catch {
			return '';
		}
	};

	const eventText = (e: any) => {
		switch (e.event) {
			case 'load_done':
				return `Loaded ${e.model} (${e.engine}) in ${duration(e.seconds)}`;
			case 'load_start':
				return `Loading ${e.model}${e.replacing ? ` (replacing ${e.replacing})` : ''}`;
			case 'load_cancelled':
				return `Cancelled loading ${e.model}`;
			case 'ram_not_released':
				return `${e.engine} did not release its RAM (${gib(e.used_mib)} GiB in use)`;
			case 'engine_stopped':
                return `Stopped ${e.engine}${e.released_s !== undefined ? ` (stop and release checks took ${duration(e.released_s)})` : ''}`;
			case 'load_failed':
				return `Loading ${e.model} failed`;
			case 'unload':
				return `Unloaded ${e.model ?? ''} (${e.reason})`;
			case 'engine_exit':
				return `${e.engine} exited unexpectedly`;
			case 'pin':
				return `Pinned ${e.model}`;
			case 'unpin':
				return `Unpinned ${e.model}${e.reason ? ` (${e.reason})` : ''}`;
			case 'switch_waiting':
				return `Switch to ${e.model} waits for ${e.running} running request(s)`;
			case 'settings':
				return 'Settings changed';
			case 'miner_not_confirmed':
				return `Miner did not confirm the hold (state: ${e.state})`;
			case 'vram_busy':
				return `VRAM still in use (${gib(e.used_mib)} GiB) when loading`;
			default:
				return e.event.replaceAll('_', ' ');
		}
	};

	$: models = (status?.models ?? []) as ManagedModel[];
	$: oldFilterInstalled = !!filterInfo && !!filterFn;
	$: phaseColor =
		{
			ready: 'bg-green-500',
			loading: 'bg-amber-400 animate-pulse',
			unloading: 'bg-amber-400 animate-pulse',
			error: 'bg-red-500'
		}[status?.phase as string] ?? 'bg-gray-400';
	$: vram = status?.vram;
	$: ram = status?.ram;
</script>

<ConfirmDialog
	bind:show={confirmShow}
	title={confirmTitle}
	message={confirmMessage}
	onConfirm={() => confirmAction()}
/>

<!-- Fork addition round 4: all progress/cost copy comes from the manager. -->
<div class="flex h-full min-w-0 flex-col text-sm">
	<h2 class="mb-3 font-medium">{$i18n.t('Model Manager')}</h2>
	<div class="min-h-0 overflow-y-auto space-y-4 break-words">
		<div role="status" aria-live="polite" aria-atomic="true">
			{#if loadingFirst}<p>{$i18n.t('Checking the model service…')}</p>{/if}
			{#if unreachable}<p class="text-red-600">{unreachable}</p>{/if}
		</div>
		<button type="button" class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]" on:click={refresh}>{$i18n.t('Refresh status')}</button>
		{#if status}
			<div class="rounded-xl border border-gray-100/70 bg-gray-50/50 px-3 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.02] space-y-1">
			<p class="flex items-center gap-2 font-medium"><span class="size-2 shrink-0 rounded-full {phaseColor}"></span>{status.model?.id ?? status.loading?.model ?? $i18n.t('No model loaded')}</p>
			<OperationPlan operation={status.ux?.operation?.outcome === 'running' ? status.ux.operation : null}
				problem={status.ux?.problem} admin={true} technical={[status.loading?.detail, status.loading?.log_tail, status.warning].filter(Boolean).join('\n')} />
			{#if status.phase === 'ready'}
				<p>{$i18n.t('Ready to answer')}: {status.model?.id}</p>
				<p>{status.inflight} {$i18n.t('chat(s) answering now.')}</p>
				<!-- Round 4 follow-up: when it will put itself away, so the next slow start is no surprise. -->
				<p>
					{#if status.pinned}
						{$i18n.t('Kept ready (pinned): it is not put away automatically.')}
					{:else if status.inflight > 0 && status.unload_in_s !== null}
						{$i18n.t('The quiet-period timer starts when the running chats finish.')}
					{:else if status.unload_in_s !== null && status.unload_in_s !== undefined}
						{$i18n.t('Puts itself away in {{left}} if nobody uses it.', { left: duration(status.unload_in_s) })}
					{:else}
						{$i18n.t('Stays ready until you put it away (quiet minutes is 0).')}
					{/if}
				</p>
				<p>{status.ux?.models?.[status.model?.id]?.reload_text}</p>
			{:else if status.phase === 'idle'}
				<p>{$i18n.t('No model is ready yet. Send a message or choose Prepare now below. Large models can take several minutes.')}</p>
			{:else if status.phase === 'error'}
				<button type="button" class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]" disabled={busy || !!unreachable} on:click={dismissError}>{$i18n.t('Dismiss error')}</button>
			{/if}
			{#if status.ux?.operation?.outcome === 'running'}<p>{status.ux.waiting_action}</p>{/if}
			</div>
			<div class="flex flex-wrap items-center gap-3">
				<label class="flex items-center gap-2">
					{$i18n.t('Keep this model ready (Pin)')}
					<Switch state={status.pinned} disabled={busy || !!unreachable || !status.ux?.actions?.can_pin} on:change={(e) => setPin(e.detail)} />
				</label>
				<button type="button" class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]"
					disabled={busy || !!unreachable || !status.ux?.actions?.can_cancel} on:click={cancelLoad}>{$i18n.t('Cancel loading for everyone')}</button>
				<button type="button" class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]"
					disabled={busy || !!unreachable || !status.ux?.actions?.can_unload} on:click={unload}>{$i18n.t('Put model away (Unload)')}</button>
			</div>
			<p class="text-xs">{$i18n.t('Pin never expires. It prevents automatic unloading and blocks other models until you unpin. Unload puts the model away; messages already answering can be interrupted only after confirmation. Cancel is available only during preparation and affects everyone waiting for that model.')}</p>
			{#if !status.ux?.actions?.can_unload}<p class="text-xs">{$i18n.t('Unload is unavailable until a model is ready.')}</p>{/if}
			<form class="space-y-2" on:submit|preventDefault={saveIdle}>
				<label for="mm-idle">{$i18n.t('Put the model away after this many quiet minutes')}</label>
				<input id="mm-idle" class="w-24 rounded border p-1" type="number" min="0" max="100000" step="1" bind:value={idleMinutes} on:input={() => (idleDirty = true)} />
				<button type="submit" disabled={savingIdle || !idleDirty || !!unreachable}>{$i18n.t('Save')}</button>
				<p class="text-xs">{$i18n.t('0 means never. A pinned model stays ready. The next message after unloading needs a fresh start; its cost is shown below. Shortening this time may put an already quiet model away immediately.')}</p>
			</form>
			{#each models as model (model.ref)}
				{@const view = status.ux?.models?.[model.id]}
				{@const canPrepare = !!view?.can_load || (view?.can_replace_pin ?? (!!view?.blocked && status.phase === 'ready'))}
				<div class="space-y-1 rounded-xl border border-gray-100/70 bg-gray-50/50 px-3 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.02]">
					<p class="font-medium break-all">{model.id}</p>
					<p>{view?.primary}</p><p class="text-xs">{view?.admin_why ?? view?.why}</p>
					<p class="text-xs">{view?.reload_text}</p>
					<div class="flex flex-wrap items-center gap-3">
						<button type="button" class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]" disabled={busy || !!unreachable || !canPrepare} on:click={() => load(model)}>{$i18n.t('Prepare now')}</button>
						<button type="button" class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]" disabled={busy || !!unreachable || !canPrepare} on:click={() => load(model, true)}>{$i18n.t('Prepare and keep ready')}</button>
						<label class="flex items-center gap-2">{$i18n.t('Show in model picker')}<Switch state={!model.hidden} disabled={busy || !!unreachable} on:change={(e) => setListed(model, e.detail)} /></label>
					</div>
				</div>
			{/each}
			<p class="text-xs">{$i18n.t('Hiding only removes a model from the picker. It does not stop it or block existing chats. Prepare now may switch away from the current model; running replies finish first.')}</p>
			{#if oldFilterInstalled}
				<p>{$i18n.t('The old loading-status filter is installed. Remove it; replies now show preparation steps themselves.')}</p>
				<button class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]" disabled={filterBusy} type="button" on:click={removeFilter}>{$i18n.t('Remove old filter')}</button>
			{/if}
			<details>
				<summary>{$i18n.t('Technical details and recent activity')}</summary>
				<p>{status.ux?.history_warning ?? ''}</p>
				{#if vram}<p>VRAM {gib(vram.used_mib)} / {gib(vram.total_mib)} GiB</p>{/if}
				{#if ram}<p>RAM {gib(ram.used_mib)} / {gib(ram.total_mib)} GiB ({ram.source})</p>{/if}
				<p>Background GPU job: {status.miner?.state ?? 'not configured'}</p>
				<p>{status.warning ?? ''}</p>
				<!-- Fork round 5: retain the diagnostics available on the 0.2.3 page. -->
				<p>Engine: {status.model?.engine ?? 'none'} · Replies served as: {status.served?.name ?? 'none'} · Context: {status.served?.ctx ?? 'unknown'} · Loads since start: {status.loads}</p>
				{#if vram}<p>Graphics card use: {vram.util_pct ?? 'unknown'}%</p>{/if}
				{#if ram?.wsl_used_mib !== undefined}<p>WSL memory: {gib(ram.wsl_used_mib)} GiB</p>{/if}
				<p>Miner configured: {status.miner?.enabled ? 'yes' : 'no'} · Hold requested: {status.miner?.hold ? 'yes' : 'no'}</p>
				{#each models as model (model.ref)}
					<p>{model.ref} · Program model name: {model.key}{model.default ? ' · default' : ''}</p>
				{/each}
				{#each [...(status.events ?? [])].reverse().slice(0, 10) as e}
					<details><summary>{time(e.ts)} {eventText(e)}</summary><pre class="whitespace-pre-wrap break-all">{JSON.stringify(e, null, 2)}</pre></details>
				{/each}
			</details>
		{/if}
	</div>
</div>
