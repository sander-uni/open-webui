// Fork addition (0.3.3): messages the user sends while an agent reply runs ("interjections").
// The backend delivers them at the model's next step; this tracks them in the browser until
// they show up in the reply's output, or the reply ends without a next step (then they come
// back to the input box).
import { get, writable } from 'svelte/store';
import {
	addInterjection,
	getInterjectionState,
	removeInterjection
} from '$lib/apis/interjections';

export type PendingInterjection = {
	id: string;
	chatId: string;
	messageId: string;
	text: string;
	files: any[];
	reason?: 'not_delivered' | 'withdrawn';
};

/** Waiting for the model's next step, per chat. */
export const pendingInterjections = writable<Record<string, PendingInterjection[]>>({});
/** Messages that came back because the reply ended first; the input box picks them up. */
export const returnedInterjections = writable<Record<string, PendingInterjection[]>>({});

const isImage = (f: any) =>
	f?.type === 'image' || String(f?.content_type ?? f?.file?.meta?.content_type ?? '').startsWith('image/');

/** The parts of an attached file the backend needs (never the whole upload record). */
const fileRef = (f: any) => ({
	type: f?.type,
	id: f?.id ?? null,
	name: f?.name ?? f?.file?.meta?.name ?? '',
	content_type: f?.content_type ?? f?.file?.meta?.content_type ?? '',
	...(f?.type === 'filesystem' ? { path: f?.path ?? f?.url ?? f?.id } : {}),
	...(f?.type === 'image' && typeof f?.url === 'string' && f.url.startsWith('data:') ? { url: f.url } : {})
});

export const isDirectAttachment = (file: File) =>
	file.type.startsWith('image/') ||
	file.type.startsWith('text/') ||
	/\.(txt|md|markdown|log|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|[cm]?js|tsx?|jsx|svelte|vue|py|pyi|sh|bash|ps1|bat|c|h|cc|cpp|hpp|cs|java|kt|go|rs|rb|php|pl|lua|r|sql|swift|dart|scala|glsl|wgsl|diff|patch)$/i.test(
		file.name
	);

export const acceptsInterjections = async (chatId: string, messageId: string) => {
	if (!chatId || !messageId) return false;
	try {
		return (await getInterjectionState(localStorage.token, chatId, messageId)).accepting;
	} catch {
		return false;
	}
};

/**
 * Send a message to the running reply. Waits (up to two minutes) for attachments that are
 * still uploading. Returns false when the reply takes no message, so the caller can fall back
 * to Open WebUI's own queue (chats without tools).
 */
export const sendInterjection = async (
	chatId: string,
	messageId: string,
	text: string,
	files: any[]
): Promise<boolean> => {
	if (!chatId || !messageId || !(await acceptsInterjections(chatId, messageId))) return false;
	const end = Date.now() + 120_000;
	while (files.some((f) => f?.status === 'uploading') && Date.now() < end) {
		await new Promise((r) => setTimeout(r, 300));
	}
	if (files.some((f) => ['uploading', 'error'].includes(f?.status))) {
		throw 'An attachment did not finish uploading. Remove it or try again.';
	}
	const usable = files.filter((f) => f && (f.id || f.url || f.path));
	const id = await addInterjection(localStorage.token, chatId, messageId, text, usable.map(fileRef));
	if (!id) return false;
	pendingInterjections.update((all) => ({
		...all,
		[chatId]: [...(all[chatId] ?? []), { id, chatId, messageId, text, files: usable }]
	}));
	return true;
};

export const withdrawInterjection = async (item: PendingInterjection) => {
	const removed = await removeInterjection(localStorage.token, item.chatId, item.messageId, item.id).catch(
		() => false
	);
	if (removed) {
		pendingInterjections.update((all) => ({
			...all,
			[item.chatId]: (all[item.chatId] ?? []).filter((p) => p.id !== item.id)
		}));
		returnedInterjections.update((all) => ({
			...all,
			[item.chatId]: [...(all[item.chatId] ?? []), { ...item, reason: 'withdrawn' }]
		}));
	}
	return removed;
};

/** Delivered ids of one reply, from its output items. */
const deliveredIds = (message: any): Set<string> => {
	const ids = new Set<string>();
	for (const item of message?.output ?? []) {
		for (const entry of item?.interjections ?? []) if (entry?.id) ids.add(entry.id);
	}
	return ids;
};

/** Called whenever the chat history changes: settle what was delivered or came back. */
export const trackInterjections = (chatId: string, history: any) => {
	const pending = get(pendingInterjections)[chatId];
	if (!pending?.length || !history?.messages) return;
	const keep: PendingInterjection[] = [];
	const back: PendingInterjection[] = [];
	for (const item of pending) {
		const message = history.messages[item.messageId];
		if (deliveredIds(message).has(item.id)) continue;
		if (!message || message.done === true) back.push({ ...item, reason: 'not_delivered' });
		else keep.push(item);
	}
	if (keep.length === pending.length) return;
	pendingInterjections.update((all) => ({ ...all, [chatId]: keep }));
	if (back.length) {
		returnedInterjections.update((all) => ({ ...all, [chatId]: [...(all[chatId] ?? []), ...back] }));
	}
};

export const takeReturned = (chatId: string): PendingInterjection[] => {
	const items = get(returnedInterjections)[chatId] ?? [];
	if (items.length) returnedInterjections.update((all) => ({ ...all, [chatId]: [] }));
	return items;
};

export { isImage };
