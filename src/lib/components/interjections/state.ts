// Fork addition (0.3.3, reworked 0.3.5): messages the user sends while an agent reply runs
// ("interjections"). The backend delivers them at the model's next step; this tracks them in the
// browser until they show up in the reply's output, or the reply ends without a next step (then
// they come back to the input box).
//
// 0.3.5 (review C3, C4, C7, C19): the server is the record. It keeps waiting messages through an
// ask_user/approval pause and keeps undelivered ones ("returned") until the browser takes them
// back, so a reload no longer loses them: syncInterjections reads them when a chat opens.
import { get, writable } from 'svelte/store';
import {
	ackReturnedInterjections,
	addInterjection,
	getInterjectionState,
	removeInterjection,
	type InterjectionItem
} from '$lib/apis/interjections';

export type PendingInterjection = {
	id: string;
	chatId: string;
	messageId: string;
	text: string;
	files: any[];
	reason?: 'not_delivered' | 'withdrawn' | 'not_sent';
	/** the server keeps it until acknowledged */
	serverHeld?: boolean;
};

/** Waiting for the model's next step, per chat. */
export const pendingInterjections = writable<Record<string, PendingInterjection[]>>({});
/** Messages that came back because the reply ended first; the input box picks them up. */
export const returnedInterjections = writable<Record<string, PendingInterjection[]>>({});

/** Text of a temporary chat's file is sent along (it was never uploaded); bounded. */
const INLINE_TEXT_LIMIT = 1_000_000;

/** The parts of an attached file the backend needs (never the whole upload record). */
const fileRef = (f: any) => ({
	type: f?.type,
	id: f?.id ?? null,
	name: f?.name ?? f?.file?.meta?.name ?? '',
	content_type: f?.content_type ?? f?.file?.meta?.content_type ?? '',
	...(f?.type === 'filesystem' ? { path: f?.path ?? f?.url ?? f?.id } : {}),
	...(f?.type === 'image' && typeof f?.url === 'string' && f.url.startsWith('data:') ? { url: f.url } : {}),
	// 0.3.5 (review C5): a temporary chat keeps a text file's content in the browser only
	...(f?.type === 'text' && typeof f?.content === 'string'
		? { content: f.content.slice(0, INLINE_TEXT_LIMIT) }
		: {})
});

export const isDirectAttachment = (file: File) =>
	file.type.startsWith('image/') ||
	file.type.startsWith('text/') ||
	/\.(txt|md|markdown|rst|log|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|[cm]?js|tsx?|jsx|svelte|vue|py|pyi|ipynb|sh|bash|zsh|ps1|bat|c|h|cc|cpp|hpp|cs|java|kt|go|rs|rb|php|pl|lua|r|sql|swift|dart|scala|gradle|cmake|mk|glsl|hlsl|wgsl|obj|mtl|diff|patch)$/i.test(
		file.name
	) ||
	/^(dockerfile|makefile)$/i.test(file.name);

export const acceptsInterjections = async (chatId: string, messageId: string) => {
	if (!chatId || !messageId) return false;
	try {
		return (await getInterjectionState(localStorage.token, chatId, messageId)).accepting;
	} catch {
		return false;
	}
};

// The latest history seen per chat, so a new message can be reconciled at once (review C7).
const lastHistory: Record<string, any> = {};

/**
 * Send a message to the running reply. Waits (up to two minutes) for attachments that are
 * still uploading. Returns false when the reply takes no message, so the caller can fall back
 * to Open WebUI's own queue (chats without tools). Throws a readable text when it could not be
 * sent (the caller keeps the message); `checked` skips the accepting check already made.
 */
export const sendInterjection = async (
	chatId: string,
	messageId: string,
	text: string,
	files: any[],
	checked = false
): Promise<boolean> => {
	if (!chatId || !messageId) return false;
	if (!checked && !(await acceptsInterjections(chatId, messageId))) return false;
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
	// The reply may have delivered it or ended while the request was on its way (review C7).
	if (lastHistory[chatId]) trackInterjections(chatId, lastHistory[chatId]);
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
		addReturned(item.chatId, [{ ...item, reason: 'withdrawn' }]);
	}
	return removed;
};

/** Put messages back for the input box; each id once. */
const addReturned = (chatId: string, items: PendingInterjection[]) => {
	if (!items.length) return;
	returnedInterjections.update((all) => {
		const have = new Set((all[chatId] ?? []).map((i) => i.id));
		const fresh = items.filter((i) => !have.has(i.id));
		return fresh.length ? { ...all, [chatId]: [...(all[chatId] ?? []), ...fresh] } : all;
	});
};

/** A message the browser could not send at all (it stays the user's; review C8). */
export const keepUnsent = (chatId: string, text: string, files: any[]) =>
	addReturned(chatId, [
		{ id: `unsent-${Date.now()}`, chatId, messageId: '', text, files, reason: 'not_sent' }
	]);

/** Delivered ids of one reply, from its output items. */
const deliveredIds = (message: any): Set<string> => {
	const ids = new Set<string>();
	for (const item of message?.output ?? []) {
		for (const entry of item?.interjections ?? []) if (entry?.id) ids.add(entry.id);
	}
	return ids;
};

const fromServer = (chatId: string, messageId: string, items: InterjectionItem[] = [], reason?: PendingInterjection['reason']) =>
	items.map((i) => ({
		id: i.id,
		chatId,
		messageId,
		text: i.text ?? '',
		files: i.files ?? [],
		...(reason ? { reason, serverHeld: true } : {})
	}));

/** The reply ended: get back what it did not deliver. The server's list is the record (it also
 * has messages from before a reload); the browser's own copy covers a server that lost it. */
const settle = async (chatId: string, messageId: string, local: PendingInterjection[]) => {
	let returned: PendingInterjection[] = [];
	try {
		const state = await getInterjectionState(localStorage.token, chatId, messageId);
		returned = fromServer(chatId, messageId, state.returned, 'not_delivered');
	} catch {
		/* the server can't say: the browser's copy below */
	}
	const have = new Set(returned.map((i) => i.id));
	addReturned(chatId, [
		...returned,
		...local.filter((i) => !have.has(i.id)).map((i) => ({ ...i, reason: 'not_delivered' as const }))
	]);
};

/** Called whenever the chat history changes: settle what was delivered or came back. */
export const trackInterjections = (chatId: string, history: any) => {
	if (chatId && history) lastHistory[chatId] = history;
	const pending = get(pendingInterjections)[chatId];
	if (!pending?.length || !history?.messages) return;
	const keep: PendingInterjection[] = [];
	const ended = new Map<string, PendingInterjection[]>();
	const delivered = new Map<string, Set<string>>(); // one scan per reply (review C19)
	for (const item of pending) {
		const message = history.messages[item.messageId];
		if (!delivered.has(item.messageId)) delivered.set(item.messageId, deliveredIds(message));
		if (delivered.get(item.messageId)!.has(item.id)) continue;
		if (!message || message.done === true) {
			ended.set(item.messageId, [...(ended.get(item.messageId) ?? []), item]);
		} else keep.push(item);
	}
	if (keep.length === pending.length) return;
	pendingInterjections.update((all) => ({ ...all, [chatId]: keep }));
	for (const [messageId, items] of ended) settle(chatId, messageId, items);
};

const synced = new Set<string>();

/**
 * 0.3.5 (review C3): when a chat opens (also after a reload), read what the server still has for
 * its latest reply: messages waiting for the next step, and messages that came back.
 */
export const syncInterjections = async (chatId: string, history: any) => {
	const messageId = history?.currentId;
	const message = messageId ? history?.messages?.[messageId] : null;
	if (!chatId || !message || message.role !== 'assistant') return;
	const key = `${chatId}:${messageId}`;
	if (synced.has(key)) return;
	synced.add(key);
	let state;
	try {
		state = await getInterjectionState(localStorage.token, chatId, messageId);
	} catch {
		synced.delete(key);
		return;
	}
	if (state.pending?.length) {
		pendingInterjections.update((all) => {
			const have = new Set((all[chatId] ?? []).map((i) => i.id));
			const fresh = fromServer(chatId, messageId, state.pending).filter((i) => !have.has(i.id));
			return fresh.length ? { ...all, [chatId]: [...(all[chatId] ?? []), ...fresh] } : all;
		});
		trackInterjections(chatId, history);
	}
	addReturned(chatId, fromServer(chatId, messageId, state.returned, 'not_delivered'));
};

/** The input box takes them; the server forgets the ones it kept. */
export const takeReturned = (chatId: string): PendingInterjection[] => {
	const items = get(returnedInterjections)[chatId] ?? [];
	if (!items.length) return items;
	returnedInterjections.update((all) => ({ ...all, [chatId]: [] }));
	const byMessage = new Map<string, string[]>();
	for (const item of items) {
		if (item.serverHeld && item.messageId) {
			byMessage.set(item.messageId, [...(byMessage.get(item.messageId) ?? []), item.id]);
		}
	}
	for (const [messageId, ids] of byMessage) {
		ackReturnedInterjections(localStorage.token, chatId, messageId, ids).catch(() => {});
	}
	return items;
};
