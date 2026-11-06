/** Which env files are listed, which of their values are secret, and the known-value set built from them. Values stay in this module's closures. */
import {
	buildKnownSet,
	DEFAULT_LIMITS,
	type Known,
	type KnownSet,
	MIN_KNOWN_LENGTH,
	scanText,
} from "./detect.ts";
import type { Entry } from "./dotenv.ts";

export type RefusedReason =
	| "absolute"
	| "parent"
	| "outside-root"
	| "symlink"
	| "bad-path"
	| "too-many";
export type NameState = {
	name: string;
	hidden: boolean;
	why?: "too-short" | "not-secret";
};
export type FileState =
	| { kind: "active"; names: NameState[] }
	| { kind: "missing" }
	| { kind: "stale"; reason: "read-failed" | "too-large" | "not-a-file" }
	| { kind: "refused"; reason: RefusedReason };
export type FileStatus = { path: string; state: FileState };
export type Status = { files: FileStatus[]; shield: "active" | "degraded" };
/** The outcome of reading 1 listed file: its state, and the values it feeds (none unless it was read). */
export type ApplyFile = FileStatus & { feed: Known[] };
export type ListEntry = { path: string; refused?: RefusedReason };

export const MAX_FILES = 10;

/** R2: the reason a path is refused by its spelling alone, before any read. */
function spellingRefusal(path: string): RefusedReason | undefined {
	if (path.includes("\0")) return "bad-path";
	// `/` and `\` cover `//` and `\\`; a leading `\` is the drive root on Windows.
	if (/^[/\\~]|^[A-Za-z]:/.test(path)) return "absolute";
	if (path.split(/[/\\]/).includes("..")) return "parent";
	return undefined;
}

/** R1, R2: the listed paths in order, each with its refusal when its spelling or position refuses it. */
export function parseList(list: string): ListEntry[] {
	const paths = [...new Set(list.split(",").map((p) => p.trim()))].filter(
		(p) => p !== "",
	);
	return paths.map((path, i) => {
		const refused = i < MAX_FILES ? spellingRefusal(path) : "too-many";
		return refused ? { path, refused } : { path };
	});
}

const SECRET_NAME =
	/KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|DSN|AUTH|CREDENTIAL|PRIVATE/i;
const NO_KNOWN = buildKnownSet([]).set;
const NO_DEADLINE = { now: () => 0, deadline: Number.POSITIVE_INFINITY };

/** R4, Q22: a secret word in the name, or a detector hit in the value. A value the detector cannot scan feeds too. */
function feeds({ name, value }: Known): boolean {
	return (
		SECRET_NAME.test(name) ||
		scanText(value, NO_KNOWN, DEFAULT_LIMITS, NO_DEADLINE).status !== "clean"
	);
}

/** R4: 1 state per name, from its last entry, and every value long enough that feeds the set. */
export function classify(entries: readonly Entry[]): {
	names: NameState[];
	feed: Known[];
} {
	const states = new Map<string, NameState>();
	const feed: Known[] = [];
	for (const { name, value } of entries) {
		let state: NameState = { name, hidden: false, why: "not-secret" };
		if (feeds({ name, value })) {
			if (value.length < MIN_KNOWN_LENGTH) {
				state = { name, hidden: false, why: "too-short" };
			} else {
				state = { name, hidden: true };
				feed.push({ name, value });
			}
		}
		states.delete(name);
		states.set(name, state);
	}
	return { names: [...states.values()], feed };
}

/** R6: degraded when any listed file is stale or refused. Copies only path and state, so no value can ride along. */
export function statusOf(files: readonly FileStatus[]): Status {
	const degraded = files.some(
		(f) => f.state.kind === "stale" || f.state.kind === "refused",
	);
	return {
		files: files.map(({ path, state }) => ({ path, state })),
		shield: degraded ? "degraded" : "active",
	};
}

const baseName = (path: string) => path.split(/[/\\]/).pop() ?? "";

/** R7: true when the JSON text of `input` holds a path or its base name. An input with no JSON text counts, so a refresh is never missed. */
export function mentionsPath(
	input: unknown,
	paths: readonly string[],
): boolean {
	let text: string | undefined;
	try {
		text = JSON.stringify(input);
	} catch {
		return paths.length > 0;
	}
	if (text === undefined) return false;
	const needles = paths
		.flatMap((p) => [p, baseName(p)])
		.filter((n) => n !== "")
		.flatMap((n) => [n, JSON.stringify(n).slice(1, -1)]);
	return needles.some((n) => text.includes(n));
}

/** Value to name, so a value read again does not grow the bucket. */
type Bucket = Map<string, string>;

const addTo = (bucket: Bucket, known: readonly Known[]) => {
	for (const { name, value } of known) {
		if (value.length >= MIN_KNOWN_LENGTH) bucket.set(value, name);
	}
};

/** R5, R6, R10: the per-session state. The `$` calls (`load`, `refreshIfNamed`, `addFile`) wrap it. */
export function createEnrollment() {
	const byFile = new Map<string, Bucket>();
	const written: Bucket = new Map();
	let files: FileStatus[] = [];
	let set: KnownSet | undefined;

	return {
		/** Replace the listed files' states in 1 step, and add their values to the values learned so far (R5). */
		apply(results: readonly ApplyFile[]): void {
			for (const { path, feed } of results) {
				const bucket = byFile.get(path) ?? new Map();
				addTo(bucket, feed);
				byFile.set(path, bucket);
			}
			files = statusOf(results).files;
			set = undefined;
		},
		learn(name: string, value: string): void {
			addTo(written, [{ name, value }]);
			set = undefined;
		},
		forget(path: string): void {
			byFile.delete(path);
			files = files.filter((f) => f.path !== path);
			set = undefined;
		},
		drop(): void {
			byFile.clear();
			written.clear();
			files = [];
			set = undefined;
		},
		knownSet(): KnownSet {
			if (!set) {
				const known: Known[] = [];
				for (const bucket of [written, ...byFile.values()]) {
					for (const [value, name] of bucket) known.push({ name, value });
				}
				set = buildKnownSet(known).set;
			}
			return set;
		},
		status(): Status {
			return statusOf(files);
		},
	};
}

export type Enrollment = ReturnType<typeof createEnrollment>;
