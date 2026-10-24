<script lang="ts">
	// Fork addition, 0.4.0: the reasoning effort picker next to the model name in the chat input.
	// Shown for models whose levels the model manager lists (cloud models and Strata's Qwen, also
	// as the base of a workspace model). The pick is remembered per model id in the user's
	// settings (`modelEfforts`) and sent with every request of that model; without a pick nothing
	// is sent, so a workspace model's own reasoning effort or the model's default applies.
	import { getContext } from 'svelte';
	import { models, settings } from '$lib/stores';
	import { updateUserSettings } from '$lib/apis/users';
	import { getPresetEffort } from '$lib/apis/model-manager';
	import Dropdown from '$lib/components/common/Dropdown.svelte';
	import DropdownMenu from '$lib/components/common/DropdownMenu.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import { budgetText, effortMeta, nearestLevel, pickedEffort, type EffortMeta } from './effort';

	const i18n = getContext('i18n');

	export let selectedModels: string[] = [];

	let show = false;
	// a workspace model's own reasoning_effort (its start value), read once per model
	const presetEffort: Record<string, string | null> = {};
	let presetSeen = 0;

	$: model = selectedModels.length === 1 ? ($models ?? []).find((m) => m?.id === selectedModels[0]) : null;
	$: meta = model ? effortMeta(model, $models) : null;
	$: picked = model && meta ? pickedEffort(model.id, meta, $settings) : null;
	$: if (model?.info?.base_model_id && !(model.id in presetEffort)) readPreset(model.id);
	// `seen` makes this run again once a workspace model's own setting has arrived
	const startOf = (id: string, m: EffortMeta, seen: number) => nearestLevel(presetEffort[id] ?? null, m);
	$: start = model && meta ? startOf(model.id, meta, presetSeen) : null;
	$: shown = picked ?? start;
	$: budgets = meta?.effort_budgets ?? {};

	const readPreset = async (id: string) => {
		presetEffort[id] = null;
		try {
			presetEffort[id] = await getPresetEffort(localStorage.token, id);
		} catch {
			presetEffort[id] = null;
		}
		presetSeen += 1;
	};

	const choose = async (level: string | null) => {
		show = false;
		if (!model) return;
		const next = { ...($settings?.modelEfforts ?? {}) };
		if (level) next[model.id] = level;
		else delete next[model.id];
		settings.set({ ...$settings, modelEfforts: next });
		await updateUserSettings(localStorage.token, { ui: { modelEfforts: next } }).catch(() => {});
	};

	$: help = meta
		? [
				$i18n.t('Reasoning effort'),
				picked
					? $i18n.t('Your pick for this model, remembered.')
					: model?.info?.base_model_id && presetEffort[model.id]
						? $i18n.t("This workspace model's own setting.")
						: $i18n.t("The model's default."),
				budgets[shown ?? ''] !== undefined ? budgetText(budgets[shown ?? '']) : ''
			]
				.filter(Boolean)
				.join(' · ')
		: '';
</script>

{#if meta && shown}
	<Dropdown bind:show align="end" side="top" sideOffset={6}>
		<Tooltip content={help} placement="top" className="flex shrink-0 self-center">
			<button
				type="button"
				aria-label={`${$i18n.t('Reasoning effort')}: ${shown}`}
				class="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[0.75rem] leading-none whitespace-nowrap transition-colors duration-100 hover:bg-gray-50/40 dark:hover:bg-gray-800/40 {picked
					? 'text-gray-700 dark:text-gray-200'
					: 'text-gray-500 dark:text-gray-400'}"
			>
				<span>{shown}</span>
				<svg class="size-3 opacity-60" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
					><path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" /></svg
				>
			</button>
		</Tooltip>
		<div slot="content">
			<DropdownMenu className="min-w-44 max-w-64">
				<div class="px-2 pt-1 pb-0.5 text-[0.6875rem] text-gray-500">{$i18n.t('Reasoning effort')}</div>
				{#each meta.efforts as level (level)}
					<button
						type="button"
						class="text-left"
						aria-pressed={shown === level}
						on:click={() => choose(level)}
					>
						<span class="w-3 shrink-0 text-center">{shown === level ? '✓' : ''}</span>
						<span class="min-w-0 flex-1 truncate">{level}</span>
						{#if budgets[level] !== undefined}
							<span class="text-[0.6875rem] text-gray-500 tabular-nums"
								>{budgets[level] ? `${Math.round((budgets[level] ?? 0) / 1024)}K` : '∞'}</span
							>
						{/if}
					</button>
				{/each}
				{#if picked}
					<hr class="border-gray-100/70 dark:border-gray-800/60" />
					<button type="button" class="text-left text-gray-500" on:click={() => choose(null)}>
						<span class="w-3 shrink-0"></span>
						<span class="min-w-0 flex-1 truncate"
							>{$i18n.t('Use the default')}{start ? ` (${start})` : ''}</span
						>
					</button>
				{/if}
			</DropdownMenu>
		</div>
	</Dropdown>
{/if}
