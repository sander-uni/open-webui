// Fork addition: client for /api/v1/model-manager (backend/open_webui/routers/model_manager.py).
import { WEBUI_API_BASE_URL } from '$lib/constants';

const call = async (token: string, method: string, path: string, body?: object) => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/model-manager${path}`, {
		method,
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			authorization: `Bearer ${token}`
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {})
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw data?.detail ?? `HTTP ${res.status}`;
	}
	return data;
};

export const getModelManagerStatus = (token: string) => call(token, 'GET', '/status');

export const loadManagedModel = (token: string, model: string, pin = false, force = false) =>
	call(token, 'POST', '/load', { model, pin, force });

// 0.3.5 (review C14): `model` is the model the confirmation was shown for; the manager refuses
// when another one is loading/loaded by then.
export const cancelManagedLoad = (token: string, model = '') =>
	call(token, 'POST', '/cancel', model ? { model } : {});

export const unloadManagedModel = (token: string, force = false, model = '') =>
	call(token, 'POST', '/unload', model ? { force, model } : { force });

/** 0.3.5 (review C15): change only a model's live hidden flag; {exists: false} = no saved settings. */
export const setModelVisibility = (token: string, id: string, hidden: boolean) =>
	call(token, 'POST', '/visibility', { id, hidden }) as Promise<{ exists: boolean }>;

export const pinManagedModel = (token: string, pinned: boolean) =>
	call(token, 'POST', '/pin', { pinned });

export const saveModelManagerSettings = (
	token: string,
	settings: { idle_minutes?: number; hidden?: string[]; hidden_add?: string[]; hidden_remove?: string[] }
) => call(token, 'POST', '/settings', settings);

export const getModelManagerFilter = (token: string) => call(token, 'GET', '/filter');

// fork 0.4.1: ComfyUI's log and its running job (modelmgr 0.8.0)
export type ComfyJobProgress = {
	phase: 'preparing' | 'sampling' | 'finishing';
	step: number;
	steps: number;
	s_per_step: number | null;
	phase_s: number;
	segment: number | null;
	segments: number | null;
	fraction: number;
	eta_s: number | null;
};

export type ComfyLogView = {
	path: string;
	lines: string[];
	running: { id: string; tool: string; status: string; detail: string; running_s: number | null; progress: ComfyJobProgress | null } | null;
};

export const getComfyLog = (token: string, lines = 300) =>
	call(token, 'GET', `/comfyui/log?lines=${lines}`) as Promise<ComfyLogView>;

// fork 0.3.7: Admin Settings > Miner. fork 0.3.8: the toolbox is held per agent run.
export type ToolboxMinerState = {
	state?: string;
	detail?: string;
	age_s?: number;
	since?: number;
	mine_at?: number;
	idle_s?: number;
	hold?: boolean;
	ack?: boolean;
	error?: string;
};

export type MinerView = {
	windows: { enabled: boolean; folder: string | null; hold: boolean; failing: boolean; state: string | null; model: string | null };
	toolbox: {
		enabled: boolean;
		target: string | null;
		holding: boolean;
		confirmed: boolean;
		held_since: number | null;
		released_at: number | null;
		state: ToolboxMinerState | null;
		runs: { run: string; tool: string | null; chat: string | null; calls: number; since: number }[];
		active_runs: number;
		last_error: { code: string; message: string; t: number } | null;
		tools: string[];
		now: number;
	};
	settings: { toolbox_tools: string[] };
	connections: { id: string | null; name: string | null; url: string; origin: string }[];
	events: { ts: string; event: string; [key: string]: unknown }[];
};

export const getMinerView = (token: string) => call(token, 'GET', '/miner') as Promise<MinerView>;

export const saveMinerSettings = (token: string, settings: { toolbox_tools: string[] }) =>
	call(token, 'POST', '/miner/settings', settings) as Promise<MinerView>;

// 0.3.2: speed and context figures of one chat, for the chat input.
export type ChatStats = {
	phase: 'none' | 'idle' | 'prefill' | 'decode' | 'compacting';
	elapsed_s?: number;
	decode_tps?: number;
	prefill_tps?: number;
	ctx_used?: number;
	ctx_max?: number;
	model?: string;
};

export const getChatStats = async (
	token: string,
	chatId: string,
	signal?: AbortSignal
): Promise<ChatStats | null> => {
	const res = await fetch(
		`${WEBUI_API_BASE_URL}/model-manager/chat-stats/${encodeURIComponent(chatId)}`,
		{ headers: { Accept: 'application/json', authorization: `Bearer ${token}` }, signal }
	);
	if (!res.ok) return null;
	return (await res.json().catch(() => null)) as ChatStats | null;
};

// 0.3.4: the note the model received when ctxproxy compacted a chat ("View summary").
export type CompactionNote = { n: number; note: string; created?: number | null };

export const getCompactionNote = (
	token: string,
	chatId: string,
	messageId: string,
	n: number,
	conv = ''
): Promise<CompactionNote> =>
	call(
		token,
		'GET',
		`/compactions/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/${n}${
			conv ? `?conv=${encodeURIComponent(conv)}` : ''
		}`
	);

// 0.4.0: reasoning effort levels per model (Admin Settings > Model Manager > Reasoning effort).
export type EffortLevel = { name: string; budget: number | null; sentence: string | null };
export type EffortModel = {
	id: string;
	name: string;
	engine: string;
	provider?: string;
	kind: 'native' | 'template' | 'budget';
	budgets: boolean; // false: the engine takes no thinking budget per request (NInfer, Ollama)
	source?: string; // where the levels were found (the chat template, the provider's list, ...)
	aliases?: Record<string, string>;
	levels: EffortLevel[];
	default: string | null;
	compact_cap: number | null;
	edited: boolean;
	defaults: { levels: EffortLevel[]; default: string | null };
};

export const getEfforts = (token: string) => call(token, 'GET', '/efforts') as Promise<{ models: EffortModel[] }>;

export const saveEfforts = (
	token: string,
	update: { id: string; levels?: Partial<EffortLevel>[]; default?: string | null; compact_cap?: number | null; reset?: boolean }
) => call(token, 'POST', '/efforts', update) as Promise<EffortModel>;

// 0.4.2: a workspace model's own reasoning_effort (the picker's start value), also for users who
// may only read the model (Open WebUI gives them the model without its params).
export const getPresetEffort = async (token: string, model: string): Promise<string | null> => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/model-manager/preset-effort?model=${encodeURIComponent(model)}`, {
		headers: { Accept: 'application/json', authorization: `Bearer ${token}` }
	});
	if (!res.ok) return null;
	const data = await res.json().catch(() => null);
	return typeof data?.reasoning_effort === 'string' && data.reasoning_effort ? data.reasoning_effort : null;
};

// 0.4.0: the ChatGPT plan's usage for a Codex model (5-hour and weekly windows).
export type UsageWindow = { used_percent: number; resets_at: number | null; window_s?: number | null };
export type CloudUsage = {
	plan?: string | null;
	limit_reached?: boolean;
	'5h'?: UsageWindow | null;
	week?: UsageWindow | null;
	updated_at?: number;
	error?: string;
};

export const getCloudUsage = async (token: string, model: string, signal?: AbortSignal): Promise<CloudUsage | null> => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/model-manager/cloud-usage?model=${encodeURIComponent(model)}`, {
		headers: { Accept: 'application/json', authorization: `Bearer ${token}` },
		signal
	});
	if (!res.ok) return null;
	const data = await res.json().catch(() => null);
	return (data?.usage ?? null) as CloudUsage | null;
};
