import type { ModelForkResult, SessionRateLimit } from "claude-code";

import type { ForkRecord, SessionRecord } from "./record.ts";

export const EMBER = "ember";
/** Store key prefix of a session's arm; the value is 0 for off. Unset is on. */
export const ARM_PREFIX = "arm:";
export const OFF = 0;
export const INGEST_EVERY_MS = 30 * 60_000;

export const armKey = (session: string) => `${ARM_PREFIX}${session}`;

/** What an off session answers ember's fork with: no request was made, and ember's judgeFork reads `aborted` as refused. */
export const OFF_FORK: ModelForkResult = {
	isAnswered: false,
	reason: "aborted",
	usage: {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	},
};

export type Ember = { version: string | null; source: string };
export const UNKNOWN_EMBER: Ember = { version: null, source: "unknown" };

export const emberOf = (e: {
	version?: string;
	provenance: string;
}): Ember => ({
	version: e.version ?? null,
	source: e.provenance,
});

/** Where bun may be: on PATH first, then the installer's default. */
export const bunCandidates = (home: string | undefined): string[] =>
	home === undefined ? ["bun"] : ["bun", `${home}/.bun/bin/bun`];

export const percentOf = (
	limits: readonly SessionRateLimit[] | undefined,
	kind: string,
): number | null => limits?.find((l) => l.kind === kind)?.percentUsed ?? null;

const objOf = (v: unknown): Record<string, unknown> | undefined =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
const numberOr = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? v : null;
const flagOr = (v: unknown): 0 | 1 | null =>
	typeof v === "boolean" ? (v ? 1 : 0) : null;

/**
 * Ember's option values as settings hold them (`pluginConfigs[<plugin id>].options`), the installed id first and
 * the --plugin-dir spellings after. A field settings do not hold is null: ember's manifest default applies.
 */
export function optionsOf(pluginConfigs: unknown, source: string) {
	const all = objOf(pluginConfigs);
	const key = [source, EMBER, `${EMBER}@inline`].find(
		(k) => objOf(all?.[k]) !== undefined,
	);
	const o = objOf(objOf(key === undefined ? undefined : all?.[key])?.options);
	return {
		ttlMinutes: numberOr(o?.ttlMinutes),
		refresh: flagOr(o?.refresh),
		refreshShortTtl: flagOr(o?.refreshShortTtl),
		refreshLeadSeconds: numberOr(o?.refreshLeadSeconds),
	};
}

export function sessionRecord(p: {
	session: string;
	startedMs: number;
	isOff: boolean;
	ccVersion: string | null;
	ember: Ember;
	pluginConfigs: unknown;
}): SessionRecord {
	return {
		kind: "session",
		session: p.session,
		startedMs: p.startedMs,
		arm: p.isOff ? 0 : 1,
		ccVersion: p.ccVersion,
		emberVersion: p.ember.version,
		emberSource: p.ember.source,
		...optionsOf(p.pluginConfigs, p.ember.source),
	};
}

export type Limits = { fiveHour: number | null; sevenDay: number | null };
export const limitsOf = (
	limits: readonly SessionRateLimit[] | undefined,
): Limits => ({
	fiveHour: percentOf(limits, "five_hour"),
	sevenDay: percentOf(limits, "seven_day"),
});

/** One fork as a row: when it fired, how long it took, how it ended, what it cost, and the plan's use around it. */
export function forkRecord(p: {
	session: string;
	firedMs: number;
	durationMs: number;
	result: ModelForkResult;
	isOff: boolean;
	before: Limits;
	after: Limits;
}): ForkRecord {
	const r = p.result;
	const u = "usage" in r ? r.usage : undefined;
	return {
		kind: "fork",
		session: p.session,
		firedMs: p.firedMs,
		durationMs: p.durationMs,
		isAnswered: r.isAnswered ? 1 : 0,
		reason: p.isOff ? "off" : r.isAnswered ? "answered" : r.reason,
		input: u?.input_tokens ?? 0,
		output: u?.output_tokens ?? 0,
		read: u?.cache_read_input_tokens ?? 0,
		creation: u?.cache_creation_input_tokens ?? 0,
		fiveHourBefore: p.before.fiveHour,
		fiveHourAfter: p.after.fiveHour,
		sevenDayBefore: p.before.sevenDay,
		sevenDayAfter: p.after.sevenDay,
	};
}

export const USAGE = "Usage: /bench off | status | delete";

/** The answer to `/bench off`, or undefined when the session may switch off now. */
export function offRefusal(turns: number, isOff: boolean): string | undefined {
	if (isOff) return "ember-bench: this session is already off.";
	if (turns > 0)
		return "ember-bench: /bench off works only before the first prompt, so the choice cannot depend on how the session goes. This session stays on.";
	return undefined;
}
