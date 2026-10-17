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
export const getInterjectionState = async (token: string, chatId: string, messageId: string) => {
	const res = await fetch(url(chatId, messageId), { headers: headers(token) });
	if (!res.ok) return { accepting: false, pending: [] };
	return (await res.json()) as { accepting: boolean; pending: { id: string }[] };
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
