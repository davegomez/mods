import type { ModelForkResult, On } from "claude-code";
import type { Engine, MockClock } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";

import { INGEST_EVERY_MS, OFF_FORK } from "../hooks/bench.ts";

const SID = "0b4f5c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const T0 = 1_800_000_000_000;
const HOME = "/home/t";

const HIT: ModelForkResult = {
	isAnswered: true,
	text: "ok",
	usage: {
		input_tokens: 3,
		output_tokens: 2,
		cache_read_input_tokens: 90_000,
		cache_creation_input_tokens: 400,
	},
};

/** Stands in for ember: one command that forks and prints what the fork resolved to. */
const EMBER = {
	name: "ember",
	register(on: On) {
		on("command.run", { command: "fork-now" }, async ($) => ({
			text: JSON.stringify(await $.model.fork({ prompt: "Reply ok." })),
		}));
		on("command.run", { command: "ember-probe" }, () => ({
			text: "probed",
		}));
	},
};

/** Another plugin's fork, which ember-bench leaves alone. */
const OTHER = {
	name: "other",
	register(on: On) {
		on("command.run", { command: "other-fork" }, async ($) => ({
			text: JSON.stringify(await $.model.fork({ prompt: "Reply ok." })),
		}));
	},
};

const WITH_EMBER = { plugins: [EMBER] };

type World = {
	clock: MockClock;
	/** Each spawned child's argv after the script path. */
	spawns: string[][];
	runs: string[][];
	forks: number;
	turns: number;
	sessionId: string;
	/** argv[0] values that fail to start. */
	missing: string[];
	logs: string[];
	answer: string;
	status: string;
};

function world(on: On): World {
	const clock = mock.clock(on, { now: T0 });
	mock.store(on);
	mock.env(on, { HOME });
	const w: World = {
		clock,
		spawns: [],
		runs: [],
		forks: 0,
		turns: 0,
		sessionId: SID,
		missing: [],
		logs: [],
		answer: "Delete",
		status: "long pauses: on 1, off 0\n",
	};
	on("session.id", () => ({ value: w.sessionId }));
	on("session.turns", () => ({ value: w.turns }));
	on("session.version", () => ({ value: { version: "2.1.309" } }));
	on("session.usage", () => ({
		value: {
			startedAt: T0 - 5_000,
			context: { window: 200_000 },
			rateLimits: [
				{ kind: "five_hour", percentUsed: 12.5 },
				{ kind: "seven_day", percentUsed: 40 },
			],
		},
	}));
	// The inline stand-in registers as ember@claude-plugin-test; its options are read under that key.
	on("settings.read", () => ({
		value: {
			pluginConfigs: {
				"ember@claude-plugin-test": {
					options: { ttlMinutes: 60, refresh: true },
				},
			},
		},
	}));
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	on("command.register", (_, e) => ({ value: { command: e.name } }));
	on("model.fork", () => {
		w.forks += 1;
		return { value: HIT };
	});
	on("process.spawn", async function* (_, e) {
		if (w.missing.includes(String(e.argv[0]))) return { deny: "not found" };
		w.spawns.push([String(e.argv[0]), ...e.argv.slice(2)]);
		yield { stream: "stdout" as const, text: "done\n" };
		return { value: { code: 0, signal: null } };
	});
	on("process.run", (_, e) => {
		if (w.missing.includes(String(e.argv[0]))) return { deny: "not found" };
		w.runs.push([String(e.argv[0]), ...e.argv.slice(2)]);
		const stdout = e.argv[2] === "status" ? w.status : "";
		return {
			value: {
				exitCode: 0,
				stdout,
				stderr: "",
				isStdoutTruncated: false,
				isStderrTruncated: false,
			},
		};
	});
	on("tool.call", { tool: "AskUserQuestion" }, (_, e) => ({
		result: {
			questions: e.questions,
			answers: { [e.questions[0]?.question ?? ""]: w.answer },
		},
	}));
	on("ui.log", (_, e) => {
		w.logs.push(e.text);
		return { value: undefined };
	});
	return w;
}

const run = ($: Engine, command: string, args = "") =>
	$.command.run({
		command,
		args,
		origin: { kind: "composer" },
		presentation: { isFullscreen: false, columns: 80 },
	});

const start = ($: Engine) =>
	$.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

const records = (w: World) =>
	w.spawns
		.filter((s) => s[1] === "record")
		.map((s) => JSON.parse(String(s[2])) as Record<string, unknown>);

const forkNow = async ($: Engine) =>
	JSON.parse((await run($, "fork-now")).text ?? "") as ModelForkResult;

const bench = async ($: Engine, args: string) =>
	(await run($, "bench", args)).text ?? "";

describe("session start", () => {
	test(
		"starts the ingest with bun and again every 30 minutes",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			await start($);
			await w.clock.settle();
			expect(w.spawns.filter((s) => s[1] === "ingest")).toHaveLength(1);
			expect(w.spawns[0]?.[0]).toBe("bun");
			await w.clock.advance(INGEST_EVERY_MS);
			expect(w.spawns.filter((s) => s[1] === "ingest")).toHaveLength(2);
		},
	);

	test(
		"falls back to the installer's bun when bun is not on PATH",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			w.missing = ["bun"];
			await start($);
			await w.clock.settle();
			expect(w.spawns.find((s) => s[1] === "ingest")?.[0]).toBe(
				`${HOME}/.bun/bin/bun`,
			);
		},
	);

	test(
		"records the session: id, start, arm, versions and ember's options",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			await start($);
			await w.clock.settle();
			expect(records(w)).toEqual([
				{
					kind: "session",
					session: SID,
					startedMs: T0 - 5_000,
					arm: 1,
					ccVersion: "2.1.309",
					emberVersion: null,
					emberSource: "ember@claude-plugin-test",
					ttlMinutes: 60,
					refresh: 1,
					refreshShortTtl: null,
					refreshLeadSeconds: null,
				},
			]);
		},
	);

	test("ember's source is unknown when ember did not register", async ($, on) => {
		const w = world(on);
		await start($);
		await w.clock.settle();
		expect(records(w)[0]?.emberSource).toBe("unknown");
	});

	test(
		"a session id that is no UUID sends nothing to the script",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			w.sessionId = "S1; rm -rf /";
			await start($);
			await w.clock.settle();
			expect(records(w)).toEqual([]);
		},
	);
});

describe("ember's forks", () => {
	test(
		"an on session passes ember's fork through unchanged and records it",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			await start($);
			const r = await forkNow($);
			await w.clock.settle();
			expect(r).toEqual(HIT);
			expect(w.forks).toBe(1);
			const fork = records(w).find((r) => r.kind === "fork");
			expect(fork).toEqual({
				kind: "fork",
				session: SID,
				firedMs: T0,
				durationMs: 0,
				isAnswered: 1,
				reason: "answered",
				input: 3,
				output: 2,
				read: 90_000,
				creation: 400,
				fiveHourBefore: 12.5,
				fiveHourAfter: 12.5,
				sevenDayBefore: 40,
				sevenDayAfter: 40,
			});
			expect(records(w).some((r) => r.kind === "seen")).toBe(true);
		},
	);

	test(
		"an off session answers ember's fork itself, without calling next",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			await start($);
			expect(await bench($, "off")).toContain("off");
			const r = await forkNow($);
			await w.clock.settle();
			expect(r).toEqual(OFF_FORK);
			expect(w.forks).toBe(0);
			expect(records(w).find((r) => r.kind === "fork")?.reason).toBe("off");
		},
	);

	test(
		"a fork another plugin makes passes untouched in an off session",
		{ plugins: [EMBER, OTHER] },
		async ($, on) => {
			const w = world(on);
			await start($);
			await bench($, "off");
			const text = (await run($, "other-fork")).text;
			expect(JSON.parse(text ?? "")).toEqual(HIT);
			expect(w.forks).toBe(1);
		},
	);

	test(
		"the off arm survives a reload: it is read from the store",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			await start($);
			await bench($, "off");
			await start($);
			expect(await forkNow($)).toEqual(OFF_FORK);
			expect(w.forks).toBe(0);
			await w.clock.settle();
			const sessions = records(w).filter((r) => r.kind === "session");
			expect(sessions.at(-1)?.arm).toBe(0);
		},
	);
});

describe("/bench", () => {
	test("off is refused after the first prompt", WITH_EMBER, async ($, on) => {
		const w = world(on);
		w.turns = 1;
		await start($);
		expect(await bench($, "off")).toContain("only before the first prompt");
		expect(await forkNow($)).toEqual(HIT);
	});

	test(
		"status shows the arm and the script's figures",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			await start($);
			const text = await bench($, "status");
			expect(text).toContain("arm: on");
			expect(text).toContain("long pauses: on 1, off 0");
			expect(w.runs.at(-1)).toEqual(["bun", "status", SID]);
		},
	);

	test(
		"delete runs the script's delete once confirmed",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			await start($);
			expect(await bench($, "delete")).toContain("deleted");
			expect(w.runs.at(-1)).toEqual(["bun", "delete"]);
		},
	);

	test("delete does nothing when not confirmed", WITH_EMBER, async ($, on) => {
		const w = world(on);
		w.answer = "Keep";
		await start($);
		expect(await bench($, "delete")).toContain("Nothing was deleted");
		expect(w.runs.some((r) => r[1] === "delete")).toBe(false);
	});

	test("anything else shows the usage", WITH_EMBER, async ($, on) => {
		world(on);
		await start($);
		expect(await bench($, "on")).toContain("Usage");
	});

	test(
		"/ember-probe is marked and passed on to ember",
		WITH_EMBER,
		async ($, on) => {
			const w = world(on);
			await start($);
			expect((await run($, "ember-probe")).text).toBe("probed");
			await w.clock.settle();
			expect(records(w).some((r) => r.kind === "probe")).toBe(true);
		},
	);
});
