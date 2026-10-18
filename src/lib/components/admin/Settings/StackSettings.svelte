<script lang="ts">
	// Fork 0.3.6: Admin Settings > Context Proxy and > Run Logger. Every setting of ctxproxy /
	// agentlog. The services apply their own settings from the next request (they write
	// ctxproxy.env / agentlog.env, keeping comments); on/off, address and port are saved for the
	// next stack start. Hover a setting's name for what it does.
	import { getContext, onDestroy, onMount } from 'svelte';
	import { toast } from 'svelte-sonner';

	import {
		getStackSettings,
		saveStackSettings,
		StackSettingsErrors,
		type StackService,
		type StackSetting,
		type StackSettingsData
	} from '$lib/apis/stack-settings';
	import {
		changesFrom,
		differsFromDefault,
		isEditable,
		isTrue,
		matches,
		shownValue,
		sourceText,
		type Draft
	} from '$lib/components/stack-settings/draft';
	import AdminSettingRow from './AdminSettingRow.svelte';
	import Switch from '$lib/components/common/Switch.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import Search from '$lib/components/icons/Search.svelte';

	export let service: StackService;

	const i18n: any = getContext('i18n');

	const inputClass =
		'h-7 rounded-lg border border-gray-100/50 bg-gray-50/40 px-2 text-xs text-gray-700 outline-hidden transition-colors placeholder:text-gray-300 focus:border-blue-400 dark:border-white/[0.04] dark:bg-white/[0.03] dark:text-gray-300 dark:placeholder:text-gray-700 dark:focus:border-blue-500';
	const textareaClass =
		'w-full rounded-lg border border-gray-100/50 bg-gray-50/40 px-2 py-1.5 text-xs text-gray-700 outline-hidden transition-colors focus:border-blue-400 dark:border-white/[0.04] dark:bg-white/[0.03] dark:text-gray-300 dark:focus:border-blue-500';
	const badgeClass = 'shrink-0 rounded px-1 py-px text-[0.625rem] leading-tight';

	let data: StackSettingsData | null = null;
	let loadError = '';
	let draft: Draft = {};
	let removeLines: string[] = [];
	let errors: Record<string, string> = {};
	let saving = false;
	let query = '';
	let open: Record<string, boolean> = { connection: true };
	let timer: ReturnType<typeof setInterval> | null = null;
	let destroyed = false;
	let loadedFor = '';

	$: title = service === 'ctxproxy' ? 'Context Proxy' : 'Run Logger';
	$: changes = data ? changesFrom(data.settings, draft) : {};
	$: changeCount = Object.keys(changes).length + removeLines.length;
	$: fileName = data?.file ? data.file.split('/').pop() : service === 'ctxproxy' ? 'ctxproxy.env' : 'agentlog.env';
	$: groups = (data?.groups ?? [])
		.map((g) => ({ ...g, items: (data?.settings ?? []).filter((s) => s.group === g.id && matches(s, query)) }))
		.filter((g) => g.items.length > 0);
	$: if (service && service !== loadedFor) {
		loadedFor = service;
		draft = {};
		removeLines = [];
		errors = {};
		data = null;
		load();
	}

	const load = async (quiet = false) => {
		try {
			const fresh = await getStackSettings(localStorage.token, service);
			if (destroyed || fresh.service !== service) return;
			data = fresh;
			loadError = '';
		} catch (e) {
			if (!quiet) loadError = e instanceof Error ? e.message : String(e);
		}
	};

	onMount(() => {
		// Pick up hand edits of the file while nobody is editing here.
		timer = setInterval(() => {
			if (!saving && changeCount === 0 && document.visibilityState === 'visible') load(true);
		}, 15000);
	});
	onDestroy(() => {
		destroyed = true;
		if (timer) clearInterval(timer);
	});

	const set = (s: StackSetting, value: string | null) => {
		draft = { ...draft, [s.key]: value };
		if (errors[s.key]) {
			const { [s.key]: _, ...rest } = errors;
			errors = rest;
		}
	};

	const discard = () => {
		draft = {};
		removeLines = [];
		errors = {};
	};

	const save = async () => {
		if (!data || changeCount === 0) return;
		saving = true;
		const sent = changes;
		const removed = removeLines.length;
		const startOnly = Object.keys(sent).every(
			(k) => data?.settings.find((s) => s.key === k)?.apply === 'start'
		);
		try {
			data = await saveStackSettings(localStorage.token, service, sent, removeLines);
			draft = {};
			removeLines = [];
			errors = {};
			toast.success(
				startOnly && removed === 0
					? $i18n.t('Saved. Applies when the stack restarts.')
					: $i18n.t('Saved. Applies from the next request.')
			);
		} catch (e) {
			if (e instanceof StackSettingsErrors) {
				errors = e.errors;
				for (const key of Object.keys(e.errors)) {
					const g = data?.settings.find((s) => s.key === key)?.group;
					if (g) open = { ...open, [g]: true };
				}
				toast.error($i18n.t('Some values are not valid; nothing was saved.'));
			} else {
				toast.error(e instanceof Error ? e.message : String(e));
			}
		} finally {
			saving = false;
		}
	};

	const escape = (t: string) =>
		t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

	const tip = (s: StackSetting) => {
		const dflt = s.kind === 'secret' ? '' : ` · default: ${s.default === '' ? '(empty)' : s.default}`;
		const running =
			s.apply === 'start' && s.running != null ? ` · running now: ${s.running}` : '';
		return (
			`<div style="max-width:22rem;white-space:normal">${escape(s.help)}</div>` +
			`<div style="margin-top:4px;opacity:.65;font-size:10px;word-break:break-all">${escape(
				s.key + dflt + running
			)}<br>${escape(sourceText(s))}</div>`
		);
	};

	const changedIn = (items: StackSetting[]) => items.filter((s) => differsFromDefault(s)).length;
	const unsaved = (s: StackSetting) => s.key in changes;
	const isNumber = (s: StackSetting) => ['int', 'float', 'port'].includes(s.kind);
</script>

<div class="flex h-full flex-col text-sm">
	<div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
		<h2 class="text-sm font-medium text-gray-900 dark:text-white">{$i18n.t(title)}</h2>
		{#if data}
			<span class="text-[0.6875rem] text-gray-400 dark:text-gray-600">
				{#if data.running}
					{$i18n.t('Running')}{data.version ? ` · ${service} ${data.version}` : ''} · {$i18n.t(
						'changes apply from the next request'
					)}
				{:else}
					{$i18n.t('Not running')}
				{/if}
			</span>
		{/if}
	</div>

	{#if loadError && !data}
		<div class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
			{$i18n.t('Could not load the settings')}: {loadError}
		</div>
	{:else if !data}
		<div class="text-xs text-gray-400">{$i18n.t('Loading…')}</div>
	{:else}
		<div class="mb-3 flex flex-col gap-2">
			{#if !data.running}
				<div
					class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
				>
					{data.name}
					{$i18n.t(
						"isn't running, so only its on/off switch, address and port can be changed here. Its other settings appear when it runs."
					)}
					{#if isTrue(data.settings.find((s) => s.key.endsWith('_ENABLED'))?.value)}
						{$i18n.t('It is switched on: if the stack is running, see')}
						<span class="font-mono">logs/{service}.log</span>.
					{/if}
				</div>
			{/if}
			{#if data.restart_needed}
				<div class="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
					{$i18n.t(
						'Some connection settings are saved for the next start. Restart the stack (Ctrl+C, then ./start_webui.sh) to apply them.'
					)}
					{#if data.model_api_url.now && data.model_api_url.next && data.model_api_url.now !== data.model_api_url.next}
						{$i18n.t("Open WebUI's model connection then switches by itself from")}
						<span class="font-mono">{data.model_api_url.now}</span>
						{$i18n.t('to')}
						<span class="font-mono">{data.model_api_url.next}</span>.
					{/if}
				</div>
			{/if}
			{#if data.error}
				<div class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
					{data.error.message}
					{#if data.error.errors}
						<ul class="mt-1 list-disc pl-4">
							{#each Object.entries(data.error.errors) as [k, msg]}
								<li><span class="font-mono">{k}</span>: {msg}</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
			<div class="flex items-center gap-2">
				<div class="relative flex-1">
					<div class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
						<Search className="size-3" />
					</div>
					<input
						class="{inputClass} w-full pl-6"
						type="search"
						placeholder={$i18n.t('Search settings')}
						aria-label={$i18n.t('Search settings')}
						bind:value={query}
					/>
				</div>
			</div>
			{#if data.file}
				<div class="text-[0.6875rem] text-gray-400 dark:text-gray-600">
					{$i18n.t('Saved in')} <span class="font-mono break-all">{data.file}</span>.
					{$i18n.t('Hover a setting for what it does.')}
				</div>
			{/if}
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto scrollbar-hover pr-1.5 pb-2">
			{#if groups.length === 0}
				<div class="py-6 text-center text-xs text-gray-400">{$i18n.t('No setting matches')}</div>
			{/if}
			{#each groups as g (g.id)}
				{@const expanded = open[g.id] || query.trim() !== ''}
				<section class="border-b border-gray-100/60 py-1 dark:border-white/[0.04]">
					<button
						type="button"
						class="flex w-full items-center justify-between gap-2 py-1.5 text-left"
						aria-expanded={expanded}
						on:click={() => (open = { ...open, [g.id]: !open[g.id] })}
					>
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300">{$i18n.t(g.title)}</span>
						<span class="flex items-center gap-2 text-[0.6875rem] text-gray-400 dark:text-gray-600">
							{#if g.items.some(unsaved)}
								<span class="text-blue-500">{$i18n.t('unsaved')}</span>
							{/if}
							{#if changedIn(g.items) > 0}
								<span>{changedIn(g.items)} {$i18n.t('changed')}</span>
							{/if}
							<span>{g.items.length}</span>
							<span class="transition-transform {expanded ? 'rotate-180' : ''}">
								<ChevronDown className="size-3" strokeWidth="2" />
							</span>
						</span>
					</button>
					{#if expanded}
						<p class="mb-2 text-[0.6875rem] text-gray-400 dark:text-gray-600">{$i18n.t(g.help)}</p>
						<div class="mb-2 flex flex-col gap-2.5">
							{#each g.items as s (s.key)}
								{@const value = shownValue(s, draft)}
								<div data-setting={s.key}>
									{#if s.kind === 'longtext'}
										<div class="flex flex-col gap-1">
											<div class="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
												<Tooltip content={tip(s)} placement="top-start" className="cursor-help">
													<span class="underline decoration-dotted decoration-gray-300 underline-offset-2 dark:decoration-gray-600"
														>{$i18n.t(s.label)}</span
													>
												</Tooltip>
												{#if unsaved(s)}<span class="size-1.5 rounded-full bg-blue-500" aria-label="unsaved"></span>{/if}
												{#if differsFromDefault(s) && draft[s.key] !== null}
													<button
														type="button"
														class="text-[0.6875rem] text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
														on:click={() => set(s, null)}>{$i18n.t('Reset')}</button
													>
												{/if}
											</div>
											<textarea
												class={textareaClass}
												rows="2"
												value={value}
												on:input={(e) => set(s, e.currentTarget.value)}
											></textarea>
										</div>
									{:else}
										<AdminSettingRow let:labelId>
											<div slot="label" class="flex min-w-0 flex-wrap items-center gap-1.5">
												<Tooltip content={tip(s)} placement="top-start" className="min-w-0 cursor-help">
													<span class="underline decoration-dotted decoration-gray-300 underline-offset-2 dark:decoration-gray-600"
														>{$i18n.t(s.label)}</span
													>
												</Tooltip>
												{#if s.apply === 'start'}
													<span
														class="{badgeClass} {s.pending
															? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
															: 'bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400'}"
														>{s.pending ? $i18n.t('restart to apply') : $i18n.t('next start')}</span
													>
												{:else if s.apply === 'launcher'}
													<span class="{badgeClass} bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400"
														>{$i18n.t('set by launcher')}</span
													>
												{:else if s.apply === 'follows'}
													<span class="{badgeClass} bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400"
														>{$i18n.t('follows Context Proxy')}</span
													>
												{/if}
												{#if unsaved(s)}<span class="size-1.5 rounded-full bg-blue-500" aria-label="unsaved"></span>{/if}
												{#if isEditable(s) && differsFromDefault(s) && draft[s.key] !== null}
													<button
														type="button"
														class="text-[0.6875rem] text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
														title={s.kind === 'secret' ? $i18n.t('Clear') : `${$i18n.t('Back to the default')}: ${s.default}`}
														on:click={() => set(s, null)}
														>{s.kind === 'secret' ? $i18n.t('Clear') : $i18n.t('Reset')}</button
													>
												{/if}
											</div>

											{#if !isEditable(s)}
												<span
													class="block max-w-[11rem] truncate font-mono text-[0.6875rem] text-gray-500 sm:max-w-[18rem]"
													title={s.resolved ?? s.value}>{s.resolved ?? s.value}</span
												>
											{:else if s.kind === 'bool'}
												<Switch
													state={isTrue(value)}
													ariaLabelledbyId={labelId}
													on:change={(e) => set(s, e.detail ? '1' : '0')}
												/>
											{:else if s.kind === 'choice'}
												<select
													class="h-7 rounded-lg border border-gray-100 bg-transparent px-2 text-xs outline-hidden dark:border-gray-800"
													aria-labelledby={labelId}
													value={value.toLowerCase()}
													on:change={(e) => set(s, e.currentTarget.value)}
												>
													{#each s.choices ?? [] as c}
														<option value={c}>{c}</option>
													{/each}
												</select>
											{:else if s.kind === 'secret'}
												<input
													class="{inputClass} w-36 sm:w-56"
													type="password"
													autocomplete="new-password"
													aria-labelledby={labelId}
													placeholder={draft[s.key] === null
														? $i18n.t('cleared on save')
														: s.is_set
															? $i18n.t('set (type to replace)')
															: $i18n.t('not set')}
													value={draft[s.key] ?? ''}
													on:input={(e) => set(s, e.currentTarget.value)}
												/>
											{:else if isNumber(s)}
												<div class="flex items-center gap-1">
													<input
														class="{inputClass} w-24 text-right"
														type="text"
														inputmode={s.kind === 'float' ? 'decimal' : 'numeric'}
														aria-labelledby={labelId}
														value={value}
														on:input={(e) => set(s, e.currentTarget.value)}
													/>
													{#if s.unit}<span class="w-9 text-[0.6875rem] text-gray-400">{s.unit}</span>{/if}
												</div>
											{:else}
												<input
													class="{inputClass} w-40 sm:w-64 {['regex', 'json', 'path', 'url', 'list'].includes(s.kind)
														? 'font-mono'
														: ''}"
													type="text"
													spellcheck="false"
													aria-labelledby={labelId}
													placeholder={s.kind === 'list' ? s.default : ''}
													value={value}
													on:input={(e) => set(s, e.currentTarget.value)}
												/>
											{/if}
										</AdminSettingRow>
									{/if}
									{#if errors[s.key]}
										<p class="mt-0.5 text-right text-[0.6875rem] text-red-600 dark:text-red-400">{errors[s.key]}</p>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>
			{/each}

			{#if data.ignored.length > 0 && query.trim() === ''}
				<section class="py-2">
					<h3 class="mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
						{$i18n.t('Lines in')} <span class="font-mono">{fileName}</span> {$i18n.t('that have no effect')}
					</h3>
					<p class="mb-2 text-[0.6875rem] text-gray-400 dark:text-gray-600">
						{$i18n.t('The service ignores these lines. Removing them changes nothing, it only tidies the file.')}
					</p>
					<div class="flex flex-col gap-1.5">
						{#each data.ignored as line (line.key)}
							{@const marked = removeLines.includes(line.key)}
							<div class="flex items-center justify-between gap-3 text-xs">
								<div class="min-w-0">
									<span class="font-mono {marked ? 'line-through opacity-50' : ''} break-all"
										>{line.key}={line.value}</span
									>
									<span class="block text-[0.6875rem] text-gray-400 dark:text-gray-600">{line.reason}</span>
								</div>
								<button
									type="button"
									class="shrink-0 text-[0.6875rem] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
									on:click={() =>
										(removeLines = marked
											? removeLines.filter((k) => k !== line.key)
											: [...removeLines, line.key])}>{marked ? $i18n.t('Keep') : $i18n.t('Remove')}</button
								>
							</div>
						{/each}
					</div>
				</section>
			{/if}
		</div>

		<div
			class="flex items-center justify-between gap-2 border-t border-gray-100/60 pt-3 text-xs dark:border-white/[0.04]"
		>
			<span class="text-gray-500 dark:text-gray-400">
				{#if changeCount > 0}
					{changeCount}
					{changeCount === 1 ? $i18n.t('unsaved change') : $i18n.t('unsaved changes')}
				{/if}
			</span>
			<div class="flex items-center gap-2">
				{#if changeCount > 0}
					<button
						type="button"
						class="h-7 rounded-lg px-2.5 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
						disabled={saving}
						on:click={discard}>{$i18n.t('Discard')}</button
					>
				{/if}
				<button
					type="button"
					class="flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-gray-900 px-2.5 text-xs font-normal text-white transition hover:bg-black disabled:opacity-60 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
					disabled={saving || changeCount === 0}
					on:click={save}>{saving ? $i18n.t('Saving…') : $i18n.t('Save')}</button
				>
			</div>
		</div>
	{/if}
</div>
