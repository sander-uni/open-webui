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

export const cancelManagedLoad = (token: string) => call(token, 'POST', '/cancel', {});

export const unloadManagedModel = (token: string, force = false) =>
	call(token, 'POST', '/unload', { force });

export const pinManagedModel = (token: string, pinned: boolean) =>
	call(token, 'POST', '/pin', { pinned });

export const saveModelManagerSettings = (
	token: string,
	settings: { idle_minutes?: number; hidden?: string[] }
) => call(token, 'POST', '/settings', settings);

export const getModelManagerFilter = (token: string) => call(token, 'GET', '/filter');
