import type { ProcessRunResult } from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import { DEFAULT_LIMITS, scanText } from "../hooks/detect.ts";
import { createEnrollment } from "../hooks/enroll.ts";
import { type Saved, saveValue } from "../hooks/write.ts";
import {
	type FakeCall,
	type FakeFile,
	type FakeOptions,
	fakeApi,
	fakes,
	REAL_ROOT,
} from "./fakes.ts";

const VALUE = fakes(31).secret(32);
const TARGET = `${REAL_ROOT}/.env`;
const never = { now: () => 0, deadline: Number.POSITIVE_INFINITY };

type Cmd =
	| "uname"
	| "rev-parse"
	| "ls-files"
	| "check-ignore"
	| "chmod"
	| "stat";
type Answer = (argv: readonly string[]) => Partial<ProcessRunResult>;

const cmdOf = (argv: readonly string[]): Cmd =>
	(argv[0] === "git"
		? argv.find((a) => ["rev-parse", "ls-files", "check-ignore"].includes(a))
		: argv[0]) as Cmd;

/** A fake `$` whose commands act like macOS with git: chmod sets the mode `stat` reads, check-ignore reads the root `.gitignore`. */
function setup(
	files: Record<string, FakeFile>,
	over: Partial<Record<Cmd, Answer>> = {},
	options: FakeOptions = {},
) {
	let mode = "644";
	const ignored = (argv: readonly string[]) =>
		(files[".gitignore"]?.text ?? "")
			.split(/\r?\n/)
			.includes(`/${(argv.at(-1) ?? "").slice(2)}`);
	const defaults: Record<Cmd, Answer> = {
		uname: () => ({ stdout: "Darwin\n" }),
		"rev-parse": () => ({ stdout: "true\n" }),
		"ls-files": () => ({ exitCode: 1 }),
		"check-ignore": (argv) => ({ exitCode: ignored(argv) ? 0 : 1 }),
		chmod: () => {
			mode = "600";
			return {};
		},
		stat: () => ({ stdout: `${mode}\n` }),
	};
	const fake = fakeApi(files, {
		run: (argv) => {
			const cmd = cmdOf(argv);
			return (over[cmd] ?? defaults[cmd])(argv);
		},
		...options,
	});
	const enrollment = createEnrollment();
	enrollment.relist(".env");
	const learn = enrollment.learn;
	enrollment.learn = (...args) => {
		fake.calls.push({ noun: "learn", args: [] });
		learn(...args);
	};
	const save = async (path = ".env", name = "API_KEY", value = VALUE) => {
		const saved = await saveValue(fake.api, enrollment, path, name, value);
		// R12: no result holds the value.
		expect(JSON.stringify(saved).includes(VALUE)).toBe(false);
		return saved;
	};
	return { ...fake, files, enrollment, save };
}

const runs = (calls: FakeCall[]) =>
	calls
		.filter((c) => c.noun === "process.run")
		.map((c) => c.args[0] as string[]);
const writes = (calls: FakeCall[]) =>
	calls.filter((c) => c.noun === "fs.write");
const indexOf = (calls: FakeCall[], match: (c: FakeCall) => boolean) =>
	calls.findIndex(match);
const isRun = (cmd: Cmd) => (c: FakeCall) =>
	c.noun === "process.run" && cmdOf(c.args[0] as string[]) === cmd;
const holdsValue = (c: FakeCall) =>
	c.noun === "fs.write" && String(c.args[1]).includes(VALUE);
const known = (enrollment: ReturnType<typeof createEnrollment>) =>
	scanText(VALUE, enrollment.knownSet(), DEFAULT_LIMITS, never).status;
const refused = (
	step: Extract<Saved, { ok: false }>["step"],
	reason: string,
) => ({
	ok: false,
	step,
	reason,
});

const ignoredRepo = () => ({ ".gitignore": { text: "/.env\n" } });

describe("write R2: the path step", () => {
	const spellings = [
		"a b.env",
		".env;x",
		".env$x",
		"é.env",
		"-x.env",
		"dir/-x.env",
		"/etc/.env",
		"../.env",
		"dir/../.env",
		"a//.env",
		"./.env",
		".env/",
		"",
		"C:.env",
		"dir\\.env",
		".git/config",
		"sub/.GIT/x",
		"[x].env",
		"*.env",
	];
	for (const path of spellings) {
		test(`R2, F52: ${JSON.stringify(path)} is refused before any $ call`, async () => {
			const s = setup({});
			expect(await s.save(path)).toEqual(refused("path", "bad-path"));
			expect(s.calls).toEqual([]);
		});
	}

	test("R2: a symbolic link is refused, and nothing is written", async () => {
		const s = setup({ ...ignoredRepo(), ".env": { text: "", isLink: true } });
		expect(await s.save()).toEqual(refused("path", "symlink"));
		expect(writes(s.calls)).toEqual([]);
		expect(runs(s.calls)).toEqual([]);
	});

	test("R2: a real path outside the root is refused", async () => {
		const s = setup({ ".env": { text: "", realPath: "/elsewhere/.env" } });
		expect(await s.save()).toEqual(refused("path", "outside-root"));
		expect(writes(s.calls)).toEqual([]);
	});

	test("R2: a path that is not a regular file is refused", async () => {
		const s = setup({ ".env": { kind: "dir" } });
		expect(await s.save()).toEqual(refused("path", "not-a-file"));
	});

	test("F33: a missing file under a folder linked outside the root is refused", async () => {
		const s = setup({ sub: { kind: "dir", realPath: "/elsewhere/sub" } });
		expect(await s.save("sub/.env")).toEqual(refused("path", "parent-outside"));
		expect(writes(s.calls)).toEqual([]);
	});

	test("F33: a missing file under a real folder in the root is created", async () => {
		const s = setup({ sub: { kind: "dir" } });
		expect(await s.save("sub/.env")).toEqual({
			ok: true,
			created: true,
			ignoredNow: true,
		});
		expect(s.files["sub/.env"]?.text).toBe(`API_KEY='${VALUE}'\n`);
	});

	test("R2: an existing file keeps its other lines, and is neither created nor chmod-ed", async () => {
		const s = setup({ ...ignoredRepo(), ".env": { text: "A=1\n# note\n" } });
		expect(await s.save()).toEqual({
			ok: true,
			created: false,
			ignoredNow: false,
		});
		expect(s.files[".env"]?.text).toBe(`A=1\n# note\nAPI_KEY='${VALUE}'\n`);
		expect(runs(s.calls).map(cmdOf)).toEqual([
			"rev-parse",
			"ls-files",
			"check-ignore",
		]);
	});
});

describe("write R3: the git step", () => {
	test("R3, F52: git runs in the root with literal path operands", async () => {
		const s = setup({ ...ignoredRepo(), ".env": { text: "" } });
		await s.save();
		const git = s.calls
			.filter(isRun("rev-parse"))
			.concat(
				s.calls.filter(isRun("ls-files")),
				s.calls.filter(isRun("check-ignore")),
			);
		expect(git.map((c) => c.args)).toEqual([
			[["git", "rev-parse", "--is-inside-work-tree"], { cwd: REAL_ROOT }],
			[
				[
					"git",
					"--literal-pathspecs",
					"ls-files",
					"--error-unmatch",
					"--",
					".env",
				],
				{ cwd: REAL_ROOT },
			],
			[["git", "check-ignore", "-q", "--", "./.env"], { cwd: REAL_ROOT }],
		]);
	});

	test("R3: a tracked file is refused before any write", async () => {
		const s = setup({ ".env": { text: "" } }, { "ls-files": () => ({}) });
		expect(await s.save()).toEqual(refused("git", "tracked"));
		expect(writes(s.calls)).toEqual([]);
	});

	test("F48: ls-files exit 128 refuses", async () => {
		const s = setup({}, { "ls-files": () => ({ exitCode: 128 }) });
		expect(await s.save()).toEqual(refused("git", "git-failed"));
		expect(writes(s.calls)).toEqual([]);
	});

	test("F48: check-ignore exit 128 refuses", async () => {
		const s = setup({}, { "check-ignore": () => ({ exitCode: 128 }) });
		expect(await s.save()).toEqual(refused("git", "git-failed"));
		expect(writes(s.calls)).toEqual([]);
	});

	test("F48: check-ignore exit 128 after the append refuses", async () => {
		let n = 0;
		const s = setup(
			{},
			{ "check-ignore": () => ({ exitCode: n++ ? 128 : 1 }) },
		);
		expect(await s.save()).toEqual(refused("git", "git-failed"));
		expect(writes(s.calls).map((c) => c.args[0])).toEqual([
			`${REAL_ROOT}/.gitignore`,
		]);
	});

	test("R3: a file not ignored gets /<path> appended to the root .gitignore, with a line ending added", async () => {
		const s = setup({ ".gitignore": { text: "node_modules" } });
		expect(await s.save()).toEqual({
			ok: true,
			created: true,
			ignoredNow: true,
		});
		expect(s.files[".gitignore"]?.text).toBe("node_modules\n/.env\n");
	});

	test("R3: a missing .gitignore is created with the 1 line", async () => {
		const s = setup({});
		await s.save(".env.local");
		expect(s.files[".gitignore"]?.text).toBe("/.env.local\n");
	});

	test("R3: a CRLF .gitignore keeps CRLF", async () => {
		const s = setup({ ".gitignore": { text: "a\r\nb\r\n" } });
		await s.save();
		expect(s.files[".gitignore"]?.text).toBe("a\r\nb\r\n/.env\r\n");
	});

	test("R3: a .gitignore that is a link is refused", async () => {
		const s = setup({ ".gitignore": { text: "", isLink: true } });
		expect(await s.save()).toEqual(refused("git", "gitignore-symlink"));
		expect(writes(s.calls)).toEqual([]);
	});

	test("R3: check-ignore still 1 after the append refuses", async () => {
		const s = setup({}, { "check-ignore": () => ({ exitCode: 1 }) });
		expect(await s.save()).toEqual(refused("git", "not-ignored"));
		expect(s.calls.filter(isRun("check-ignore")).length).toBe(2);
		expect(writes(s.calls).map((c) => c.args[0])).toEqual([
			`${REAL_ROOT}/.gitignore`,
		]);
	});

	test("Q36: outside a work tree the git step is skipped", async () => {
		const s = setup({}, { "rev-parse": () => ({ exitCode: 128 }) });
		expect(await s.save()).toEqual({
			ok: true,
			created: true,
			ignoredNow: false,
		});
		expect(s.calls.some(isRun("ls-files"))).toBe(false);
		expect(".gitignore" in s.files).toBe(false);
	});

	test("Q36: git that does not start skips the git step", async () => {
		const s = setup(
			{},
			{
				"rev-parse": () => {
					throw new Error("ENOENT git");
				},
			},
		);
		expect(await s.save()).toEqual({
			ok: true,
			created: true,
			ignoredNow: false,
		});
		expect(s.calls.some(isRun("ls-files"))).toBe(false);
	});
});

describe("write R4: the create step", () => {
	test("R4: chmod non-zero refuses, after only the empty write, and the value is not learned", async () => {
		const s = setup(ignoredRepo(), { chmod: () => ({ exitCode: 1 }) });
		expect(await s.save()).toEqual(refused("create", "chmod-failed"));
		expect(writes(s.calls).map((c) => c.args)).toEqual([[TARGET, ""]]);
		expect(known(s.enrollment)).toBe("clean");
	});

	test("R4: on Windows chmod and stat do not run", async () => {
		const s = setup(ignoredRepo(), {}, { env: { OS: "Windows_NT" } });
		expect(await s.save()).toEqual({
			ok: true,
			created: true,
			ignoredNow: false,
		});
		expect(runs(s.calls).map(cmdOf)).toEqual([
			"rev-parse",
			"ls-files",
			"check-ignore",
		]);
	});

	test("R4: an unknown platform refuses before the file is created", async () => {
		const s = setup(ignoredRepo(), { uname: () => ({ stdout: "SunOS\n" }) });
		expect(await s.save()).toEqual(refused("create", "unknown-platform"));
		expect(writes(s.calls)).toEqual([]);
	});
});

describe("write R5: the changed step", () => {
	test("R5: a file changed since the path step is refused", async () => {
		const files: Record<string, FakeFile> = {
			...ignoredRepo(),
			".env": { text: "A=1\n" },
		};
		const s = setup(files, {
			"ls-files": () => {
				files[".env"] = { text: "A=2\n" };
				return { exitCode: 1 };
			},
		});
		expect(await s.save()).toEqual(refused("changed", "changed"));
		expect(writes(s.calls)).toEqual([]);
	});

	test("R5: a file swapped for a link since the path step is refused", async () => {
		const files: Record<string, FakeFile> = {
			...ignoredRepo(),
			".env": { text: "" },
		};
		const s = setup(files, {
			"ls-files": () => {
				files[".env"] = { text: "", isLink: true };
				return { exitCode: 1 };
			},
		});
		expect(await s.save()).toEqual(refused("changed", "symlink"));
		expect(writes(s.calls)).toEqual([]);
	});
});

describe("write R6, F54: the value step forwards the setValue reason", () => {
	const cases: [string, string, string, string][] = [
		["bad-name", "", "1BAD", VALUE],
		["bad-name", "", "__proto__", VALUE],
		["unsafe-value", "", "API_KEY", `${VALUE}'"`],
		["duplicate-name", "API_KEY=a\nAPI_KEY=b\n", "API_KEY", VALUE],
		["too-large", `X=${"a".repeat(140_000)}\n`, "API_KEY", VALUE],
	];
	for (const [reason, text, name, value] of cases) {
		test(`R6, F54: ${reason} (${name})`, async () => {
			const s = setup({ ...ignoredRepo(), ".env": { text } });
			expect(await s.save(".env", name, value)).toEqual(
				refused("value", reason),
			);
			expect(writes(s.calls)).toEqual([]);
			expect(known(s.enrollment)).toBe("clean");
		});
	}
});

describe("write R7, R8: the write and verify steps", () => {
	test("R7: a failed write refuses with step write, and the value stays learned", async () => {
		const s = setup({ ...ignoredRepo(), ".env": { text: "" } });
		s.api.fs.write = async () => {
			throw new Error(`EIO ${VALUE}`);
		};
		expect(await s.save()).toEqual(refused("write", "failed"));
		expect(known(s.enrollment)).toBe("found");
	});

	test("R8: a failed verify refuses, the name is not marked set, and the value stays learned (F47)", async () => {
		const s = setup(
			{ ...ignoredRepo(), ".env": { text: "" } },
			{},
			{ onWrite: (_rel, text) => text.replace(VALUE, "other-value-1234") },
		);
		expect(await s.save()).toEqual(refused("verify", "mismatch"));
		expect(known(s.enrollment)).toBe("found");
		expect(s.enrollment.status().files).toEqual([]);
	});

	test("R8: verify reads the last entry for the name", async () => {
		const s = setup(
			{ ...ignoredRepo(), ".env": { text: "" } },
			{},
			{ onWrite: (_rel, text) => `${text}API_KEY=late\n` },
		);
		expect(await s.save()).toEqual(refused("verify", "mismatch"));
	});
});

describe("write R9, F49, F50: the mode step", () => {
	test("F50: on macOS chmod and stat take the absolute target", async () => {
		const s = setup(ignoredRepo());
		await s.save();
		expect(
			runs(s.calls).filter((a) => ["chmod", "stat"].includes(a[0] ?? "")),
		).toEqual([
			["chmod", "600", TARGET],
			["stat", "-f", "%Lp", TARGET],
		]);
	});

	test("F50: on Linux stat reads the mode with -c %a", async () => {
		const s = setup(ignoredRepo(), { uname: () => ({ stdout: "Linux\n" }) });
		expect((await s.save()).ok).toBe(true);
		expect(runs(s.calls).find((a) => a[0] === "stat")).toEqual([
			"stat",
			"-c",
			"%a",
			TARGET,
		]);
	});

	test("R9, F49: a wrong mode is repaired, with the warning", async () => {
		const modes = ["644", "600"];
		const s = setup(ignoredRepo(), {
			stat: () => ({ stdout: `${modes.shift()}\n` }),
		});
		expect(await s.save()).toEqual({
			ok: true,
			created: true,
			ignoredNow: false,
			warning: "mode-repaired",
		});
		expect(s.calls.filter(isRun("chmod")).length).toBe(2);
	});

	test("R9: a mode still wrong after the repair refuses", async () => {
		const s = setup(ignoredRepo(), { stat: () => ({ stdout: "644\n" }) });
		expect(await s.save()).toEqual(refused("mode", "wrong-mode"));
	});

	test("R9: stat non-zero refuses", async () => {
		const s = setup(ignoredRepo(), { stat: () => ({ exitCode: 1 }) });
		expect(await s.save()).toEqual(refused("mode", "stat-failed"));
	});

	test("R9: the repair chmod non-zero refuses", async () => {
		let n = 0;
		const s = setup(ignoredRepo(), {
			stat: () => ({ stdout: "644\n" }),
			chmod: () => ({ exitCode: n++ ? 1 : 0 }),
		});
		expect(await s.save()).toEqual(refused("mode", "chmod-failed"));
	});
});

describe("write: the order", () => {
	test("R3, R4, F47, F51: git before any write, chmod and learn before the value write, the absolute target everywhere", async () => {
		const s = setup({ ".gitignore": { text: "" } });
		expect((await s.save()).ok).toBe(true);
		const { calls } = s;
		const firstTargetWrite = indexOf(
			calls,
			(c) => c.noun === "fs.write" && c.args[0] === TARGET,
		);
		const valueWrite = indexOf(calls, holdsValue);
		const lastGit = calls.findLastIndex(
			(c) => c.noun === "process.run" && (c.args[0] as string[])[0] === "git",
		);
		// Each call happened (no -1), and in this order.
		const order = [
			indexOf(calls, isRun("ls-files")),
			indexOf(calls, (c) => c.noun === "fs.write"),
			lastGit,
			firstTargetWrite,
			indexOf(calls, isRun("chmod")),
			indexOf(calls, (c) => c.noun === "learn"),
			valueWrite,
		];
		expect(order[0]).toBeGreaterThan(-1);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(new Set(order).size).toBe(order.length);

		// F51: every fs call is absolute, and every one on the env file names the 1 target.
		const fsPaths = calls
			.filter((c) => c.noun.startsWith("fs."))
			.map((c) => String(c.args[0]));
		expect(fsPaths.every((p) => p.startsWith("/"))).toBe(true);
		expect(
			fsPaths.filter((p) => p.endsWith("/.env")).every((p) => p === TARGET),
		).toBe(true);
		expect(fsPaths.filter((p) => p === TARGET).length).toBeGreaterThan(0);
	});
});

describe("write R10: the status", () => {
	test("R10: after a save the status shows the name as set", async () => {
		const s = setup(ignoredRepo());
		expect((await s.save()).ok).toBe(true);
		expect(s.enrollment.status().files).toEqual([
			{
				path: ".env",
				state: { kind: "active", names: [{ name: "API_KEY", hidden: true }] },
			},
		]);
	});
});

describe("write R12: no leak", () => {
	test("R12: no argv, env, or stdin holds the value; only fs.write text does", async () => {
		const s = setup({ ".gitignore": { text: "" } });
		await s.save();
		const failed = setup(ignoredRepo(), { stat: () => ({ exitCode: 1 }) });
		await failed.save();
		for (const calls of [s.calls, failed.calls]) {
			expect(calls.some(holdsValue)).toBe(true);
			const others = calls.filter((c) => c.noun !== "fs.write");
			expect(JSON.stringify(others).includes(VALUE)).toBe(false);
		}
	});
});
