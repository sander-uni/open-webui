// Fork 0.3.3: the browser side of interjections.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
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

	it('drops what the reply shows as delivered; returns the rest when the reply is done', () => {
		pendingInterjections.set({ c: [pending('a'), pending('b')] });
		const history = { messages: { m: { done: false, output: [{ interjections: [{ id: 'a' }] }] } } };
		trackInterjections('c', history);
		expect(get(pendingInterjections).c.map((p) => p.id)).toEqual(['b']);
		expect(takeReturned('c')).toEqual([]);
		history.messages.m.done = true;
		trackInterjections('c', history);
		expect(get(pendingInterjections).c).toEqual([]);
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
