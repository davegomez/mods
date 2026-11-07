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
function spellingOk(path: string): boolean {
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

/** R2, F33: true when `path` is missing and may be created, false when it is a regular file under the root. */
async function checkPath(
	$: EngineInterface,
	root: Root,
	path: string,
): Promise<boolean> {
	const place = await locate($, root, path);
	if (!("state" in place)) return false;
	if (place.state.kind !== "missing") throw new Refusal(why(place.state));
	if (!(await parentInside($, root, path))) {
		throw new Refusal("parent-outside");
	}
	return true;
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

/** R3, Q36, F48: true when this save made git ignore `path`. Only the exit codes the spec names let the save go on. */
async function ensureIgnored(
	$: EngineInterface,
	root: Root,
	path: string,
): Promise<boolean> {
	const git = (args: string[]) =>
		$.process.run(["git", ...args], { cwd: root.real });
	const probe = await git(["rev-parse", "--is-inside-work-tree"]).catch(
		() => undefined,
	);
	if (probe?.exitCode !== 0 || probe.stdout.trim() !== "true") return false;
	const listed = await git([
		"--literal-pathspecs",
		"ls-files",
		"--error-unmatch",
		"--",
		path,
	]);
	if (listed.exitCode === 0) throw new Refusal("tracked");
	if (listed.exitCode !== 1) throw new Refusal("git-failed");
	const ignored = async () =>
		(await git(["check-ignore", "-q", "--", `./${path}`])).exitCode;
	const first = await ignored();
	if (first === 0) return false;
	if (first !== 1) throw new Refusal("git-failed");
	await appendIgnore($, root, path);
	const again = await ignored();
	if (again === 1) throw new Refusal("not-ignored");
	if (again !== 0) throw new Refusal("git-failed");
	return true;
}

/** R4, F50: the absolute target never starts with `-`, so it needs no `--`. */
async function chmod600($: EngineInterface, target: string): Promise<void> {
	const { exitCode } = await $.process.run(["chmod", "600", target]);
	if (exitCode !== 0) throw new Refusal("chmod-failed");
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
	try {
		return await save($, enrollment, path, name, value, at);
	} catch (error) {
		const reason = error instanceof Refusal ? error.message : "failed";
		return { ok: false, step: at.step, reason };
	}
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
	const created = await checkPath($, root, path);
	const before = created ? "" : await $.fs.read(target);

	at.step = "git";
	const ignoredNow = await ensureIgnored($, root, path);

	at.step = "create";
	let platform: Platform | undefined;
	if (created) {
		platform = await detectPlatform($);
		// Without a known stat argv the mode of a new file cannot be checked.
		if (platform === "unknown") throw new Refusal("unknown-platform");
		await $.fs.write(target, "");
		if (platform !== "windows") await chmod600($, target);
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

	// R10: the value is saved and verified; a failed status refresh does not undo that.
	await load($, enrollment, enrollment.listed()).catch(() => undefined);
	return {
		ok: true,
		created,
		ignoredNow,
		...(repaired ? { warning: "mode-repaired" as const } : {}),
	};
}
