import type { Clock, Hit, KnownSet, Scan, Unscannable } from "./detect.ts";
import { DEFAULT_LIMITS, scanText, scanValue } from "./detect.ts";

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
