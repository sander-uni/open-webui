// Fork addition (0.3.3): client for /api/v1/interjections (backend/open_webui/routers/interjections.py).
import { WEBUI_API_BASE_URL } from '$lib/constants';

const url = (chatId: string, messageId: string, id = '') =>
	`${WEBUI_API_BASE_URL}/interjections/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}${
		id ? `/${encodeURIComponent(id)}` : ''
	}`;

const headers = (token: string) => ({
	Accept: 'application/json',
	'Content-Type': 'application/json',
	authorization: `Bearer ${token}`
});

/** Whether this reply still takes messages for its next step. */
export type InterjectionItem = { id: string; text: string; files: any[] };
export type InterjectionState = {
	accepting: boolean;
	paused?: boolean;
	pending: InterjectionItem[];
	/** 0.3.5: not delivered (the reply ended first), kept until the browser acknowledges them */
	returned?: InterjectionItem[];
};

export const getInterjectionState = async (
	token: string,
	chatId: string,
	messageId: string
): Promise<InterjectionState> => {
	const res = await fetch(url(chatId, messageId), { headers: headers(token) });
	if (!res.ok) throw `HTTP ${res.status}`;
	return (await res.json()) as InterjectionState;
};

/** 0.3.5: these returned messages are back in the input box; the server forgets them. */
export const ackReturnedInterjections = async (
	token: string,
	chatId: string,
	messageId: string,
	ids: string[]
): Promise<void> => {
	await fetch(`${url(chatId, messageId)}/returned/ack`, {
		method: 'POST',
		headers: headers(token),
		body: JSON.stringify({ ids })
	});
};

/** Returns the new id, or null when the reply takes no message (no tools, or already finishing). */
export const addInterjection = async (
	token: string,
	chatId: string,
	messageId: string,
	text: string,
	files: object[]
): Promise<string | null> => {
	const res = await fetch(url(chatId, messageId), {
		method: 'POST',
		headers: headers(token),
		body: JSON.stringify({ text, files })
	});
	if (res.status === 409) return null;
	if (!res.ok) throw (await res.json().catch(() => ({})))?.detail ?? `HTTP ${res.status}`;
	return (await res.json()).id;
};

export const removeInterjection = async (
	token: string,
	chatId: string,
	messageId: string,
	id: string
): Promise<boolean> => {
	const res = await fetch(url(chatId, messageId, id), { method: 'DELETE', headers: headers(token) });
	return res.ok ? !!(await res.json()).removed : false;
};
