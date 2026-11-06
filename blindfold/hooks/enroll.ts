/** Which env files are listed, which of their values are secret, and the known-value set built from them. Values stay in this module's closures. */
import type { EngineInterface } from "claude-code";
import {
	buildKnownSet,
	DEFAULT_LIMITS,
	type Known,
	type KnownSet,
	MIN_KNOWN_LENGTH,
	scanText,
} from "./detect.ts";
import { type Entry, parse } from "./dotenv.ts";

export type StaleReason = "read-failed" | "too-large" | "not-a-file";
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
	| { kind: "stale"; reason: StaleReason }
	| { kind: "refused"; reason: RefusedReason };
export type FileStatus = { path: string; state: FileState };
export type Status = { files: FileStatus[]; shield: "active" | "degraded" };
/** The outcome of reading 1 listed file: its state, and the values it feeds (none unless it was read). */
export type ApplyFile = FileStatus & { feed: Known[] };
export type ListEntry = { path: string; refused?: RefusedReason };

export const MAX_FILES = 10;
/** R3: the largest file `load` reads, by its `stat` size. */
export const MAX_FILE_BYTES = 1_048_576;

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

/** R10: `text`, or `placeholder` when `known` finds a kept value in it or cannot scan it. */
function shown(text: string, known: KnownSet, placeholder: string): string {
	const scan = scanText(text, known, DEFAULT_LIMITS, NO_DEADLINE);
	const hit =
		scan.status === "unscannable" ||
		(scan.status === "found" && scan.hits.some((h) => h.kind === "known"));
	return hit ? placeholder : text;
}

/** R6: degraded when any listed file is stale or refused. R10: copies only path and state, and hides a path or a name that holds a value of `known`. */
export function statusOf(
	files: readonly FileStatus[],
	known: KnownSet = NO_KNOWN,
): Status {
	const degraded = files.some(
		(f) => f.state.kind === "stale" || f.state.kind === "refused",
	);
	return {
		files: files.map(({ path, state }) => ({
			path: shown(path, known, "[hidden path]"),
			state:
				state.kind === "active"
					? {
							kind: "active",
							names: state.names.map((n) => ({
								...n,
								name: shown(n.name, known, "[hidden name]"),
							})),
						}
					: state,
		})),
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

/** The session root as its real path, and its separator. */
type Root = { real: string; sep: string };

const stale = (reason: StaleReason): FileState => ({ kind: "stale", reason });
const refuse = (reason: RefusedReason): FileState => ({
	kind: "refused",
	reason,
});

/** R2: the session root resolved the way a file is, or undefined when it does not resolve. */
async function rootOf($: EngineInterface): Promise<Root | undefined> {
	try {
		const { realPath } = await $.fs.stat(await $.session.root(), {
			resolve: true,
		});
		if (realPath === undefined) return undefined;
		// `$` has no separator of its own: a POSIX root starts with `/`, a Windows drive or share does not.
		const sep = realPath.startsWith("/") ? "/" : "\\";
		// On POSIX a trailing `\` is part of the folder name, not a separator.
		return { real: realPath.replace(sep === "/" ? /\/+$/ : /\\+$/, ""), sep };
	} catch {
		return undefined;
	}
}

/** R2, R10: where an accepted path lands when it is a regular file under the root, else the state that stops its read. An `$.fs` error becomes a reason. */
async function locate(
	$: EngineInterface,
	root: Root,
	path: string,
): Promise<{ state: FileState } | { realPath: string; size: number }> {
	const full = `${root.real}${root.sep}${path}`;
	let stat: Awaited<ReturnType<EngineInterface["fs"]["stat"]>>;
	try {
		stat = await $.fs.stat(full, { resolve: true });
	} catch {
		// A stat rejects for a missing path and for any other failure alike.
		const exists = await $.fs.exists(full).catch(() => true);
		return { state: exists ? stale("read-failed") : { kind: "missing" } };
	}
	if (stat.isLink) return { state: refuse("symlink") };
	const { realPath } = stat;
	if (realPath === undefined || !realPath.startsWith(root.real + root.sep)) {
		return { state: refuse("outside-root") };
	}
	if (stat.kind !== "file") return { state: stale("not-a-file") };
	return { realPath, size: stat.size };
}

/** R9: the nearest folder that exists above a missing `path` is a folder, and is the root or under it. */
async function parentInside(
	$: EngineInterface,
	root: Root,
	path: string,
): Promise<boolean> {
	const parts = path.split(root.sep === "/" ? "/" : /[/\\]/);
	for (let n = parts.length - 1; n > 0; n--) {
		const dir = `${root.real}${root.sep}${parts.slice(0, n).join(root.sep)}`;
		try {
			const { kind, realPath } = await $.fs.stat(dir, { resolve: true });
			return (
				kind === "dir" &&
				realPath !== undefined &&
				(realPath === root.real || realPath.startsWith(root.real + root.sep))
			);
		} catch {
			if (await $.fs.exists(dir).catch(() => true)) return false;
		}
	}
	return true;
}

/** R2, R3: 1 listed entry's state and the values it feeds. Only an active file feeds; a stale one keeps its old values (R6). */
async function readEntry(
	$: EngineInterface,
	root: Root | undefined,
	{ path, refused }: ListEntry,
): Promise<ApplyFile> {
	const without = (state: FileState): ApplyFile => ({ path, state, feed: [] });
	if (refused) return without(refuse(refused));
	if (!root) return without(stale("read-failed"));
	const place = await locate($, root, path);
	if ("state" in place) return without(place.state);
	if (place.size > MAX_FILE_BYTES) return without(stale("too-large"));
	let text: string;
	try {
		text = await $.fs.read(place.realPath);
	} catch {
		return without(stale("read-failed"));
	}
	// shortcut: stat again narrows a swap during the read but cannot close it (Q25); a no-follow read in $.fs would.
	const again = await locate($, root, path);
	if ("state" in again || again.realPath !== place.realPath) {
		return without(stale("read-failed"));
	}
	const parsed = parse(text);
	if ("tooLarge" in parsed) return without(stale("too-large"));
	const { names, feed } = classify(parsed.entries);
	return { path, state: { kind: "active", names }, feed };
}

/** R5, R6, R8, R10: the per-session state. The host refuses `$` passed to a method, so `load`, `refreshIfNamed`, and `addFile` are functions that take it. */
export function createEnrollment() {
	const byFile = new Map<string, Bucket>();
	let files: FileStatus[] = [];
	let set: KnownSet | undefined;
	let generation = 0;
	let list = "";
	let adding: Promise<unknown> = Promise.resolve();

	const feed = (path: string, known: readonly Known[]) => {
		const bucket = byFile.get(path) ?? new Map();
		addTo(bucket, known);
		byFile.set(path, bucket);
		set = undefined;
	};

	/** Replace the listed files' states in 1 step, and add their values to the values learned so far (R5). */
	const apply = (results: readonly ApplyFile[]): void => {
		for (const { path, feed: known } of results) feed(path, known);
		files = results.map(({ path, state }) => ({ path, state }));
	};

	const knownSet = (): KnownSet => {
		if (!set) {
			const known: Known[] = [];
			for (const bucket of byFile.values()) {
				for (const [value, name] of bucket) known.push({ name, value });
			}
			set = buildKnownSet(known).set;
		}
		return set;
	};

	return {
		apply,
		/** R8: take a new generation for a load of `listed`, and keep the list for `refreshIfNamed` and `addFile`. */
		begin(listed: string): number {
			list = listed;
			return ++generation;
		},
		/** R8: apply only when no newer load or drop took a generation meanwhile. */
		finish(mine: number, results: readonly ApplyFile[]): void {
			if (mine === generation) apply(results);
		},
		/** The list of the last load, or of the last `addFile`. */
		listed(): string {
			return list;
		},
		relist(listed: string): void {
			list = listed;
		},
		/** R9: run `task` after every earlier one, so 2 adds never build on the same list. */
		serial<T>(task: () => Promise<T>): Promise<T> {
			const run = adding.then(task);
			adding = run.catch(() => {});
			return run;
		},
		/** R4: a value blindfold wrote to `path`; `forget(path)` drops it with the file's own. */
		learn(path: string, name: string, value: string): void {
			feed(path, [{ name, value }]);
		},
		/** R8: takes a generation, so a load still running cannot bring the file back. */
		forget(path: string): void {
			generation++;
			byFile.delete(path);
			files = files.filter((f) => f.path !== path);
			set = undefined;
		},
		/** R8: takes a generation too, so a load still running adds nothing. Clears the list, so a late refresh reads nothing. */
		drop(): void {
			generation++;
			list = "";
			byFile.clear();
			files = [];
			set = undefined;
		},
		knownSet,
		status(): Status {
			return statusOf(files, knownSet());
		},
	};
}

export type Enrollment = ReturnType<typeof createEnrollment>;

/** R1, R8: read every listed file again. The result applies only if no newer load or drop came meanwhile. */
export async function load(
	$: EngineInterface,
	enrollment: Enrollment,
	list: string,
): Promise<Status> {
	const mine = enrollment.begin(list);
	const root = await rootOf($);
	const results = await Promise.all(
		parseList(list).map((entry) => readEntry($, root, entry)),
	);
	enrollment.finish(mine, results);
	return enrollment.status();
}

/** R7: load again when the input names a listed file. */
export async function refreshIfNamed(
	$: EngineInterface,
	enrollment: Enrollment,
	input: unknown,
): Promise<void> {
	const list = enrollment.listed();
	const paths = parseList(list).map((entry) => entry.path);
	if (mentionsPath(input, paths)) await load($, enrollment, list);
}

const ENV_FILES_KEY = "blindfold.envFiles";

type Added = "added" | "refused" | "denied";

/** R9 (Q9): list 1 more file in `envFiles`, after the R2 checks. A missing file is accepted, because `write` creates it. Adds run 1 at a time. */
export function addFile(
	$: EngineInterface,
	enrollment: Enrollment,
	path: string,
): Promise<Added> {
	return enrollment.serial(() => addOne($, enrollment, path));
}

async function addOne(
	$: EngineInterface,
	enrollment: Enrollment,
	path: string,
): Promise<Added> {
	const wanted = path.trim();
	// A comma would split the path into 2 entries of the list.
	if (wanted.includes(",")) return "refused";
	const [spelled] = parseList(wanted);
	if (!spelled || spelled.refused) return "refused";
	const root = await rootOf($);
	if (!root) return "refused";
	const place = await locate($, root, wanted);
	if ("state" in place) {
		if (place.state.kind !== "missing") return "refused";
		if (!(await parentInside($, root, wanted))) return "refused";
	}
	// Read the list after the awaits, so a load that came meanwhile is kept.
	const current = parseList(enrollment.listed()).map((entry) => entry.path);
	if (current.includes(wanted)) return "added";
	const value = [...current, wanted].join(",");
	if (parseList(value).at(-1)?.refused) return "refused";
	const result = await $.config
		.set({ key: ENV_FILES_KEY, value })
		.catch(() => ({ deny: "failed" }));
	if (result.deny !== undefined) return "denied";
	// The plugin reloads on a config change, maybe later: keep the new list so a 2nd add keeps the 1st.
	enrollment.relist(value);
	return "added";
}
