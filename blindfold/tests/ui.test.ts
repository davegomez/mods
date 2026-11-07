import { describe, expect, test } from "claude-code/testing";
import { buildKnownSet } from "../hooks/detect.ts";
import { type FileStatus, type Status, statusOf } from "../hooks/enroll.ts";
import type { Request } from "../hooks/request.ts";
import {
	type Command,
	canonicalArgs,
	type GitState,
	type Outcome,
	outcomeText,
	parseCommand,
	rowsOf,
	statusLine,
	targetFile,
} from "../hooks/ui.ts";
import { fakes } from "./fakes.ts";

const fake = fakes(41);
const noValue = () => false;

describe("R1 parseCommand (Q39)", () => {
	test("R1: empty or blank arguments open the pane", () => {
		expect(parseCommand("", noValue)).toEqual({ kind: "open" });
		expect(parseCommand("  \t ", noValue)).toEqual({ kind: "open" });
	});

	test("R1: set NAME and add NAME carry the name, with any spacing", () => {
		expect(parseCommand("set API_KEY", noValue)).toEqual({
			kind: "set",
			name: "API_KEY",
		});
		expect(parseCommand("  add   _TOKEN2 ", noValue)).toEqual({
			kind: "add",
			name: "_TOKEN2",
		});
	});

	test("R1: dismiss and refresh take no name", () => {
		expect(parseCommand("dismiss", noValue)).toEqual({ kind: "dismiss" });
		expect(parseCommand(" refresh ", noValue)).toEqual({ kind: "refresh" });
	});

	for (const args of [
		"set",
		"add",
		"set API_KEY extra",
		`set API_KEY ${fake.secret(20)}`,
		"dismiss now",
		"refresh API_KEY",
		"open",
		"SET API_KEY",
		"set 1BAD",
		"set bad-name",
		"set __proto__",
		`set A${"B".repeat(64)}`,
		"add KEY=value",
		fake.secret(24),
	]) {
		test(`R1 (Q39): "${args.slice(0, 12)}…" is refused`, () => {
			expect(parseCommand(args, noValue)).toEqual({ kind: "refused" });
		});
	}

	test("R1 (F64): a name with a known-value hit is refused, and the predicate sees only the name", () => {
		const seen: string[] = [];
		const value = `K${fake.secret(23)}`;
		const holdsValue = (name: string) => {
			seen.push(name);
			return name === value;
		};
		expect(parseCommand(`set ${value}`, holdsValue)).toEqual({
			kind: "refused",
		});
		expect(parseCommand(`add ${value}`, holdsValue)).toEqual({
			kind: "refused",
		});
		expect(parseCommand("set API_KEY", holdsValue)).toEqual({
			kind: "set",
			name: "API_KEY",
		});
		expect(seen).toEqual([value, value, "API_KEY"]);
	});
});

describe("R1 canonicalArgs (F64)", () => {
	const cases: [Command, string][] = [
		[{ kind: "set", name: "API_KEY" }, "set API_KEY"],
		[{ kind: "add", name: "API_KEY" }, "add API_KEY"],
		[{ kind: "dismiss" }, "dismiss"],
		[{ kind: "refresh" }, "refresh"],
		[{ kind: "open" }, ""],
		[{ kind: "refused" }, ""],
	];
	for (const [command, args] of cases) {
		test(`R1 (F64): ${command.kind} is "${args}"`, () => {
			expect(canonicalArgs(command)).toBe(args);
		});
	}

	test("R1 (F64): a refused argument leaves nothing of itself", () => {
		const value = fake.secret(24);
		expect(canonicalArgs(parseCommand(`set API_KEY ${value}`, noValue))).toBe(
			"",
		);
	});

	test("R1 (F64): the canonical form parses back to the same command", () => {
		for (const [command] of cases.filter(([c]) => c.kind !== "refused")) {
			expect(parseCommand(canonicalArgs(command), noValue)).toEqual(command);
		}
	});
});

const file = (path: string, state: FileStatus["state"]): FileStatus => ({
	path,
	state,
});
const set = (name: string) => ({ name, hidden: true });
const empty = (name: string) => ({
	name,
	hidden: false,
	why: "empty" as const,
});
const healthy = (...files: FileStatus[]): Status => ({
	files,
	shield: "active",
});
const request = (
	name: string,
	state: Request["state"] = "pending",
): Request => ({ id: "r1", name, reason: "the task needs it", state });
const none = new Map<string, number>();
const noGit = new Map<string, GitState>();

describe("R3 statusLine (Q40, F74)", () => {
	const degraded: Status = {
		files: [
			file(".env", { kind: "active", names: [] }),
			file("config/.env.local", { kind: "stale", reason: "read-failed" }),
		],
		shield: "degraded",
	};
	const failed: Outcome = {
		kind: "not-saved",
		name: "API_KEY",
		step: "git",
		reason: "tracked",
	};

	test("R3 (Q40): a degraded shield comes first, before a failed outcome and a request", () => {
		expect(statusLine(degraded, request("DB_PASSWORD"), failed)).toBe(
			"blindfold: degraded, config/.env.local could not be read. New values may not be hidden.",
		);
	});

	test("R3: a refused file degrades the line too", () => {
		const status = statusOf([
			file("/abs/.env", { kind: "refused", reason: "absolute" }),
		]);
		expect(statusLine(status, undefined, undefined)).toBe(
			"blindfold: degraded, /abs/.env could not be read. New values may not be hidden.",
		);
	});

	const failures: Outcome[] = [
		failed,
		{ kind: "refused", name: "API_KEY", file: ".env" },
		{ kind: "denied", name: "API_KEY" },
		{ kind: "cleared", name: "API_KEY" },
	];
	for (const outcome of failures) {
		test(`R3 (F74): a failed outcome ${outcome.kind} comes before an open request`, () => {
			expect(statusLine(healthy(), request("DB_PASSWORD"), outcome)).toBe(
				"blindfold: API_KEY not saved, run /secrets",
			);
		});
	}

	const others: Outcome[] = [
		{ kind: "repaired", name: "API_KEY" },
		{ kind: "manual", name: "API_KEY", file: ".env" },
		{ kind: "added", name: "API_KEY", file: ".env.local" },
	];
	for (const outcome of others) {
		test(`R3: outcome ${outcome.kind} is not a failure, so the request shows, else nothing`, () => {
			expect(statusLine(healthy(), request("DB_PASSWORD"), outcome)).toBe(
				"blindfold: DB_PASSWORD requested, run /secrets",
			);
			expect(statusLine(healthy(), undefined, outcome)).toBeUndefined();
		});
	}

	test("R3: an open request, pending or ready, shows its name", () => {
		for (const state of ["pending", "ready"] as const) {
			expect(
				statusLine(healthy(), request("DB_PASSWORD", state), undefined),
			).toBe("blindfold: DB_PASSWORD requested, run /secrets");
		}
	});

	test("R3: nothing to tell is undefined", () => {
		expect(statusLine(healthy(), undefined, undefined)).toBeUndefined();
	});
});

describe("R5 outcomeText (R7)", () => {
	const cases: [Outcome, string][] = [
		[
			{ kind: "refused", name: "API_KEY", file: ".env.local" },
			"blindfold cannot use .env.local: it is outside the project, a link, or not a regular file.",
		],
		[
			{ kind: "denied", name: "API_KEY" },
			"The env file setting was not saved.",
		],
		[
			{ kind: "added", name: "API_KEY", file: ".env" },
			".env added. Run /secrets set API_KEY, or ask Claude again.",
		],
		[
			{ kind: "manual", name: "API_KEY", file: ".env" },
			"Add API_KEY= to .env in your editor, then press Refresh.",
		],
		[
			{
				kind: "not-saved",
				name: "API_KEY",
				step: "mode",
				reason: "chmod-failed",
			},
			"Not saved: step mode, chmod-failed.",
		],
		[
			{ kind: "cleared", name: "API_KEY" },
			"Not saved: the request was cleared.",
		],
		[
			{ kind: "repaired", name: "API_KEY" },
			"Saved. The file was readable by others for a moment.",
		],
	];
	for (const [outcome, text] of cases) {
		test(`R5: ${outcome.kind} has its fixed text`, () => {
			expect(outcomeText(outcome)).toBe(text);
		});
	}
});

describe("R4 rowsOf", () => {
	test("R4: each name in an active file is Set or Empty, with its count", () => {
		const status = healthy(
			file(".env", {
				kind: "active",
				names: [set("API_KEY"), empty("DB_URL")],
			}),
		);
		expect(rowsOf(status, undefined, new Map([["API_KEY", 3]]), noGit)).toEqual(
			[
				{
					name: "API_KEY",
					file: ".env",
					state: "Set",
					hidden: false,
					rewrites: 3,
				},
				{
					name: "DB_URL",
					file: ".env",
					state: "Empty",
					hidden: false,
					rewrites: 0,
				},
			],
		);
	});

	test("R4: a name with a value that is not secret is Set", () => {
		const status = healthy(
			file(".env", {
				kind: "active",
				names: [{ name: "PORT", hidden: false, why: "not-secret" }],
			}),
		);
		expect(rowsOf(status, undefined, none, noGit)[0]?.state).toBe("Set");
	});

	test("R4: an empty name a pending request asks for is Requested, and gets no 2nd row", () => {
		const status = healthy(
			file(".env", { kind: "active", names: [empty("API_KEY")] }),
		);
		expect(rowsOf(status, request("API_KEY"), none, noGit)).toEqual([
			{
				name: "API_KEY",
				file: ".env",
				state: "Requested",
				hidden: false,
				rewrites: 0,
			},
		]);
	});

	test("R4: a ready request's name reads Set, and gets no 2nd row", () => {
		const status = healthy(
			file(".env", { kind: "active", names: [set("API_KEY")] }),
		);
		const rows = rowsOf(status, request("API_KEY", "ready"), none, noGit);
		expect(rows.map((r) => r.state)).toEqual(["Set"]);
	});

	test("R4: the requested name in no file is 1 more Requested row with no file", () => {
		const status = healthy(
			file(".env", { kind: "active", names: [set("DB_URL")] }),
		);
		expect(
			rowsOf(status, request("API_KEY"), new Map([["API_KEY", 2]]), noGit).at(
				-1,
			),
		).toEqual({
			name: "API_KEY",
			file: "",
			state: "Requested",
			hidden: false,
			rewrites: 2,
		});
	});

	test("R4: a missing, stale, or refused file is 1 row in words, with no name", () => {
		const status = statusOf([
			file(".env", { kind: "missing" }),
			file(".env.local", { kind: "stale", reason: "too-large" }),
			file("../.env", { kind: "refused", reason: "parent" }),
		]);
		expect(rowsOf(status, undefined, none, noGit)).toEqual([
			{ name: "", file: ".env", state: "Missing", hidden: false, rewrites: 0 },
			{
				name: "",
				file: ".env.local",
				state: "Stale",
				hidden: false,
				rewrites: 0,
			},
			{
				name: "",
				file: "../.env",
				state: "Refused",
				hidden: false,
				rewrites: 0,
			},
		]);
	});

	test("R4 (design 1g): a stale file never reads Set, so its requested name is Requested in no file", () => {
		const status = statusOf([
			file(".env", { kind: "stale", reason: "read-failed" }),
		]);
		const rows = rowsOf(status, request("API_KEY"), none, noGit);
		expect(rows.map((r) => [r.name, r.state])).toEqual([
			["", "Stale"],
			["API_KEY", "Requested"],
		]);
		expect(rows.some((r) => r.state === "Set")).toBe(false);
	});

	test("R4: the git state of a file is a warning in words on each of its rows, and none is no warning", () => {
		const status = healthy(
			file(".env", { kind: "active", names: [set("API_KEY"), set("DB_URL")] }),
			file(".env.local", { kind: "missing" }),
			file("app/.env", { kind: "active", names: [set("TOKEN")] }),
		);
		const git = new Map<string, GitState>([
			[".env", "tracked"],
			[".env.local", "not-ignored"],
			["app/.env", "none"],
		]);
		const rows = rowsOf(status, undefined, none, git);
		expect(rows.map((r) => [r.name, r.gitWarning])).toEqual([
			["API_KEY", "tracked"],
			["DB_URL", "tracked"],
			["", "not-ignored"],
			["TOKEN", undefined],
		]);
		expect(rows.map((r) => "gitWarning" in r)).toEqual([
			true,
			true,
			true,
			false,
		]);
	});

	test("R4 (F73): a name or path enroll hides is a hidden row, and the hidden text gets no count", () => {
		const value = `K${fake.secret(23)}`;
		const { set: known } = buildKnownSet([{ name: "API_KEY", value }]);
		const status = statusOf(
			[
				file(".env", {
					kind: "active",
					names: [set("API_KEY"), set(value)],
				}),
				file(`.env.${value}`, { kind: "active", names: [set("DB_URL")] }),
				file(`${value}.env`, { kind: "missing" }),
			],
			known,
		);
		const rows = rowsOf(status, undefined, new Map([[value, 5]]), noGit);
		expect(rows.map((r) => [r.name, r.file, r.hidden, r.rewrites])).toEqual([
			["API_KEY", ".env", false, 0],
			["[hidden name]", ".env", true, 0],
			["DB_URL", "[hidden path]", true, 0],
			["", "[hidden path]", true, 0],
		]);
		expect(JSON.stringify(rows)).not.toContain(value);
	});
});

describe("R5 step 1 targetFile", () => {
	test("R5: the first listed file that is active", () => {
		const status = healthy(
			file(".env", { kind: "missing" }),
			file(".env.local", { kind: "active", names: [] }),
			file(".env.dev", { kind: "active", names: [] }),
		);
		expect(targetFile(status)).toBe(".env.local");
	});

	test("R5: else the first listed file that is missing", () => {
		const status = healthy(
			file(".env", { kind: "stale", reason: "read-failed" }),
			file(".env.local", { kind: "missing" }),
			file(".env.dev", { kind: "missing" }),
		);
		expect(targetFile(status)).toBe(".env.local");
	});

	test("R5 (F73): a hidden path is no target, and with none left there is no target", () => {
		const status = healthy(
			file("[hidden path]", { kind: "active", names: [] }),
			file(".env", { kind: "refused", reason: "absolute" }),
		);
		expect(targetFile(status)).toBeUndefined();
	});
});
