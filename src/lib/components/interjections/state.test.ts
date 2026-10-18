// Fork 0.3.3: the browser side of interjections.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	keepUnsent,
	syncInterjections,
	isDirectAttachment,
	pendingInterjections,
	returnedInterjections,
	sendInterjection,
	takeReturned,
	trackInterjections,
	withdrawInterjection
} from './state';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	pendingInterjections.set({});
	returnedInterjections.set({});
	(globalThis as any).localStorage = { token: 't' };
});

describe('sending', () => {
	it('falls back (false) when the reply takes no message, without posting', async () => {
		const fetch = vi.fn(async () => json({ accepting: false, pending: [] }));
		vi.stubGlobal('fetch', fetch);
		expect(await sendInterjection('c', 'm', 'hi', [])).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('posts text and file references, and tracks it as pending', async () => {
		const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
			init?.method === 'POST' ? json({ id: 'i1' }) : json({ accepting: true, pending: [] })
		);
		vi.stubGlobal('fetch', fetch);
		const file = { type: 'file', id: 'f1', name: 'a.png', status: 'uploaded', content_type: 'image/png', file: { big: 'x'.repeat(100) } };
		expect(await sendInterjection('c', 'm', 'look', [file])).toBe(true);
		const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
		expect(body).toEqual({ text: 'look', files: [{ type: 'file', id: 'f1', name: 'a.png', content_type: 'image/png' }] });
		expect(get(pendingInterjections).c.map((p) => p.id)).toEqual(['i1']);
	});

	it('a 409 on post (the reply just finished) falls back', async () => {
		vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) =>
			init?.method === 'POST' ? json({ detail: 'x' }, 409) : json({ accepting: true, pending: [] })));
		expect(await sendInterjection('c', 'm', 'hi', [])).toBe(false);
	});
});

describe('tracking', () => {
	const pending = (id: string) => ({ id, chatId: 'c', messageId: 'm', text: `t-${id}`, files: [] });

	it('drops what the reply shows as delivered; returns the rest when the reply is done', async () => {
		pendingInterjections.set({ c: [pending('a'), pending('b')] });
		const history = { messages: { m: { done: false, output: [{ interjections: [{ id: 'a' }] }] } } };
		trackInterjections('c', history);
		expect(get(pendingInterjections).c.map((p) => p.id)).toEqual(['b']);
		expect(takeReturned('c')).toEqual([]);
		history.messages.m.done = true;
		// the server lost its copy (restart): the browser's own copy comes back
		vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'x' }, 500)));
		trackInterjections('c', history);
		expect(get(pendingInterjections).c).toEqual([]);
		await vi.waitFor(() => expect(get(returnedInterjections).c?.length).toBe(1));
		const back = takeReturned('c');
		expect(back.map((p) => [p.id, p.reason])).toEqual([['b', 'not_delivered']]);
		expect(takeReturned('c')).toEqual([]);
	});

	it('a withdrawn message comes back as withdrawn', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => json({ removed: true })));
		pendingInterjections.set({ c: [pending('a')] });
		expect(await withdrawInterjection(pending('a'))).toBe(true);
		expect(takeReturned('c').map((p) => p.reason)).toEqual(['withdrawn']);
	});
});

it('images and text files go to the model directly; other documents do not', () => {
	const f = (name: string, type = '') => new File(['x'], name, { type });
	expect(isDirectAttachment(f('shot.png', 'image/png'))).toBe(true);
	expect(isDirectAttachment(f('main.py'))).toBe(true);
	expect(isDirectAttachment(f('notes.md'))).toBe(true);
	expect(isDirectAttachment(f('report.pdf', 'application/pdf'))).toBe(false);
	expect(isDirectAttachment(f('book.docx'))).toBe(false);
});

// fork 0.3.5: review findings C3, C5, C7, C8, C10, C19
describe('0.3.5', () => {
	const pending = (id: string) => ({ id, chatId: 'c', messageId: 'm', text: `t-${id}`, files: [] });

	it('C3: after a reload the server\'s waiting and returned messages come back', async () => {
		const calls: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? 'GET'} ${u}`);
			if (u.endsWith('/returned/ack')) return json({ acknowledged: 1 });
			return json({ accepting: true, pending: [{ id: 'p1', text: 'wait', files: [] }],
				returned: [{ id: 'r1', text: 'back', files: [] }] });
		}));
		const history = { currentId: 'm', messages: { m: { role: 'assistant', done: false, output: [] } } };
		await syncInterjections('c2', history);
		expect(get(pendingInterjections).c2.map((p) => p.id)).toEqual(['p1']);
		const back = takeReturned('c2');
		expect(back.map((p) => [p.id, p.reason, p.serverHeld])).toEqual([['r1', 'not_delivered', true]]);
		await vi.waitFor(() => expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/m/returned/ack'))).toBe(true));
		await syncInterjections('c2', history); // once per reply
		expect(calls.filter((c) => c.startsWith('GET')).length).toBe(1);
	});

	it('C3: a reply that ended gets back what the server kept, each message once', async () => {
		vi.stubGlobal('fetch', vi.fn(async () =>
			json({ accepting: false, pending: [], returned: [{ id: 'b', text: 't-b', files: [] }] })));
		pendingInterjections.set({ c: [pending('b')] });
		trackInterjections('c', { messages: { m: { done: true, output: [] } } });
		await vi.waitFor(() => expect(get(returnedInterjections).c?.length).toBe(1));
		expect(takeReturned('c')[0].serverHeld).toBe(true);
	});

	it('C7: a message the reply delivered before the POST answered is settled at once', async () => {
		vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) =>
			init?.method === 'POST' ? json({ id: 'x1' }) : json({ accepting: true, pending: [] })));
		trackInterjections('c3', { messages: { m: { done: false, output: [{ interjections: [{ id: 'x1' }] }] } } });
		expect(await sendInterjection('c3', 'm', 'hi', [])).toBe(true);
		expect(get(pendingInterjections).c3).toEqual([]);
	});

	it('C5: a temporary chat\'s text file is sent with its text', async () => {
		const fetch = vi.fn(async (_u: string, init?: RequestInit) =>
			init?.method === 'POST' ? json({ id: 'i' }) : json({ accepting: true, pending: [] }));
		vi.stubGlobal('fetch', fetch);
		const file = { type: 'text', id: 'tmp-uuid', name: 'note.txt', status: 'uploaded', content: 'hello' };
		await sendInterjection('c4', 'm', '', [file]);
		const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
		expect(body.files[0]).toMatchObject({ type: 'text', name: 'note.txt', content: 'hello' });
	});

	it('C10: a full queue is an error the caller shows, not a silent fallback', async () => {
		vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) =>
			init?.method === 'POST' ? json({ detail: '20 messages are already waiting' }, 429) : json({ accepting: true, pending: [] })));
		await expect(sendInterjection('c', 'm', 'hi', [])).rejects.toContain('already waiting');
	});

	it('C8: a message that could not be sent comes back to the input as not sent', () => {
		keepUnsent('c5', 'draft', []);
		expect(takeReturned('c5').map((p) => [p.text, p.reason])).toEqual([['draft', 'not_sent']]);
	});

	it('C19: one scan of the reply however many messages wait', () => {
		let reads = 0;
		const output = Array.from({ length: 1000 }, () => ({ get interjections() { reads++; return []; } }));
		pendingInterjections.set({ c6: Array.from({ length: 20 }, (_, i) => ({ ...pending(`p${i}`), chatId: 'c6' })) });
		trackInterjections('c6', { messages: { m: { done: false, output } } });
		expect(reads).toBe(1000);
	});
});
