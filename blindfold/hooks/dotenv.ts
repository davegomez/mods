/** The env-file dialect of the `dotenv` npm package, version 16. Pure: no imports, no I/O. */

export type Entry = { name: string; value: string; start: number; end: number };
export type Parsed = {
	entries: Entry[];
	badLines: number[];
	duplicates: string[];
};

export const MAX_FILE_CHARS = 1_048_576;

/**
 * dotenv 16.6.1's `LINE` pattern, with capture groups added for spans
 * (1 export, 2 name, 3 separator, 4 value) and sticky instead of global.
 */
const LINE =
	/^\s*(export\s+)?([\w.-]+)(\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/dmy;
const WHITESPACE = /\s*/y;
/** Where `^` matches under the `m` flag, once `\r` is gone. */
const LINE_BREAK = /[\n\u2028\u2029]/g;

type Match = Entry & {
	nameStart: number;
	matchStart: number;
	matchEnd: number;
};

/** dotenv turns every `\r\n` and lone `\r` into `\n`. Returns the text and where each removed `\r` was. */
function normalize(text: string): { text: string; removed: number[] } {
	const removed: number[] = [];
	const out = text.replace(/\r\n?/g, (crlf, offset: number) => {
		if (crlf.length === 2) removed.push(offset - removed.length);
		return "\n";
	});
	return { text: out, removed };
}

/** The original index of a normalized index. */
function original(index: number, removed: number[]): number {
	let low = 0;
	let high = removed.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (removed[mid] < index) low = mid + 1;
		else high = mid;
	}
	return index + low;
}

/** The first line start after the line break at or after `index`, or -1. */
function nextLineStart(text: string, index: number): number {
	LINE_BREAK.lastIndex = index;
	return LINE_BREAK.exec(text) ? LINE_BREAK.lastIndex : -1;
}

/** dotenv's value cleanup: trim, drop matching outer quotes, expand `\n` and `\r` in double quotes. */
function clean(raw: string): string {
	const value = raw.trim();
	const unquoted = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
	return value[0] === '"'
		? unquoted.replace(/\\n/g, "\n").replace(/\\r/g, "\r")
		: unquoted;
}

/**
 * The matches dotenv's global regex finds, in order. When a try at a line start
 * fails, each later line start inside the same leading whitespace fails too
 * (its `\s*` has fewer choices), so it is skipped. That keeps blank lines linear
 * where dotenv itself is quadratic.
 */
function matches(text: string): Match[] {
	const found: Match[] = [];
	let at = 0;
	while (at >= 0 && at <= text.length) {
		LINE.lastIndex = at;
		const m = LINE.exec(text);
		if (m?.indices) {
			const { indices } = m;
			const end = m.index + m[0].length;
			found.push({
				name: m[2],
				value: clean(m[4] ?? ""),
				start: (indices[1] ?? indices[2])[0],
				nameStart: indices[2][0],
				end: m[4] ? indices[4][0] + m[4].trimEnd().length : indices[3][1],
				matchStart: m.index,
				matchEnd: end,
			});
			at = /[\n\u2028\u2029]/.test(text[end - 1] ?? "")
				? end
				: nextLineStart(text, end);
		} else {
			WHITESPACE.lastIndex = at;
			WHITESPACE.exec(text);
			at = nextLineStart(text, WHITESPACE.lastIndex);
		}
	}
	return found;
}

/** 1-based numbers of lines with text outside every match that is not a comment. */
function badLines(text: string, found: Match[]): number[] {
	let rest = "";
	let at = 0;
	for (const m of found) {
		rest +=
			text.slice(at, m.matchStart) +
			text.slice(m.matchStart, m.matchEnd).replace(/[^\n]/g, " ");
		at = m.matchEnd;
	}
	rest += text.slice(at);
	const bad: number[] = [];
	rest.split("\n").forEach((line, i) => {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith("#")) bad.push(i + 1);
	});
	return bad;
}

/** Entries with spans in the original text, plus the name starts `setValue` needs. */
function scan(text: string): { parsed: Parsed; nameStarts: number[] } {
	const normal = normalize(text);
	const found = matches(normal.text);
	const at = (i: number) => original(i, normal.removed);
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const { name } of found) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return {
		parsed: {
			entries: found.map(({ name, value, start, end }) => ({
				name,
				value,
				start: at(start),
				end: at(end),
			})),
			badLines: badLines(normal.text, found),
			duplicates: [...duplicates],
		},
		nameStarts: found.map((m) => at(m.nameStart)),
	};
}

export function parse(text: string): Parsed | { tooLarge: true } {
	return text.length > MAX_FILE_CHARS ? { tooLarge: true } : scan(text).parsed;
}

export type SetResult =
	| { ok: true; text: string }
	| {
			ok: false;
			reason: "bad-name" | "unsafe-value" | "duplicate-name" | "too-large";
	  };

const fail = (
	reason: Extract<SetResult, { ok: false }>["reason"],
): SetResult => ({
	ok: false,
	reason,
});

export function isValidName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name);
}

/** R5: the one form that holds the value, or undefined. */
function serialize(name: string, value: string): string | undefined {
	// Any control character (Unicode Cc) except tab and newline.
	if (value === "" || /[^\P{Cc}\t\n]/u.test(value)) return undefined;
	if (!/['\n]/.test(value)) return `${name}='${value}'`;
	if (!/["\\$`]/.test(value)) {
		return `${name}="${value.replaceAll("\n", "\\n")}"`;
	}
	return undefined;
}

export function setValue(text: string, name: string, value: string): SetResult {
	if (text.length > MAX_FILE_CHARS) return fail("too-large");
	if (!isValidName(name)) return fail("bad-name");
	const entry = serialize(name, value);
	if (entry === undefined) return fail("unsafe-value");
	const { parsed, nameStarts } = scan(text);
	if (parsed.duplicates.includes(name)) return fail("duplicate-name");

	const at = parsed.entries.findIndex((e) => e.name === name);
	const expected = parsed.entries.map((e) => [
		e.name,
		e.name === name ? value : e.value,
	]);
	let next: string;
	if (at >= 0) {
		next =
			text.slice(0, nameStarts[at]) +
			entry +
			text.slice(parsed.entries[at].end);
	} else {
		const eol = /\r\n|\n|\r/.exec(text)?.[0] === "\r\n" ? "\r\n" : "\n";
		const gap = text === "" || /[\r\n]$/.test(text) ? "" : eol;
		next = text + gap + entry + eol;
		expected.push([name, value]);
	}

	// R7: dotenv must read back the new value and every other value unchanged.
	const after = parse(next);
	if ("tooLarge" in after) return fail("too-large");
	const same =
		after.entries.length === expected.length &&
		after.entries.every(
			(e, i) => e.name === expected[i][0] && e.value === expected[i][1],
		);
	return same ? { ok: true, text: next } : fail("unsafe-value");
}
