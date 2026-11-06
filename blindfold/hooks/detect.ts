export const VENDOR_IDS = [
	"github",
	"stripe",
	"anthropic",
	"openai",
	"slack",
	"aws",
	"google",
	"npm",
	"jwt",
] as const;
export const CONTEXT_IDS = ["assign", "auth-header", "url-userinfo"] as const;

export type RuleId =
	| "private-key"
	| `vendor:${(typeof VENDOR_IDS)[number]}`
	| `context:${(typeof CONTEXT_IDS)[number]}`;
export type Known = { name: string; value: string };
export type Hit =
	| { kind: "known"; name: string }
	| { kind: "rule"; rule: RuleId };
export type Limits = { maxChars: number; maxDepth: number; maxNodes: number };
export type Clock = { now: () => number; deadline: number };
export type Unscannable = {
	status: "unscannable";
	reason:
		| "too-large"
		| "too-deep"
		| "too-many-nodes"
		| "unsupported"
		| "cycle"
		| "deadline";
};
export type Scan<T> =
	| { status: "clean" }
	| { status: "found"; value: T; hits: Hit[] }
	| Unscannable;

type Form = { text: string; name: string };
/** Opaque: built by `buildKnownSet`, read only by the scans. Forms by their first `HEAD` characters, longest first. */
export type KnownSet = {
	readonly heads: ReadonlyMap<string, readonly Form[]>;
	/** R1: finds the exact markers, `[secret: NAME]` only for a NAME in this set. */
	readonly markers: Rule;
};

export const DEFAULT_LIMITS: Limits = {
	maxChars: 2_097_152,
	maxDepth: 64,
	maxNodes: 50_000,
};
/** Q14: a shorter value matches normal text. Every form of a value this long has at least this many characters. */
export const MIN_KNOWN_LENGTH = 8;
const HEAD = MIN_KNOWN_LENGTH;

/** The text that replaces a hit. It never holds the value. */
export function marker(hit: Hit): string {
	return hit.kind === "known" ? `[secret: ${hit.name}]` : "[secret hidden]";
}

/** The base64 characters of `bytes` that do not depend on the bytes around them, after `align` prefix bytes. */
function base64Core(bytes: Uint8Array, align: number): string {
	const binary = Array.from(
		[...new Array<number>(align).fill(0), ...bytes],
		(b) => String.fromCharCode(b),
	).join("");
	const first = Math.ceil((align * 8) / 6);
	const last = Math.floor(((align + bytes.length) * 8) / 6);
	return btoa(binary).slice(first, last);
}

/** R2: every form of a value that a scan looks for, without repeats. */
export function knownForms(value: string): string[] {
	const bytes = new TextEncoder().encode(value);
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	const forms = [
		value,
		JSON.stringify(value).slice(1, -1),
		hex,
		hex.toUpperCase(),
	];
	try {
		forms.push(encodeURIComponent(value));
	} catch {
		// A lone surrogate has no URL form.
	}
	for (const align of [0, 1, 2]) {
		const core = base64Core(bytes, align);
		forms.push(core, core.replaceAll("+", "-").replaceAll("/", "_"));
	}
	return [...new Set(forms)];
}

const byName = (a: Known, b: Known) =>
	a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export function buildKnownSet(known: Known[]): {
	set: KnownSet;
	skipped: { name: string; reason: "too-short" }[];
} {
	const skipped: { name: string; reason: "too-short" }[] = [];
	const owner = new Map<string, string>();
	for (const { name, value } of [...known].sort(byName)) {
		if (value.length < MIN_KNOWN_LENGTH) {
			skipped.push({ name, reason: "too-short" });
			continue;
		}
		for (const form of knownForms(value)) {
			if (!owner.has(form)) owner.set(form, name);
		}
	}
	const heads = new Map<string, Form[]>();
	for (const [text, name] of owner) {
		const head = text.slice(0, HEAD);
		const list = heads.get(head) ?? [];
		list.push({ text, name });
		heads.set(head, list);
	}
	for (const list of heads.values()) {
		list.sort((a, b) => b.text.length - a.text.length);
	}
	const markers = markerRule(new Set(owner.values()));
	return { set: { heads, markers }, skipped };
}

type Span = { start: number; end: number; hit: Hit };
type Range = readonly [start: number, end: number];
/** What a match comes to: a range to hide, or nothing, or the index where the search goes on. */
type Found = Range | { resume: number } | undefined;
/** A regex rule. `span` gets a match that starts at text index `at`. */
type Rule = {
	re: RegExp;
	/** The longest text a match covers, so a window that holds a match's start holds all of it. */
	maxLen: number;
	span: (m: RegExpExecArray, at: number, text: string) => Found;
};

/** R8: the clock is read before each window of this many characters. */
const WINDOW = 65_536;
/** R9: the bound for a token body with no published length. A longer body is hidden up to this length. */
const CAP = 4096;

const expired = (clock: Clock) => clock.now() >= clock.deadline;
const unscannable = (reason: Unscannable["reason"]): Unscannable => ({
	status: "unscannable",
	reason,
});
const whole = (m: RegExpExecArray, at: number): Range => [at, at + m[0].length];
/** R5: a word boundary, or the end of a JSON or C escape `\n`, `\r`, `\t`. */
const B = String.raw`(?:\b|(?<=\\[nrt]))`;
const vendor = (source: string, maxLen: number): Rule => ({
	re: new RegExp(B + source, "g"),
	maxLen,
	span: whole,
});

/** R1: a candidate with a NAME not in the set is normal text; the search goes on inside it, so a nested exact marker is found. */
function markerRule(names: ReadonlySet<string>): Rule {
	return {
		re: /\[secret(?:: ([^\]\r\n]{1,256})| hidden)\]/g,
		maxLen: 266,
		span: (m, at) =>
			m[1] === undefined || names.has(m[1]) ? whole(m, at) : { resume: at + 1 },
	};
}

const PRIVATE_KEY: Rule = {
	re: /-----BEGIN ([A-Z0-9 ]{0,64})PRIVATE KEY-----/g,
	maxLen: 91,
	span: (m, at, text) => {
		const endLine = `-----END ${m[1]}PRIVATE KEY-----`;
		const end = text.indexOf(endLine, at + m[0].length);
		return [at, end === -1 ? text.length : end + endLine.length];
	},
};

/**
 * R5, with the shapes checked against vendor documentation. `ghs_` also takes GitHub's
 * stateless installation token (`ghs_<app id>_<JWT>`). The JWT rule matches the first
 * segment alone when the rest is missing, so a failed start never rescans its run (R9).
 */
const VENDOR: [(typeof VENDOR_IDS)[number], Rule][] = [
	[
		"github",
		vendor(
			`(?:ghs_[A-Za-z0-9._-]{36,${CAP}}|gh[pousr]_[A-Za-z0-9]{36,${CAP}}|github_pat_[A-Za-z0-9_]{22,${CAP}})`,
			11 + CAP,
		),
	],
	["stripe", vendor(`[rs]k_(?:live|test)_[A-Za-z0-9]{16,${CAP}}`, 8 + CAP)],
	["anthropic", vendor(`sk-ant-[A-Za-z0-9_-]{20,${CAP}}`, 7 + CAP)],
	["openai", vendor(`sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,${CAP}}`, 8 + CAP)],
	["slack", vendor(`(?:xox[bp]|xoxe-1|xapp)-[A-Za-z0-9-]{10,${CAP}}`, 7 + CAP)],
	["aws", vendor(`(?:AKIA|ASIA)[0-9A-Z]{16}`, 20)],
	["google", vendor(`AIza[0-9A-Za-z_-]{35}`, 39)],
	["npm", vendor(`npm_[A-Za-z0-9]{36}`, 40)],
	[
		"jwt",
		{
			re: new RegExp(
				String.raw`${B}eyJ[A-Za-z0-9_-]{10,${CAP}}(\.eyJ[A-Za-z0-9_-]{10,${CAP}}\.[A-Za-z0-9_-]{10,${CAP}})?`,
				"g",
			),
			maxLen: 3 * CAP + 8,
			span: (m, at) => (m[1] === undefined ? undefined : whole(m, at)),
		},
	],
];

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
	const counts = new Map<string, number>();
	let total = 0;
	for (const c of text) {
		counts.set(c, (counts.get(c) ?? 0) + 1);
		total++;
	}
	let bits = 0;
	for (const n of counts.values()) bits -= (n / total) * Math.log2(n / total);
	return bits;
}

const PLACEHOLDER_WORD = /your|example|changeme|placeholder|dummy|redacted/i;

/** R6: not a placeholder, and at least 3 bits per character. A run of `x` or `*` has 0 bits; a marker is dropped by `onMarker`. */
export function isSecretValue(value: string): boolean {
	const wrapped = (open: string, close: string) =>
		value.startsWith(open) && value.endsWith(close);
	const placeholder =
		wrapped("<", ">") ||
		wrapped("${", "}") ||
		wrapped("{{", "}}") ||
		value.startsWith("process.env.") ||
		value.startsWith("os.environ") ||
		PLACEHOLDER_WORD.test(value);
	return !placeholder && entropy(value) >= 3;
}

const secretBefore = (value: string, end: number): Range | undefined =>
	isSecretValue(value) ? [end - value.length, end] : undefined;

const NAME_CHAR = /[\w.-]/;
/** The end of a key name, a closing quote or `]`, then `:` or `=` and an opening quote. */
const SEPARATOR = /["']?\]?[ \t]{0,8}[:=][ \t]{0,8}["']?/y;
/** One more than the longest value, so a longer value shows as too long instead of cut. */
const ASSIGN_VALUE = /[^\s"'`,;]{1,513}/y;

/**
 * The match is the keyword, wherever it sits in the name, so a name of any length is found.
 * The rest of the name, the separator and the value are read after it. When nothing is hidden,
 * the search goes on after what was read, or at a `&` or `?` inside a rejected value
 * (`?a=your_token&token=...`), so each character is read a bounded number of times (R9).
 */
const ASSIGN: Rule = {
	re: /api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|auth/gi,
	maxLen: 11,
	span: (m, at, text) => {
		let end = at + m[0].length;
		while (NAME_CHAR.test(text.charAt(end))) end++;
		SEPARATOR.lastIndex = end;
		if (!SEPARATOR.test(text)) return { resume: end };
		const start = SEPARATOR.lastIndex;
		ASSIGN_VALUE.lastIndex = start;
		const value = ASSIGN_VALUE.exec(text)?.[0] ?? "";
		if (value.length >= 12 && value.length <= 512 && isSecretValue(value)) {
			return [start, start + value.length];
		}
		const inner = value.search(/[&?]/);
		return { resume: start + (inner === -1 ? value.length : inner) };
	},
};

const AUTH_HEADER: Rule = {
	re: new RegExp(
		String.raw`${B}Authorization["']?[ \t]{0,8}:[ \t]{0,8}["']?(?:Bearer|Basic|Token)[ \t]{1,8}([^\s"'\x60]{1,4097})`,
		"gi",
	),
	maxLen: 4143,
	span: (m, at) => {
		const value = m[1] ?? "";
		return value.length < 8 || value.length > 4096
			? undefined
			: secretBefore(value, at + m[0].length);
	},
};

/** The password ends at the last `@` before the host, so a password with a raw `@` is hidden in full. */
const URL_USERINFO: Rule = {
	re: new RegExp(
		String.raw`${B}[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s:/@?#]{0,256}:([^\s/?#]{1,512})@`,
		"g",
	),
	maxLen: 805,
	span: (m, at) => secretBefore(m[1] ?? "", at + m[0].length - 1),
};

const RULES: { id: RuleId; rule: Rule }[] = [
	{ id: "private-key", rule: PRIVATE_KEY },
	...VENDOR.map(([id, rule]) => ({ id: `vendor:${id}` as const, rule })),
	{ id: "context:assign", rule: ASSIGN },
	{ id: "context:auth-header", rule: AUTH_HEADER },
	{ id: "context:url-userinfo", rule: URL_USERINFO },
];

/** Runs `rule` over `text` one window at a time, reading the clock before each. False when the deadline passed. */
function eachSpan(
	text: string,
	rule: Rule,
	clock: Clock,
	found: (range: Range) => void,
): boolean {
	let from = 0;
	for (let w = 0; w < text.length; w += WINDOW) {
		if (expired(clock)) return false;
		if (from >= w + WINDOW) continue;
		// 2 characters before the window, for the boundary after an escape (`\n`).
		const base = Math.max(0, w - 2);
		const slice = text.slice(base, w + WINDOW + rule.maxLen + 1);
		rule.re.lastIndex = Math.max(from, w) - base;
		for (
			let m = rule.re.exec(slice);
			m !== null && m.index + base < w + WINDOW;
			m = rule.re.exec(slice)
		) {
			const at = m.index + base;
			const result = rule.span(m, at, text);
			if (result === undefined) from = at + m[0].length;
			else if ("resume" in result) from = result.resume;
			else {
				found(result);
				from = Math.max(at + m[0].length, result[1]);
			}
			rule.re.lastIndex = from - base;
		}
	}
	return true;
}

function knownSpans(
	text: string,
	set: KnownSet,
	clock: Clock,
	out: Span[],
): boolean {
	if (set.heads.size === 0) return true;
	for (let i = 0; i + HEAD <= text.length; i++) {
		if (i % WINDOW === 0 && expired(clock)) return false;
		const form = set.heads
			.get(text.slice(i, i + HEAD))
			?.find((f) => text.startsWith(f.text, i));
		if (form) {
			const hit: Hit = { kind: "known", name: form.name };
			out.push({ start: i, end: i + form.text.length, hit });
		}
	}
	return true;
}

/** True when `span` overlaps a range of `sorted`, a list of disjoint ranges in order. */
function overlaps(sorted: readonly Range[], span: Span): boolean {
	let lo = 0;
	let hi = sorted.length;
	// The first range that ends after the span starts.
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((sorted[mid]?.[1] ?? 0) <= span.start) lo = mid + 1;
		else hi = mid;
	}
	const range = sorted[lo];
	return range !== undefined && range[0] < span.end;
}

/**
 * R1: a context value that overlaps a marker was read from the marker (`[secret: NAME]`
 * looks like `secret: value`). Other rules still hide a token written inside marker-like text.
 */
const onMarker = (markers: readonly Range[], span: Span) =>
	span.hit.kind === "rule" &&
	span.hit.rule.startsWith("context:") &&
	overlaps(markers, span);

const length = (span: Span) => span.end - span.start;
/** R3 (Q31): a known value, then a private key or vendor rule, then a context rule. */
const rank = (span: Span) =>
	span.hit.kind === "known" ? 0 : span.hit.rule.startsWith("context:") ? 2 : 1;

/**
 * R3: overlapping spans merge into their union, so no part of a match stays visible. The union
 * takes the hit of its highest-ranked member, then the longest, then the earliest.
 */
function resolve(spans: Span[]): Span[] {
	const merged: { start: number; end: number; best: Span }[] = [];
	for (const span of spans.sort((a, b) => a.start - b.start)) {
		const last = merged.at(-1);
		if (last === undefined || span.start >= last.end) {
			merged.push({ start: span.start, end: span.end, best: span });
			continue;
		}
		last.end = Math.max(last.end, span.end);
		const { best } = last;
		const better = rank(best) - rank(span) || length(span) - length(best);
		if (better > 0) last.best = span;
	}
	return merged.map(({ start, end, best }) => ({ start, end, hit: best.hit }));
}

function rewrite(
	text: string,
	set: KnownSet,
	clock: Clock,
): { text: string; hits: Hit[] } | "deadline" {
	// No form and no rule matches fewer characters.
	if (text.length < MIN_KNOWN_LENGTH) return { text, hits: [] };
	const markers: Range[] = [];
	if (!eachSpan(text, set.markers, clock, (range) => markers.push(range))) {
		return "deadline";
	}
	const spans: Span[] = [];
	if (!knownSpans(text, set, clock, spans)) return "deadline";
	for (const { id, rule } of RULES) {
		const pushed = eachSpan(text, rule, clock, ([start, end]) =>
			spans.push({ start, end, hit: { kind: "rule", rule: id } }),
		);
		if (!pushed) return "deadline";
	}
	const kept = resolve(spans.filter((span) => !onMarker(markers, span)));
	// The spans are disjoint, so building left to right equals replacing right to left.
	let out = "";
	let last = 0;
	for (const span of kept) {
		out += text.slice(last, span.start) + marker(span.hit);
		last = span.end;
	}
	return { text: out + text.slice(last), hits: kept.map((span) => span.hit) };
}

export function scanText(
	text: string,
	set: KnownSet,
	limits: Limits,
	clock: Clock,
): Scan<string> {
	try {
		if (text.length > limits.maxChars) return unscannable("too-large");
		const result = rewrite(text, set, clock);
		if (result === "deadline") return unscannable("deadline");
		return result.hits.length === 0
			? { status: "clean" }
			: { status: "found", value: result.text, hits: result.hits };
	} catch {
		// R10: the error may hold a value, so it is dropped.
		return unscannable("unsupported");
	}
}

type Walk = {
	set: KnownSet;
	limits: Limits;
	clock: Clock;
	nodes: number;
	chars: number;
	hits: Hit[];
	/** The objects and arrays above the current one, to find a cycle. */
	path: Set<object>;
};
type Step = { value: unknown } | Unscannable;

/** R8: counts one node, and reads the clock every 1024 nodes. */
function countNode(walk: Walk): Unscannable | undefined {
	walk.nodes++;
	if (walk.nodes > walk.limits.maxNodes) return unscannable("too-many-nodes");
	if (walk.nodes % 1024 === 0 && expired(walk.clock)) {
		return unscannable("deadline");
	}
	return undefined;
}

function walkText(text: string, walk: Walk): { value: string } | Unscannable {
	const stop = countNode(walk);
	if (stop) return stop;
	walk.chars += text.length;
	if (walk.chars > walk.limits.maxChars) return unscannable("too-large");
	const result = rewrite(text, walk.set, walk.clock);
	if (result === "deadline") return unscannable("deadline");
	for (const hit of result.hits) walk.hits.push(hit);
	return { value: result.text };
}

/**
 * R7: an own data property that a plain read agrees with, read once. A getter, a hole, or a
 * proxy whose `get` differs from its descriptor gives undefined.
 */
function ownData(
	target: object,
	key: string | number,
): { value: unknown } | undefined {
	const field = Object.getOwnPropertyDescriptor(target, key);
	if (!field || !("value" in field)) return undefined;
	return Object.is(Reflect.get(target, key), field.value)
		? { value: field.value }
		: undefined;
}

function walkArray(list: unknown[], depth: number, walk: Walk): Step {
	// Read once, so a proxy cannot grow it after the check.
	const length = list.length;
	if (length > walk.limits.maxNodes) return unscannable("too-many-nodes");
	const out: unknown[] = [];
	for (let i = 0; i < length; i++) {
		// Numbers and nulls are not nodes, so a long run of them reads the clock here.
		if (i % 1024 === 1023 && expired(walk.clock)) {
			return unscannable("deadline");
		}
		const field = ownData(list, i);
		if (!field) return unscannable("unsupported");
		const step = walkAny(field.value, depth, walk);
		if ("status" in step) return step;
		out.push(step.value);
	}
	return { value: out };
}

/** R7: keys are scanned like values. A rewritten key that meets a key already used gets ` #2`, ` #3`. */
function walkObject(object: object, depth: number, walk: Walk): Step {
	if (Object.getOwnPropertySymbols(object).length > 0) {
		return unscannable("unsupported");
	}
	const fields: { key: string; value: unknown; changed: boolean }[] = [];
	for (const key of Object.keys(object)) {
		const field = ownData(object, key);
		if (!field) return unscannable("unsupported");
		const name = walkText(key, walk);
		if ("status" in name) return name;
		const step = walkAny(field.value, depth, walk);
		if ("status" in step) return step;
		fields.push({
			key: name.value,
			value: step.value,
			changed: name.value !== key,
		});
	}
	const used = new Set(fields.filter((f) => !f.changed).map((f) => f.key));
	const out = {};
	for (const { key, value, changed } of fields) {
		let name = key;
		for (let n = 2; changed && used.has(name); n++) name = `${key} #${n}`;
		used.add(name);
		// Defined, not assigned, so a `__proto__` key stays a key.
		Object.defineProperty(out, name, {
			value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return { value: out };
}

function walkAny(input: unknown, depth: number, walk: Walk): Step {
	if (
		input === null ||
		input === undefined ||
		typeof input === "number" ||
		typeof input === "boolean"
	) {
		return { value: input };
	}
	if (typeof input === "string") return walkText(input, walk);
	if (typeof input !== "object") return unscannable("unsupported");
	const proto = Object.getPrototypeOf(input);
	const isArray = Array.isArray(input) && proto === Array.prototype;
	if (!isArray && proto !== Object.prototype && proto !== null) {
		return unscannable("unsupported");
	}
	if (walk.path.has(input)) return unscannable("cycle");
	if (depth >= walk.limits.maxDepth) return unscannable("too-deep");
	const stop = countNode(walk);
	if (stop) return stop;
	walk.path.add(input);
	const step = isArray
		? walkArray(input as unknown[], depth + 1, walk)
		: walkObject(input, depth + 1, walk);
	walk.path.delete(input);
	return step;
}

export function scanValue(
	value: unknown,
	set: KnownSet,
	limits: Limits,
	clock: Clock,
): Scan<unknown> {
	const walk: Walk = {
		set,
		limits,
		clock,
		nodes: 0,
		chars: 0,
		hits: [],
		path: new Set(),
	};
	try {
		const step = walkAny(value, 0, walk);
		if ("status" in step) return step;
		return walk.hits.length === 0
			? { status: "clean" }
			: { status: "found", value: step.value, hits: walk.hits };
	} catch {
		// R7, R10: a revoked proxy or a throwing trap; the error may hold a value, so it is dropped.
		return unscannable("unsupported");
	}
}
