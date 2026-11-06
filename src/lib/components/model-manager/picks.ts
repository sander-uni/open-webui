// Fork addition: the chat model picker's account-wide lists and how models are grouped.
// Favourites and recents are kept per account on the server so PC and iPad match. Favourites are
// their own list: "Keep in Sidebar" (pinnedModels) is a separate thing and stays as it is.
import { get, writable } from 'svelte/store';
import { toast } from 'svelte-sonner';
import { user } from '$lib/stores';
import { updateModelPicks, type ModelPicks } from '$lib/apis/model-manager';
import { managedId, type ManagerState } from './state';

export const RECENT_SHOWN = 5;
const RECENT_KEPT = 40; // enough for 5 non-favourites after stars and removed models

export const nextRecents = (recents: string[], used: string[]) =>
	[...used.filter(Boolean), ...recents.filter((id) => !used.includes(id))].slice(0, RECENT_KEPT);

export const nextFavorites = (favorites: string[], id: string) =>
	favorites.includes(id) ? favorites.filter((x) => x !== id) : [...favorites, id];

/** Favourites in the order they were starred, then 5 recents that aren't favourites. Models that
 * no longer exist drop out quietly. */
export const quickPicks = <T extends { value: string }>(
	items: T[],
	favorites: string[],
	recents: string[]
) => {
	const byId = new Map(items.map((item) => [item.value, item]));
	const take = (ids: string[], section: 'favorites' | 'recent') =>
		ids.flatMap((id) => {
			const item = byId.get(id);
			return item ? [{ ...item, section }] : [];
		});
	const stars = take(favorites, 'favorites');
	const starred = new Set(favorites);
	const recent = take(
		recents.filter((id) => !starred.has(id)),
		'recent'
	).slice(0, RECENT_SHOWN);
	return [...stars, ...recent];
};

/** What the picker shows. Saved per account on the server, not in the user's settings. */
export const modelPicks = writable<ModelPicks>({ favoriteModels: [], recentModels: [] });

const EMPTY: ModelPicks = { favoriteModels: [], recentModels: [] };
let confirmed = EMPTY; // the server's last answer
let pending = 0;
let queue: Promise<unknown> = Promise.resolve();

// Another account in this tab: nothing queued or answered for the last one carries over.
let account: string | null | undefined;
let session = 0;
user.subscribe((u: any) => {
	const id = u?.id ?? null;
	if (id === account) return;
	account = id;
	session++;
	pending = 0;
	queue = Promise.resolve(); // a request stuck for the last account must not hold up this one
	confirmed = EMPTY;
	modelPicks.set(EMPTY);
});

// One at a time, and the display follows the server only once nothing is on its way: an earlier
// answer would hide a later star for a moment. A change that could not be saved disappears again.
const send = (change: Parameters<typeof updateModelPicks>[1], loud = false) => {
	const mine = session;
	const token = localStorage.token;
	pending++;
	const run = async () => {
		if (mine !== session) return;
		let answer: ModelPicks | null = null;
		try {
			answer = await updateModelPicks(token, change);
		} catch (error) {
			console.error(error);
			if (loud && mine === session) toast.error(String(error));
			answer = await updateModelPicks(token).catch(() => null);
		}
		if (mine !== session) return;
		if (answer) confirmed = answer;
		if (--pending === 0) modelPicks.set(confirmed);
	};
	queue = queue.then(run);
	return queue;
};

/** Shows at once; the server's answer then decides. */
export const toggleFavorite = (id: string) => {
	const current = get(modelPicks).favoriteModels;
	const on = !current.includes(id);
	modelPicks.update((p) => ({ ...p, favoriteModels: nextFavorites(current, id) }));
	return send({ favorite: { id, on } }, true);
};

/** A message was sent with these models. A failure here stays quiet: the chat matters, not this. */
export const recordModelUse = (ids: string[]) => {
	const used = [...new Set(ids.filter(Boolean))];
	if (!used.length) return;
	modelPicks.update((p) => ({ ...p, recentModels: nextRecents(p.recentModels, used) }));
	return send({ used });
};

/** At page load and when the picker opens: picks up what another device changed. */
export const refreshPicks = () => send({});

export const GROUPS = [
	{ key: 'ninfer', label: 'ninfer', open: true },
	{ key: 'strata', label: 'Strata', open: true },
	{ key: 'ollama', label: 'Ollama', open: true },
	{ key: 'chatgpt', label: 'ChatGPT', open: true },
	{ key: 'cloud', label: 'Cloud', open: false },
	{ key: 'presets', label: 'Presets', open: true }
] as const;

export type GroupKey = (typeof GROUPS)[number]['key'];

export const isPreset = (item: any) => !!item?.model?.info?.base_model_id;

/** "__" in a preset's display name marks it experimental; the rule is the name, nothing else. */
export const isExperimental = (item: any) =>
	isPreset(item) && String(item?.label ?? '').startsWith('__');

export const groupOf = (item: any, state: ManagerState | null): GroupKey => {
	if (isPreset(item)) return 'presets';
	const id = managedId(item?.model, state);
	const engine = id ? state?.ux?.models?.[id]?.engine : null;
	if (engine === 'ninfer' || engine === 'strata' || engine === 'ollama') return engine;
	if (String(item?.value ?? '').startsWith('codex/')) return 'chatgpt';
	return 'cloud';
};

export const groupLabel = (key: GroupKey) => GROUPS.find((g) => g.key === key)?.label ?? key;

// This device's own view of the window: which groups are open, the experimental switch, the size.
const read = (key: string) => {
	try {
		return JSON.parse(localStorage.getItem(key) ?? 'null');
	} catch {
		return null;
	}
};
const write = (key: string, value: unknown) => {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// private window or full storage: the window works, it just forgets
	}
};

const OPEN_KEY = 'modelBrowser.groups';
const EXPERIMENTAL_KEY = 'modelBrowser.experimental';
const SIZE_KEY = 'modelBrowser.size';
const MAGIC_KEY = 'modelBrowser.magic';

/** The search bar's toggle for Lua magic characters: off until turned on, in both search bars. */
export const magicSearch = writable<boolean>(
	typeof localStorage !== 'undefined' && read(MAGIC_KEY) === true
);
export const setMagicSearch = (on: boolean) => {
	magicSearch.set(on);
	write(MAGIC_KEY, on);
};

export const loadOpenGroups = (): Record<string, boolean> => {
	const saved = read(OPEN_KEY);
	return Object.fromEntries(
		GROUPS.map((g) => [g.key, typeof saved?.[g.key] === 'boolean' ? saved[g.key] : g.open])
	);
};
export const saveOpenGroups = (open: Record<string, boolean>) => write(OPEN_KEY, open);
export const experimentalShown = writable<boolean>(
	typeof localStorage !== 'undefined' && read(EXPERIMENTAL_KEY) === true
);
export const setExperimentalShown = (on: boolean) => {
	experimentalShown.set(on);
	write(EXPERIMENTAL_KEY, on);
};
export const loadSize = (): { w: number; h: number } | null => {
	const saved = read(SIZE_KEY);
	return Number.isFinite(saved?.w) && Number.isFinite(saved?.h) ? { w: saved.w, h: saved.h } : null;
};
export const saveSize = (size: { w: number; h: number }) => write(SIZE_KEY, size);
