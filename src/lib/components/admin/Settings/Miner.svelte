<script lang="ts">
	// Fork addition 0.3.7: Admin Settings > Miner. The background GPU jobs (miners) on this PC and
	// on the toolbox PC, and when the stack pauses them. All data comes from the local model manager
	// (modelmgr) through /api/v1/model-manager/miner; settings are saved there too.
	import { getContext, onDestroy, onMount } from 'svelte';
	import { toast } from 'svelte-sonner';

	import { getMinerView, saveMinerSettings, type MinerView } from '$lib/apis/model-manager';

	const i18n = getContext('i18n');

	let view: MinerView | null = null;
	let unreachable = '';
	let loadingFirst = true;
	let quietMinutes: number | string = 10;
	let toolsText = '';
	let dirty = false;
	let saving = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;

	const STATE_WORDS: Record<string, string> = {
		held: 'paused',
		mining: 'mining',
		idle: 'waiting for the PC to be quiet before mining',
		stopped: 'its controller was stopped',
		absent: 'its controller is not running'
	};
	const stateWords = (state: string | null | undefined) =>
		state ? $i18n.t(STATE_WORDS[state] ?? state) : $i18n.t('unknown');

	const EVENT_WORDS: Record<string, string> = {
		toolbox_hold_open: 'Asked the toolbox miner to pause',
		toolbox_call_start: 'A GPU tool started',
		toolbox_call_end: 'A GPU tool finished',
		toolbox_call_expired: 'A GPU tool never reported its end; stopped waiting for it',
		toolbox_hold_released: 'Let the toolbox miner start again (after its own idle wait)',
		toolbox_hold_failed: 'Could not pause the toolbox miner; the GPU tool was not run',
		toolbox_hold_lost: 'Lost the connection to the toolbox while a GPU tool ran',
		miner_hold_failed: 'Could not pause the miner on this PC; the model was not loaded',
		miner_not_confirmed: 'The miner on this PC did not confirm it stopped',
		miner_hold_kept: 'Kept the miner on this PC paused until the model program was gone',
		miner_hold_refresh_failed: 'Could not keep the miner on this PC paused',
		stale_miner_inhibit_removed: 'Removed an old pause left behind by a crash',
		stale_miner_inhibit_kept: 'Kept an old pause: a model program is still running'
	};

	const duration = (s: number) => {
		if (s < 60) return $i18n.t('{{n}} s', { n: Math.round(s) });
		return $i18n.t('{{n}} min', { n: Math.ceil(s / 60) });
	};

	const readView = async () => {
		try {
			const next = await getMinerView(localStorage.token);
			if (destroyed) return;
			view = next;
			unreachable = '';
			if (!dirty) {
				quietMinutes = next.settings.toolbox_quiet_minutes;
				toolsText = next.settings.toolbox_tools.join('\n');
			}
		} catch (error) {
			if (destroyed) return;
			unreachable = $i18n.t(
				'The model service is not reachable, so the miners cannot be checked. Check that start_webui.sh is running and look at logs/modelmgr.log.'
			);
		} finally {
			loadingFirst = false;
		}
	};

	const poll = async () => {
		await readView();
		if (!destroyed) timer = setTimeout(poll, 5000);
	};

	onMount(poll);
	onDestroy(() => {
		destroyed = true;
		if (timer) clearTimeout(timer);
	});

	const save = async () => {
		const minutes = Number(quietMinutes);
		if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
			toast.error($i18n.t('Enter a whole number of minutes from 0 to 1440.'));
			return;
		}
		const tools = toolsText
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line);
		saving = true;
		try {
			await saveMinerSettings(localStorage.token, { toolbox_quiet_minutes: minutes, toolbox_tools: tools });
			dirty = false;
			toast.success($i18n.t('Settings saved successfully!'));
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			saving = false;
			await readView();
		}
	};

	$: win = view?.windows;
	$: box = view?.toolbox;
</script>

<div class="flex h-full min-w-0 flex-col text-sm">
	<h2 class="mb-3 font-medium">{$i18n.t('Miner')}</h2>
	<div class="min-h-0 overflow-y-auto space-y-4 break-words">
		<p class="text-xs">
			{$i18n.t(
				'A background GPU job (a miner) uses the graphics cards whenever nothing else needs them. The stack pauses it by itself: on this PC before a model loads, and on the toolbox PC before a GPU tool such as Blender runs. A paused miner starts again only after a quiet time, so a busy agent does not keep stopping and starting it.'
			)}
		</p>
		<div role="status" aria-live="polite" aria-atomic="true">
			{#if loadingFirst}<p>{$i18n.t('Checking the miners…')}</p>{/if}
			{#if unreachable}<p class="text-red-600">{unreachable}</p>{/if}
		</div>

		{#if view && win && box}
			<div class="rounded-xl border border-gray-100/70 bg-gray-50/50 px-3 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.02] space-y-1">
				<h3 class="font-medium">{$i18n.t('This PC')}</h3>
				{#if !win.enabled}
					<p>{$i18n.t('No miner is set up on this PC (MINER_DIR is empty).')}</p>
				{:else}
					<p>
						{#if win.hold && win.model}
							{$i18n.t('Paused while {{model}} uses the graphics card.', { model: win.model })}
						{:else if win.hold}
							{$i18n.t('Paused while a model program is still closing.')}
						{:else}
							{$i18n.t('Not paused by the stack: no model is loaded.')}
						{/if}
					</p>
					<p class="text-xs">{$i18n.t('Miner reports')}: {stateWords(win.state)}</p>
					{#if win.failing}
						<p class="text-red-600">
							{$i18n.t('The pause on this PC could not be renewed. Check that MINER_DIR is reachable and writable from WSL.')}
						</p>
					{/if}
				{/if}
			</div>

			<div class="rounded-xl border border-gray-100/70 bg-gray-50/50 px-3 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.02] space-y-1">
				<h3 class="font-medium">{$i18n.t('Toolbox PC')}</h3>
				{#if !box.enabled}
					<p>
						{$i18n.t(
							'Not set up (MODELMGR_TOOLBOX_SSH is empty). GPU tools run without pausing the toolbox miner.'
						)}
					</p>
				{:else}
					<p>
						{#if box.holding && box.active_calls > 0}
							{$i18n.t('Paused: {{n}} GPU tool call(s) running.', { n: box.active_calls })}
						{:else if box.holding && box.release_in_s !== null}
							{$i18n.t(
								'Paused. It may mine again in {{left}} if no GPU tool runs; then the toolbox still waits its own idle minutes.',
								{ left: duration(box.release_in_s) }
							)}
						{:else if box.holding}
							{$i18n.t('Paused.')}
						{:else}
							{$i18n.t('Not paused by the stack. The next GPU tool call pauses it first and waits until it has stopped.')}
						{/if}
					</p>
					{#if box.state?.state}
						<p class="text-xs">
							{$i18n.t('Miner reports')}: {stateWords(box.state.state)}{#if box.state.detail}&nbsp;({box.state.detail}){/if}
						</p>
					{/if}
					{#if box.last_error}
						<p class="text-red-600">{$i18n.t('Last problem')}: {box.last_error.message}</p>
						<p class="text-xs">
							{$i18n.t(
								'GPU tools fail until this is fixed, and the agent is told to stop and ask you. To check the toolbox, run "ssh minerhold status" in WSL, and on the toolbox "systemctl status idle-miner".'
							)}
						</p>
					{/if}
					<p class="text-xs">{$i18n.t('Connection')}: ssh {box.target}</p>
				{/if}
			</div>

			<form class="space-y-2" on:submit|preventDefault={save}>
				<h3 class="font-medium">{$i18n.t('Toolbox settings')}</h3>
				<label class="block" for="miner-quiet">{$i18n.t('Let the toolbox miner start again this many minutes after the last GPU tool call')}</label>
				<input id="miner-quiet" class="w-24 rounded border p-1" type="number" min="0" max="1440" step="1" bind:value={quietMinutes} on:input={() => (dirty = true)} />
				<p class="text-xs">
					{$i18n.t(
						'After this, the toolbox miner still waits its own idle minutes before it mines. Longer than the agent’s thinking pauses avoids stopping and starting it all the time.'
					)}
				</p>
				<label class="block" for="miner-tools">{$i18n.t('GPU tool servers (one address per line)')}</label>
				<textarea id="miner-tools" class="w-full rounded border p-1 font-mono text-xs" rows="3" bind:value={toolsText} on:input={() => (dirty = true)} placeholder="http://192.168.10.52:8000/"></textarea>
				<p class="text-xs">
					{$i18n.t(
						'Use the address exactly as in Admin Settings > External Tools. Only calls to these servers pause the toolbox miner; every other tool (web search, the file relay) runs at once.'
					)}
				</p>
				<button type="submit" class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]" disabled={saving || !dirty || !!unreachable}>{$i18n.t('Save')}</button>
			</form>

			{#if view.events.length}
				<details class="text-xs">
					<summary class="cursor-pointer">{$i18n.t('Recent activity')}</summary>
					<ul class="mt-1 space-y-0.5">
						{#each [...view.events].reverse() as ev}
							<li>
								<span class="text-gray-500">{ev.ts.slice(11, 19)}</span>
								{$i18n.t(EVENT_WORDS[ev.event] ?? ev.event)}{#if ev.tool}&nbsp;({ev.tool}){/if}{#if ev.error}: {ev.error}{/if}
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		{/if}
	</div>
</div>
