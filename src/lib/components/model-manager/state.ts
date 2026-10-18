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
	ux?: any; // Round 4: manager-owned copy, permissions and ordered plan.
};

let refreshNow: () => void = () => {};
export const managerConnection = writable<'checking' | 'online' | 'offline'>('checking');
// Round 4 follow-up: the models the manager handled at its last answer, so an outage is
// reported only for those (not for cloud models, which don't depend on it).
let knownManaged: string[] = [];

export const managerState = writable<ManagerState | null>(null, (set) => {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let polling = false;
	let again = false; // a refresh asked for while a poll was in flight
	let controller: AbortController | null = null;
	let requestTimer: ReturnType<typeof setTimeout> | null = null;

	const poll = async () => {
		if (stopped) return;
		if (polling) {
			again = true;
			return;
		}
		polling = true;
		controller = new AbortController();
		let delay = 4000;
		if (typeof document !== 'undefined' && document.hidden) {
			delay = 4000;
		} else {
			try {
				requestTimer = setTimeout(() => controller?.abort(), 10000);
				const res = await fetch(`${WEBUI_API_BASE_URL}/model-manager/state`, {
					signal: controller.signal,
					headers: { authorization: `Bearer ${localStorage.token}` }
				});
				if (res.ok) {
					const state = (await res.json()) as ManagerState;
					if (stopped) return;
					if (controller.signal.aborted) throw new Error('stale request');
					set(state);
					if (Array.isArray(state.managed)) knownManaged = state.managed;
					managerConnection.set('online');
					if (state.phase === 'loading' || state.phase === 'unloading' || state.switch_to) {
						delay = 1000;
					}
				} else {
					if (stopped) return;
					set(null);
					managerConnection.set('offline');
					delay = 30000;
				}
			} catch {
				if (stopped) return;
				set(null);
				managerConnection.set('offline');
				delay = 30000;
			} finally {
				if (requestTimer) clearTimeout(requestTimer);
				requestTimer = null;
			}
		}
		polling = false;
		if (stopped) return;
		if (again) {
			again = false;
			delay = 0;
		}
		timer = setTimeout(poll, delay);
	};

	refreshNow = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		poll();
	};
	// Round 4: resume immediately on wake/reconnect, using the existing single poll loop.
	const wake = () => {
		if (typeof document === 'undefined' || !document.hidden) {
			if (polling) controller?.abort();
			refreshNow();
		}
	};
	if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', wake);
	if (typeof window !== 'undefined') {
		window.addEventListener('online', wake);
		window.addEventListener('pageshow', wake);
	}
	poll();
	return () => {
		if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', wake);
		if (typeof window !== 'undefined') {
			window.removeEventListener('online', wake);
			window.removeEventListener('pageshow', wake);
		}
		stopped = true;
		controller?.abort();
		if (requestTimer) clearTimeout(requestTimer);
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

/** managedId against the last list the manager reported (for when it can't be reached). */
export const knownManagedId = (model: any) =>
	managedId(model, { managed: knownManaged } as unknown as ManagerState);

/** Why this model can't be picked right now, or null. */
export const managerBlock = (model: any, state: ManagerState | null = get(managerState)) => {
	const id = managedId(model, state);
	if (!state || !id) return null;
	const view = state.ux?.models?.[id];
	if (view) return view.can_select ? null : `${view.primary} ${view.why}`;
	// Older manager: keep a role-neutral fallback until both sides are updated.
	if (state.pinned && (state.target || state.model) && (state.target || state.model) !== id) {
		return 'Another model is pinned by an admin. Choose that model or ask the admin to allow switching.';
	}
	return null;
};
