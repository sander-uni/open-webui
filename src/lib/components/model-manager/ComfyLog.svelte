<script lang="ts">
	// fork 0.4.1: Admin Settings > Model Manager > ComfyUI. The running ComfyUI job with its progress, and
	// the end of ComfyUI's own log (modelmgr 0.8.0), read every few seconds while the section is open.
	import { getContext, onDestroy, tick } from 'svelte';
	import { getComfyLog, type ComfyLogView } from '$lib/apis/model-manager';

	const i18n = getContext('i18n');

	let open = false;
	let view: ComfyLogView | null = null;
	let error = '';
	let lines = 300;
	let follow = true;
	let pre: HTMLPreElement | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;

	const clock = (s: number | null | undefined) => {
		const t = Math.max(0, Math.round(s ?? 0));
		const hh = Math.floor(t / 3600);
		const mm = Math.floor((t % 3600) / 60);
		const ss = `${t % 60}`.padStart(2, '0');
		return hh ? `${hh}:${`${mm}`.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
	};

	const read = async () => {
		try {
			view = await getComfyLog(localStorage.token, lines);
			error = '';
		} catch (e) {
			error = `${e}`;
		}
		if (follow && pre) {
			await tick();
			pre.scrollTop = pre.scrollHeight;
		}
	};

	const poll = async () => {
		if (destroyed || !open) return;
		if (typeof document === 'undefined' || !document.hidden) await read();
		if (!destroyed && open) timer = setTimeout(poll, 3000);
	};

	const toggled = (e: Event) => {
		open = (e.currentTarget as HTMLDetailsElement).open;
		if (timer) clearTimeout(timer);
		if (open) poll();
	};

	onDestroy(() => {
		destroyed = true;
		if (timer) clearTimeout(timer);
	});

	$: job = view?.running ?? null;
	$: pr = job?.progress ?? null;
</script>

<details class="rounded-xl border border-gray-100/70 bg-gray-50/50 px-3 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.02]" on:toggle={toggled}>
	<summary class="cursor-pointer select-none font-medium">{$i18n.t('ComfyUI: running job and log')}</summary>
	<div class="mt-2 space-y-2">
		{#if error}<p class="text-red-600">{error}</p>{/if}
		{#if job}
			<div class="space-y-1">
				<p>{job.tool} · {job.status} · {clock(job.running_s)}{job.detail ? ` · ${job.detail}` : ''}</p>
				{#if pr}
					<div class="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(pr.fraction * 100)}>
						<div class="h-full bg-blue-500 transition-all" style="width: {Math.round(pr.fraction * 100)}%"></div>
					</div>
					<p class="text-xs">
						{Math.round(pr.fraction * 100)}%
						{#if pr.segments} · {$i18n.t('segment')} {pr.segment}/{pr.segments}{/if}
						{#if pr.phase === 'sampling'} · {$i18n.t('step')} {pr.step}/{pr.steps}{#if pr.s_per_step} ({pr.s_per_step} s/{$i18n.t('step')}){/if}
						{:else} · {pr.phase} {clock(pr.phase_s)}{#if pr.node} ({pr.node}){/if}{/if}
						{#if pr.eta_s !== null} · {$i18n.t('about {{left}} left', { left: clock(pr.eta_s) })}{/if}
					</p>
				{/if}
			</div>
		{:else if view}
			<p class="text-xs">{$i18n.t('No ComfyUI job is running.')}</p>
		{/if}
		<div class="flex flex-wrap items-center gap-3 text-xs">
			<label class="flex items-center gap-1">
				{$i18n.t('Lines')}
				<select class="rounded border bg-transparent p-0.5" bind:value={lines} on:change={read}>
					<option value={100}>100</option>
					<option value={300}>300</option>
					<option value={1000}>1000</option>
					<option value={3000}>3000</option>
				</select>
			</label>
			<label class="flex items-center gap-1"><input type="checkbox" bind:checked={follow} />{$i18n.t('Follow the end')}</label>
			<button type="button" class="rounded-lg border border-gray-200/70 px-2.5 py-1 text-gray-700 transition hover:bg-gray-100 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]" on:click={read}>{$i18n.t('Refresh')}</button>
			{#if view}<span class="text-gray-500 break-all">{view.path}</span>{/if}
		</div>
		<pre bind:this={pre} class="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-900 p-2 font-mono text-[0.6875rem] leading-snug text-gray-100">{(view?.lines ?? []).join('\n')}</pre>
	</div>
</details>
