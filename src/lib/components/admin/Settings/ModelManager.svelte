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

	const ENGINE_NAMES: Record<string, string> = {
		ninfer: 'NInfer',
		strata: 'Strata',
		ollama: 'Ollama'
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
			unreachable = `${error}`;
		} finally {
			loadingFirst = false;
		}
	};

	const poll = async () => {
		await refresh();
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

	onMount(async () => {
		await poll();
		await refreshFilter();
	});

	onDestroy(() => {
		destroyed = true;
		if (timer) clearTimeout(timer);
	});

	const run = async (fn: () => Promise<any>, success?: string) => {
		busy = true;
		try {
			await fn();
			if (success) toast.success(success);
		} catch (error) {
			toast.error(`${error}`);
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

	const cancelLoad = () =>
		run(async () => {
			await cancelManagedLoad(localStorage.token);
			refreshManagerState();
		});

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
		run(() => unloadManagedModel(localStorage.token, false));
	};

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
				return `Stopped ${e.engine}${e.released_s !== undefined ? ` (RAM and port released in ${duration(e.released_s)})` : ''}`;
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
	$: groups = ['ninfer', 'strata', 'ollama']
		.filter((engine) => (status?.engines ?? []).includes(engine))
		.map((engine) => ({ engine, models: models.filter((m) => m.engine === engine) }));
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

<div class="flex h-full flex-col text-sm">
	<h2 class="text-sm font-medium text-gray-900 dark:text-white mb-4">
		{$i18n.t('Model Manager')}
	</h2>

	<div class="flex-1 min-h-0 overflow-y-auto scrollbar-hover pr-1.5">
		{#if loadingFirst}
			<div class="flex justify-center py-8"><Spinner className="size-6" /></div>
		{:else if unreachable && !status}
			<div
				class="rounded-xl border border-red-200/60 bg-red-50/60 px-3 py-2.5 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"
			>
				{unreachable}
			</div>
		{:else if status}
			{#if unreachable}
				<div class="mb-3 text-xs text-red-600 dark:text-red-400">{unreachable}</div>
			{/if}

			<!-- current state -->
			<div
				class="rounded-xl border border-gray-100/70 bg-gray-50/50 px-3 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.02]"
			>
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span class="size-2 shrink-0 rounded-full {phaseColor}"></span>
							<span class="truncate font-medium text-gray-900 dark:text-gray-100">
								{#if status.phase === 'ready'}
									{status.model?.id}
								{:else if status.phase === 'loading'}
									{$i18n.t('Loading {{model}}', { model: status.loading?.model ?? '' })}
								{:else if status.phase === 'unloading'}
									{$i18n.t('Unloading {{model}}', { model: status.loading?.model ?? '' })}
								{:else if status.phase === 'error'}
									{$i18n.t('Error')}
								{:else}
									{$i18n.t('No model loaded')}
								{/if}
							</span>
							{#if status.phase === 'ready'}
								<span
									class="shrink-0 rounded-md bg-gray-200/60 px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-gray-600 dark:bg-white/[0.06] dark:text-gray-400"
								>
									{ENGINE_NAMES[status.model?.engine] ?? status.model?.engine}
								</span>
							{/if}
						</div>
						<div class="mt-1 text-[0.6875rem] text-gray-500 dark:text-gray-400">
							{#if status.phase === 'ready'}
								{#if status.inflight > 0}
									{$i18n.t('{{count}} request(s) running', { count: status.inflight })}
								{:else if status.pinned}
									{$i18n.t('Pinned: stays loaded until you unpin or unload it')}
								{:else if status.settings?.idle_minutes === 0}
									{$i18n.t('Idle for {{time}}; idle unload is off', {
										time: duration(status.idle_s)
									})}
								{:else}
									{$i18n.t('Idle for {{idle}}; unloads in {{left}}', {
										idle: duration(status.idle_s),
										left: duration(status.unload_in_s)
									})}
								{/if}
								{#if status.served?.ctx}
									· {$i18n.t('context {{ctx}}', { ctx: status.served.ctx.toLocaleString() })}
								{/if}
								{#if status.switch_to}
									· {$i18n.t('switching to {{model}} when the running requests finish', {
										model: status.switch_to
									})}
								{/if}
							{:else if status.phase === 'loading' || status.phase === 'unloading'}
								{status.loading?.detail} · {duration(status.loading?.elapsed_s)}
							{:else if status.phase === 'error'}
								<span class="whitespace-pre-wrap text-red-600 dark:text-red-400"
									>{status.error?.message}</span
								>
							{:else}
								{$i18n.t('Models load when a chat asks for one, or with Load below.')}
							{/if}
						</div>
						{#if (status.phase === 'loading' || status.phase === 'unloading') && status.loading?.log_tail}
							<div
								class="mt-1 truncate font-mono text-[0.625rem] text-gray-400 dark:text-gray-500"
								title={status.loading.log_tail}
							>
								{status.loading.log_tail}
							</div>
						{/if}
						{#if status.warning}
							<div class="mt-1 text-[0.6875rem] text-amber-600 dark:text-amber-400">
								{status.warning}
							</div>
						{/if}
					</div>

					<div class="flex shrink-0 items-center gap-2">
						{#if status.phase === 'ready' || status.phase === 'loading'}
							<label class="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
								{$i18n.t('Pin')}
								<Switch state={status.pinned} disabled={busy} on:change={(e) => setPin(e.detail)} />
							</label>
						{/if}
						{#if status.phase === 'loading'}
							<button
								class="flex h-7 items-center rounded-lg border border-gray-200/70 px-2.5 text-xs text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:border-white/[0.08] dark:text-red-400 dark:hover:bg-red-500/10"
								disabled={busy}
								on:click={cancelLoad}
								type="button"
							>
								{$i18n.t('Cancel loading')}
							</button>
						{/if}
						{#if status.phase === 'ready' || status.phase === 'error'}
							<button
								class="flex h-7 items-center rounded-lg border border-gray-200/70 px-2.5 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]"
								disabled={busy}
								on:click={unload}
								type="button"
							>
								{status.phase === 'error' ? $i18n.t('Clear') : $i18n.t('Unload now')}
							</button>
						{/if}
					</div>
				</div>

				<div
					class="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-100/70 pt-2 text-[0.6875rem] text-gray-500 dark:border-white/[0.05] dark:text-gray-400"
				>
					{#if vram}
						<span class="flex items-center gap-1.5">
							VRAM
							<span
								class="relative h-1.5 w-20 overflow-hidden rounded-full bg-gray-200 dark:bg-white/[0.08]"
							>
								<span
									class="absolute inset-y-0 left-0 rounded-full bg-gray-500 dark:bg-gray-300"
									style="width: {Math.min(100, (vram.used_mib / vram.total_mib) * 100)}%"
								></span>
							</span>
							{gib(vram.used_mib)} / {gib(vram.total_mib)} GiB · GPU {vram.util_pct}%
						</span>
					{/if}
					{#if ram}
						<span
							class="flex items-center gap-1.5"
							title={ram.source === 'windows'
								? $i18n.t('Whole PC (Windows), including WSL')
								: $i18n.t('WSL only: Windows RAM is not available')}
						>
							{ram.source === 'windows' ? $i18n.t('RAM (PC)') : $i18n.t('RAM (WSL)')}
							<span
								class="relative h-1.5 w-20 overflow-hidden rounded-full bg-gray-200 dark:bg-white/[0.08]"
							>
								<span
									class="absolute inset-y-0 left-0 rounded-full bg-gray-500 dark:bg-gray-300"
									style="width: {Math.min(100, (ram.used_mib / ram.total_mib) * 100)}%"
								></span>
							</span>
							{gib(ram.used_mib)} / {gib(ram.total_mib)} GiB{#if ram.source === 'windows' && ram.wsl_used_mib !== undefined}{' '}·
								WSL {gib(ram.wsl_used_mib)} GiB{/if}
						</span>
					{/if}
					<span>
						{$i18n.t('Miner')}:
						{#if !status.miner?.enabled}
							{$i18n.t('not configured')}
						{:else}
							{status.miner.state ?? $i18n.t('not running')}{status.miner.hold
								? ` (${$i18n.t('held')})`
								: ''}
						{/if}
					</span>
					<span>{$i18n.t('Loads since start')}: {status.loads}</span>
				</div>
			</div>

			<!-- idle setting -->
			<form class="mt-4 flex items-end justify-between gap-3" on:submit|preventDefault={saveIdle}>
				<div>
					<label class="text-xs text-gray-600 dark:text-gray-400" for="mm-idle">
						{$i18n.t('Unload after idle')}
					</label>
					<div class="mt-1 flex items-center gap-1.5">
						<input
							id="mm-idle"
							type="number"
							min="0"
							step="1"
							bind:value={idleMinutes}
							on:input={() => (idleDirty = true)}
							class="h-7 w-20 rounded-lg border border-gray-100/50 bg-gray-50/40 px-2 text-xs text-gray-700 outline-hidden transition-colors focus:border-blue-400 dark:border-white/[0.04] dark:bg-white/[0.03] dark:text-gray-300 dark:focus:border-blue-500"
						/>
						<span class="text-[0.6875rem] text-gray-400 dark:text-gray-600">
							{$i18n.t(
								'minutes with no request running (0 = never). A pinned model never unloads.'
							)}
						</span>
					</div>
				</div>
				<button
					class="flex h-7 shrink-0 items-center justify-center rounded-lg bg-gray-900 px-2.5 text-xs font-normal text-white transition hover:bg-black disabled:opacity-60 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
					type="submit"
					disabled={savingIdle || !idleDirty}
				>
					{$i18n.t('Save')}
				</button>
			</form>

			<!-- models -->
			<div class="mt-5">
				<div class="mb-1.5 flex items-baseline justify-between">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
						>{$i18n.t('Models')}</span
					>
					<span class="text-[0.625rem] text-gray-400 dark:text-gray-600">
						{$i18n.t('Listed = shown in the chat model picker')}
					</span>
				</div>
				{#each groups as group}
					<div
						class="mt-2 text-[0.625rem] uppercase tracking-wide text-gray-400 dark:text-gray-500"
					>
						{ENGINE_NAMES[group.engine] ?? group.engine}
					</div>
					{#if group.models.length === 0}
						<div class="py-1 text-[0.6875rem] text-gray-400">{$i18n.t('No models installed')}</div>
					{/if}
					{#each group.models as model (model.ref)}
						{@const isCurrent = status.model?.ref === model.ref}
						<div
							class="flex items-center justify-between gap-2 border-b border-gray-100/60 py-1.5 last:border-b-0 dark:border-white/[0.04]"
						>
							<div class="min-w-0">
								<div class="flex items-center gap-1.5">
									<span
										class="truncate text-xs {model.hidden
											? 'text-gray-400 dark:text-gray-600'
											: 'text-gray-800 dark:text-gray-200'}"
										title={model.ref}>{model.id}</span
									>
									{#if model.loaded}
										<span
											class="rounded bg-green-500/15 px-1 text-[0.625rem] text-green-700 dark:text-green-400"
											>{$i18n.t('loaded')}</span
										>
									{:else if isCurrent && status.phase === 'loading'}
										<span
											class="rounded bg-amber-400/20 px-1 text-[0.625rem] text-amber-700 dark:text-amber-300"
											>{$i18n.t('loading')}</span
										>
									{/if}
									{#if model.default}
										<span class="text-[0.625rem] text-gray-400">{$i18n.t('default')}</span>
									{/if}
								</div>
								{#if model.id !== model.key}
									<div class="truncate text-[0.625rem] text-gray-400 dark:text-gray-600">
										{model.key}
									</div>
								{/if}
							</div>
							<div class="flex shrink-0 items-center gap-2">
								{#if !model.loaded && !(isCurrent && status.phase === 'loading')}
									<button
										class="h-6 rounded-md px-2 text-[0.6875rem] text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-white/[0.06]"
										disabled={busy || status.phase === 'loading' || status.phase === 'unloading'}
										on:click={() => load(model)}
										type="button">{$i18n.t('Load')}</button
									>
									<button
										class="h-6 rounded-md px-2 text-[0.6875rem] text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-white/[0.06]"
										disabled={busy || status.phase === 'loading' || status.phase === 'unloading'}
										on:click={() => load(model, true)}
										type="button">{$i18n.t('Load & pin')}</button
									>
								{:else if model.loaded}
									<button
										class="h-6 rounded-md px-2 text-[0.6875rem] text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-500/10"
										disabled={busy}
										on:click={unload}
										type="button">{$i18n.t('Unload')}</button
									>
								{/if}
								<label
									class="flex items-center gap-1 text-[0.625rem] text-gray-400"
									title={$i18n.t('Show in the chat model picker')}
								>
									{$i18n.t('Listed')}
									<Switch
										state={!model.hidden}
										disabled={busy}
										on:change={(e) => setListed(model, e.detail)}
									/>
								</label>
							</div>
						</div>
					{/each}
				{/each}
			</div>

			<!-- old loading-status filter (retired) -->
			{#if oldFilterInstalled}
				<div
					class="mt-5 flex items-center justify-between gap-3 rounded-xl border border-amber-200/60 bg-amber-50/50 px-3 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/5"
				>
					<div class="min-w-0">
						<div class="text-xs font-medium text-gray-700 dark:text-gray-300">
							{$i18n.t('Old loading-status filter installed')}
						</div>
						<div class="text-[0.6875rem] text-gray-500 dark:text-gray-400">
							{$i18n.t(
								'Replies now show loading status themselves. The old filter loaded models through a separate request, which could let another chat swap the model out, so remove it.'
							)}
						</div>
					</div>
					<button
						class="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-gray-900 px-2.5 text-xs text-white transition hover:bg-black disabled:opacity-60 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
						disabled={filterBusy}
						on:click={removeFilter}
						type="button"
					>
						{#if filterBusy}<Spinner className="size-3" />{/if}
						{$i18n.t('Remove')}
					</button>
				</div>
			{/if}

			<!-- recent events -->
			{#if status.events?.length}
				<div class="mt-5">
					<div class="mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
						{$i18n.t('Recent activity')}
					</div>
					{#each [...status.events].reverse().slice(0, 10) as e}
						<div class="flex gap-2 py-0.5 text-[0.6875rem]">
							<span class="shrink-0 tabular-nums text-gray-400">{time(e.ts)}</span>
							<span
								class="min-w-0 truncate {e.event === 'load_failed' || e.event === 'engine_exit'
									? 'text-red-600 dark:text-red-400'
									: 'text-gray-600 dark:text-gray-400'}"
								title={e.error ?? ''}>{eventText(e)}</span
							>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>
