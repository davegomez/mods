import { describe, expect, test } from "claude-code/testing";
import { DEFAULT_LIMITS, scanText } from "../hooks/detect.ts";
import { type Entry, MAX_FILE_CHARS } from "../hooks/dotenv.ts";
import {
	type ApplyFile,
	addFile,
	classify,
	createEnrollment,
	type FileState,
	load,
	MAX_FILE_BYTES,
	MAX_FILES,
	mentionsPath,
	parseList,
	refreshIfNamed,
	type Status,
	statusOf,
} from "../hooks/enroll.ts";
import { type FakeFile, fakeApi, fakes, gate, REAL_ROOT } from "./fakes.ts";

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
		e.learn(".env", "APP_NAME", value);
		expect(hides(e, value)).toBe(true);
		expectNoValue(e.status());
	});

	test("R4 (Q14): a learned value under 8 characters is not kept", () => {
		const e = createEnrollment();
		e.learn(".env", "PIN_CODE", "1234567");
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

	test("R4, R5: forget drops the values learned for that file, and keeps the others", () => {
		const e = createEnrollment();
		const mine = remember(fake.secret(20));
		const other = remember(fake.secret(20));
		e.learn("new.env", "NEW_TOKEN", mine);
		e.learn(".env", "API_KEY", other);
		e.forget("new.env");
		expect(hides(e, mine)).toBe(false);
		expect(hides(e, other)).toBe(true);
	});

	test("R5: drop drops every value, learned ones too, and every file state", () => {
		const e = createEnrollment();
		const fromFile = fake.secret(20);
		const written = remember(fake.secret(20));
		e.apply([active(".env", [["API_KEY", fromFile]])]);
		e.learn(".env", "NEW_TOKEN", written);
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
		e.learn(".env", "API_KEY", remember(fake.secret(20)));
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
		e.learn(".env", "NEW_TOKEN", remember(fake.anthropic));
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

/** A fresh enrollment, and a fake `$` over `files` to load them with. */
const setup = (
	files: Record<string, FakeFile>,
	options?: Parameters<typeof fakeApi>[1],
) => ({ e: createEnrollment(), ...fakeApi(files, options) });

const envText = (value: string) => `API_KEY=${remember(value)}\n`;
const secretFile = (): FakeFile => ({ text: envText(fake.secret(24)) });
const stateOf = (status: Status) => status.files.map((f) => f.state);

describe("R2 path checks through $.fs.stat", () => {
	test("R2: a file under the resolved root is read through its real path", async () => {
		const value = fake.secret(24);
		const { e, api, reads } = setup({ ".env": { text: envText(value) } });
		const status = await load(api, e, ".env");
		expect(status).toEqual({
			files: [
				{
					path: ".env",
					state: { kind: "active", names: [{ name: "API_KEY", hidden: true }] },
				},
			],
			shield: "active",
		});
		expect(reads).toEqual([`${REAL_ROOT}/.env`]);
		expect(hides(e, value)).toBe(true);
		expectNoValue(status);
	});

	test("R2: a file reached through a folder link inside the root is read at its real path", async () => {
		const { e, api, reads } = setup({
			"link/.env": { ...secretFile(), realPath: `${REAL_ROOT}/real/.env` },
		});
		const status = await load(api, e, "link/.env");
		expect(status.files[0]?.state.kind).toBe("active");
		expect(reads).toEqual([`${REAL_ROOT}/real/.env`]);
	});

	const refusals: [string, FakeFile, FileState][] = [
		[
			"a symbolic link is refused as symlink",
			{ ...secretFile(), isLink: true },
			{ kind: "refused", reason: "symlink" },
		],
		[
			"a real path outside the root is refused as outside-root",
			{ ...secretFile(), realPath: "/etc/app.env" },
			{ kind: "refused", reason: "outside-root" },
		],
		[
			"a sibling folder that starts with the root's name is outside-root",
			{ ...secretFile(), realPath: `${REAL_ROOT}-other/.env` },
			{ kind: "refused", reason: "outside-root" },
		],
		[
			"a path with no real path is refused as outside-root",
			{ ...secretFile(), realPath: null },
			{ kind: "refused", reason: "outside-root" },
		],
		[
			"a folder is stale with not-a-file",
			{ kind: "dir" },
			{ kind: "stale", reason: "not-a-file" },
		],
		[
			"a stat that fails on a path that exists is stale with read-failed",
			{ ...secretFile(), statFails: true },
			{ kind: "stale", reason: "read-failed" },
		],
	];

	for (const [name, file, state] of refusals) {
		test(`R2: ${name}, and is never read`, async () => {
			const { e, api, reads } = setup({ ".env": file });
			const status = await load(api, e, ".env");
			expect(stateOf(status)).toEqual([state]);
			expect(status.shield).toBe("degraded");
			expect(reads).toEqual([]);
			expectNoValue(status);
		});
	}

	test("R2: a missing file is missing, and the shield stays active", async () => {
		const { e, api } = setup({});
		expect(await load(api, e, ".env")).toEqual({
			files: [{ path: ".env", state: { kind: "missing" } }],
			shield: "active",
		});
	});

	test("R2: a root that does not resolve makes every accepted entry read-failed", async () => {
		const { e, api, reads } = setup(
			{ ".env": secretFile() },
			{ realRoot: null },
		);
		const status = await load(api, e, ".env,../x.env");
		expect(stateOf(status)).toEqual([
			{ kind: "stale", reason: "read-failed" },
			{ kind: "refused", reason: "parent" },
		]);
		expect(reads).toEqual([]);
	});

	test("R2: the files keep the list order, refused entries included", async () => {
		const { e, api } = setup({ "a.env": secretFile() });
		const status = await load(api, e, "a.env,../b.env,c.env");
		expect(status.files.map((f) => [f.path, f.state.kind])).toEqual([
			["a.env", "active"],
			["../b.env", "refused"],
			["c.env", "missing"],
		]);
	});
});

describe("R3 reads", () => {
	test("R3: a file over 1 MiB by stat is too-large and never read", async () => {
		const { e, api, reads } = setup({
			".env": { ...secretFile(), size: MAX_FILE_BYTES + 1 },
		});
		const status = await load(api, e, ".env");
		expect(MAX_FILE_BYTES).toBe(1_048_576);
		expect(stateOf(status)).toEqual([{ kind: "stale", reason: "too-large" }]);
		expect(reads).toEqual([]);
	});

	test("R3: a file of exactly 1 MiB by stat is read", async () => {
		const { e, api } = setup({
			".env": { ...secretFile(), size: MAX_FILE_BYTES },
		});
		const status = await load(api, e, ".env");
		expect(status.files[0]?.state.kind).toBe("active");
	});

	test("R3: a read that rejects is stale with read-failed", async () => {
		const { e, api } = setup({ ".env": { ...secretFile(), readFails: true } });
		const status = await load(api, e, ".env");
		expect(stateOf(status)).toEqual([{ kind: "stale", reason: "read-failed" }]);
	});

	test("R3: text that parse finds too large is stale with too-large", async () => {
		const { e, api } = setup({
			".env": { text: `A=${"x".repeat(MAX_FILE_CHARS)}`, size: 10 },
		});
		const status = await load(api, e, ".env");
		expect(stateOf(status)).toEqual([{ kind: "stale", reason: "too-large" }]);
	});

	test("R3, R6: a file that turns stale keeps the values of its last read", async () => {
		const value = fake.secret(24);
		const file: FakeFile = { text: envText(value) };
		const { e, api } = setup({ ".env": file });
		await load(api, e, ".env");
		file.readFails = true;
		const status = await load(api, e, ".env");
		expect(stateOf(status)).toEqual([{ kind: "stale", reason: "read-failed" }]);
		expect(hides(e, value)).toBe(true);
		expectNoValue(status);
	});

	test("R3, R10: an $.fs error becomes a reason only", async () => {
		const { e, api } = setup({
			"a.env": { ...secretFile(), statFails: true },
			"b.env": { ...secretFile(), readFails: true },
		});
		const text = JSON.stringify(await load(api, e, "a.env,b.env,c.env"));
		for (const word of ["EACCES", "EIO", "ENOENT", REAL_ROOT]) {
			expect(text.includes(word)).toBe(false);
		}
	});
});

describe("R7 refreshIfNamed", () => {
	test("R7: refreshIfNamed loads again when the input names a listed file", async () => {
		const file = secretFile();
		const { e, api, reads } = setup({ ".env": file });
		await load(api, e, ".env");
		const value = fake.secret(24);
		file.text = envText(value);
		await refreshIfNamed(api, e, { command: "echo API_KEY=x >> .env" });
		expect(reads).toHaveLength(2);
		expect(hides(e, value)).toBe(true);
		expectNoValue(e.status());
	});

	test("R7: refreshIfNamed does nothing when the input names no listed file", async () => {
		const { e, api, reads } = setup({ ".env": secretFile() });
		await load(api, e, ".env");
		await refreshIfNamed(api, e, { command: "ls" });
		expect(reads).toHaveLength(1);
	});

	test("R7: refreshIfNamed before any load reads nothing", async () => {
		const { e, api, reads } = setup({ ".env": secretFile() });
		await refreshIfNamed(api, e, { command: "cat .env" });
		expect(reads).toEqual([]);
	});
});

describe("R8 overlap", () => {
	test("R8: a load that ends after drop adds nothing", async () => {
		const slow = gate();
		const value = fake.secret(24);
		const { e, api } = setup({
			".env": { text: envText(value), gate: slow.wait },
		});
		const pending = load(api, e, ".env");
		e.drop();
		slow.open();
		await pending;
		expect(e.status()).toEqual({ files: [], shield: "active" });
		expect(hides(e, value)).toBe(false);
	});

	test("R8: of 2 overlapping loads, the newest wins", async () => {
		const slow = gate();
		const old = fake.secret(24);
		const fresh = fake.secret(24);
		const { e, api } = setup({
			"a.env": { text: envText(old), gate: slow.wait },
			"b.env": { text: envText(fresh) },
		});
		const first = load(api, e, "a.env");
		await load(api, e, "b.env");
		slow.open();
		expect((await first).files.map((f) => f.path)).toEqual(["b.env"]);
		expect(e.status().files.map((f) => f.path)).toEqual(["b.env"]);
		expect(hides(e, fresh)).toBe(true);
		expect(hides(e, old)).toBe(false);
	});
});

describe("R9 addFile", () => {
	test("R9: a file under the root is appended to envFiles", async () => {
		const { e, api, sets } = setup({
			".env": secretFile(),
			"config/.env.local": secretFile(),
		});
		await load(api, e, ".env");
		expect(await addFile(api, e, "config/.env.local")).toBe("added");
		expect(sets).toEqual([
			{ key: "blindfold.envFiles", value: ".env,config/.env.local" },
		]);
	});

	test("R9: a missing file is accepted, and 2 adds keep both", async () => {
		const { e, api, sets } = setup({});
		await load(api, e, ".env");
		expect(await addFile(api, e, " a.env ")).toBe("added");
		expect(await addFile(api, e, "b.env")).toBe("added");
		expect(sets.map((s) => s.value)).toEqual([
			".env,a.env",
			".env,a.env,b.env",
		]);
	});

	test("R9: a file already listed is added without a set", async () => {
		const { e, api, sets } = setup({});
		await load(api, e, ".env");
		expect(await addFile(api, e, ".env")).toBe("added");
		expect(sets).toEqual([]);
	});

	test("R9: a set answered with deny returns denied", async () => {
		const { e, api } = setup({}, { setAnswer: { deny: "managed" } });
		await load(api, e, ".env");
		expect(await addFile(api, e, "a.env")).toBe("denied");
		expect(e.listed()).toBe(".env");
	});

	test("R9: a set that rejects returns denied", async () => {
		const { e, api } = setup({});
		api.config.set = async () => {
			throw new Error("no config");
		};
		await load(api, e, ".env");
		expect(await addFile(api, e, "a.env")).toBe("denied");
	});

	const refused: [string, string, Record<string, FakeFile>][] = [
		["a parent path", "../x.env", {}],
		["an absolute path", "/etc/x.env", {}],
		["a path with a comma", "a,b.env", {}],
		["an empty path", " ", {}],
		["a symbolic link", "link.env", { "link.env": { isLink: true } }],
		[
			"a real path outside the root",
			"out.env",
			{ "out.env": { text: "", realPath: "/etc/out.env" } },
		],
		["a folder", "dir", { dir: { kind: "dir" } }],
		["a path whose stat fails", "x.env", { "x.env": { statFails: true } }],
	];

	for (const [name, path, files] of refused) {
		test(`R9: ${name} is refused and not set`, async () => {
			const { e, api, sets } = setup(files);
			await load(api, e, ".env");
			expect(await addFile(api, e, path)).toBe("refused");
			expect(sets).toEqual([]);
		});
	}

	test("R9: a root that does not resolve refuses every path", async () => {
		const { e, api, sets } = setup({}, { realRoot: null });
		expect(await addFile(api, e, "a.env")).toBe("refused");
		expect(sets).toEqual([]);
	});

	test("R9: an 11th file is refused as too-many", async () => {
		const { e, api, sets } = setup({});
		const list = Array.from({ length: MAX_FILES }, (_, i) => `f${i}.env`);
		await load(api, e, list.join(","));
		expect(await addFile(api, e, "more.env")).toBe("refused");
		expect(sets).toEqual([]);
	});
});
