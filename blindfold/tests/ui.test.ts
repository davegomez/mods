import { describe, expect, test } from "claude-code/testing";
import { buildKnownSet } from "../hooks/detect.ts";
import {
	createEnrollment,
	type FileState,
	type FileStatus,
	type Status,
	statusOf,
} from "../hooks/enroll.ts";
import type { Entered, Platform } from "../hooks/entry.ts";
import {
	createRequests,
	REASON_HIDDEN,
	type Request,
} from "../hooks/request.ts";
import {
	BUSY,
	type Command,
	canonicalArgs,
	chooseFile,
	createUi,
	type FlowIo,
	type FlowSettings,
	type GitState,
	type Outcome,
	outcomeText,
	parseCommand,
	rescan,
	rowsOf,
	startFlow,
	statusLine,
	targetFile,
} from "../hooks/ui.ts";
import type { Saved } from "../hooks/write.ts";
import { fakes, gate } from "./fakes.ts";

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
		[
			{ kind: "choose", name: "API_KEY" },
			"No listed env file can take API_KEY. Run /secrets and pick .env or .env.local.",
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

describe("R5 the flow, with a fake entry and write", () => {
	const NAME = "API_KEY";
	const VALUE = `V${fake.secret(27)}`;
	const ASK: FlowSettings = { method: "auto", save: "ask" };
	const SAVED: Saved = { ok: true, created: false, ignoredNow: false };

	/** A ui over `states`, by path, with the request for NAME open. */
	const setup = (
		states: Record<string, FileState> = { ".env": { kind: "missing" } },
	) => {
		const enrollment = createEnrollment();
		enrollment.apply(
			Object.entries(states).map(([path, state]) => ({
				path,
				state,
				feed: [],
			})),
		);
		const requests = createRequests();
		const ui = createUi(enrollment, requests);
		const request = requests.ask(NAME, "to charge the card");
		return { ui, requests, request };
	};

	type Script = {
		platform?: Platform;
		entered?: Entered | Promise<Entered>;
		saved?: Saved;
		added?: "added" | "refused" | "denied" | Promise<never>;
		fails?: boolean;
	};
	/** Records each call by its non-value arguments; `values` holds what save got. */
	const fakeIo = (script: Script = {}) => {
		const calls: string[] = [];
		const toasts: string[] = [];
		const values: string[] = [];
		const io: FlowIo = {
			platform: async () => {
				calls.push("platform");
				if (script.fails) throw new Error(`boom ${VALUE}`);
				return script.platform ?? "macos";
			},
			enter: async (platform, name, reason) => {
				calls.push(`enter ${platform} ${name} ${reason}`);
				return script.entered ?? { kind: "value", value: VALUE };
			},
			save: async (path, name, value) => {
				calls.push(`save ${path} ${name}`);
				values.push(value);
				return script.saved ?? SAVED;
			},
			addFile: async (path) => {
				calls.push(`addFile ${path}`);
				return script.added ?? "added";
			},
			toast: (text) => toasts.push(text),
		};
		return { io, calls, toasts, values };
	};

	test("R5 step 1 (Q41, F34): with no listed file that can take a value, the start offers the file choice and opens no dialog", async () => {
		const { ui } = setup({ ".env": { kind: "refused", reason: "symlink" } });
		const { io, calls } = fakeIo();
		const flow = startFlow(ui, NAME, io, ASK);
		await flow.done;
		expect(flow.text).toBe(
			`No listed env file can take ${NAME}. Run /secrets and pick .env or .env.local.`,
		);
		expect(ui.outcome()).toEqual({ kind: "choose", name: NAME });
		expect(calls).toEqual([]);
	});

	const choices: [Script["added"], Outcome][] = [
		["added", { kind: "added", name: NAME, file: ".env.local" }],
		["refused", { kind: "refused", name: NAME, file: ".env.local" }],
		["denied", { kind: "denied", name: NAME }],
		[Promise.reject(new Error("no")), { kind: "denied", name: NAME }],
	];
	for (const [added, outcome] of choices) {
		test(`R5 step 1 (Q42, F68, F69): the file choice through addFile, ${typeof added === "string" ? added : "a rejection"}, shows ${outcome.kind} and stops`, async () => {
			const { ui } = setup({});
			const { io, calls, toasts } = fakeIo({ added });
			await chooseFile(ui, NAME, ".env.local", io);
			expect(calls).toEqual(["addFile .env.local"]);
			expect(ui.outcome()).toEqual(outcome);
			expect(toasts).toEqual([outcomeText(outcome)]);
		});
	}

	test("R5 step 2: never shows the line to add by hand and opens no dialog", async () => {
		const { ui } = setup();
		const { io, calls } = fakeIo();
		const flow = startFlow(ui, NAME, io, { method: "auto", save: "never" });
		await flow.done;
		expect(flow.text).toBe(
			`Add ${NAME}= to .env in your editor, then press Refresh.`,
		);
		expect(ui.outcome()).toEqual({ kind: "manual", name: NAME, file: ".env" });
		expect(calls).toEqual([]);
	});

	for (const save of ["ask", "always"] as const) {
		test(`R5 step 2 (Q43): with ${save}, a start enters the value and saves it to the target`, async () => {
			const { ui } = setup();
			const { io, calls, values } = fakeIo();
			const flow = startFlow(ui, NAME, io, { method: "auto", save });
			expect(flow.text).toBe(`blindfold is asking for ${NAME}.`);
			await flow.done;
			expect(calls).toEqual([
				"platform",
				`enter macos ${NAME} to charge the card`,
				`save .env ${NAME}`,
			]);
			expect(values).toEqual([VALUE]);
		});
	}

	test("R5 step 3: with no request for the name, the dialog says where the value goes", async () => {
		const { ui, requests } = setup();
		requests.clear();
		const { io, calls } = fakeIo();
		await startFlow(ui, NAME, io, ASK).done;
		expect(calls[1]).toBe(`enter macos ${NAME} blindfold saves it to .env.`);
	});

	test("R5 step 3 (F70): the route unavailable shows the line to add by hand, with no dialog", async () => {
		const { ui } = setup();
		const { io, calls, toasts } = fakeIo({ platform: "unknown" });
		await startFlow(ui, NAME, io, ASK).done;
		const manual: Outcome = { kind: "manual", name: NAME, file: ".env" };
		expect(ui.outcome()).toEqual(manual);
		expect(toasts).toEqual([outcomeText(manual)]);
		expect(calls).toEqual(["platform"]);
	});

	test("R5 step 3 (F70): a cancel with why unavailable shows the line to add by hand", async () => {
		const { ui } = setup();
		const { io, calls } = fakeIo({
			entered: { kind: "cancel", why: "unavailable" },
		});
		await startFlow(ui, NAME, io, ASK).done;
		expect(ui.outcome()).toEqual({ kind: "manual", name: NAME, file: ".env" });
		expect(calls.some((c) => c.startsWith("save"))).toBe(false);
	});

	for (const why of ["cancelled", "timeout", "failed"] as const) {
		test(`R5 step 3 (F81): a cancel (${why}) stops with the earlier outcome cleared and the request open`, async () => {
			const { ui, requests, request } = setup();
			ui.setOutcome({
				kind: "not-saved",
				name: "OLD_KEY",
				step: "git",
				reason: "tracked",
			});
			const dialog = gate();
			const entered = dialog.wait.then(
				(): Entered => ({ kind: "cancel", why }),
			);
			const { io, calls, toasts } = fakeIo({ entered });
			const flow = startFlow(ui, NAME, io, ASK);
			expect(ui.outcome()).toBeUndefined();
			dialog.open();
			await flow.done;
			expect(ui.outcome()).toBeUndefined();
			expect(requests.current()).toEqual(request);
			expect(calls.some((c) => c.startsWith("save"))).toBe(false);
			expect(toasts).toEqual([]);
		});
	}

	const saves: [Saved, Outcome | undefined][] = [
		[SAVED, undefined],
		[
			{ ...SAVED, warning: "mode-repaired" },
			{ kind: "repaired", name: NAME },
		],
		[
			{ ok: false, step: "git", reason: "tracked" },
			{ kind: "not-saved", name: NAME, step: "git", reason: "tracked" },
		],
	];
	for (const [saved, outcome] of saves) {
		test(`R5 step 4: a save that is ${saved.ok ? (saved.warning ?? "ok") : "not ok"} sets the outcome ${outcome?.kind ?? "undefined"}`, async () => {
			const { ui } = setup();
			ui.setOutcome({ kind: "cleared", name: NAME });
			const { io, toasts } = fakeIo({ saved });
			await startFlow(ui, NAME, io, ASK).done;
			expect(ui.outcome()).toEqual(outcome);
			expect(toasts).toEqual(outcome ? [outcomeText(outcome)] : []);
		});
	}

	test("R5: 1 flow at a time; a 2nd start and a file choice say busy; the busy flag resets after the flow", async () => {
		const { ui } = setup();
		const dialog = gate();
		const entered = dialog.wait.then(
			(): Entered => ({ kind: "cancel", why: "cancelled" }),
		);
		const first = fakeIo({ entered });
		const flow = startFlow(ui, NAME, first.io, ASK);
		const second = fakeIo();
		expect(startFlow(ui, NAME, second.io, ASK).text).toBe(BUSY);
		expect(BUSY).toBe("blindfold is already asking for a value.");
		await chooseFile(ui, NAME, ".env", second.io);
		expect(second.toasts).toEqual([BUSY]);
		expect(second.calls).toEqual([]);
		dialog.open();
		await flow.done;
		const third = fakeIo();
		await startFlow(ui, NAME, third.io, ASK).done;
		expect(third.calls.at(-1)).toBe(`save .env ${NAME}`);
	});

	test("R5: the flow never rejects; a failure becomes the line to add by hand, names no value, and frees the flow", async () => {
		const { ui } = setup();
		const { io, toasts } = fakeIo({ fails: true });
		await startFlow(ui, NAME, io, ASK).done;
		expect(ui.outcome()).toEqual({ kind: "manual", name: NAME, file: ".env" });
		expect(JSON.stringify([ui.outcome(), toasts])).not.toContain(VALUE);
		const again = fakeIo();
		await startFlow(ui, NAME, again.io, ASK).done;
		expect(again.calls.at(-1)).toBe(`save .env ${NAME}`);
	});

	test("R5 (F81): a start that is not accepted keeps the outcome", async () => {
		const { ui } = setup();
		const dialog = gate();
		const entered = dialog.wait.then(
			(): Entered => ({ kind: "cancel", why: "cancelled" }),
		);
		const flow = startFlow(ui, NAME, fakeIo({ entered }).io, ASK);
		const before: Outcome = { kind: "cleared", name: NAME };
		ui.setOutcome(before);
		expect(startFlow(ui, NAME, fakeIo().io, ASK).text).toBe(BUSY);
		expect(ui.outcome()).toEqual(before);
		dialog.open();
		await flow.done;
	});

	/** F79: what Dismiss and session.end do to the ui while a flow waits. */
	const ends: [string, (s: ReturnType<typeof setup>) => void][] = [
		[
			"a Dismiss",
			({ ui, requests }) => {
				requests.clear();
				ui.setOutcome(undefined);
			},
		],
		[
			"a session end",
			({ ui, requests }) => {
				requests.clear();
				ui.setOutcome(undefined);
				ui.sessions++;
			},
		],
	];
	for (const [label, end] of ends) {
		test(`R5 (F79): ${label} during entry, then a cancel with why unavailable, sets no outcome and no toast`, async () => {
			const s = setup();
			const dialog = gate();
			const entered = dialog.wait.then(
				(): Entered => ({ kind: "cancel", why: "unavailable" }),
			);
			const { io, toasts } = fakeIo({ entered });
			const flow = startFlow(s.ui, NAME, io, ASK);
			await Promise.resolve();
			end(s);
			dialog.open();
			await flow.done;
			expect(s.ui.outcome()).toBeUndefined();
			expect(toasts).toEqual([]);
			expect(s.ui.busy).toBe(false);
		});

		test(`R5 (F79): ${label} during saveValue, then a save that throws, sets no outcome and no toast`, async () => {
			const s = setup();
			const { io, toasts } = fakeIo();
			io.save = async () => {
				end(s);
				throw new Error("made-up");
			};
			await startFlow(s.ui, NAME, io, ASK).done;
			expect(s.ui.outcome()).toBeUndefined();
			expect(toasts).toEqual([]);
			expect(s.ui.busy).toBe(false);
		});

		test(`R5 (F79): ${label} while a file choice waits, then denied, sets no outcome and no toast`, async () => {
			const s = setup({});
			const door = gate();
			const { io, toasts } = fakeIo();
			io.addFile = async () => {
				await door.wait;
				return "denied";
			};
			const choose = chooseFile(s.ui, NAME, ".env.local", io);
			end(s);
			door.open();
			await choose;
			expect(s.ui.outcome()).toBeUndefined();
			expect(toasts).toEqual([]);
			expect(s.ui.busy).toBe(false);
		});
	}

	const changes: [string, (s: ReturnType<typeof setup>) => void][] = [
		["a clear (Dismiss, a user prompt)", ({ requests }) => requests.clear()],
		["a new request", ({ requests }) => void requests.ask("OTHER_KEY", "r")],
		["a session end alone", ({ ui }) => void ui.sessions++],
	];
	for (const [label, change] of changes) {
		test(`R5 (F67): ${label} during entry drops the value before saveValue, and the outcome is cleared`, async () => {
			const s = setup();
			const dialog = gate();
			const entered = dialog.wait.then(
				(): Entered => ({ kind: "value", value: VALUE }),
			);
			const { io, calls } = fakeIo({ entered });
			const flow = startFlow(s.ui, NAME, io, ASK);
			await Promise.resolve();
			change(s);
			dialog.open();
			await flow.done;
			expect(calls.some((c) => c.startsWith("save"))).toBe(false);
			expect(s.ui.outcome()).toEqual({ kind: "cleared", name: NAME });
		});

		test(`R5 (F67): ${label} during saveValue leaves the outcome as it is`, async () => {
			const s = setup();
			const { io } = fakeIo({
				saved: { ok: false, step: "git", reason: "tracked" },
			});
			const save = io.save;
			io.save = async (...args) => {
				change(s);
				s.ui.setOutcome(undefined);
				return save(...args);
			};
			await startFlow(s.ui, NAME, io, ASK).done;
			expect(s.ui.outcome()).toBeUndefined();
		});
	}

	test("R7: the start text, the outcome, and every toast hold no value", async () => {
		const texts: unknown[] = [];
		for (const saved of saves.map(([s]) => s)) {
			const { ui } = setup();
			const { io, toasts } = fakeIo({ saved });
			const flow = startFlow(ui, NAME, io, ASK);
			await flow.done;
			texts.push(flow.text, ui.outcome(), toasts);
		}
		expect(JSON.stringify(texts)).not.toContain(VALUE);
	});
});

describe("R7 (F77) rescan after a load", () => {
	const VALUE = `V${fake.secret(23)}`;
	/** A ui whose enrollment learns `value` for `name` only after the request and the outcome were made. */
	const setup = () => {
		const enrollment = createEnrollment();
		enrollment.apply([
			{ path: ".env", state: { kind: "active", names: [] }, feed: [] },
		]);
		const requests = createRequests();
		return { enrollment, requests, ui: createUi(enrollment, requests) };
	};

	test("R7 (F77): a reason that now holds a known value becomes the request R2 text", () => {
		const { enrollment, requests, ui } = setup();
		const asked = requests.ask("DB_PASSWORD", `Use ${VALUE} for the database`);
		enrollment.learn(".env", "DB_PASSWORD", VALUE);
		rescan(ui);
		expect(requests.current()).toEqual({ ...asked, reason: REASON_HIDDEN });
	});

	test("R7 (F77): a name that now holds a known value clears the request", () => {
		const { enrollment, requests, ui } = setup();
		requests.ask("DB_PASSWORD", "for the database");
		enrollment.learn(".env", "DB_PASSWORD", "DB_PASSWORD");
		rescan(ui);
		expect(requests.current()).toBeUndefined();
	});

	test("R7 (F77): an outcome whose name now holds a known value is cleared; another stays", () => {
		const { enrollment, ui } = setup();
		const kept: Outcome = { kind: "denied", name: "API_KEY" };
		ui.setOutcome(kept);
		enrollment.learn(".env", "OTHER_KEY", "DB_PASSWORD");
		rescan(ui);
		expect(ui.outcome()).toEqual(kept);
		ui.setOutcome({ kind: "manual", name: "DB_PASSWORD", file: ".env" });
		rescan(ui);
		expect(ui.outcome()).toBeUndefined();
	});
});
