<script lang="ts">
	// Fork addition 0.3.7: Admin Settings > Miner. The background GPU jobs (miners) on this PC and
	// on the toolbox PC, and when the stack pauses them. All data comes from the local model manager
	// (modelmgr) through /api/v1/model-manager/miner; settings are saved there too.
	// fork 0.3.8: the toolbox miner is paused per agent run (from its first toolbox tool call until
	// the run is over); live timers; toolbox tool servers are picked from the configured MCP servers.
	import { getContext, onDestroy, onMount } from 'svelte';
	import { toast } from 'svelte-sonner';

	import { getMinerView, saveMinerSettings, type MinerView } from '$lib/apis/model-manager';

	const i18n = getContext('i18n');

	let view: MinerView | null = null;
	let fetchedAt = 0;
	let nowS = 0;
	let unreachable = '';
	let loadingFirst = true;
	let picked: Record<string, boolean> = {};
	let otherText = '';
	let dirty = false;
	let saving = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let ticker: ReturnType<typeof setInterval> | null = null;
	let destroyed = false;

	const STATE_WORDS: Record<string, string> = {
		held: 'paused',
		stopping: 'stopping the miner',
		mining: 'mining',
		idle: 'waiting for the PC to be quiet before mining',
		stopped: 'its controller was stopped',
		absent: 'its controller is not running'
	};
	const stateWords = (state: string | null | undefined) =>
		state ? $i18n.t(STATE_WORDS[state] ?? state) : $i18n.t('unknown');

	const EVENT_WORDS: Record<string, string> = {
		toolbox_hold_open: 'Asked the toolbox miner to pause',
		toolbox_run_start: 'An agent run started using the toolbox',
		toolbox_run_end: 'An agent run that used the toolbox is over',
		toolbox_hold_released: 'Let the toolbox miner go (it still waits its own idle minutes)',
		toolbox_hold_failed: 'Could not pause the toolbox miner; the tool was not run',
		toolbox_hold_lost: 'Lost the connection to the toolbox while an agent run needed it',
		miner_hold_failed: 'Could not pause the miner on this PC; the model was not loaded',
		miner_not_confirmed: 'The miner on this PC did not confirm it stopped',
		miner_hold_kept: 'Kept the miner on this PC paused until the model program was gone',
		miner_hold_refresh_failed: 'Could not keep the miner on this PC paused',
		stale_miner_inhibit_removed: 'Removed an old pause left behind by a crash',
		stale_miner_inhibit_kept: 'Kept an old pause: a model program is still running'
	};

	const duration = (s: number) => {
		s = Math.max(0, Math.round(s));
		if (s < 60) return $i18n.t('{{n}} s', { n: s });
		if (s < 3600) return $i18n.t('{{m}} min {{s}} s', { m: Math.floor(s / 60), s: s % 60 });
		return $i18n.t('{{h}} h {{m}} min', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
	};

	const originOf = (url: string) => {
		try {
			const u = new URL(url.trim());
			if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
			return `${u.protocol.slice(0, -1)}://${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
		} catch {
			return '';
		}
	};

	const fillForm = (next: MinerView) => {
		const listed = new Set(next.settings.toolbox_tools.map(originOf));
		const known = new Set(next.connections.map((c) => c.origin));
		picked = Object.fromEntries(next.connections.map((c) => [c.origin, listed.has(c.origin)]));
		otherText = next.settings.toolbox_tools.filter((t) => !known.has(originOf(t))).join('\n');
	};

	const take = (next: MinerView) => {
		view = next;
		fetchedAt = Date.now();
		nowS = next.toolbox.now;
		unreachable = '';
		if (!dirty) fillForm(next);
	};

	const readView = async () => {
		try {
			const next = await getMinerView(localStorage.token);
			if (!destroyed) take(next);
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

	onMount(() => {
		poll();
		ticker = setInterval(() => {
			if (view) nowS = view.toolbox.now + (Date.now() - fetchedAt) / 1000;
		}, 1000);
	});
	onDestroy(() => {
		destroyed = true;
		if (timer) clearTimeout(timer);
		if (ticker) clearInterval(ticker);
	});

	const save = async () => {
		if (!view) return;
		const tools = [
			...view.connections.filter((c) => picked[c.origin]).map((c) => c.url),
			...otherText
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line)
		];
		saving = true;
		try {
			const next = await saveMinerSettings(localStorage.token, { toolbox_tools: tools });
			dirty = false;
			take(next);
			toast.success($i18n.t('Settings saved successfully!'));
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			saving = false;
		}
	};

	$: win = view?.windows;
	$: box = view?.toolbox;
	$: remote = box?.state;
</script>

<div class="flex h-full min-w-0 flex-col text-sm">
	<h2 class="mb-3 font-medium">{$i18n.t('Miner')}</h2>
	<div class="min-h-0 overflow-y-auto space-y-4 break-words">
		<p class="text-xs">
			{$i18n.t(
				'A background GPU job (a miner) uses the graphics cards whenever nothing else needs them. The stack pauses it by itself: on this PC before a model loads, and on the toolbox PC from the first toolbox tool call of an agent run until that run is over. Then the toolbox miner still waits its own idle minutes before it mines again.'
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
							'Not set up (MODELMGR_TOOLBOX_SSH is empty). Toolbox tools run without pausing the toolbox miner.'
						)}
					</p>
				{:else}
					<p>
						{#if box.confirmed && box.held_since}
							{$i18n.t('Paused for {{time}} while {{n}} agent run(s) use the toolbox.', {
								time: duration(nowS - box.held_since),
								n: box.active_runs
							})}
						{:else if box.holding}
							{$i18n.t('Pausing: waiting for the toolbox miner to confirm it has stopped.')}
						{:else if box.active_runs > 0}
							{$i18n.t('An agent run needs the toolbox, but the connection to it is lost; reconnecting. Toolbox tool calls fail until it is back.')}
						{:else}
							{$i18n.t('Not paused by the stack. The next toolbox tool call pauses it first and waits until it has stopped.')}
						{/if}
					</p>
					{#each box.runs as run (run.run)}
						<p class="text-xs">
							{$i18n.t('Agent run {{run}}: {{n}} toolbox call(s), running for {{time}}', {
								run: run.run.slice(0, 8),
								n: run.calls,
								time: duration(nowS - run.since)
							})}{#if run.tool}&nbsp;({$i18n.t('last')}: {run.tool}){/if}
						</p>
					{/each}
					{#if !box.holding && box.released_at}
						<p class="text-xs">{$i18n.t('Let go {{time}} ago.', { time: duration(nowS - box.released_at) })}</p>
					{/if}
					{#if remote?.error}
						<p class="text-xs text-red-600">{$i18n.t('Could not ask the toolbox')}: {remote.error}</p>
					{:else if remote?.state}
						<p class="text-xs">
							{$i18n.t('Miner reports')}: {stateWords(remote.state)}{#if remote.detail}&nbsp;({remote.detail}){/if}
							{#if remote.state === 'mining' && remote.since}
								&middot; {$i18n.t('for {{time}}', { time: duration(nowS - remote.since) })}
							{:else if remote.state === 'idle' && remote.mine_at}
								&middot;
								{nowS < remote.mine_at
									? $i18n.t('may start in about {{time}} if the toolbox stays quiet', { time: duration(remote.mine_at - nowS) })
									: $i18n.t('may start any moment')}
							{:else if remote.state === 'idle'}
								&middot; {$i18n.t('the toolbox is busy right now')}
							{/if}
						</p>
					{/if}
					{#if box.last_error}
						<p class="text-red-600">{$i18n.t('Last problem')}: {box.last_error.message}</p>
						<p class="text-xs">
							{$i18n.t(
								'Toolbox tools fail until this is fixed, and the agent is told to stop and ask you. To check the toolbox, run "ssh minerhold status" in WSL, and on the toolbox "systemctl status idle-miner".'
							)}
						</p>
					{/if}
					<p class="text-xs">{$i18n.t('Connection')}: ssh {box.target}</p>
				{/if}
			</div>

			<form class="space-y-2" on:submit|preventDefault={save}>
				<h3 class="font-medium">{$i18n.t('Toolbox tools')}</h3>
				<p class="text-xs">
					{$i18n.t(
						'Tool servers that run on the toolbox PC. The first call of an agent run to one of them pauses the toolbox miner until the run is over. Every other tool (web search, the file relay) runs at once.'
					)}
				</p>
				{#if view.connections.length}
					<fieldset class="space-y-1">
						<legend class="sr-only">{$i18n.t('Configured MCP servers')}</legend>
						{#each view.connections as c (c.origin + c.url)}
							<label class="flex items-start gap-2">
								<input type="checkbox" class="mt-0.5" bind:checked={picked[c.origin]} on:change={() => (dirty = true)} />
								<span>{c.name ?? c.id}<span class="block font-mono text-xs text-gray-500">{c.url}</span></span>
							</label>
						{/each}
					</fieldset>
				{:else}
					<p class="text-xs">{$i18n.t('No MCP servers are set up in Admin Settings > External Tools yet.')}</p>
				{/if}
				<label class="block text-xs" for="miner-tools">{$i18n.t('Other toolbox tool servers, not set up here yet (one address per line)')}</label>
				<textarea id="miner-tools" class="w-full rounded border p-1 font-mono text-xs" rows="2" bind:value={otherText} on:input={() => (dirty = true)} placeholder="http://192.168.10.52:8001/"></textarea>
				<p class="text-xs">{$i18n.t('Servers compare by address and port; the path does not matter.')}</p>
				<button type="submit" class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]" disabled={saving || !dirty || !!unreachable}>{$i18n.t('Save')}</button>
			</form>

			{#if view.events.length}
				<details class="text-xs">
					<summary class="cursor-pointer">{$i18n.t('Recent activity')}</summary>
					<ul class="mt-1 space-y-0.5">
						{#each [...view.events].reverse() as ev}
							<li>
								<span class="text-gray-500">{ev.ts.slice(11, 19)}</span>
								{$i18n.t(EVENT_WORDS[ev.event] ?? ev.event)}{#if ev.tool}&nbsp;({ev.tool}){/if}{#if ev.why}&nbsp;- {ev.why}{/if}{#if ev.error}: {ev.error}{/if}
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		{/if}
	</div>
</div>
