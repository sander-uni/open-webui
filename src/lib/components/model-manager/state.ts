// Fork addition: the local model manager's state for the chat model picker.
// Polls /api/v1/model-manager/state while something is subscribed and the tab is visible:
// every second while a model loads, every 4 s otherwise, every 30 s if the manager is absent.
import { get, writable } from 'svelte/store';
import { WEBUI_API_BASE_URL } from '$lib/constants';

export type ManagerState = {
	phase: 'idle' | 'loading' | 'ready' | 'unloading' | 'error';
	model: string | null; // loaded and ready
	target: string | null; // being loaded or unloaded
	detail: string | null;
	log_tail: string | null; // last line of the engine's log while loading or unloading
	elapsed_s: number | null;
	pinned: boolean;
	switch_to: string | null;
	inflight: number;
	error: { model: string | null; message: string } | null;
	managed: string[];
};

let refreshNow: () => void = () => {};

export const managerState = writable<ManagerState | null>(null, (set) => {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	const poll = async () => {
		if (stopped) return;
		let delay = 4000;
		if (typeof document !== 'undefined' && document.hidden) {
			delay = 4000;
		} else {
			try {
				const res = await fetch(`${WEBUI_API_BASE_URL}/model-manager/state`, {
					headers: { authorization: `Bearer ${localStorage.token}` }
				});
				if (res.ok) {
					const state = (await res.json()) as ManagerState;
					set(state);
					if (state.phase === 'loading' || state.phase === 'unloading' || state.switch_to) {
						delay = 1000;
					}
				} else {
					set(null);
					delay = 30000;
				}
			} catch {
				set(null);
				delay = 30000;
			}
		}
		if (!stopped) timer = setTimeout(poll, delay);
	};

	refreshNow = () => {
		if (timer) clearTimeout(timer);
		poll();
	};
	poll();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		refreshNow = () => {};
	};
});

export const refreshManagerState = () => refreshNow();

/** Ask the chat model picker to switch to this model id (after a load from the Model Manager). */
export const modelSelectRequest = writable<{ id: string; at: number } | null>(null);
export const requestModelSelection = (id: string) => modelSelectRequest.set({ id, at: Date.now() });

/** The manager's id for an Open WebUI model (its own id, its base model, or behind a prefix). */
export const managedId = (model: any, state: ManagerState | null = get(managerState)) => {
	if (!state || !model) return null;
	const ids = new Set(state.managed);
	for (const candidate of [model?.id, model?.info?.base_model_id]) {
		if (typeof candidate !== 'string' || !candidate) continue;
		if (ids.has(candidate)) return candidate;
		const hit = state.managed
			.filter((id) => candidate.endsWith(`.${id}`))
			.sort((a, b) => b.length - a.length)[0];
		if (hit) return hit;
	}
	return null;
};

/** Why this model can't be picked right now, or null. */
export const managerBlock = (model: any, state: ManagerState | null = get(managerState)) => {
	const id = managedId(model, state);
	if (!state || !id) return null;
	if (
		(state.phase === 'loading' || state.phase === 'unloading') &&
		state.target &&
		state.target !== id
	) {
		return state.phase === 'loading'
			? `${state.target} is loading. Wait until it is ready.`
			: `${state.target} is unloading. Wait a moment.`;
	}
	if (state.pinned && state.model && state.model !== id) {
		return `${state.model} is pinned. Unpin it in Admin Settings > Model Manager.`;
	}
	return null;
};
