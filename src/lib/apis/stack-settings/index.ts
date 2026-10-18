// Fork 0.3.6: client for /api/v1/stack-settings (backend/open_webui/routers/stack_settings.py):
// every setting of the context proxy (ctxproxy) and the run logger (agentlog).
import { WEBUI_API_BASE_URL } from '$lib/constants';

export type StackService = 'ctxproxy' | 'agentlog';

export type StackSetting = {
	key: string;
	label: string;
	kind: string;
	group: string;
	help: string;
	value: string;
	default: string;
	source: 'file' | 'default' | 'environment' | 'launcher';
	in_file: boolean;
	apply?: 'live' | 'start' | 'launcher' | 'follows';
	choices?: string[];
	unit?: string;
	min?: number;
	max?: number;
	sep?: string;
	cache?: boolean;
	is_set?: boolean;
	resolved?: string;
	readonly_reason?: string;
	running?: string | null;
	pending?: boolean;
};

export type StackSettingsData = {
	service: StackService;
	name: string;
	running: boolean;
	version: string | null;
	file: string | null;
	runtime_file: string | null;
	restart_needed: boolean;
	model_api_url: { now: string | null; next: string | null };
	groups: { id: string; title: string; help: string }[];
	settings: StackSetting[];
	ignored: { key: string; value: string; reason: string }[];
	error: { message: string; errors?: Record<string, string> } | null;
};

export class StackSettingsErrors extends Error {
	/** partial: the save stopped halfway; these settings were saved (review R09). */
	constructor(
		public errors: Record<string, string>,
		public partial: { saved: string[] } | null = null
	) {
		super('Some values are not valid');
	}
}

const call = async (token: string, method: string, service: StackService, body?: object) => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/stack-settings/${service}`, {
		method,
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			authorization: `Bearer ${token}`
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {})
	});
	const data = await res.json().catch(() => ({}));
	if ((res.status === 422 || res.status === 500) && data?.errors) {
		throw new StackSettingsErrors(data.errors, data.partial ?? null);
	}
	if (!res.ok) {
		throw new Error(typeof data?.detail === 'string' ? data.detail : `HTTP ${res.status}`);
	}
	return data as StackSettingsData;
};

export const getStackSettings = (token: string, service: StackService) => call(token, 'GET', service);

/** changes: {KEY: value | null}; null = back to the default. removeLines: lines the service doesn't use. */
export const saveStackSettings = (
	token: string,
	service: StackService,
	changes: Record<string, string | null>,
	removeLines: string[] = []
) => call(token, 'PUT', service, { changes, remove_lines: removeLines });
