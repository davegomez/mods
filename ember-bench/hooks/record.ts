/** The rows the mod hands the script. Shared by both sides: the mod checks before it sends, the script before it writes. */

export const FORK_REASONS = [
	"answered",
	"api-error",
	"empty-reply",
	"aborted",
	"nothing-to-fork",
	"off",
] as const;
export type ForkReason = (typeof FORK_REASONS)[number];

export type SessionRecord = {
	kind: "session";
	session: string;
	startedMs: number;
	/** 1 records refreshes as usual, 0 refuses ember's refresh forks. */
	arm: 0 | 1;
	ccVersion: string | null;
	emberVersion: string | null;
	/** `<name>@<marketplace>` installed, `<name>@inline` by --plugin-dir, or `unknown`. */
	emberSource: string;
	ttlMinutes: number | null;
	refresh: 0 | 1 | null;
	refreshShortTtl: 0 | 1 | null;
	refreshLeadSeconds: number | null;
};

export type ForkRecord = {
	kind: "fork";
	session: string;
	firedMs: number;
	durationMs: number;
	isAnswered: 0 | 1;
	reason: ForkReason;
	input: number;
	output: number;
	read: number;
	creation: number;
	fiveHourBefore: number | null;
	fiveHourAfter: number | null;
	sevenDayBefore: number | null;
	sevenDayAfter: number | null;
};

/** `probe`: /ember-probe ran (its fork is no refresh). `seen`: ember-bench saw a call ember made. */
export type MarkRecord = {
	kind: "probe" | "seen";
	session: string;
	atMs: number;
};

export type BenchRecord = SessionRecord | ForkRecord | MarkRecord;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[\w.+-]{1,64}$/;
const SOURCE = /^[\w.-]{1,64}@[\w.-]{1,64}$/;

export const isSessionId = (v: unknown): v is string =>
	typeof v === "string" && UUID.test(v);

const isCount = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;
const isCountOrNull = (v: unknown) => v === null || isCount(v);
const isFlag = (v: unknown) => v === 0 || v === 1;
const isFlagOrNull = (v: unknown) => v === null || isFlag(v);
const isVersionOrNull = (v: unknown) =>
	v === null || (typeof v === "string" && VERSION.test(v));

const KEYS: Record<BenchRecord["kind"], readonly string[]> = {
	session: [
		"kind",
		"session",
		"startedMs",
		"arm",
		"ccVersion",
		"emberVersion",
		"emberSource",
		"ttlMinutes",
		"refresh",
		"refreshShortTtl",
		"refreshLeadSeconds",
	],
	fork: [
		"kind",
		"session",
		"firedMs",
		"durationMs",
		"isAnswered",
		"reason",
		"input",
		"output",
		"read",
		"creation",
		"fiveHourBefore",
		"fiveHourAfter",
		"sevenDayBefore",
		"sevenDayAfter",
	],
	probe: ["kind", "session", "atMs"],
	seen: ["kind", "session", "atMs"],
};

/** True when `v` is exactly one record: known keys only, every number finite, the session a UUID, every text from a closed form. */
export function isRecord(v: unknown): v is BenchRecord {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const r = v as Record<string, unknown>;
	const keys = KEYS[r.kind as BenchRecord["kind"]];
	if (keys === undefined || !isSessionId(r.session)) return false;
	const own = Object.keys(r);
	if (own.length !== keys.length || own.some((k) => !keys.includes(k)))
		return false;
	switch (r.kind) {
		case "session":
			return (
				isCount(r.startedMs) &&
				isFlag(r.arm) &&
				isVersionOrNull(r.ccVersion) &&
				isVersionOrNull(r.emberVersion) &&
				(r.emberSource === "unknown" ||
					(typeof r.emberSource === "string" && SOURCE.test(r.emberSource))) &&
				isCountOrNull(r.ttlMinutes) &&
				isFlagOrNull(r.refresh) &&
				isFlagOrNull(r.refreshShortTtl) &&
				isCountOrNull(r.refreshLeadSeconds)
			);
		case "fork":
			return (
				isCount(r.firedMs) &&
				isCount(r.durationMs) &&
				isFlag(r.isAnswered) &&
				FORK_REASONS.includes(r.reason as ForkReason) &&
				isCount(r.input) &&
				isCount(r.output) &&
				isCount(r.read) &&
				isCount(r.creation) &&
				isCountOrNull(r.fiveHourBefore) &&
				isCountOrNull(r.fiveHourAfter) &&
				isCountOrNull(r.sevenDayBefore) &&
				isCountOrNull(r.sevenDayAfter)
			);
		default:
			return isCount(r.atMs);
	}
}
