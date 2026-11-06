import { describe, expect, test } from "claude-code/testing";
import { DEFAULT_LIMITS, scanText } from "../hooks/detect.ts";
import type { Entry } from "../hooks/dotenv.ts";
import {
	type ApplyFile,
	classify,
	createEnrollment,
	type FileState,
	MAX_FILES,
	mentionsPath,
	parseList,
	type Status,
	statusOf,
} from "../hooks/enroll.ts";
import { fakes } from "./fakes.ts";

const fake = fakes(23);
const never = { now: () => 0, deadline: Number.POSITIVE_INFINITY };

/** Every fake value a test fed to `enroll`, for the R10 check. */
const seen: string[] = [];
const remember = (value: string) => {
	seen.push(value);
	return value;
};
/** R10: the JSON text of a status holds none of the values fed so far. */
const expectNoValue = (status: Status) => {
	const text = JSON.stringify(status);
	for (const value of seen) {
		if (value !== "") expect(text.includes(value)).toBe(false);
	}
};

const entries = (pairs: [string, string][]): Entry[] =>
	pairs.map(([name, value], i) => ({
		name,
		value: remember(value),
		start: i,
		end: i + 1,
	}));

/** True when `value` is found by the enrollment's known-value set. */
const hides = (e: ReturnType<typeof createEnrollment>, value: string) => {
	const result = scanText(
		`out ${value} end`,
		e.knownSet(),
		DEFAULT_LIMITS,
		never,
	);
	return (
		result.status === "found" && result.hits.some((hit) => hit.kind === "known")
	);
};

const active = (path: string, pairs: [string, string][]): ApplyFile => {
	const { names, feed } = classify(entries(pairs));
	return { path, state: { kind: "active", names }, feed };
};

describe("R1 the list", () => {
	test("R1: entries are trimmed, and empty ones and repeats are dropped", () => {
		expect(parseList(" .env , ,config/.env.local,.env,, ")).toEqual([
			{ path: ".env" },
			{ path: "config/.env.local" },
		]);
	});

	test("R1: an empty list has no entries", () => {
		expect(parseList("")).toEqual([]);
		expect(parseList(" , ,")).toEqual([]);
	});

	test("R1: entries after the 10th are refused with too-many", () => {
		const list = Array.from({ length: 12 }, (_, i) => `f${i}.env`).join(",");
		const result = parseList(list);
		expect(MAX_FILES).toBe(10);
		expect(result).toHaveLength(12);
		expect(result.slice(0, 10).every((entry) => !entry.refused)).toBe(true);
		expect(result.slice(10)).toEqual([
			{ path: "f10.env", refused: "too-many" },
			{ path: "f11.env", refused: "too-many" },
		]);
	});

	test("R1: a repeat does not count toward the 10", () => {
		const list = [...Array(10).fill(".env"), "a.env", "b.env"].join(",");
		expect(parseList(list).every((entry) => !entry.refused)).toBe(true);
	});
});

describe("R2 path spelling", () => {
	const refusal = (path: string) => parseList(path)[0]?.refused;

	for (const path of [
		"/etc/app.env",
		"~/.env",
		"~",
		"C:\\app\\.env",
		"c:.env",
		"\\\\server\\share\\.env",
		"//server/share/.env",
		"\\app\\.env",
	]) {
		test(`R2: ${path} is refused as absolute`, () => {
			expect(refusal(path)).toBe("absolute");
		});
	}

	test("R2: a path with NUL is refused as bad-path", () => {
		expect(refusal(".env\u0000.txt")).toBe("bad-path");
	});

	for (const path of [
		"../.env",
		"config/../../.env",
		"config\\..\\.env",
		"..",
		"a/..",
	]) {
		test(`R2: ${path} is refused as parent`, () => {
			expect(refusal(path)).toBe("parent");
		});
	}

	for (const path of [
		".env",
		"config/.env.local",
		"..env",
		"a..b/.env",
		"./.env",
		"dir\\.env",
	]) {
		test(`R2: ${path} is accepted`, () => {
			expect(refusal(path)).toBeUndefined();
		});
	}
});

describe("R4 which values feed the set", () => {
	const word = (name: string) => classify(entries([[name, fake.secret(20)]]));

	for (const name of [
		"API_KEY",
		"GITHUB_TOKEN",
		"CLIENT_SECRET",
		"DB_PASSWORD",
		"SMTP_PASSWD",
		"MYSQL_PWD",
		"SENTRY_DSN",
		"BASIC_AUTH",
		"GCP_CREDENTIALS",
		"PRIVATE_PEM",
		"api_key",
		"Session_Token",
	]) {
		test(`R4: a name with a secret word feeds its value (${name})`, () => {
			const { names, feed } = word(name);
			expect(names).toEqual([{ name, hidden: true }]);
			expect(feed).toHaveLength(1);
			expect(feed[0]?.name).toBe(name);
		});
	}

	test("R4 (Q22): a detector hit under a plain name feeds the value", () => {
		const url = `postgres://app:${fake.secret(24)}@db.example:5432/app`;
		const { names, feed } = classify(
			entries([
				["DATABASE_URL", url],
				["UPSTREAM", fake.githubClassic],
			]),
		);
		expect(names).toEqual([
			{ name: "DATABASE_URL", hidden: true },
			{ name: "UPSTREAM", hidden: true },
		]);
		expect(feed.map((k) => k.value)).toEqual([url, fake.githubClassic]);
	});

	test("R4: a plain name with a plain value is not-secret and not fed", () => {
		const { names, feed } = classify(entries([["APP_NAME", "blindfold demo"]]));
		expect(names).toEqual([
			{ name: "APP_NAME", hidden: false, why: "not-secret" },
		]);
		expect(feed).toEqual([]);
	});

	test("R4 (Q14): a fed value under 8 characters is too-short", () => {
		const { names, feed } = classify(
			entries([
				["API_KEY", "abc1234"],
				["EMPTY_TOKEN", ""],
				["LONG_KEY", "abcd1234"],
			]),
		);
		expect(names).toEqual([
			{ name: "API_KEY", hidden: false, why: "too-short" },
			{ name: "EMPTY_TOKEN", hidden: false, why: "too-short" },
			{ name: "LONG_KEY", hidden: true },
		]);
		expect(feed.map((k) => k.name)).toEqual(["LONG_KEY"]);
	});

	test("R4: a repeated name has 1 state, from its last value, and every value feeds", () => {
		const first = fake.secret(16);
		const last = fake.secret(16);
		const { names, feed } = classify(
			entries([
				["API_KEY", first],
				["API_KEY", last],
			]),
		);
		expect(names).toEqual([{ name: "API_KEY", hidden: true }]);
		expect(feed.map((k) => k.value)).toEqual([first, last]);
	});

	test("R4: every learned value feeds the set, whatever its name", () => {
		const e = createEnrollment();
		const value = remember(fake.secret(12));
		expect(hides(e, value)).toBe(false);
		e.learn("APP_NAME", value);
		expect(hides(e, value)).toBe(true);
		expectNoValue(e.status());
	});

	test("R4 (Q14): a learned value under 8 characters is not kept", () => {
		const e = createEnrollment();
		e.learn("PIN_CODE", "1234567");
		expect(hides(e, "1234567")).toBe(false);
	});
});

describe("R5 learned values stay learned", () => {
	test("R5 (Q23): a value removed from a file stays in the set", () => {
		const e = createEnrollment();
		const old = fake.secret(20);
		const next = fake.secret(20);
		e.apply([active(".env", [["API_KEY", old]])]);
		e.apply([active(".env", [["API_KEY", next]])]);
		expect(hides(e, old)).toBe(true);
		expect(hides(e, next)).toBe(true);
		expectNoValue(e.status());
	});

	test("R5: forget drops the values of 1 file and its state", () => {
		const e = createEnrollment();
		const kept = fake.secret(20);
		const gone = fake.secret(20);
		e.apply([
			active(".env", [["API_KEY", kept]]),
			active("other.env", [["OTHER_TOKEN", gone]]),
		]);
		e.forget("other.env");
		expect(hides(e, kept)).toBe(true);
		expect(hides(e, gone)).toBe(false);
		expect(e.status().files.map((f) => f.path)).toEqual([".env"]);
	});

	test("R5: drop drops every value, learned ones too, and every file state", () => {
		const e = createEnrollment();
		const fromFile = fake.secret(20);
		const written = remember(fake.secret(20));
		e.apply([active(".env", [["API_KEY", fromFile]])]);
		e.learn("NEW_TOKEN", written);
		e.drop();
		expect(hides(e, fromFile)).toBe(false);
		expect(hides(e, written)).toBe(false);
		expect(e.status()).toEqual({ files: [], shield: "active" });
	});

	test("R5: a file no longer listed keeps its values", () => {
		const e = createEnrollment();
		const value = fake.secret(20);
		e.apply([active("old.env", [["API_KEY", value]])]);
		e.apply([active(".env", [["APP_NAME", "plain"]])]);
		expect(hides(e, value)).toBe(true);
		expect(e.status().files.map((f) => f.path)).toEqual([".env"]);
	});

	test("R5: knownSet returns the same set until the values change", () => {
		const e = createEnrollment();
		const first = e.knownSet();
		expect(e.knownSet()).toBe(first);
		e.learn("API_KEY", remember(fake.secret(20)));
		expect(e.knownSet()).not.toBe(first);
	});
});

describe("R6 shield state", () => {
	const states: [string, FileState, Status["shield"]][] = [
		["active", { kind: "active", names: [] }, "active"],
		["missing", { kind: "missing" }, "active"],
		["stale", { kind: "stale", reason: "read-failed" }, "degraded"],
		["refused", { kind: "refused", reason: "parent" }, "degraded"],
	];

	for (const [kind, state, shield] of states) {
		test(`R6: a ${kind} file gives a shield that is ${shield}`, () => {
			expect(
				statusOf([
					{ path: ".env", state: { kind: "active", names: [] } },
					{ path: "x.env", state },
				]).shield,
			).toBe(shield);
		});
	}

	test("R6: no files gives an active shield", () => {
		expect(statusOf([])).toEqual({ files: [], shield: "active" });
	});

	test("R6: a stale file shows no names and keeps its last values", () => {
		const e = createEnrollment();
		const value = fake.secret(20);
		e.apply([active(".env", [["API_KEY", value]])]);
		e.apply([
			{
				path: ".env",
				state: { kind: "stale", reason: "read-failed" },
				feed: [],
			},
		]);
		expect(e.status()).toEqual({
			files: [
				{ path: ".env", state: { kind: "stale", reason: "read-failed" } },
			],
			shield: "degraded",
		});
		expect(hides(e, value)).toBe(true);
	});

	test("R6: refused entries from the list make the status degraded", () => {
		const e = createEnrollment();
		e.apply(
			parseList(".env,../x.env").map(({ path, refused }) => ({
				path,
				state: refused
					? { kind: "refused", reason: refused }
					: { kind: "missing" },
				feed: [],
			})),
		);
		expect(e.status()).toEqual({
			files: [
				{ path: ".env", state: { kind: "missing" } },
				{ path: "../x.env", state: { kind: "refused", reason: "parent" } },
			],
			shield: "degraded",
		});
	});
});

describe("refreshIfNamed name check", () => {
	const paths = [".env", "config/.env.local", "dir\\win.env"];

	for (const input of [
		{ file_path: "/repo/.env" },
		{ command: "cat config/.env.local" },
		{ command: "echo X >> .env.local" },
		{ path: "dir\\win.env" },
		{ pattern: "win.env" },
	]) {
		test(`names a listed file: ${JSON.stringify(input)}`, () => {
			expect(mentionsPath(input, paths)).toBe(true);
		});
	}

	for (const input of [
		{ file_path: "/repo/README.md" },
		{ command: "ls" },
		undefined,
		null,
		42,
	]) {
		test(`does not name a listed file: ${JSON.stringify(input)}`, () => {
			expect(mentionsPath(input, paths)).toBe(false);
		});
	}

	test("no paths names nothing, and an empty base name matches nothing", () => {
		expect(mentionsPath({ file_path: ".env" }, [])).toBe(false);
		expect(mentionsPath({ command: "ls" }, ["config/"])).toBe(false);
	});

	test("an input that has no JSON text counts as naming a file", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(mentionsPath(cycle, paths)).toBe(true);
		expect(mentionsPath({ n: 1n }, paths)).toBe(true);
	});
});

describe("R10 no leak", () => {
	test("R10: every fake value fed in these tests stays out of a status", () => {
		const e = createEnrollment();
		const files = [
			active(".env", [
				["API_KEY", fake.secret(20)],
				["UPSTREAM", fake.stripeSecret],
				["APP_NAME", "plain value here"],
				["SHORT_TOKEN", "abc"],
			]),
			{ path: "gone.env", state: { kind: "missing" }, feed: [] },
		] satisfies ApplyFile[];
		e.apply(files);
		e.learn("NEW_TOKEN", remember(fake.anthropic));
		expect(seen.length).toBeGreaterThan(3);
		expectNoValue(e.status());
		expectNoValue(statusOf(files));
	});

	test("R10: a status holds only paths, names, kinds, and reasons", () => {
		const e = createEnrollment();
		e.apply([active(".env", [["API_KEY", fake.secret(20)]])]);
		expect(e.status()).toEqual({
			files: [
				{
					path: ".env",
					state: { kind: "active", names: [{ name: "API_KEY", hidden: true }] },
				},
			],
			shield: "active",
		});
	});
});
