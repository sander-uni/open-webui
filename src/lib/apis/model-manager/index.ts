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
