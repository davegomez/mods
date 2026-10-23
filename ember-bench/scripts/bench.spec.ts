import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { FileRef } from "./bench.ts";
import {
	classifyPrompt,
	deleteAll,
	fileRef,
	ingest,
	openDb,
	parseTranscript,
	releaseLock,
	statusText,
	takeLock,
	writeRecord,
} from "./bench.ts";

const S = "0b4f5c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const S2 = "9c8b7a6f-5e4d-4c3b-8a29-1f0e0d0c0b0a";
/** Text the fixtures carry where a person's words would be; none of it may reach the database. */
const SECRET = "SECRET-TEXT";
const MIN = 60_000;
const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const MAIN: FileRef = {
	path: `/p/proj/${S}.jsonl`,
	sessionId: S,
	isSubagent: false,
};

type Usage = {
	input?: number;
	output?: number;
	read?: number;
	creation?: number;
	m5?: number;
	h1?: number;
};

const assistant = (id: string, ms: number, u: Usage = {}, extra = {}) =>
	JSON.stringify({
		type: "assistant",
		sessionId: S,
		uuid: `a-${id}-${ms}`,
		timestamp: iso(ms),
		isSidechain: false,
		message: {
			id,
			model: "claude-opus-5-5",
			role: "assistant",
			content: [{ type: "text", text: SECRET }],
			usage: {
				input_tokens: u.input ?? 1,
				output_tokens: u.output ?? 1,
				cache_read_input_tokens: u.read ?? 0,
				cache_creation_input_tokens: u.creation ?? 0,
				...(u.m5 === undefined
					? {}
					: {
							cache_creation: {
								ephemeral_5m_input_tokens: u.m5,
								ephemeral_1h_input_tokens: u.h1 ?? 0,
							},
						}),
			},
		},
		...extra,
	});

const user = (uuid: string, ms: number, content: unknown, extra = {}) =>
	JSON.stringify({
		type: "user",
		sessionId: S,
		uuid,
		timestamp: iso(ms),
		isSidechain: false,
		message: { role: "user", content },
		...extra,
	});

const compact = (uuid: string, ms: number) =>
	JSON.stringify({
		type: "system",
		subtype: "compact_boundary",
		sessionId: S,
		uuid,
		timestamp: iso(ms),
		content: SECRET,
		compactMetadata: {
			trigger: "manual",
			preTokens: 150_000,
			postTokens: 9_000,
		},
	});

const lines = (...l: string[]) => `${l.join("\n")}\n`;

describe("fileRef", () => {
	test("reads the session from a main transcript's name", () => {
		expect(fileRef("/r", `/r/proj/${S}.jsonl`)).toEqual({
			path: `/r/proj/${S}.jsonl`,
			sessionId: S,
			isSubagent: false,
		});
	});

	test("reads a subagent transcript's session from its folder", () => {
		expect(fileRef("/r", `/r/proj/${S}/subagents/agent-a1.jsonl`)).toEqual({
			path: `/r/proj/${S}/subagents/agent-a1.jsonl`,
			sessionId: S,
			isSubagent: true,
		});
	});

	test("refuses any other path", () => {
		expect(fileRef("/r", "/r/proj/notes.jsonl")).toBeUndefined();
		expect(fileRef("/r", `/r/proj/${S}/tool-results/x.jsonl`)).toBeUndefined();
	});
});

describe("classifyPrompt", () => {
	const e = (content: unknown, extra = {}) =>
		JSON.parse(user("u", T0, content, extra));

	test("a typed prompt is a prompt", () => {
		expect(classifyPrompt(e(SECRET))).toBe("prompt");
		expect(classifyPrompt(e([{ type: "text", text: SECRET }]))).toBe("prompt");
	});

	test("a slash command, its output, a shell line and a notification are told apart", () => {
		expect(classifyPrompt(e("<command-name>/x</command-name>"))).toBe(
			"command",
		);
		expect(classifyPrompt(e("<command-message>x</command-message>"))).toBe(
			"command",
		);
		expect(classifyPrompt(e("<local-command-stdout>x"))).toBe("command-output");
		expect(classifyPrompt(e("<bash-input>ls</bash-input>"))).toBe("bash");
		expect(classifyPrompt(e("<bash-stdout>x</bash-stdout>"))).toBe(
			"command-output",
		);
		expect(
			classifyPrompt(
				e("<task-notification>x", { origin: { kind: "task-notification" } }),
			),
		).toBe("task-notification");
	});

	test("tool results, meta rows, compaction summaries and sidechains are no prompts", () => {
		expect(
			classifyPrompt(
				e([{ type: "tool_result", tool_use_id: "t", content: "x" }]),
			),
		).toBeUndefined();
		expect(classifyPrompt(e(SECRET, { isMeta: true }))).toBeUndefined();
		expect(
			classifyPrompt(e(SECRET, { isCompactSummary: true })),
		).toBeUndefined();
		expect(classifyPrompt(e(SECRET, { isSidechain: true }))).toBeUndefined();
	});
});

describe("parseTranscript", () => {
	const text = lines(
		user("p1", T0, SECRET),
		assistant("msg_1", T0 + 1000, {
			output: 5,
			read: 10,
			creation: 7,
			m5: 0,
			h1: 7,
		}),
		assistant("msg_1", T0 + 3000, {
			output: 90,
			read: 10,
			creation: 7,
			m5: 0,
			h1: 7,
		}),
		user("t1", T0 + 4000, [
			{ type: "tool_result", tool_use_id: "t", content: SECRET },
		]),
		assistant("msg_2", T0 + 5000, { output: 3 }),
		assistant(
			"err",
			T0 + 6000,
			{},
			{
				isApiErrorMessage: true,
				message: { id: "err", model: "<synthetic>", usage: {} },
			},
		),
		compact("c1", T0 + 7000),
		'{"type":"assistant","message":{"id":"cut',
	);
	const parsed = parseTranscript(text, MAIN);

	test("merges an assistant message written twice into one request", () => {
		expect(parsed.requests).toHaveLength(2);
		expect(parsed.requests[0]).toEqual({
			id: "msg_1",
			sessionId: S,
			isSubagent: 0,
			agentId: null,
			firstMs: T0 + 1000,
			lastMs: T0 + 3000,
			model: "claude-opus-5-5",
			input: 1,
			output: 90,
			read: 10,
			creation: 7,
			eph5m: 0,
			eph1h: 7,
			path: MAIN.path,
		});
		expect(parsed.requests[1]?.eph5m).toBeNull();
	});

	test("keeps prompts and the compaction boundary, skips tool results, synthetic replies and a cut line", () => {
		expect(parsed.prompts).toEqual([
			{ uuid: "p1", sessionId: S, tsMs: T0, kind: "prompt", path: MAIN.path },
		]);
		expect(parsed.compactions).toEqual([
			{
				uuid: "c1",
				sessionId: S,
				tsMs: T0 + 7000,
				trigger: "manual",
				preTokens: 150_000,
				postTokens: 9_000,
				path: MAIN.path,
			},
		]);
	});

	test("carries no message text", () => {
		expect(JSON.stringify(parsed)).not.toContain(SECRET);
	});

	test("a subagent's requests carry its agent id and no prompts", () => {
		const sub = parseTranscript(
			lines(
				user("sp", T0, SECRET, { isSidechain: true, agentId: "a1" }),
				assistant("msg_s", T0 + 1000, {}, { isSidechain: true, agentId: "a1" }),
			),
			{ path: "/p/sub.jsonl", sessionId: S, isSubagent: true },
		);
		expect(sub.prompts).toEqual([]);
		expect(sub.requests[0]?.isSubagent).toBe(1);
		expect(sub.requests[0]?.agentId).toBe("a1");
	});
});

const memDb = () => openDb(":memory:");

const pauses = (db: Database) =>
	db
		.query(
			"SELECT session_id, arm, kind, gap_ms, request_id FROM pauses ORDER BY prompt_ms",
		)
		.all();

describe("the pauses view", () => {
	test("measures each gap from the last main request to the prompt before the next request", () => {
		const db = memDb();
		const text = lines(
			user("p1", T0, SECRET),
			assistant("r1", T0 + 1000),
			assistant("r1", T0 + 2000),
			user("c1", T0 + 2000 + 60 * MIN, "<command-name>/ember</command-name>"),
			user("o1", T0 + 2001 + 60 * MIN, "<local-command-stdout>x"),
			user("p2", T0 + 2000 + 62 * MIN, SECRET),
			assistant("r3", T0 + 2001 + 62 * MIN),
		);
		ingestText(db, MAIN, text);
		// A subagent's request inside the gap is no main request.
		ingestText(
			db,
			{ path: "/p/sub.jsonl", sessionId: S, isSubagent: true },
			lines(assistant("s1", T0 + 30 * MIN, {}, { agentId: "a1" })),
		);
		writeRecord(db, sessionRec({ arm: 0 }), T0);
		expect(pauses(db)).toEqual([
			{
				session_id: S,
				arm: "off",
				kind: "prompt",
				gap_ms: 62 * MIN,
				request_id: "r3",
			},
		]);
	});

	test("a session ember-bench never recorded has no arm", () => {
		const db = memDb();
		ingestText(
			db,
			MAIN,
			lines(
				assistant("r1", T0),
				user("p", T0 + MIN, SECRET),
				assistant("r2", T0 + 2 * MIN),
			),
		);
		expect(pauses(db)).toEqual([
			{
				session_id: S,
				arm: null,
				kind: "prompt",
				gap_ms: MIN,
				request_id: "r2",
			},
		]);
	});
});

const ingestText = (db: Database, ref: FileRef, text: string) => {
	const dir = mkdtempSync(`${tmpdir()}/eb-`);
	const rel = ref.isSubagent
		? `proj/${ref.sessionId}/subagents/agent-${Math.random().toString(36).slice(2)}.jsonl`
		: `proj/${ref.sessionId}.jsonl`;
	mkdirSync(`${dir}/${rel.split("/").slice(0, -1).join("/")}`, {
		recursive: true,
	});
	writeFileSync(`${dir}/${rel}`, text);
	const r = ingest(db, dir, { nowMs: T0, pid: process.pid });
	expect(r.status).toBe("done");
};

const sessionRec = (o: Partial<Record<string, unknown>> = {}) =>
	({
		kind: "session",
		session: S,
		startedMs: T0,
		arm: 1,
		ccVersion: "2.1.309",
		emberVersion: "0.4.0",
		emberSource: "ember@davegomez",
		ttlMinutes: 60,
		refresh: 1,
		refreshShortTtl: 1,
		refreshLeadSeconds: 0,
		...o,
	}) as Parameters<typeof writeRecord>[1];

describe("ingest", () => {
	test("reads each file once, again after it changes, and repeats nothing", () => {
		const db = memDb();
		const dir = mkdtempSync(`${tmpdir()}/eb-`);
		mkdirSync(`${dir}/proj`);
		const file = `${dir}/proj/${S}.jsonl`;
		writeFileSync(
			file,
			lines(user("p1", T0, SECRET), assistant("r1", T0 + 1000)),
		);
		expect(ingest(db, dir, { nowMs: T0, pid: process.pid })).toEqual({
			status: "done",
			read: 1,
			skipped: 0,
		});
		expect(ingest(db, dir, { nowMs: T0, pid: process.pid })).toEqual({
			status: "done",
			read: 0,
			skipped: 1,
		});
		appendFileSync(file, lines(assistant("r1", T0 + 2000, { output: 40 })));
		expect(ingest(db, dir, { nowMs: T0, pid: process.pid }).status).toBe(
			"done",
		);
		expect(
			db
				.query("SELECT COUNT(*) AS n, MAX(output_tokens) AS o FROM requests")
				.get(),
		).toEqual({
			n: 1,
			o: 40,
		});
	});

	test("a second ingest exits while a live one holds the lock", () => {
		const db = memDb();
		expect(takeLock(db, process.pid, T0)).toBe(true);
		expect(ingest(db, "/nowhere", { nowMs: T0, pid: process.pid + 1 })).toEqual(
			{
				status: "busy",
			},
		);
		releaseLock(db, process.pid, T0);
		expect(takeLock(db, process.pid + 1, T0)).toBe(true);
	});

	test("a lock left by a dead process is taken over", () => {
		const db = memDb();
		// No process has this id: kill(pid, 0) fails.
		expect(takeLock(db, 2 ** 30, T0)).toBe(true);
		expect(takeLock(db, process.pid, T0)).toBe(true);
	});
});

describe("records", () => {
	test("an off arm sticks: a late on record does not undo it", () => {
		const db = memDb();
		writeRecord(db, sessionRec({ arm: 0 }), T0);
		writeRecord(db, sessionRec({ arm: 1, emberSource: "unknown" }), T0);
		expect(db.query("SELECT arm, ember_source FROM sessions").get()).toEqual({
			arm: "off",
			ember_source: "ember@davegomez",
		});
	});

	test("forks, probes and marks are written once each", () => {
		const db = memDb();
		const fork = {
			kind: "fork",
			session: S,
			firedMs: T0,
			durationMs: 900,
			isAnswered: 1,
			reason: "answered",
			input: 3,
			output: 2,
			read: 90_000,
			creation: 400,
			fiveHourBefore: 12.5,
			fiveHourAfter: 12.6,
			sevenDayBefore: null,
			sevenDayAfter: null,
		} as const;
		writeRecord(db, fork, T0);
		writeRecord(db, fork, T0);
		writeRecord(db, { kind: "probe", session: S, atMs: T0 }, T0);
		writeRecord(db, { kind: "seen", session: S2, atMs: T0 }, T0);
		expect(db.query("SELECT COUNT(*) AS n FROM forks").get()).toEqual({ n: 1 });
		expect(db.query("SELECT COUNT(*) AS n FROM probes").get()).toEqual({
			n: 1,
		});
		expect(
			db
				.query("SELECT ember_seen_ms FROM sessions WHERE session_id = ?")
				.get(S2),
		).toEqual({ ember_seen_ms: T0 });
	});

	test("status reports what was seen, the long pauses per arm and the last ingest", () => {
		const db = memDb();
		ingestText(
			db,
			MAIN,
			lines(
				assistant("r1", T0),
				user("p", T0 + 70 * MIN, SECRET),
				assistant("r2", T0 + 71 * MIN),
			),
		);
		writeRecord(db, sessionRec(), T0);
		const text = statusText(db, S, T0);
		expect(text).toContain("ember calls seen this session: not yet");
		expect(text).toContain("long pauses (55 min or more): on 1, off 0");
		expect(text).toContain("last ingest:");
		expect(text).not.toContain("never");
	});

	test("delete removes every collected row", () => {
		const db = memDb();
		ingestText(db, MAIN, lines(user("p", T0, SECRET), assistant("r1", T0 + 1)));
		writeRecord(db, sessionRec(), T0);
		deleteAll(db);
		expect(
			db
				.query(
					`SELECT (SELECT COUNT(*) FROM files) + (SELECT COUNT(*) FROM requests) + (SELECT COUNT(*) FROM prompts)
					+ (SELECT COUNT(*) FROM compactions) + (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM forks)
					+ (SELECT COUNT(*) FROM probes) AS n`,
				)
				.get(),
		).toEqual({ n: 0 });
		expect(statusText(db, S, T0)).toContain("last ingest: never");
	});
});

test("the marketplace does not list ember-bench", async () => {
	const market = (await Bun.file(
		`${import.meta.dir}/../../.claude-plugin/marketplace.json`,
	).json()) as { plugins: { name: string; source: string }[] };
	expect(market.plugins.map((p) => p.name)).not.toContain("ember-bench");
	expect(market.plugins.map((p) => p.source)).not.toContain("./ember-bench");
});
