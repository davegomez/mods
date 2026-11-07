/** Saves 1 value under 1 name in 1 env file in the session root, in an order that keeps the value off disk until git ignores the file and a new file has mode 600. */
import type { EngineInterface } from "claude-code";
import { parse, setValue } from "./dotenv.ts";
import {
	type Enrollment,
	type FileState,
	load,
	locate,
	parentInside,
	parseList,
	type Root,
	rootOf,
} from "./enroll.ts";
import { detectPlatform, type Platform } from "./entry.ts";

export type Step =
	| "path"
	| "git"
	| "create"
	| "changed"
	| "value"
	| "write"
	| "verify"
	| "mode";
export type Saved =
	| {
			ok: true;
			created: boolean;
			ignoredNow: boolean;
			warning?: "mode-repaired";
	  }
	| { ok: false; step: Step; reason: string };
/** R1: `ui` reads the `saveToEnvFile` setting; `write` does not. */
export type SaveMode = "ask" | "always" | "never";

/** Stops the save at the current step. `reason` is a fixed word, never the value (R12). */
class Refusal extends Error {}

/** R2 (F52): only characters no git pattern or pathspec treats as special. No segment is empty, `.`, `.git`, or starts with `-`. */
export function spellingOk(path: string): boolean {
	if (!/^[A-Za-z0-9._/-]+$/.test(path) || parseList(path)[0]?.refused) {
		return false;
	}
	return path
		.split("/")
		.every(
			(s) =>
				s !== "" &&
				s !== "." &&
				!s.startsWith("-") &&
				s.toLowerCase() !== ".git",
		);
}

const why = (state: FileState) =>
	"reason" in state ? state.reason : state.kind;

/** R2, F33: `created` when `path` is missing and may be created, else it is a regular file under the root. `folder` is its nearest existing folder (F59). */
async function checkPath(
	$: EngineInterface,
	root: Root,
	path: string,
): Promise<{ created: boolean; folder: string }> {
	const place = await locate($, root, path);
	if ("state" in place && place.state.kind !== "missing") {
		throw new Refusal(why(place.state));
	}
	const folder = await parentInside($, root, path);
	if (folder === undefined) throw new Refusal("parent-outside");
	return { created: "state" in place, folder };
}

/** R3: add `/<path>` to the root `.gitignore`, after the R2 checks on it, keeping its other lines. */
async function appendIgnore(
	$: EngineInterface,
	root: Root,
	path: string,
): Promise<void> {
	const place = await locate($, root, ".gitignore");
	let text = "";
	if (!("state" in place)) {
		text = await $.fs.read(`${root.real}${root.sep}.gitignore`);
	} else if (place.state.kind !== "missing") {
		throw new Refusal(`gitignore-${why(place.state)}`);
	}
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const gap = text === "" || /[\r\n]$/.test(text) ? "" : eol;
	await $.fs.write(
		`${root.real}${root.sep}.gitignore`,
		`${text}${gap}/${path}${eol}`,
	);
}

/** R3: 1 git command in `cwd`. Rejects when git does not start. */
function git($: EngineInterface, cwd: string, args: readonly string[]) {
	return $.process.run(["git", ...args], { cwd });
}

async function ignoredCode(
	$: EngineInterface,
	cwd: string,
	path: string,
): Promise<number> {
	return (await git($, cwd, ["check-ignore", "-q", "--", `./${path}`]))
		.exitCode;
}

export type GitProbe =
	| "outside"
	| "tracked"
	| "ignored"
	| "not-ignored"
	| "failed";

/**
 * R3, Q36: what the read-only commands say of the root-relative `path`, with `cwd` the root. A rev-parse that does not start
 * is `outside`; a later command that does not start rejects. `ui` R4 shows it too.
 */
export async function probeGit(
	$: EngineInterface,
	cwd: string,
	path: string,
): Promise<GitProbe> {
	const inside = await git($, cwd, [
		"rev-parse",
		"--is-inside-work-tree",
	]).catch(() => undefined);
	if (inside?.exitCode !== 0 || inside.stdout.trim() !== "true") {
		return "outside";
	}
	const listed = await git($, cwd, [
		"--literal-pathspecs",
		"ls-files",
		"--error-unmatch",
		"--",
		path,
	]);
	if (listed.exitCode === 0) return "tracked";
	if (listed.exitCode !== 1) return "failed";
	const ignored = await ignoredCode($, cwd, path);
	return ignored === 0 ? "ignored" : ignored === 1 ? "not-ignored" : "failed";
}

/** R3, Q36, F48: true when this save made git ignore `path`. Only the exit codes the spec names let the save go on. */
async function ensureIgnored(
	$: EngineInterface,
	root: Root,
	path: string,
	folder: string,
): Promise<boolean> {
	// F59: the checks below see only the root's index, so the target's folder must be in the root's work tree, or both in none (Q36).
	const top = (cwd: string) =>
		git($, cwd, ["rev-parse", "--show-toplevel"]).then(
			(r) => (r.exitCode === 0 ? r.stdout.replace(/\r?\n$/, "") : undefined),
			() => undefined,
		);
	if ((await top(folder)) !== (await top(root.real))) {
		throw new Refusal("nested-repository");
	}
	const probe = await probeGit($, root.real, path);
	if (probe === "outside" || probe === "ignored") return false;
	if (probe === "tracked") throw new Refusal("tracked");
	if (probe === "failed") throw new Refusal("git-failed");
	await appendIgnore($, root, path);
	const again = await ignoredCode($, root.real, path);
	if (again === 1) throw new Refusal("not-ignored");
	if (again !== 0) throw new Refusal("git-failed");
	return true;
}

/** R4, F50: the absolute target never starts with `-`, so it needs no `--`. */
async function chmod600($: EngineInterface, target: string): Promise<void> {
	const { exitCode } = await $.process.run(["chmod", "600", target]);
	if (exitCode !== 0) throw new Refusal("chmod-failed");
}

/**
 * R4, F60: links an empty mode-600 file at `target` only when nothing is there, since `$.fs.write` would truncate a file
 * that appeared after the path step. The temp name always goes: a second name would also receive the value.
 */
async function createEmpty($: EngineInterface, target: string): Promise<void> {
	const run = (argv: string[]) => $.process.run(argv).catch(() => undefined);
	const folder = target.slice(0, target.lastIndexOf("/"));
	const made = await run(["mktemp", `${folder}/.blindfold-XXXXXX`]);
	if (made?.exitCode !== 0) throw new Refusal("mktemp-failed");
	const temp = made.stdout.replace(/\n$/, "");
	const linked = await run(["ln", temp, target]);
	const removed = await run(["rm", temp]);
	if (linked?.exitCode !== 0) throw new Refusal("exists");
	if (removed?.exitCode !== 0) throw new Refusal("temp-left");
}

/** R9, F49: true when the mode was wrong and is now repaired. */
async function ensureMode(
	$: EngineInterface,
	platform: "macos" | "linux",
	target: string,
): Promise<boolean> {
	const argv =
		platform === "macos"
			? ["stat", "-f", "%Lp", target]
			: ["stat", "-c", "%a", target];
	const mode = async () => {
		const { exitCode, stdout } = await $.process.run(argv);
		if (exitCode !== 0) throw new Refusal("stat-failed");
		return stdout.trim();
	};
	if ((await mode()) === "600") return false;
	await chmod600($, target);
	if ((await mode()) !== "600") throw new Refusal("wrong-mode");
	return true;
}

/** R2 to R10: the steps in order; the first failure stops the save and names its step. Any rejection is reason `failed`, so no error text leaks (R12). */
export async function saveValue(
	$: EngineInterface,
	enrollment: Enrollment,
	path: string,
	name: string,
	value: string,
): Promise<Saved> {
	const at: { step: Step } = { step: "path" };
	let saved: Saved;
	try {
		saved = await save($, enrollment, path, name, value, at);
	} catch (error) {
		const reason = error instanceof Refusal ? error.message : "failed";
		saved = { ok: false, step: at.step, reason };
	}
	// R10, F61: from the write step on (success ends at step mode) the file may have changed, so the status reads it again.
	// A failed refresh does not undo a verified save.
	if (["write", "verify", "mode"].includes(at.step)) {
		await load($, enrollment, enrollment.listed()).catch(() => undefined);
	}
	return saved;
}

async function save(
	$: EngineInterface,
	enrollment: Enrollment,
	path: string,
	name: string,
	value: string,
	at: { step: Step },
): Promise<Saved> {
	if (!spellingOk(path)) throw new Refusal("bad-path");
	const root = await rootOf($);
	if (!root) throw new Refusal("no-root");
	// F51: 1 absolute target for every $.fs call, chmod, and stat; `path` stays root-relative for git and enroll.
	const target = `${root.real}${root.sep}${path}`;
	const { created, folder } = await checkPath($, root, path);
	const before = created ? "" : await $.fs.read(target);

	at.step = "git";
	const ignoredNow = await ensureIgnored($, root, path, folder);

	at.step = "create";
	let platform: Platform | undefined;
	if (created) {
		platform = await detectPlatform($);
		// Without a known stat argv the mode of a new file cannot be checked.
		if (platform === "unknown") throw new Refusal("unknown-platform");
		if (platform === "windows") {
			// shortcut: Windows has no exclusive create here, so a file made between this stat and the write is truncated; upgrade when `$.fs` gains an exclusive create.
			const again = await locate($, root, path);
			if (!("state" in again) || again.state.kind !== "missing") {
				throw new Refusal("exists");
			}
			await $.fs.write(target, "");
		} else {
			await createEmpty($, target);
			await chmod600($, target);
		}
	}

	at.step = "changed";
	// The path check again right before the write: a swap since the path step stops here.
	const place = await locate($, root, path);
	if ("state" in place) throw new Refusal(why(place.state));
	if ((await $.fs.read(target)) !== before) throw new Refusal("changed");

	at.step = "value";
	const next = setValue(before, name, value);
	if (!next.ok) throw new Refusal(next.reason);

	at.step = "write";
	// F47: the shield masks the value from now on, also when a later step fails.
	enrollment.learn(path, name, value);
	await $.fs.write(target, next.text);

	at.step = "verify";
	const parsed = parse(await $.fs.read(target));
	const entries = "entries" in parsed ? parsed.entries : [];
	if (entries.filter((e) => e.name === name).at(-1)?.value !== value) {
		throw new Refusal("mismatch");
	}

	at.step = "mode";
	const repaired =
		platform === "macos" || platform === "linux"
			? await ensureMode($, platform, target)
			: false;

	return {
		ok: true,
		created,
		ignoredNow,
		...(repaired ? { warning: "mode-repaired" as const } : {}),
	};
}
