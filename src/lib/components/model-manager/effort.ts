// Fork addition, 0.4.0: reasoning effort levels from the local model manager (modelmgr).
// A model's levels come from its own `modelmgr` block in the model list, or its base model's
// (workspace models). The last pick per model id (workspace models separately) is kept in the
// user's settings as `modelEfforts`; a model without a pick sends nothing, so the workspace
// model's own reasoning_effort or the model's default applies.

export type EffortMeta = {
	efforts: string[];
	default_effort?: string | null;
	effort_aliases?: Record<string, string>; // the template's own (Qwen: high = xhigh)
	effort_budgets?: Record<string, number | null>;
	provider?: string;
	engine?: string;
	ctx?: number;
};

export const ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const metaOf = (model: any): EffortMeta | null => {
	const m = model?.modelmgr ?? model?.openai?.modelmgr;
	return m && Array.isArray(m.efforts) && m.efforts.length > 0 ? (m as EffortMeta) : null;
};

/** The model's own levels, or its base model's (a workspace model). */
export const effortMeta = (model: any, models: any[]): EffortMeta | null => {
	const own = metaOf(model);
	if (own) return own;
	const baseId = model?.info?.base_model_id;
	if (!baseId) return null;
	return metaOf((models ?? []).find((m) => m?.id === baseId));
};

/** The base model's id for a workspace model, else the model's own id. */
export const baseIdOf = (model: any): string => model?.info?.base_model_id || model?.id || '';

/** The level a request with `asked` gets (as modelmgr picks it): the asked level, else the
 * nearest one the model has (the higher of two equally near), else the default. */
export const nearestLevel = (asked: string | null | undefined, meta: EffortMeta): string | null => {
	const names = meta.efforts;
	if (!names.length) return null;
	let want = (asked ?? '').trim().toLowerCase() || (meta.default_effort ?? '');
	want = meta.effort_aliases?.[want] ?? want;
	if (names.includes(want)) return want;
	const i = ORDER.indexOf(want);
	if (i >= 0) {
		const ranked = names
			.filter((n) => ORDER.includes(n))
			.map((n) => [Math.abs(ORDER.indexOf(n) - i), -ORDER.indexOf(n), n] as [number, number, string])
			.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		if (ranked.length) return ranked[0][2];
	}
	return meta.default_effort && names.includes(meta.default_effort) ? meta.default_effort : names[0];
};

/** The remembered pick for this model id, if it is still one of its levels. */
export const pickedEffort = (modelId: string, meta: EffortMeta | null, settings: any): string | null => {
	const v = settings?.modelEfforts?.[modelId];
	return meta && typeof v === 'string' && meta.efforts.includes(v) ? v : null;
};

/** What the chat request adds: the picked level, or nothing (the preset's own value applies). */
export const effortParams = (model: any, models: any[], settings: any): { reasoning_effort?: string } => {
	const meta = effortMeta(model, models);
	const picked = pickedEffort(model?.id ?? '', meta, settings);
	return picked ? { reasoning_effort: picked } : {};
};

export const budgetText = (tokens: number | null | undefined): string => {
	if (tokens === null || tokens === undefined) return '';
	if (tokens === 0) return 'no thinking budget';
	return `thinks up to ${tokens >= 1000 ? `${Math.round(tokens / 1024)}K` : tokens} tokens`;
};
