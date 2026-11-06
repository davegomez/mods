import type { CatchHandler, Hook, ToolCallResult } from "claude-code";
import type { Clock, Hit, KnownSet, Scan, Unscannable } from "./detect.ts";
import { DEFAULT_LIMITS, scanText, scanValue } from "./detect.ts";
import { type Enrollment, refreshIfNamed } from "./enroll.ts";

export type Verdict<T> =
	| { kind: "pass" }
	| { kind: "rewrite"; value: T; count: number }
	| { kind: "stop"; reason: Unscannable["reason"] };
/** R4: tool arguments are never rewritten (P2), so a hit that counts refuses the call. */
export type ArgsVerdict =
	| { kind: "pass" }
	| { kind: "refuse" }
	| { kind: "stop"; reason: Unscannable["reason"] };

/** R2: the time a hook keeps for its answer after the scan. */
const RESERVE_MS = 1000;

const expired = (clock: Clock) => clock.now() >= clock.deadline;
const stop = (reason: Unscannable["reason"]) =>
	({ kind: "stop", reason }) as const;
const unscannable = (reason: Unscannable["reason"]): Unscannable => ({
	status: "unscannable",
	reason,
});

function verdict<T>(scan: Scan<T>): Verdict<T> {
	if (scan.status === "clean") return { kind: "pass" };
	if (scan.status === "unscannable") return stop(scan.reason);
	return { kind: "rewrite", value: scan.value, count: scan.hits.length };
}

/** JSON would write a Map, a typed array, or a class as `{}`, which hides its data from the scan while `pass` forwards the original. */
function isPlain(object: object): boolean {
	if (Object.getOwnPropertySymbols(object).length > 0) return false;
	const proto = Object.getPrototypeOf(object);
	return Array.isArray(object)
		? proto === Array.prototype
		: proto === Object.prototype || proto === null;
}

/** R1: a JSON round trip. A cycle, a BigInt, a throwing `toJSON`, or an object that is not plain gives undefined. */
function plainCopy(value: unknown): { value: unknown } | undefined {
	try {
		const json = JSON.stringify(value, (_key, field: unknown) => {
			if (typeof field === "object" && field !== null && !isPlain(field)) {
				throw new TypeError("not plain");
			}
			return field;
		});
		return json === undefined ? undefined : { value: JSON.parse(json) };
	} catch {
		// The error may hold a value, so it is dropped.
		return undefined;
	}
}

function scanPlain(value: unknown, set: KnownSet, clock: Clock): Scan<unknown> {
	// JSON writes nothing for undefined, and undefined holds no text, so it is scanned as it is.
	const copy = value === undefined ? { value } : plainCopy(value);
	if (copy === undefined) return unscannable("unsupported");
	// The copy is not timed, so the clock is read after it.
	if (expired(clock)) return unscannable("deadline");
	return scanValue(copy.value, set, DEFAULT_LIMITS, clock);
}

export function guardText(
	text: string,
	set: KnownSet,
	clock: Clock,
): Verdict<string> {
	// A short text never reads the clock in the scan, so it is read here.
	if (expired(clock)) return stop("deadline");
	return verdict(scanText(text, set, DEFAULT_LIMITS, clock));
}

export function guardValue(
	value: unknown,
	set: KnownSet,
	clock: Clock,
): Verdict<unknown> {
	return verdict(scanPlain(value, set, clock));
}

/** Q30: only a context rule hit may pass. Any other hit refuses, a rule added later too. */
const refuses = (hit: Hit) =>
	hit.kind === "known" || !hit.rule.startsWith("context:");

export function guardArgs(
	args: unknown,
	set: KnownSet,
	clock: Clock,
): ArgsVerdict {
	const scan = scanPlain(args, set, clock);
	if (scan.status === "unscannable") return stop(scan.reason);
	return scan.status === "found" && scan.hits.some(refuses)
		? { kind: "refuse" }
		: { kind: "pass" };
}

/** R2: `now` and the deadline are in milliseconds. An unmetered budget (Infinity) never stops. */
export function clockFor(remainingMs: number, now: () => number): Clock {
	const deadline = now() + remainingMs - RESERVE_MS;
	// NaN would never expire, so it fails closed.
	return { now, deadline: Number.isNaN(deadline) ? -Infinity : deadline };
}

/** R4, P3: tells Claude what to do instead. It holds no value and no name (R15). */
export const REFUSED_ARGS =
	"blindfold refused this call because its arguments hold a secret value. Refer to the secret by its env variable name, for example $NAME in a shell command, and never write the value itself.";

const unscannedArgs = (reason: string) =>
	`blindfold refused this call (${reason}): it could not scan the arguments. Shorten or split the call.`;
const withheld = (reason: string) => ({
	deny: `blindfold withheld this result (${reason}). Narrow the call.`,
});

type ToolCall = Parameters<Hook<"tool.call">>;

/** R2: `performance.now` is monotonic, so a wall-clock change cannot move the deadline. */
const clockOf = (next: ToolCall[2]) =>
	clockFor(next.budget.remainingMs, () => performance.now());

/** R4: the tool's own arguments, without the keys the engine reserves. */
function argsOf(e: ToolCall[1]): Record<string, unknown> {
	const { tool, tool_use_id, agentId, ...args } = e as Record<string, unknown>;
	return args;
}

/** R5 (Q26): a copy without `ref` and `text`, so core maps the scanned `result` again. */
function rewritten(
	from: { isError?: true; isReadOnly?: true },
	scanned: { result?: unknown; context?: string[] },
): ToolCallResult {
	return {
		result: scanned.result,
		...(scanned.context === undefined ? {} : { context: scanned.context }),
		...(from.isError ? { isError: true } : {}),
		...(from.isReadOnly ? { isReadOnly: true } : {}),
	} as ToolCallResult;
}

/** R5: scan what `next` returned with the set as it is now. */
function guardResult(out: ToolCallResult, set: KnownSet, clock: Clock) {
	if (out.deny !== undefined) {
		const verdict = guardText(out.deny, set, clock);
		if (verdict.kind === "stop") return withheld(verdict.reason);
		return verdict.kind === "rewrite" ? { deny: verdict.value } : out;
	}
	const verdict = guardValue(
		{ result: out.result, context: out.context },
		set,
		clock,
	);
	if (verdict.kind === "stop") return withheld(verdict.reason);
	// pass keeps the same object, so core keeps `ref`.
	return verdict.kind === "rewrite"
		? rewritten(out, verdict.value as { result?: unknown; context?: string[] })
		: out;
}

/** R4, R5: every tool, MCP tools too. `enrollment` is a parameter, because `register.ts` owns it and imports this module. */
export async function onToolCall(
	$: ToolCall[0],
	enrollment: Enrollment,
	e: ToolCall[1],
	next: ToolCall[2],
): Promise<ToolCallResult> {
	await refreshIfNamed($, enrollment, e);
	const before = guardArgs(argsOf(e), enrollment.knownSet(), clockOf(next));
	if (before.kind === "refuse") return { deny: REFUSED_ARGS };
	if (before.kind === "stop") return { deny: unscannedArgs(before.reason) };
	// P2: the arguments go on unchanged.
	const out = await next(e);
	// The call may have written a listed file.
	await refreshIfNamed($, enrollment, e);
	return guardResult(out, enrollment.knownSet(), clockOf(next));
}

/** R5, P5: the handler has 1 s, so it does not scan. */
export const onToolCallCatch: CatchHandler<Hook<"tool.call">> = (
	_$,
	_e,
	next,
) =>
	next.called
		? { deny: "blindfold withheld this result." }
		: { deny: "blindfold refused this call." };
