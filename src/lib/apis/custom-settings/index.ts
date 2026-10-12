import { WEBUI_API_BASE_URL } from '$lib/constants';
import type { CustomSettings } from '$lib/utils/custom-settings';

async function request(token: string, settings?: CustomSettings): Promise<CustomSettings> {
	const response = await fetch(`${WEBUI_API_BASE_URL}/custom-settings`, {
		method: settings ? 'POST' : 'GET',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		...(settings ? { body: JSON.stringify(settings) } : {})
	});
	if (!response.ok) {
		const error = await response.json().catch(() => null);
		throw new Error(
			typeof error?.detail === 'string'
				? error.detail
				: `Settings request failed (${response.status})`
		);
	}
	return response.json();
}

export const getCustomSettings = (token: string) => request(token);
export const setCustomSettings = (token: string, settings: CustomSettings) =>
	request(token, settings);
