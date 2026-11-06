// Fork addition: the model picker's search. Plain text by default. With the search bar's toggle on
// (magic), a model also shows if it matches as a Lua pattern (. %a %d %l %s %u %w %x %p %c %g, % as
// escape, * + ? -, ^ $, [...]). Plain text still counts then, and comes first, because "-" and "."
// are magic and model names are full of them: as a pure pattern gpt-6 would not find gpt-6-luna.
// Case-insensitive; an unfinished pattern means plain text, never an error. Lua has no alternation,
// so neither does this. Port of lstrlib.c's matcher.

export type MatchSpan = { start: number; end: number };
export type ModelMatch = MatchSpan & { field: 'label' | 'value'; plain: boolean };

class Malformed extends Error {}
class TooLong extends Error {}

// Names are short: this only stops a pathological pattern from freezing the page.
const MAX_STEPS = 100000;
const MAX_DEPTH = 200; // MAXCCALLS in lstrlib.c
// One search over all models: about 300 ms at the very worst. A few hundred models with an
// ordinary pattern stay well under it, so it only ever stops pathological patterns.
const MAX_SEARCH_STEPS = 20000000;
type Budget = { steps: number };

const fold = (c: string) => c.toLowerCase();

const inClass = (c: string, cl: string): boolean => {
	const code = c.charCodeAt(0);
	let hit: boolean;
	switch (cl.toLowerCase()) {
		case 'a':
			hit = /[A-Za-z]/.test(c);
			break;
		case 'd':
			hit = /[0-9]/.test(c);
			break;
		case 'l':
			hit = /[a-z]/.test(c);
			break;
		case 'u':
			hit = /[A-Z]/.test(c);
			break;
		case 's':
			hit = /[ \t\n\r\f\v]/.test(c);
			break;
		case 'w':
			hit = /[A-Za-z0-9]/.test(c);
			break;
		case 'x':
			hit = /[0-9A-Fa-f]/.test(c);
			break;
		case 'p':
			hit = code > 32 && code < 127 && !/[A-Za-z0-9]/.test(c);
			break;
		case 'c':
			hit = code < 32 || code === 127;
			break;
		case 'g':
			hit = code > 32 && code < 127;
			break;
		default:
			return fold(cl) === fold(c); // %. %- %%: the character itself
	}
	return cl === cl.toUpperCase() ? !hit : hit; // %A = not a letter
};

const inSet = (c: string, p: string, start: number, close: number): boolean => {
	let pi = start + 1;
	let sig = true;
	if (p[pi] === '^') {
		sig = false;
		pi++;
	}
	while (pi < close) {
		if (p[pi] === '%') {
			if (inClass(c, p[pi + 1])) return sig;
			pi += 2;
		} else if (p[pi + 1] === '-' && pi + 2 < close) {
			const f = fold(c);
			const lo = fold(p[pi]);
			const hi = fold(p[pi + 2]);
			if (lo <= f && f <= hi) return sig;
			pi += 3;
		} else {
			if (fold(p[pi]) === fold(c)) return sig;
			pi++;
		}
	}
	return !sig;
};

const itemEnd = (p: string, start: number): number => {
	let pi = start;
	const c = p[pi++];
	if (c === '%') {
		if (pi >= p.length) throw new Malformed();
		if ('bf0123456789'.includes(p[pi])) throw new Malformed(); // not offered
		return pi + 1;
	}
	if (c === '[') {
		if (p[pi] === '^') pi++;
		do {
			if (pi >= p.length) throw new Malformed();
			const cc = p[pi++];
			if (cc === '%') {
				if (pi >= p.length) throw new Malformed();
				pi++;
			}
		} while (p[pi] !== ']');
		return pi + 1;
	}
	return pi;
};

const compile = (p: string) => {
	let depth = 0;
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		if (c === '%') {
			i++;
		} else if (c === '[') {
			i = itemEnd(p, i) - 1;
		} else if (c === '(') {
			depth++;
		} else if (c === ')') {
			if (--depth < 0) throw new Malformed();
		}
	}
	if (depth !== 0) throw new Malformed();
	if (p.endsWith('%') && !p.endsWith('%%')) throw new Malformed();
};

const luaFind = (text: string, pattern: string, budget: Budget): MatchSpan | null => {
	const anchored = pattern[0] === '^';
	const pstart = anchored ? 1 : 0;
	let steps = 0;
	let depth = 0;

	const single = (si: number, pi: number, ep: number) => {
		if (si >= text.length) return false;
		const c = text[si];
		switch (pattern[pi]) {
			case '.':
				return true;
			case '%':
				return inClass(c, pattern[pi + 1]);
			case '[':
				return inSet(c, pattern, pi, ep - 1);
			default:
				return fold(pattern[pi]) === fold(c);
		}
	};

	const maxExpand = (si: number, pi: number, ep: number): number => {
		let n = 0;
		while (single(si + n, pi, ep)) n++;
		for (; n >= 0; n--) {
			const r = match(si + n, ep + 1);
			if (r !== -1) return r;
		}
		return -1;
	};

	const minExpand = (start: number, pi: number, ep: number): number => {
		let si = start;
		for (;;) {
			const r = match(si, ep + 1);
			if (r !== -1) return r;
			if (single(si, pi, ep)) si++;
			else return -1;
		}
	};

	const match = (startSi: number, startPi: number): number => {
		if (++depth > MAX_DEPTH) throw new TooLong();
		try {
			return matchHere(startSi, startPi);
		} finally {
			depth--;
		}
	};

	const matchHere = (startSi: number, startPi: number): number => {
		let si = startSi;
		let pi = startPi;
		for (;;) {
			if (++steps > MAX_STEPS || --budget.steps < 0) throw new TooLong();
			if (pi >= pattern.length) return si;
			const c = pattern[pi];
			if (c === '(' || c === ')') {
				pi++; // groups capture nothing here
				continue;
			}
			if (c === '$' && pi + 1 === pattern.length) return si === text.length ? si : -1;
			const ep = itemEnd(pattern, pi);
			const next = pattern[ep];
			if (next === '?') {
				if (single(si, pi, ep)) {
					const r = match(si + 1, ep + 1);
					if (r !== -1) return r;
				}
				pi = ep + 1;
				continue;
			}
			if (next === '+') return single(si, pi, ep) ? maxExpand(si + 1, pi, ep) : -1;
			if (next === '*') return maxExpand(si, pi, ep);
			if (next === '-') return minExpand(si, pi, ep);
			if (!single(si, pi, ep)) return -1;
			si++;
			pi = ep;
		}
	};

	for (let start = 0; start <= text.length; start++) {
		const end = match(start, pstart);
		// An empty match says nothing: "a-" would otherwise show every model.
		if (end > start) return { start, end };
		if (anchored) break;
	}
	return null;
};

/** The first match of a Lua pattern, or null; null too for a pattern that isn't finished. */
export const findPattern = (
	text: string,
	pattern: string,
	budget: Budget = { steps: MAX_SEARCH_STEPS }
): MatchSpan | null => {
	try {
		compile(pattern);
		return luaFind(text, pattern, budget);
	} catch (e) {
		if (e instanceof Malformed || e instanceof TooLong) return null;
		throw e;
	}
};

export const findPlain = (text: string, query: string): MatchSpan | null => {
	const start = text.toLowerCase().indexOf(query.toLowerCase());
	return start < 0 ? null : { start, end: start + query.length };
};

/** How a model matches the search: plain text before pattern, its display name before its id. */
export const matchModel = (
	label: string,
	value: string,
	query: string,
	magic = false,
	budget: Budget = { steps: MAX_SEARCH_STEPS }
): ModelMatch | null => {
	const q = query.trim();
	if (!q) return null;
	const finders: [(text: string, query: string) => MatchSpan | null, boolean][] = [
		[findPlain, true]
	];
	if (magic) finders.push([(text, p) => findPattern(text, p, budget), false]);
	for (const [find, plain] of finders) {
		for (const [field, text] of [
			['label', label],
			['value', value]
		] as const) {
			const span = find(text, q);
			if (span) return { ...span, field, plain };
		}
	}
	return null;
};

/** The items that match, plain-text matches first; the list's order otherwise. */
export const searchItems = <T extends { label: string; value: string }>(
	items: T[],
	query: string,
	magic = false
) => {
	const budget = { steps: MAX_SEARCH_STEPS }; // shared: many models can't add up to a freeze
	const hits = items.flatMap((item) => {
		const match = matchModel(item.label ?? '', item.value ?? '', query, magic, budget);
		return match ? [{ ...item, match }] : [];
	});
	return [...hits.filter((h) => h.match.plain), ...hits.filter((h) => !h.match.plain)];
};
