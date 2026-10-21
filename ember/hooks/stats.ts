import type { TurnUsage } from "claude-code";
import type { RefreshState } from "./refresh.ts";
import { parseRefresh } from "./refresh.ts";

export const BUCKETS = [
	"first",
	"user",
	"ask",
	"subagent",
	"tool",
	"compact",
	"model-switch",
	"agent",
] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BANDS = [
	"<1m",
	"1-5m",
	"5-15m",
	"15-30m",
	"30-60m",
	">60m",
] as const;
export type Band = (typeof BANDS)[number];
const BAND_UPPER_MS = [1, 5, 15, 30, 60].map((minutes) => minutes * 60_000);

export const DEFAULT_TTL_MINUTES = 60;
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;
export const MAX_SESSIONS = 500;
/** A `user` request that read at least this share of the previous main prefix found the cache warm. */
const WARM_PREFIX_SHARE = 0.5;

export type Totals = { n: number; read: number; total: number };
/** Token sums over every measured request, main thread and subagents, for the cost share. */
export type Sums = { input: number; read: number; created: number };

/** What one session stores: aggregates only, never prompt text, paths or tool inputs. */
export type Agg = {
	updatedAt: number;
	buckets: Record<Bucket, Totals>;
	/** Per `user` gap band, like `buckets`. Before 0.3.0 a band held its count alone. */
	bands: Record<Band, Totals>;
	/** Largest cache age at a `user` request that read >= half the previous prefix. */
	warmMaxMs?: number;
	/** Smallest cache age at a `user` request that read < half the previous prefix. */
	coldMinMs?: number;
	compactions: number;
	modelSwitches: number;
	sums: Sums;
	/** The last main request with usage and the resolved TTL, for the status line script; never merged. */
	live?: CacheLive;
	/** Cache refresh: the open pause, the breaker, the record ring buffer; never merged. */
	refresh?: RefreshState;
};

/**
 * `hit` is 0 to 1; `prefix` is cache read + cache creation tokens. `refreshes`: refreshes in the current
 * pause; `savedTokens`: the session's net saving from them. Each is left out while 0. `savedPct`: the
 * session's cache saving as a cost share, left out before any token.
 */
export type CacheLive = {
	lastStartMs: number;
	ttlMinutes: number;
	prefix: number;
	hit: number;
	refreshes?: number;
	savedTokens?: number;
	savedPct?: number;
};

/** The main thread's last measured request, which the next one is classified against. */
export type Main = {
	/** When it started: the cache's TTL runs from here. */
	lastStartMs?: number;
	/** When its response ended: the human pause runs from here. */
	lastEndMs?: number;
	lastModel?: string;
	lastToolNames: readonly string[];
	lastHit?: number;
	/** Its cached prefix: cache read + cache creation tokens. */
	lastPrefix?: number;
	isCompactPending: boolean;
};

export type Step = {
	agentId?: string;
	index: number;
	startedMs: number;
	endedMs: number;
	usage: TurnUsage | null;
	toolNames: readonly string[];
};

export const emptyMain: Main = { lastToolNames: [], isCompactPending: false };

const zeros = <K extends string>(keys: readonly K[]) =>
	Object.fromEntries(
		keys.map((k) => [k, { n: 0, read: 0, total: 0 }]),
	) as Record<K, Totals>;
const addTotals = (x: Totals, y: Totals): Totals => ({
	n: x.n + y.n,
	read: x.read + y.read,
	total: x.total + y.total,
});

export function emptyAgg(updatedAt: number): Agg {
	return {
		updatedAt,
		buckets: zeros(BUCKETS),
		bands: zeros(BANDS),
		compactions: 0,
		modelSwitches: 0,
		sums: { input: 0, read: 0, created: 0 },
	};
}

export function validTtlMinutes(value: unknown): number {
	return typeof value === "number" && value >= 1 && value <= 1440
		? value
		: DEFAULT_TTL_MINUTES;
}

export type TtlInputs = {
	force5m?: string;
	envTtl?: string;
	settingTtl?: unknown;
	enable1h?: string;
	optionMinutes: number;
};
export type Ttl = { minutes: number; source: string };

const ttlWord = (v: unknown) => (v === "5m" ? 5 : v === "1h" ? 60 : undefined);

/** Claude Code's main-conversation TTL order; the plan default is not visible, so the option stands in. */
export function resolveTtl(i: TtlInputs): Ttl {
	if (i.force5m === "1")
		return { minutes: 5, source: "FORCE_PROMPT_CACHING_5M" };
	const env = ttlWord(i.envTtl);
	if (env !== undefined)
		return { minutes: env, source: "CLAUDE_CODE_PROMPT_CACHE_TTL" };
	const setting = ttlWord(i.settingTtl);
	if (setting !== undefined)
		return { minutes: setting, source: "promptCacheTtl" };
	if (i.enable1h === "1")
		return { minutes: 60, source: "ENABLE_PROMPT_CACHING_1H" };
	return { minutes: i.optionMinutes, source: "ttlMinutes option" };
}

export function cacheTokens(
	usage: TurnUsage | null,
): { read: number; total: number } | undefined {
	if (usage === null) return undefined;
	const total =
		usage.input_tokens +
		usage.cache_read_input_tokens +
		usage.cache_creation_input_tokens;
	return total > 0 ? { read: usage.cache_read_input_tokens, total } : undefined;
}

export function band(gapMs: number): Band {
	const i = BAND_UPPER_MS.findIndex((upper) => gapMs < upper);
	return BANDS[i === -1 ? BANDS.length - 1 : i] as Band;
}

export function classify(
	main: Main,
	index: number,
	isModelSwitch: boolean,
): Bucket {
	if (main.lastEndMs === undefined) return "first";
	if (main.isCompactPending) return "compact";
	if (isModelSwitch) return "model-switch";
	if (index === 0) return "user";
	if (main.lastToolNames.includes("AskUserQuestion")) return "ask";
	if (main.lastToolNames.includes("Agent")) return "subagent";
	return "tool";
}

function addSample(
	agg: Agg,
	bucket: Bucket,
	t: { read: number; total: number },
	now: number,
): Agg {
	return {
		...agg,
		updatedAt: now,
		buckets: {
			...agg.buckets,
			[bucket]: addTotals(agg.buckets[bucket], { n: 1, ...t }),
		},
	};
}

function addSums(agg: Agg, u: TurnUsage): Agg {
	const s = agg.sums;
	return {
		...agg,
		sums: {
			input: s.input + u.input_tokens,
			read: s.read + u.cache_read_input_tokens,
			created: s.created + u.cache_creation_input_tokens,
		},
	};
}

function addBand(
	agg: Agg,
	gapMs: number,
	t: { read: number; total: number },
): Agg {
	const name = band(gapMs);
	return {
		...agg,
		bands: { ...agg.bands, [name]: addTotals(agg.bands[name], { n: 1, ...t }) },
	};
}

function addTtlEvidence(agg: Agg, ageMs: number, isWarm: boolean): Agg {
	return isWarm
		? { ...agg, warmMaxMs: Math.max(ageMs, agg.warmMaxMs ?? ageMs) }
		: { ...agg, coldMinMs: Math.min(ageMs, agg.coldMinMs ?? ageMs) };
}

/** Folds one finished model request into the aggregates and the main-thread state. */
export function observe(
	agg: Agg,
	main: Main,
	step: Step,
): { agg: Agg; main: Main } {
	const t = cacheTokens(step.usage);
	// No usage or a zero denominator: no measurable request, so nothing moves.
	if (t === undefined || step.usage === null) return { agg, main };
	if (step.agentId !== undefined)
		return {
			agg: addSums(addSample(agg, "agent", t, step.endedMs), step.usage),
			main,
		};

	const model = step.usage.model;
	const prefix =
		step.usage.cache_read_input_tokens + step.usage.cache_creation_input_tokens;
	const next: Main = {
		lastStartMs: step.startedMs,
		lastEndMs: step.endedMs,
		lastModel: model,
		lastToolNames: step.toolNames,
		lastHit: t.read / t.total,
		lastPrefix: prefix,
		isCompactPending: false,
	};

	const isModelSwitch =
		main.lastModel !== undefined && model !== main.lastModel;
	const bucket = classify(main, step.index, isModelSwitch);
	let out = addSums(addSample(agg, bucket, t, step.endedMs), step.usage);
	if (isModelSwitch) out = { ...out, modelSwitches: out.modelSwitches + 1 };
	if (bucket === "user" && main.lastEndMs !== undefined)
		out = addBand(out, step.startedMs - main.lastEndMs, t);
	const prevPrefix = main.lastPrefix ?? 0;
	if (bucket === "user" && main.lastStartMs !== undefined && prevPrefix > 0) {
		out = addTtlEvidence(
			out,
			step.startedMs - main.lastStartMs,
			t.read >= WARM_PREFIX_SHARE * prevPrefix,
		);
	}
	return { agg: out, main: next };
}

export function noteCompaction(
	agg: Agg,
	main: Main,
	nowMs: number,
): { agg: Agg; main: Main } {
	return {
		agg: { ...agg, updatedAt: nowMs, compactions: agg.compactions + 1 },
		main: { ...main, isCompactPending: true },
	};
}

/** Sets `live` from the main thread's last request; the same aggregate before one with usage. */
export function withLive(agg: Agg, main: Main, ttlMinutes: number): Agg {
	const { lastStartMs, lastHit, lastPrefix = 0 } = main;
	if (lastStartMs === undefined || lastHit === undefined) return agg;
	return {
		...agg,
		live: { lastStartMs, ttlMinutes, prefix: lastPrefix, hit: lastHit },
	};
}

/** Sets the live refresh count and saving, each left out while 0; the same aggregate when unchanged. */
export function withRefreshLive(
	agg: Agg,
	refreshes: number,
	savedTokens: number,
): Agg {
	const live = agg.live;
	if (live === undefined) return agg;
	const saved = Math.round(savedTokens);
	if ((live.refreshes ?? 0) === refreshes && (live.savedTokens ?? 0) === saved)
		return agg;
	const { refreshes: _r, savedTokens: _s, ...base } = live;
	return {
		...agg,
		live: {
			...base,
			...(refreshes === 0 ? {} : { refreshes }),
			...(saved === 0 ? {} : { savedTokens: saved }),
		},
	};
}

/** Sets the stored live TTL and the saving it weighs; the same aggregate when there is none or it is unchanged. */
export function withTtl(agg: Agg, ttlMinutes: number): Agg {
	return agg.live === undefined || agg.live.ttlMinutes === ttlMinutes
		? agg
		: withSavedPct({ ...agg, live: { ...agg.live, ttlMinutes } });
}

/**
 * The cost share the cache saved, 0 to 100, below 0 when writes cost more than reads saved: a read costs 0.1
 * of an input token, a write 1.25 at a 5-minute TTL and 2 above it. Undefined before any token.
 */
export function savedPct(sums: Sums, ttlMinutes: number): number | undefined {
	const uncached = sums.input + sums.read + sums.created;
	if (uncached <= 0) return undefined;
	const actual =
		sums.input + 0.1 * sums.read + (ttlMinutes <= 5 ? 1.25 : 2) * sums.created;
	return Math.round(((uncached - actual) * 100) / uncached);
}

/** Sets `live.savedPct` from the sums, left out before any token; the same aggregate when unchanged. */
export function withSavedPct(agg: Agg): Agg {
	const live = agg.live;
	if (live === undefined) return agg;
	const pct = savedPct(agg.sums, live.ttlMinutes);
	if (live.savedPct === pct) return agg;
	const { savedPct: _p, ...base } = live;
	return {
		...agg,
		live: { ...base, ...(pct === undefined ? {} : { savedPct: pct }) },
	};
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
/** A band stored before 0.3.0 is a bare count: its requests, with no tokens and so no hit ratio. */
const totalsOf = (v: unknown): Totals =>
	isRecord(v)
		? { n: count(v.n), read: count(v.read), total: count(v.total) }
		: { n: count(v), read: 0, total: 0 };
const optMs = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

function parseLive(v: unknown): CacheLive | undefined {
	if (!isRecord(v)) return undefined;
	const lastStartMs = optMs(v.lastStartMs);
	const prefix = optMs(v.prefix);
	const ttlMinutes = optMs(v.ttlMinutes);
	const hit = optMs(v.hit);
	if (
		lastStartMs === undefined ||
		prefix === undefined ||
		ttlMinutes === undefined ||
		ttlMinutes === 0 ||
		hit === undefined ||
		hit > 1
	)
		return undefined;
	const refreshes = optMs(v.refreshes);
	const savedTokens =
		typeof v.savedTokens === "number" && Number.isFinite(v.savedTokens)
			? v.savedTokens
			: undefined;
	const savedPct =
		typeof v.savedPct === "number" && Number.isFinite(v.savedPct)
			? v.savedPct
			: undefined;
	return {
		lastStartMs,
		ttlMinutes,
		prefix,
		hit,
		...(refreshes ? { refreshes } : {}),
		...(savedTokens ? { savedTokens } : {}),
		...(savedPct === undefined ? {} : { savedPct }),
	};
}

/** Reads a stored aggregate defensively; undefined when it is not one. */
export function parseAgg(value: unknown): Agg | undefined {
	if (!isRecord(value) || typeof value.updatedAt !== "number") return undefined;
	const buckets = isRecord(value.buckets) ? value.buckets : {};
	const bands = isRecord(value.bands) ? value.bands : {};
	const sums = isRecord(value.sums) ? value.sums : {};
	const agg = emptyAgg(value.updatedAt);
	for (const b of BUCKETS) agg.buckets[b] = totalsOf(buckets[b]);
	for (const b of BANDS) agg.bands[b] = totalsOf(bands[b]);
	const warmMaxMs = optMs(value.warmMaxMs);
	const coldMinMs = optMs(value.coldMinMs);
	const live = parseLive(value.live);
	const refresh = parseRefresh(value.refresh);
	return {
		...agg,
		...(warmMaxMs === undefined ? {} : { warmMaxMs }),
		...(coldMinMs === undefined ? {} : { coldMinMs }),
		...(live === undefined ? {} : { live }),
		...(refresh === undefined ? {} : { refresh }),
		compactions: count(value.compactions),
		modelSwitches: count(value.modelSwitches),
		sums: {
			input: count(sums.input),
			read: count(sums.read),
			created: count(sums.created),
		},
	};
}

const minOf = (a?: number, b?: number) =>
	a === undefined ? b : b === undefined ? a : Math.min(a, b);
const maxOf = (a?: number, b?: number) =>
	a === undefined ? b : b === undefined ? a : Math.max(a, b);

export function mergeAggs(aggs: readonly Agg[]): Agg {
	return aggs.reduce<Agg>((sum, a) => {
		const out = emptyAgg(Math.max(sum.updatedAt, a.updatedAt));
		for (const b of BUCKETS)
			out.buckets[b] = addTotals(sum.buckets[b], a.buckets[b]);
		for (const b of BANDS) out.bands[b] = addTotals(sum.bands[b], a.bands[b]);
		const warmMaxMs = maxOf(sum.warmMaxMs, a.warmMaxMs);
		const coldMinMs = minOf(sum.coldMinMs, a.coldMinMs);
		return {
			...out,
			...(warmMaxMs === undefined ? {} : { warmMaxMs }),
			...(coldMinMs === undefined ? {} : { coldMinMs }),
			compactions: sum.compactions + a.compactions,
			modelSwitches: sum.modelSwitches + a.modelSwitches,
			sums: {
				input: sum.sums.input + a.sums.input,
				read: sum.sums.read + a.sums.read,
				created: sum.sums.created + a.sums.created,
			},
		};
	}, emptyAgg(0));
}

/**
 * The session keys to delete: each unreadable or untouched for 30 days, then the oldest
 * until at most MAX_SESSIONS remain with the current one, which is never picked.
 */
export function keysToPrune(
	entries: readonly (readonly [string, unknown])[],
	currentKey: string | undefined,
	nowMs: number,
): string[] {
	const stale: string[] = [];
	const kept: { key: string; updatedAt: number }[] = [];
	for (const [key, value] of entries) {
		if (key === currentKey) continue;
		const agg = parseAgg(value);
		if (agg === undefined || nowMs - agg.updatedAt > PRUNE_AFTER_MS)
			stale.push(key);
		else kept.push({ key, updatedAt: agg.updatedAt });
	}
	// One place stays free for the current session, stored yet or not.
	const excess = kept.length - (MAX_SESSIONS - 1);
	const oldest =
		excess > 0
			? kept.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, excess)
			: [];
	return [...stale, ...oldest.map((e) => e.key)];
}

export function percent(read: number, total: number): string {
	return total > 0 ? `${Math.round((read / total) * 100)}%` : "–";
}

const pad = (n: number) => String(n).padStart(2, "0");

export function duration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (h > 0) return `${h}h${pad(m)}m`;
	return m > 0 ? `${m}m${pad(s % 60)}s` : `${s % 60}s`;
}

export function tokens(n: number): string {
	if (n < 1000) return String(n);
	const k = Math.round(n / 1000);
	return k < 1000 ? `${k}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

function sessionTotals(agg: Agg): { read: number; total: number } {
	return Object.values(agg.buckets).reduce(
		(s, t) => ({ read: s.read + t.read, total: s.total + t.total }),
		{ read: 0, total: 0 },
	);
}

export type StatusView = {
	nowMs: number;
	ttlMs: number;
	isInFlight: boolean;
	main: Main;
	session: Agg;
};

export function statusText(v: StatusView): string | undefined {
	if (v.isInFlight) {
		const t = sessionTotals(v.session);
		return t.total > 0 ? `session hit ${percent(t.read, t.total)}` : undefined;
	}
	if (
		v.main.lastStartMs === undefined ||
		v.main.lastEndMs === undefined ||
		v.main.lastHit === undefined
	)
		return undefined;
	const idleMs = v.nowMs - v.main.lastEndMs;
	const leftMs = v.ttlMs - (v.nowMs - v.main.lastStartMs);
	const cold = leftMs > 0 ? `cold in ~${duration(leftMs)}` : "likely cold";
	const size =
		(v.main.lastPrefix ?? 0) > 0
			? ` · ${tokens(v.main.lastPrefix ?? 0)} cached`
			: "";
	return `idle ${duration(idleMs)} · last hit ${percent(v.main.lastHit, 1)}${size} · ${cold}`;
}

const MAX_WARN_LEAD_MS = 5 * 60_000;

/**
 * The toast to show while idle once the time left falls to min(5 min, TTL / 5) and is above 0;
 * undefined when already warned for this request (`warnedStartMs`), in flight, or no prefix.
 */
export function warning(
	v: StatusView,
	warnedStartMs?: number,
): string | undefined {
	const { lastStartMs, lastEndMs, lastPrefix = 0 } = v.main;
	if (
		v.isInFlight ||
		lastStartMs === undefined ||
		lastEndMs === undefined ||
		lastPrefix <= 0 ||
		lastStartMs === warnedStartMs
	)
		return undefined;
	const leftMs = v.ttlMs - (v.nowMs - lastStartMs);
	if (leftMs <= 0 || leftMs > Math.min(MAX_WARN_LEAD_MS, v.ttlMs / 5))
		return undefined;
	return `cache goes cold in ~${duration(leftMs)} (${tokens(lastPrefix)} tokens)`;
}

const orDash = (ms?: number) => (ms === undefined ? "–" : duration(ms));

/** A Markdown table of the rows with requests and their token-weighted hit ratio; `empty` when there are none. */
function hitTable<K extends string>(
	head: string,
	keys: readonly K[],
	totals: Record<K, Totals>,
	empty: string,
): string {
	const rows = keys
		.filter((k) => totals[k].n > 0)
		.map(
			(k) =>
				`| ${k} | ${totals[k].n} | ${percent(totals[k].read, totals[k].total)} |`,
		);
	return rows.length > 0
		? [`| ${head} | Requests | Hit |`, "| --- | ---: | ---: |", ...rows].join(
				"\n",
			)
		: empty;
}

/** The pane's report for one scope as Markdown: the buckets with requests, the user gap bands, bounds and counts. */
export function report(agg: Agg): string {
	return [
		hitTable("Gap type", BUCKETS, agg.buckets, "No requests yet."),
		hitTable("User gap", BANDS, agg.bands, "No user gaps yet."),
		`Observed TTL: warm up to ${orDash(agg.warmMaxMs)} · cold from ${orDash(agg.coldMinMs)}`,
		`Compactions ${agg.compactions} · model switches ${agg.modelSwitches}`,
	].join("\n\n");
}
