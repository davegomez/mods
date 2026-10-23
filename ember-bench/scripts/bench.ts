/**
 * ember-bench's database: the one writer of ~/.claude/ember-bench/bench.db.
 *
 *   bun bench.ts ingest            read the transcripts that changed since the last run
 *   bun bench.ts record <json>     write one row the mod sends
 *   bun bench.ts status <session>  print the figures /bench status shows
 *   bun bench.ts delete            remove all collected data
 *
 * No message text is stored: ids, times, token counts, and the transcript path to join back to.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

import type { BenchRecord } from "../hooks/record.ts";
import { isRecord, isSessionId } from "../hooks/record.ts";

const DIR = `${homedir()}/.claude/ember-bench`;
const PROJECTS = `${homedir()}/.claude/projects`;
/** A lock older than this is taken over even when its pid is alive (a reused pid). */
const LOCK_STALE_MS = 60 * 60_000;
const LONG_PAUSE_MS = 55 * 60_000;

export type FileRef = { path: string; sessionId: string; isSubagent: boolean };

export type RequestRow = {
	id: string;
	sessionId: string;
	isSubagent: 0 | 1;
	agentId: string | null;
	firstMs: number;
	lastMs: number;
	model: string | null;
	input: number;
	output: number;
	read: number;
	creation: number;
	eph5m: number | null;
	eph1h: number | null;
	path: string;
};

export type PromptKind =
	| "prompt"
	| "command"
	| "command-output"
	| "bash"
	| "task-notification";

export type PromptRow = {
	uuid: string;
	sessionId: string;
	tsMs: number;
	kind: PromptKind;
	path: string;
};

export type CompactionRow = {
	uuid: string;
	sessionId: string;
	tsMs: number;
	trigger: string | null;
	preTokens: number | null;
	postTokens: number | null;
	path: string;
};

export type Parsed = {
	requests: RequestRow[];
	prompts: PromptRow[];
	compactions: CompactionRow[];
};

type Entry = Record<string, unknown>;

const SESSION_FILE = /^[^/]+\/([^/]+)\.jsonl$/;
const SUBAGENT_FILE = /^[^/]+\/([^/]+)\/subagents\/[^/]+\.jsonl$/;

/** What a transcript path says: its session, and whether it is a subagent's. Undefined for any other file. */
export function fileRef(root: string, path: string): FileRef | undefined {
	if (!path.startsWith(`${root}/`)) return undefined;
	const rel = path.slice(root.length + 1);
	const main = SESSION_FILE.exec(rel)?.[1];
	if (main !== undefined && isSessionId(main))
		return { path, sessionId: main, isSubagent: false };
	const sub = SUBAGENT_FILE.exec(rel)?.[1];
	if (sub !== undefined && isSessionId(sub))
		return { path, sessionId: sub, isSubagent: true };
	return undefined;
}

const obj = (v: unknown): Entry | undefined =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Entry)
		: undefined;
const count = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const countOrNull = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const str = (v: unknown) => (typeof v === "string" ? v : null);
const msOf = (v: unknown) => {
	const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
	return Number.isFinite(ms) ? ms : undefined;
};

/** The leading tag of a user row's text, read only to classify it; the text itself is never kept. */
const leadingTag = (content: unknown): string | undefined => {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? str(obj(content.find((b) => obj(b)?.type === "text"))?.text)
				: null;
	return text === null ? undefined : /^\s*<([a-z-]+)>/.exec(text)?.[1];
};

/** A main-thread user row the person or the session sent, by kind; undefined for tool results, meta rows, compaction summaries and sidechains. */
export function classifyPrompt(e: Entry): PromptKind | undefined {
	if (e.type !== "user" || e.isMeta === true || e.isCompactSummary === true)
		return undefined;
	if (e.isSidechain === true) return undefined;
	const content = obj(e.message)?.content;
	if (
		Array.isArray(content) &&
		content.some((b) => obj(b)?.type === "tool_result")
	)
		return undefined;
	if (obj(e.origin)?.kind === "task-notification") return "task-notification";
	switch (leadingTag(content)) {
		case "command-name":
		case "command-message":
			return "command";
		case "local-command-stdout":
		case "local-command-stderr":
		case "local-command-caveat":
		case "bash-stdout":
		case "bash-stderr":
			return "command-output";
		case "bash-input":
			return "bash";
		case "task-notification":
			return "task-notification";
		default:
			return "prompt";
	}
}

/** The same message written again as it streamed: only its output grows. */
export const mergeRequest = (a: RequestRow, b: RequestRow): RequestRow => ({
	...a,
	firstMs: Math.min(a.firstMs, b.firstMs),
	lastMs: Math.max(a.lastMs, b.lastMs),
	output: Math.max(a.output, b.output),
});

function requestOf(e: Entry, ref: FileRef): RequestRow | undefined {
	const m = obj(e.message);
	const u = obj(m?.usage);
	const id = str(m?.id);
	const ms = msOf(e.timestamp);
	if (u === undefined || id === null || ms === undefined) return undefined;
	if (m?.model === "<synthetic>") return undefined;
	const split = obj(u.cache_creation);
	return {
		id,
		sessionId: ref.sessionId,
		isSubagent: ref.isSubagent ? 1 : 0,
		agentId: str(e.agentId),
		firstMs: ms,
		lastMs: ms,
		model: str(m?.model),
		input: count(u.input_tokens),
		output: count(u.output_tokens),
		read: count(u.cache_read_input_tokens),
		creation: count(u.cache_creation_input_tokens),
		eph5m: countOrNull(split?.ephemeral_5m_input_tokens),
		eph1h: countOrNull(split?.ephemeral_1h_input_tokens),
		path: ref.path,
	};
}

/** Reads one transcript's lines into rows; a line that is not JSON (one being written) is skipped. */
export function parseTranscript(text: string, ref: FileRef): Parsed {
	const requests = new Map<string, RequestRow>();
	const prompts: PromptRow[] = [];
	const compactions: CompactionRow[] = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		let e: Entry | undefined;
		try {
			e = obj(JSON.parse(line));
		} catch {
			continue;
		}
		if (e === undefined) continue;
		if (e.type === "assistant") {
			const r = requestOf(e, ref);
			if (r === undefined) continue;
			const prev = requests.get(r.id);
			requests.set(r.id, prev === undefined ? r : mergeRequest(prev, r));
			continue;
		}
		const uuid = str(e.uuid);
		const tsMs = msOf(e.timestamp);
		if (uuid === null || tsMs === undefined) continue;
		const base = { uuid, sessionId: ref.sessionId, tsMs, path: ref.path };
		if (e.type === "user" && !ref.isSubagent) {
			const kind = classifyPrompt(e);
			if (kind !== undefined) prompts.push({ ...base, kind });
		} else if (e.type === "system" && e.subtype === "compact_boundary") {
			const c = obj(e.compactMetadata);
			compactions.push({
				...base,
				trigger: str(c?.trigger),
				preTokens: countOrNull(c?.preTokens),
				postTokens: countOrNull(c?.postTokens),
			});
		}
	}
	return { requests: [...requests.values()], prompts, compactions };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingest (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	lock_pid INTEGER,
	lock_ms INTEGER,
	last_ms INTEGER
);
CREATE TABLE IF NOT EXISTS files (
	path TEXT PRIMARY KEY,
	size INTEGER NOT NULL,
	mtime_ms REAL NOT NULL,
	ingested_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	is_subagent INTEGER NOT NULL,
	agent_id TEXT,
	first_ms INTEGER NOT NULL,
	last_ms INTEGER NOT NULL,
	model TEXT,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	cache_read_input_tokens INTEGER NOT NULL,
	cache_creation_input_tokens INTEGER NOT NULL,
	ephemeral_5m_input_tokens INTEGER,
	ephemeral_1h_input_tokens INTEGER,
	path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_first ON requests (session_id, is_subagent, first_ms);
CREATE INDEX IF NOT EXISTS requests_last ON requests (session_id, is_subagent, last_ms);
CREATE TABLE IF NOT EXISTS prompts (
	uuid TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	ts_ms INTEGER NOT NULL,
	kind TEXT NOT NULL,
	path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prompts_ts ON prompts (session_id, ts_ms);
CREATE TABLE IF NOT EXISTS compactions (
	uuid TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	ts_ms INTEGER NOT NULL,
	trigger TEXT,
	pre_tokens INTEGER,
	post_tokens INTEGER,
	path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	session_id TEXT PRIMARY KEY,
	started_ms INTEGER,
	arm TEXT CHECK (arm IN ('on', 'off')),
	cc_version TEXT,
	ember_version TEXT,
	ember_source TEXT,
	opt_ttl_minutes REAL,
	opt_refresh INTEGER,
	opt_refresh_short_ttl INTEGER,
	opt_refresh_lead_seconds REAL,
	ember_seen_ms INTEGER,
	updated_ms INTEGER
);
CREATE TABLE IF NOT EXISTS forks (
	session_id TEXT NOT NULL,
	fired_ms INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	is_answered INTEGER NOT NULL,
	reason TEXT NOT NULL,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	cache_read_input_tokens INTEGER NOT NULL,
	cache_creation_input_tokens INTEGER NOT NULL,
	five_hour_before REAL,
	five_hour_after REAL,
	seven_day_before REAL,
	seven_day_after REAL,
	PRIMARY KEY (session_id, fired_ms)
);
CREATE TABLE IF NOT EXISTS probes (
	session_id TEXT NOT NULL,
	at_ms INTEGER NOT NULL,
	PRIMARY KEY (session_id, at_ms)
);
-- A pause: the gap from the session's last main-thread request to the last user row before its next main-thread request.
CREATE VIEW IF NOT EXISTS pauses AS
WITH p AS (
	SELECT u.session_id, u.uuid, u.kind, u.ts_ms,
		(SELECT MAX(r.last_ms) FROM requests r
			WHERE r.session_id = u.session_id AND r.is_subagent = 0 AND r.last_ms < u.ts_ms) AS prev_ms,
		(SELECT MIN(r.first_ms) FROM requests r
			WHERE r.session_id = u.session_id AND r.is_subagent = 0 AND r.first_ms > u.ts_ms) AS next_ms
	FROM prompts u
)
SELECT p.session_id, s.arm, p.uuid AS prompt_uuid, p.kind, p.ts_ms AS prompt_ms,
	p.prev_ms, p.ts_ms - p.prev_ms AS gap_ms,
	(SELECT r.id FROM requests r
		WHERE r.session_id = p.session_id AND r.is_subagent = 0 AND r.first_ms = p.next_ms
		ORDER BY r.id LIMIT 1) AS request_id
FROM p LEFT JOIN sessions s ON s.session_id = p.session_id
WHERE p.prev_ms IS NOT NULL AND p.next_ms IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM prompts u2
		WHERE u2.session_id = p.session_id AND u2.ts_ms > p.ts_ms AND u2.ts_ms < p.next_ms);
`;

export function openDb(path: string): Database {
	const isFile = path !== ":memory:";
	if (isFile) {
		mkdirSync(DIR, { recursive: true, mode: 0o700 });
		chmodSync(DIR, 0o700);
	}
	const db = new Database(path, { create: true, strict: true });
	// The journal files sqlite makes take the database file's mode.
	if (isFile) chmodSync(path, 0o600);
	db.exec("PRAGMA busy_timeout = 10000");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(SCHEMA);
	return db;
}

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === "EPERM";
	}
};

/** Takes the ingest lock unless a live run holds it; one immediate transaction, so two runs cannot both take it. */
export function takeLock(db: Database, pid: number, nowMs: number): boolean {
	return db
		.transaction(() => {
			const row = db
				.query("SELECT lock_pid, lock_ms FROM ingest WHERE id = 1")
				.get() as { lock_pid: number | null; lock_ms: number | null } | null;
			if (
				row?.lock_pid != null &&
				nowMs - (row.lock_ms ?? 0) < LOCK_STALE_MS &&
				isAlive(row.lock_pid)
			)
				return false;
			db.query(
				`INSERT INTO ingest (id, lock_pid, lock_ms) VALUES (1, ?, ?)
				ON CONFLICT (id) DO UPDATE SET lock_pid = excluded.lock_pid, lock_ms = excluded.lock_ms`,
			).run(pid, nowMs);
			return true;
		})
		.immediate();
}

export function releaseLock(db: Database, pid: number, nowMs: number): void {
	db.query(
		"UPDATE ingest SET lock_pid = NULL, lock_ms = NULL, last_ms = ? WHERE id = 1 AND lock_pid = ?",
	).run(nowMs, pid);
}

function writeParsed(
	db: Database,
	p: Parsed,
	file: { path: string; size: number; mtimeMs: number },
	nowMs: number,
): void {
	const req = db.query(
		`INSERT INTO requests (id, session_id, is_subagent, agent_id, first_ms, last_ms, model, input_tokens,
			output_tokens, cache_read_input_tokens, cache_creation_input_tokens, ephemeral_5m_input_tokens,
			ephemeral_1h_input_tokens, path)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			first_ms = MIN(first_ms, excluded.first_ms),
			last_ms = MAX(last_ms, excluded.last_ms),
			output_tokens = MAX(output_tokens, excluded.output_tokens)`,
	);
	const prompt = db.query(
		"INSERT OR IGNORE INTO prompts (uuid, session_id, ts_ms, kind, path) VALUES (?, ?, ?, ?, ?)",
	);
	const compaction = db.query(
		`INSERT OR IGNORE INTO compactions (uuid, session_id, ts_ms, trigger, pre_tokens, post_tokens, path)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	db.transaction(() => {
		for (const r of p.requests)
			req.run(
				r.id,
				r.sessionId,
				r.isSubagent,
				r.agentId,
				r.firstMs,
				r.lastMs,
				r.model,
				r.input,
				r.output,
				r.read,
				r.creation,
				r.eph5m,
				r.eph1h,
				r.path,
			);
		for (const u of p.prompts)
			prompt.run(u.uuid, u.sessionId, u.tsMs, u.kind, u.path);
		for (const c of p.compactions)
			compaction.run(
				c.uuid,
				c.sessionId,
				c.tsMs,
				c.trigger,
				c.preTokens,
				c.postTokens,
				c.path,
			);
		db.query(
			`INSERT INTO files (path, size, mtime_ms, ingested_ms) VALUES (?, ?, ?, ?)
			ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
				ingested_ms = excluded.ingested_ms`,
		).run(file.path, file.size, file.mtimeMs, nowMs);
	})();
}

export type IngestResult =
	| { status: "busy" }
	| { status: "done"; read: number; skipped: number };

/** Reads every transcript under `root` that changed since it was last read, oldest first, one transaction per file. */
export function ingest(
	db: Database,
	root: string,
	run: { nowMs: number; pid: number },
): IngestResult {
	if (!takeLock(db, run.pid, run.nowMs)) return { status: "busy" };
	let read = 0;
	let skipped = 0;
	try {
		const known = db.query("SELECT size, mtime_ms FROM files WHERE path = ?");
		const files = [
			...new Bun.Glob("*/*.jsonl").scanSync({ cwd: root, absolute: true }),
			...new Bun.Glob("*/*/subagents/*.jsonl").scanSync({
				cwd: root,
				absolute: true,
			}),
		]
			.flatMap((path) => {
				const ref = fileRef(root, path);
				if (ref === undefined) return [];
				try {
					const st = statSync(path);
					return [{ ref, size: st.size, mtimeMs: st.mtimeMs }];
				} catch {
					return [];
				}
			})
			.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const f of files) {
			const prev = known.get(f.ref.path) as {
				size: number;
				mtime_ms: number;
			} | null;
			if (prev?.size === f.size && prev.mtime_ms === f.mtimeMs) {
				skipped += 1;
				continue;
			}
			try {
				// Stat came first: a line written since is read now and read again next time, never lost.
				const text = readFileSync(f.ref.path, "utf8");
				writeParsed(
					db,
					parseTranscript(text, f.ref),
					{ path: f.ref.path, size: f.size, mtimeMs: f.mtimeMs },
					run.nowMs,
				);
				read += 1;
			} catch {
				// A file gone or unreadable is tried again on the next run.
			}
		}
	} finally {
		releaseLock(db, run.pid, Date.now());
	}
	return { status: "done", read, skipped };
}

export function writeRecord(db: Database, r: BenchRecord, nowMs: number): void {
	switch (r.kind) {
		case "session":
			db.query(
				`INSERT INTO sessions (session_id, started_ms, arm, cc_version, ember_version, ember_source,
					opt_ttl_minutes, opt_refresh, opt_refresh_short_ttl, opt_refresh_lead_seconds, updated_ms)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (session_id) DO UPDATE SET
					started_ms = excluded.started_ms,
					-- Off sticks: a record sent before /bench off may land after it.
					arm = CASE WHEN sessions.arm = 'off' THEN 'off' ELSE excluded.arm END,
					cc_version = COALESCE(excluded.cc_version, sessions.cc_version),
					ember_version = COALESCE(excluded.ember_version, sessions.ember_version),
					ember_source = CASE WHEN excluded.ember_source = 'unknown' AND sessions.ember_source IS NOT NULL
						THEN sessions.ember_source ELSE excluded.ember_source END,
					opt_ttl_minutes = excluded.opt_ttl_minutes,
					opt_refresh = excluded.opt_refresh,
					opt_refresh_short_ttl = excluded.opt_refresh_short_ttl,
					opt_refresh_lead_seconds = excluded.opt_refresh_lead_seconds,
					updated_ms = excluded.updated_ms`,
			).run(
				r.session,
				r.startedMs,
				r.arm === 0 ? "off" : "on",
				r.ccVersion,
				r.emberVersion,
				r.emberSource,
				r.ttlMinutes,
				r.refresh,
				r.refreshShortTtl,
				r.refreshLeadSeconds,
				nowMs,
			);
			return;
		case "fork":
			db.query(
				`INSERT OR IGNORE INTO forks (session_id, fired_ms, duration_ms, is_answered, reason, input_tokens,
					output_tokens, cache_read_input_tokens, cache_creation_input_tokens, five_hour_before,
					five_hour_after, seven_day_before, seven_day_after)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				r.session,
				r.firedMs,
				r.durationMs,
				r.isAnswered,
				r.reason,
				r.input,
				r.output,
				r.read,
				r.creation,
				r.fiveHourBefore,
				r.fiveHourAfter,
				r.sevenDayBefore,
				r.sevenDayAfter,
			);
			return;
		case "probe":
			db.query(
				"INSERT OR IGNORE INTO probes (session_id, at_ms) VALUES (?, ?)",
			).run(r.session, r.atMs);
			return;
		case "seen":
			db.query(
				`INSERT INTO sessions (session_id, ember_seen_ms, updated_ms) VALUES (?, ?, ?)
				ON CONFLICT (session_id) DO UPDATE SET
					ember_seen_ms = COALESCE(sessions.ember_seen_ms, excluded.ember_seen_ms)`,
			).run(r.session, r.atMs, nowMs);
	}
}

const local = (ms: number) => new Date(ms).toLocaleString("sv-SE");

export function statusText(
	db: Database,
	session: string,
	nowMs: number,
): string {
	const s = db
		.query("SELECT ember_seen_ms FROM sessions WHERE session_id = ?")
		.get(session) as { ember_seen_ms: number | null } | null;
	const forks = db
		.query(
			"SELECT COUNT(*) AS n, COALESCE(SUM(reason = 'off'), 0) AS off FROM forks WHERE session_id = ?",
		)
		.get(session) as { n: number; off: number };
	const byArm = new Map(
		(
			db
				.query(
					"SELECT COALESCE(arm, 'unrecorded') AS arm, COUNT(*) AS n FROM pauses WHERE gap_ms >= ? GROUP BY 1",
				)
				.all(LONG_PAUSE_MS) as { arm: string; n: number }[]
		).map((r) => [r.arm, r.n]),
	);
	const last = (
		db.query("SELECT last_ms FROM ingest WHERE id = 1").get() as {
			last_ms: number | null;
		} | null
	)?.last_ms;
	const seenMs = s?.ember_seen_ms;
	return [
		`ember calls seen this session: ${seenMs == null ? "not yet (run /ember to check)" : `yes, first at ${local(seenMs)}`}`,
		`ember refresh forks this session: ${forks.n} (${forks.off} refused by the off arm)`,
		`long pauses (55 min or more): on ${byArm.get("on") ?? 0}, off ${byArm.get("off") ?? 0}, before ember-bench ${byArm.get("unrecorded") ?? 0}`,
		`last ingest: ${last == null ? "never" : `${local(last)} (${Math.round((nowMs - last) / 60_000)} min ago)`}`,
	].join("\n");
}

export function deleteAll(db: Database): void {
	db.transaction(() =>
		db.exec(`
			DELETE FROM files;
			DELETE FROM requests;
			DELETE FROM prompts;
			DELETE FROM compactions;
			DELETE FROM sessions;
			DELETE FROM forks;
			DELETE FROM probes;
			UPDATE ingest SET last_ms = NULL;
		`),
	)();
	db.exec("VACUUM");
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

function main(argv: readonly string[]): number {
	const [cmd, arg] = argv;
	const db = openDb(`${DIR}/bench.db`);
	try {
		switch (cmd) {
			case "ingest":
				ingest(db, PROJECTS, { nowMs: Date.now(), pid: process.pid });
				return 0;
			case "record": {
				let r: unknown;
				try {
					r = JSON.parse(arg ?? "");
				} catch {
					r = undefined;
				}
				if (!isRecord(r)) {
					console.error("bench: refused an invalid record");
					return 2;
				}
				writeRecord(db, r, Date.now());
				return 0;
			}
			case "status":
				if (!isSessionId(arg)) {
					console.error("bench: status needs a session id");
					return 2;
				}
				console.log(statusText(db, arg, Date.now()));
				return 0;
			case "delete":
				deleteAll(db);
				return 0;
			default:
				console.error(
					"usage: bench.ts ingest | record <json> | status <session> | delete",
				);
				return 2;
		}
	} finally {
		db.close();
	}
}

if (import.meta.main) {
	try {
		process.exit(main(Bun.argv.slice(2)));
	} catch (e) {
		console.error(`bench: failed (${(e as Error).name})`);
		process.exit(1);
	}
}
