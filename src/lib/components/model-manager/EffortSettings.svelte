<script lang="ts">
	// Fork addition, 0.4.0: Admin Settings > Model Manager > Reasoning effort. Every model with
	// effort levels (cloud models, Strata's Qwen): the default level, each level's thinking budget
	// (and for Qwen the sentence the model is given), and a compaction cap. Saved in the model
	// manager (state/efforts.json); used from the next request.
	import { getContext, onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { getModels } from '$lib/apis';
	import { models as owuiModels } from '$lib/stores';
	import { getEfforts, saveEfforts, type EffortModel } from '$lib/apis/model-manager';

	const i18n = getContext('i18n');

	type Draft = {
		levels: { name: string; budget: string; sentence: string }[];
		default: string;
		cap: string;
	};

	let entries: EffortModel[] = [];
	let drafts: Record<string, Draft> = {};
	let saved: Record<string, string> = {};
	let busy: Record<string, boolean> = {};
	let error = '';
	let loading = true;

	const toDraft = (m: EffortModel): Draft => ({
		levels: m.levels.map((lv) => ({
			name: lv.name,
			budget: lv.budget === null || lv.budget === undefined ? '' : String(lv.budget),
			sentence: lv.sentence ?? ''
		})),
		default: m.default ?? '',
		cap: m.compact_cap ? String(m.compact_cap) : ''
	});

	const take = (m: EffortModel) => {
		drafts[m.id] = toDraft(m);
		saved[m.id] = JSON.stringify(drafts[m.id]);
		entries = entries.map((e) => (e.id === m.id ? m : e));
	};

	const load = async () => {
		try {
			const res = await getEfforts(localStorage.token);
			entries = res.models ?? [];
			for (const m of entries) take(m);
			error = '';
		} catch (e) {
			error = `${e}`;
		}
		loading = false;
	};
	onMount(load);

	const refreshPicker = async () => {
		try {
			owuiModels.set(await getModels(localStorage.token));
		} catch {
			// the picker reads the new levels at its next model list refresh
		}
	};

	const save = async (m: EffortModel) => {
		const d = drafts[m.id];
		const levels = d.levels.map((lv) => {
			const out: { name: string; budget?: number; sentence?: string } = { name: lv.name };
			if (m.budgets && lv.budget.trim() !== '') out.budget = Number(lv.budget.trim());
			if (m.kind === 'template' && defaultOf(m, lv.name)?.sentence != null) out.sentence = lv.sentence;
			return out;
		});
		const bad = levels.find((lv) => lv.budget !== undefined && (!Number.isInteger(lv.budget) || lv.budget < 0));
		if (bad) {
			toast.error($i18n.t('{{level}}: the thinking budget must be a whole number of tokens (0 = no budget).', { level: bad.name }));
			return;
		}
		const cap = d.cap.trim() === '' ? null : Number(d.cap.trim());
		if (cap !== null && (!Number.isInteger(cap) || cap < 1000)) {
			toast.error($i18n.t('The compaction cap must be a whole number of tokens, 1000 or more, or empty.'));
			return;
		}
		busy[m.id] = true;
		try {
			take(await saveEfforts(localStorage.token, { id: m.id, levels, default: d.default || null, compact_cap: cap }));
			toast.success($i18n.t('Saved. Used from the next request.'));
			await refreshPicker();
		} catch (e) {
			toast.error(`${e}`);
		}
		busy[m.id] = false;
	};

	const reset = async (m: EffortModel) => {
		busy[m.id] = true;
		try {
			take(await saveEfforts(localStorage.token, { id: m.id, reset: true }));
			toast.success($i18n.t('Back to the defaults.'));
			await refreshPicker();
		} catch (e) {
			toast.error(`${e}`);
		}
		busy[m.id] = false;
	};

	const kindText = (m: EffortModel) =>
		m.kind === 'native'
			? $i18n.t('The service sets what each level does. Choose the default level.')
			: m.kind === 'template' && m.budgets
				? $i18n.t("The chat template's own levels. Each has a thinking budget and the sentence the model is given.")
				: m.kind === 'template'
				? $i18n.t("The chat template's own levels: the sentence the model is given (the engine's own thinking budget applies).")
				: $i18n.t('Six levels, each a thinking budget (sent to the service, and enforced here).');
	const defaultOf = (m: EffortModel, name: string) => m.defaults.levels.find((lv) => lv.name === name);
	const btn =
		'rounded-lg border border-gray-200/70 px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.05]';
	const field = 'rounded border border-gray-200/70 bg-transparent p-1 dark:border-white/[0.08]';
</script>

<div class="space-y-2">
	<h3 class="font-medium">{$i18n.t('Reasoning effort')}</h3>
	<p class="text-xs">
		{$i18n.t('The levels of the effort picker next to the model name. A level the model lacks becomes the nearest one it has. A thinking budget of 0 means no budget. The compaction cap makes the context proxy compact by that prompt size at the latest (otherwise at the model\'s window minus the reply minus the offset in Admin Settings > Context Proxy).')}
	</p>
	{#if loading}<p class="text-xs">{$i18n.t('Loading…')}</p>{/if}
	{#if error}<p class="text-xs text-red-600">{error}</p>{/if}
	{#each entries as m (m.id)}
		{@const d = drafts[m.id]}
		{#if d}
			<details class="rounded-xl border border-gray-100/70 bg-gray-50/50 px-3 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.02]">
				<summary class="cursor-pointer select-none">
					<span class="font-medium break-all">{m.name}</span>
					{#if m.name !== m.id}<span class="text-xs text-gray-500"> · {m.id}</span>{/if}
					<span class="text-xs text-gray-500"> · {$i18n.t('default')} {m.default}{m.edited ? ` · ${$i18n.t('edited')}` : ''}</span>
				</summary>
				<div class="mt-2 space-y-2 text-xs">
					<p>{kindText(m)}</p>
					{#if m.source}<p class="text-gray-500">{$i18n.t('Found from')}: {m.source}{m.aliases && Object.keys(m.aliases).length ? ` · ${Object.entries(m.aliases).map(([a, b]) => `${a} = ${b}`).join(', ')}` : ''}</p>{/if}
					<label class="flex items-center gap-2">
						{$i18n.t('Default level')}
						<select class={field} bind:value={d.default}>
							{#each d.levels as lv (lv.name)}<option value={lv.name}>{lv.name}</option>{/each}
						</select>
						{#if m.defaults.default && m.defaults.default !== d.default}
							<span class="text-gray-500">({$i18n.t('default')}: {m.defaults.default})</span>
						{/if}
					</label>
					{#if m.kind !== 'native'}
						<div class="space-y-1.5">
							{#each d.levels as lv (lv.name)}
								{@const def = defaultOf(m, lv.name)}
								<div class="space-y-1">
									<label class="flex flex-wrap items-center gap-2">
										<span class="w-12 font-medium">{lv.name}</span>
										{#if m.budgets}
											<input class="w-28 {field}" type="text" inputmode="numeric" bind:value={lv.budget}
												aria-label={`${lv.name}: ${$i18n.t('thinking budget in tokens')}`} />
											<span class="text-gray-500">{$i18n.t('tokens')}{def && String(def.budget) !== lv.budget ? ` (${$i18n.t('default')} ${def.budget})` : ''}</span>
										{:else}
											<span class="text-gray-500">{$i18n.t("The engine's own thinking budget applies (no budget per request).")}</span>
										{/if}
									</label>
									{#if m.kind === 'template' && def?.sentence != null}
										<textarea class="w-full {field}" rows="2" bind:value={lv.sentence}
											aria-label={`${lv.name}: ${$i18n.t('sentence the model is given')}`}
											placeholder={$i18n.t('No sentence (the template adds none at this level)')}></textarea>
										{#if def && (def.sentence ?? '') !== lv.sentence}
											<button type="button" class="text-gray-500 underline" on:click={() => (lv.sentence = def.sentence ?? '')}>
												{$i18n.t("Use the template's own sentence")}</button>
										{/if}
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					<label class="flex flex-wrap items-center gap-2">
						{$i18n.t('Compact by')}
						<input class="w-28 {field}" type="text" inputmode="numeric" bind:value={d.cap}
							placeholder={$i18n.t('no cap')} aria-label={$i18n.t('Compaction cap in tokens')} />
						<span class="text-gray-500">{$i18n.t('tokens at the latest (empty = no cap)')}</span>
					</label>
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btn} disabled={busy[m.id] || JSON.stringify(d) === saved[m.id]}
							on:click={() => save(m)}>{$i18n.t('Save')}</button>
						{#if m.edited}
							<button type="button" class={btn} disabled={busy[m.id]} on:click={() => reset(m)}>{$i18n.t('Reset to defaults')}</button>
						{/if}
					</div>
				</div>
			</details>
		{/if}
	{/each}
</div>
