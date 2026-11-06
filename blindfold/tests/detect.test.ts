import { describe, expect, test } from "claude-code/testing";
import type { Known } from "../hooks/detect.ts";
import {
	buildKnownSet,
	DEFAULT_LIMITS,
	knownForms,
	marker,
	scanText,
	scanValue,
} from "../hooks/detect.ts";
import { BASE62, chars, fakes, random } from "./fakes.ts";

const fake = fakes(7);
const never = { now: () => 0, deadline: Number.POSITIVE_INFINITY };
const scan = (text: string, known: Known[] = []) =>
	scanText(text, buildKnownSet(known).set, DEFAULT_LIMITS, never);
/** The rewritten text, or the status when nothing was rewritten. */
const hide = (text: string, known: Known[] = []) => {
	const result = scan(text, known);
	return result.status === "found" ? result.value : result.status;
};

describe("R1 markers", () => {
	test("R1: a known value becomes [secret: NAME]", () => {
		expect(marker({ kind: "known", name: "API_TOKEN" })).toBe(
			"[secret: API_TOKEN]",
		);
	});

	test("R1: a rule hit becomes [secret hidden]", () => {
		expect(marker({ kind: "rule", rule: "vendor:github" })).toBe(
			"[secret hidden]",
		);
	});
});

describe("R2 known-value forms", () => {
	const hex = (value: string) =>
		Array.from(new TextEncoder().encode(value), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");

	test("R2: holds the raw, JSON, URL and hex forms", () => {
		const value = 'pa"ss wo\\rd&é';
		const forms = knownForms(value);
		expect(forms).toContain(value);
		expect(forms).toContain('pa\\"ss wo\\\\rd&é');
		expect(forms).toContain(encodeURIComponent(value));
		expect(forms).toContain(hex(value));
		expect(forms).toContain(hex(value).toUpperCase());
	});

	test("R2: a base64 core is found inside a longer base64 string, for each alignment", () => {
		const value = "s3cr>>>???et";
		const forms = knownForms(value);
		for (const prefix of ["", "u:", "us:", "user:"]) {
			const standard = btoa(`${prefix}${value}tail`);
			const urlSafe = standard.replaceAll("+", "-").replaceAll("/", "_");
			expect(forms.some((f) => f.length >= 10 && standard.includes(f))).toBe(
				true,
			);
			expect(forms.some((f) => f.length >= 10 && urlSafe.includes(f))).toBe(
				true,
			);
		}
	});

	test("R2: drops a form equal to another", () => {
		const forms = knownForms("abcdefgh");
		expect(new Set(forms).size).toBe(forms.length);
	});

	test("R2: a value under 8 characters is skipped by name only (Q14)", () => {
		const { skipped } = buildKnownSet([
			{ name: "SHORT", value: "admin12" },
			{ name: "LONG", value: fake.secret() },
		]);
		expect(skipped).toEqual([{ name: "SHORT", reason: "too-short" }]);
	});
});

describe("R2 known values in text", () => {
	const value = fake.secret(24);
	const known = [{ name: "API_TOKEN", value }];

	test("R2: hides each form of a known value", () => {
		for (const form of knownForms(value)) {
			expect(hide(`x ${form} y`, known)).toBe("x [secret: API_TOKEN] y");
		}
	});

	test("R2: hides a value inside Authorization: Basic base64(user:pass)", () => {
		const header = `Basic ${btoa(`deploy:${value}`)}`;
		const out = hide(header, known);
		expect(out).toContain("[secret: API_TOKEN]");
		for (const form of knownForms(value)) expect(out).not.toContain(form);
	});

	test("R2: 2 names with the same value use the first name in sort order", () => {
		const twins = [
			{ name: "ZETA", value },
			{ name: "ALPHA", value },
		];
		expect(hide(value, twins)).toBe("[secret: ALPHA]");
	});

	test("R2: keeps text without a known value, and a value under 8 characters", () => {
		expect(hide("GET /admin/users", [{ name: "U", value: "admin" }])).toBe(
			"clean",
		);
		expect(hide("nothing to see here", known)).toBe("clean");
	});

	test("R2: hits hold the name only", () => {
		expect(scan(value, known)).toEqual({
			status: "found",
			value: "[secret: API_TOKEN]",
			hits: [{ kind: "known", name: "API_TOKEN" }],
		});
	});
});

describe("R3 match order", () => {
	test("R3: longest span wins, a known value inside a vendor token loses", () => {
		const token = fake.githubClassic;
		const known = [{ name: "PART", value: token.slice(4, 20) }];
		expect(hide(`t=${token}`, known)).toBe("t=[secret hidden]");
	});

	test("R3: a known value wins over a rule for spans of equal length", () => {
		const token = fake.npm;
		expect(hide(token, [{ name: "NPM_TOKEN", value: token }])).toBe(
			"[secret: NPM_TOKEN]",
		);
	});

	test("R3: overlapping spans of equal length merge, and the earliest names the marker", () => {
		const known = [
			{ name: "A", value: "Qw7rT2zp9X" },
			{ name: "B", value: "T2zp9XmK4v" },
		];
		expect(hide("Qw7rT2zp9XmK4v", known)).toBe("[secret: A]");
	});

	test("F13: overlapping spans merge into their union", () => {
		const known = [{ name: "PW", value: "Pa55w0rdXy;zQ" }];
		expect(hide("token=v1-Kq9Pa55w0rdXy;zQ", known)).toBe(
			"token=[secret hidden]",
		);
	});

	test("R3: replaces every span that does not overlap", () => {
		const known = [{ name: "A", value: "Qw7rT2zp9X" }];
		expect(hide(`Qw7rT2zp9X ${fake.aws} Qw7rT2zp9X`, known)).toBe(
			"[secret: A] [secret hidden] [secret: A]",
		);
	});
});

describe("R4 private keys", () => {
	test("R4: hides a block up to and including the END line", () => {
		for (const label of ["RSA ", "EC ", "OPENSSH ", "ENCRYPTED ", ""]) {
			expect(hide(`before\n${fake.privateKey(label)}\nafter`)).toBe(
				"before\n[secret hidden]\nafter",
			);
		}
	});

	test("R4: with no END line, hides to the end of the text", () => {
		expect(hide(`before\n${fake.privateKeyOpen("RSA ")}more text`)).toBe(
			"before\n[secret hidden]",
		);
	});

	test("R4: keeps public keys and certificates", () => {
		const body = fake.base64(64);
		for (const label of ["PUBLIC KEY", "CERTIFICATE"]) {
			const block = `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
			expect(hide(block)).toBe("clean");
		}
	});
});

describe("R5 vendor prefixes", () => {
	const cases: [string, string][] = [
		["github", fake.githubClassic],
		["github", fake.githubOauth],
		["github", fake.githubPat],
		["github", fake.githubStateless],
		["stripe", fake.stripeSecret],
		["stripe", fake.stripeRestricted],
		["anthropic", fake.anthropic],
		["openai", fake.openai],
		["openai", fake.openaiLegacy],
		["slack", fake.slackBot],
		["slack", fake.slackUser],
		["aws", fake.aws],
		["aws", fake.awsTemporary],
		["google", fake.google],
		["npm", fake.npm],
		["jwt", fake.jwt],
	];

	test("R5: hides each vendor format with its rule id", () => {
		for (const [id, token] of cases) {
			expect(scan(`key: "${token}"`)).toEqual({
				status: "found",
				value: 'key: "[secret hidden]"',
				hits: [{ kind: "rule", rule: `vendor:${id}` }],
			});
		}
	});

	test("R5: needs a word boundary on the left", () => {
		const body = fake.secret(40);
		expect(hide(`task-ant-${body}`)).toBe("clean");
		expect(hide(`xghp_${body}`)).toBe("clean");
	});

	test("R5: keeps near misses", () => {
		const cut = (token: string, n: number) => token.slice(0, n);
		for (const text of [
			cut(fake.githubClassic, 39),
			cut(fake.aws, 19),
			cut(fake.google, 38),
			cut(fake.npm, 39),
			"sk-ant-short",
			"sk_live_short",
			"xoxb-123",
			"eyJhbGciOiJIUzI1NiJ9.notajwt",
		]) {
			expect(hide(text)).toBe("clean");
		}
	});

	test("Q18: slack xoxe-1- and xapp- tokens are hidden", () => {
		for (const token of [fake.slackRefresh, fake.slackApp]) {
			expect(scan(`key: "${token}"`)).toEqual({
				status: "found",
				value: 'key: "[secret hidden]"',
				hits: [{ kind: "rule", rule: "vendor:slack" }],
			});
		}
	});

	test("Q18: keeps slack near misses", () => {
		const body = fake.secret(40);
		for (const text of [`xoxe-2-${body}`, `xapp${body}`, `xoxa-${body}`]) {
			expect(hide(text)).toBe("clean");
		}
	});

	test("R5: keeps ordinary values", () => {
		const integrity = `sha512-${fake.base64(86)}==`;
		for (const text of [
			"id 123e4567-e89b-12d3-a456-426614174000",
			`commit ${fake.hex(40)}`,
			`"integrity": "${integrity}"`,
			"color: #ff00aa; background: #FFF;",
			"The quick brown fox jumps over the lazy dog.",
			`<img src="data:image/png;base64,${fake.base64(200)}">`,
		]) {
			expect(hide(text)).toBe("clean");
		}
	});
});

describe("R1 markers rescan clean", () => {
	test("R1: a scan of an output returns clean", () => {
		const secret = fake.secret();
		const known = [{ name: "DB_PASSWORD", value: secret }];
		const text = `a ${secret} b ${fake.githubClassic} c\n${fake.privateKey()}`;
		const first = scan(text, known);
		expect(first.status).toBe("found");
		if (first.status === "found") {
			expect(scan(first.value, known)).toEqual({ status: "clean" });
		}
	});

	test("R1: marker text alone does not match", () => {
		expect(hide("[secret hidden] and [secret: API_TOKEN]")).toBe("clean");
	});
});

describe("R6 context rules", () => {
	const value = fake.secret(32);
	const ruleOf = (text: string) => {
		const result = scan(text);
		return result.status === "found" ? result.hits : result.status;
	};

	test("R6: assign hides the value, not the label", () => {
		const cases: [string, string][] = [
			[`API_KEY=${value}`, "API_KEY=[secret hidden]"],
			[`export DB_PASSWORD="${value}"`, 'export DB_PASSWORD="[secret hidden]"'],
			[`{"client_secret": "${value}"}`, '{"client_secret": "[secret hidden]"}'],
			[`  auth-token: '${value}'`, "  auth-token: '[secret hidden]'"],
			[
				`spring.datasource.password=${value}`,
				"spring.datasource.password=[secret hidden]",
			],
			[
				`cb?state=abc&access_token=${value} x`,
				"cb?state=abc&access_token=[secret hidden] x",
			],
		];
		for (const [text, out] of cases) expect(hide(text)).toBe(out);
		expect(ruleOf(`TOKEN=${value}`)).toEqual([
			{ kind: "rule", rule: "context:assign" },
		]);
	});

	test("R6: assign keeps placeholders, low entropy, short and long values", () => {
		for (const line of [
			"API_KEY=your-api-key-here",
			"SECRET_KEY=changeme",
			"TOKEN=<token>",
			`PASSWORD=\${DB_PASSWORD}`,
			"GITHUB_TOKEN={{github_token}}",
			"AUTH_TOKEN=process.env.AUTH_TOKEN",
			"client_secret=os.environ.get(SECRET)",
			"DB_PASSWORD=xxxxxxxxxxxxxxxx",
			"API_SECRET=****************",
			"password=aaaaaaaaaaaaaaaa",
			"token=EXAMPLE_TOKEN_1234567",
			"api_key=Dummy-Key-9f8e7d6c",
			"api_key=REDACTED-0123456789",
			"token=abc123",
			`token=${fake.secret(513)}`,
			`name=${value}`,
		]) {
			expect(hide(line)).toBe("clean");
		}
	});

	test("R6: auth-header hides Bearer, Basic and Token values", () => {
		expect(hide(`Authorization: Bearer ${value}`)).toBe(
			"Authorization: Bearer [secret hidden]",
		);
		expect(hide(`"Authorization": "Token ${value}"`)).toBe(
			'"Authorization": "Token [secret hidden]"',
		);
		expect(ruleOf(`authorization: basic ${btoa(`deploy:${value}`)}`)).toEqual([
			{ kind: "rule", rule: "context:auth-header" },
		]);
	});

	test("R6: auth-header keeps placeholders and short values", () => {
		for (const line of [
			"Authorization: Bearer <token>",
			`Authorization: Bearer \${TOKEN}`,
			"Authorization: Bearer aaaaaaaaaaaa",
			"Authorization: Basic Zm9v",
		]) {
			expect(hide(line)).toBe("clean");
		}
	});

	test("R6: url-userinfo hides the password only", () => {
		expect(hide(`postgres://admin:${value}@db.internal:5432/app`)).toBe(
			"postgres://admin:[secret hidden]@db.internal:5432/app",
		);
		expect(ruleOf(`redis://:${value}@cache:6379`)).toEqual([
			{ kind: "rule", rule: "context:url-userinfo" },
		]);
	});

	test("R6: url-userinfo keeps URLs without a real password", () => {
		for (const url of [
			"https://user:password@example.com",
			"https://example.com:8080/path?q=1",
			"git@github.com:org/repo.git",
			`redis://:\${REDIS_PASSWORD}@localhost`,
		]) {
			expect(hide(url)).toBe("clean");
		}
	});

	test("R6: an output with markers rescans clean", () => {
		const names = ["API_TOKEN", "DB_PASSWORD", "VERY_LONG_SECRET_TOKEN_NAME"];
		const known = names.map((name) => ({ name, value: fake.secret() }));
		for (const text of [
			"token: [secret: API_TOKEN]",
			"Authorization: Bearer [secret: API_TOKEN]",
			"postgres://admin:[secret: DB_PASSWORD]@db/app",
			"[secret: VERY_LONG_SECRET_TOKEN_NAME]",
		]) {
			expect(hide(text, known)).toBe("clean");
		}
	});

	test("F10: a token right after an escaped \\n, \\r or \\t is hidden", () => {
		const json = JSON.stringify({ log: `line\n${fake.githubClassic}` });
		expect(hide(json)).toBe('{"log":"line\\n[secret hidden]"}');
		expect(hide(`"a\\n${fake.aws}"`)).toBe('"a\\n[secret hidden]"');
		expect(hide(`"a\\t${fake.npm}"`)).toBe('"a\\t[secret hidden]"');
		expect(hide(`"Host: x\\r\\nAuthorization: Bearer ${value}"`)).toBe(
			'"Host: x\\r\\nAuthorization: Bearer [secret hidden]"',
		);
		expect(hide(`"a\\npostgres://u:${value}@db/app"`)).toBe(
			'"a\\npostgres://u:[secret hidden]@db/app"',
		);
		// The escape ends exactly where a 64 KiB window starts.
		const pad = "a ".repeat(32_767);
		expect(hide(`${pad}\\n${fake.aws}`)).toBe(`${pad}\\n[secret hidden]`);
	});

	test("F11: a password with a raw @ is hidden up to the last @ before the host", () => {
		expect(hide("postgres://admin:Pq7@Zx9Lm3Kv8Rt2@db.internal:5432/app")).toBe(
			"postgres://admin:[secret hidden]@db.internal:5432/app",
		);
	});

	test("F12: assign finds a long key name and a bracketed key", () => {
		const long = `${"x".repeat(200)}_token`;
		expect(hide(`${long}=${value}`)).toBe(`${long}=[secret hidden]`);
		expect(hide(`config["api_key"] = "${value}"`)).toBe(
			'config["api_key"] = "[secret hidden]"',
		);
	});

	test("F16: a rejected value resumes at a & inside it", () => {
		expect(hide(`token=your_token&password=${value}`)).toBe(
			"token=your_token&password=[secret hidden]",
		);
	});
});

describe("R1 marker-shaped text", () => {
	test("R1: a token written inside marker-like text is still hidden", () => {
		// The assign value `<token>]` merges with the vendor span (R3).
		const out = hide(`[secret: ${fake.githubClassic}]`);
		expect(out).toBe("[secret: [secret hidden]");
		expect(hide(out)).toBe("clean");
	});

	test("F14: a context span that overlaps a marker is dropped, so the output rescans clean", () => {
		const known = [{ name: "PAD", value: "zzzzzzzzzzzz" }];
		const first = hide("token=Ab1Cd2Ef3Gh4zzzzzzzzzzzz", known);
		expect(first).toBe("token=Ab1Cd2Ef3Gh4[secret: PAD]");
		expect(hide(first, known)).toBe("clean");
	});

	test("F15: marker-shaped text with an unknown name does not turn off context rules", () => {
		const secret = fake.secret(16);
		for (const text of [
			`[secret: x password=${secret}]`,
			`[secret: Authorization: Bearer ${secret}]`,
		]) {
			const out = hide(text);
			expect(out).toContain("[secret hidden]");
			expect(out).not.toContain(secret);
		}
	});
});

const set = (known: Known[] = []) => buildKnownSet(known).set;
const value = (input: unknown, known: Known[] = []) =>
	scanValue(input, set(known), DEFAULT_LIMITS, never);
const deepFreeze = <T>(input: T): T => {
	if (input && typeof input === "object") {
		for (const child of Object.values(input)) deepFreeze(child);
		Object.freeze(input);
	}
	return input;
};

describe("R7 values", () => {
	const token = fake.githubClassic;

	test("R7: walks objects, arrays and strings, and returns a copy", () => {
		const input = deepFreeze({
			list: ["plain", { deep: `t=${token}` }],
			n: 1,
			ok: true,
			none: null,
			gone: undefined,
		});
		expect(value(input)).toEqual({
			status: "found",
			value: {
				list: ["plain", { deep: "t=[secret hidden]" }],
				n: 1,
				ok: true,
				none: null,
				gone: undefined,
			},
			hits: [{ kind: "rule", rule: "vendor:github" }],
		});
		expect(input.list[1]).toEqual({ deep: `t=${token}` });
	});

	test("R7: a clean value returns clean", () => {
		expect(value({ a: ["b", 1, null], c: { d: "e" } })).toEqual({
			status: "clean",
		});
	});

	test("R7: scans keys, and numbers 2 keys that become the same text", () => {
		const input = {
			[token]: 1,
			[fake.npm]: 2,
			"[secret hidden]": 3,
		};
		const result = value(input);
		expect(result.status).toBe("found");
		if (result.status === "found") {
			expect(result.value).toEqual({
				"[secret hidden]": 3,
				"[secret hidden] #2": 1,
				"[secret hidden] #3": 2,
			});
		}
	});

	test("R7: other types are unsupported", () => {
		class Box {
			x = 1;
		}
		for (const input of [
			new Map(),
			new Set(),
			new Box(),
			new Uint8Array(2),
			new Date(0),
			() => 1,
			Symbol("s"),
			10n,
			{ nested: [new Map()] },
			{ [Symbol("k")]: "v" },
			Object.defineProperty({}, "getter", { get: () => "x", enumerable: true }),
		]) {
			expect(value(input)).toEqual({
				status: "unscannable",
				reason: "unsupported",
			});
		}
	});

	test("R7: a cycle returns cycle, a shared reference does not", () => {
		const loop: Record<string, unknown> = { a: "b" };
		loop.self = loop;
		expect(value(loop)).toEqual({ status: "unscannable", reason: "cycle" });
		const shared = { s: "x" };
		expect(value([shared, shared])).toEqual({ status: "clean" });
	});

	const unsupported = { status: "unscannable", reason: "unsupported" };

	test("F17: an array getter, a hole, and a proxy whose get differs from its descriptor are unsupported", () => {
		let reads = 0;
		const getter = Object.defineProperty(["a"], 0, {
			get: () => (reads++ === 0 ? "ok" : token),
			enumerable: true,
		});
		const lies = <T extends object>(target: T, key: string) =>
			new Proxy(target, {
				get: (t, k, r) => (k === key ? token : Reflect.get(t, k, r)),
			});
		for (const input of [
			getter,
			new Array(2),
			lies(["ok"], "0"),
			lies({ a: "ok" }, "a"),
		]) {
			expect(value(input)).toEqual(unsupported);
		}
	});

	test("F18: an error inside the walk returns unsupported and does not leave the scan", () => {
		const { proxy, revoke } = Proxy.revocable(["x"], {});
		revoke();
		const throws = new Proxy(["x"], {
			getOwnPropertyDescriptor: () => {
				throw new Error(`value=${token}`);
			},
		});
		const broken = {
			now: () => {
				throw new Error(`value=${token}`);
			},
			deadline: 0,
		};
		expect(value(proxy)).toEqual(unsupported);
		expect(value(throws)).toEqual(unsupported);
		expect(
			scanValue(new Array(1024).fill("x"), set(), DEFAULT_LIMITS, broken),
		).toEqual(unsupported);
		expect(scanText("a ".repeat(8), set(), DEFAULT_LIMITS, broken)).toEqual(
			unsupported,
		);
	});

	test("F19: an array longer than maxNodes returns too-many-nodes before the walk", () => {
		const tooMany = { status: "unscannable", reason: "too-many-nodes" };
		expect(value(new Array(DEFAULT_LIMITS.maxNodes + 1).fill(0))).toEqual(
			tooMany,
		);
		const huge: unknown[] = [];
		huge.length = 2 ** 32 - 1;
		// A clock that expires quickly bounds the walk if the length check is missing.
		let reads = 0;
		const quick = { now: () => reads++, deadline: 2 };
		expect(scanValue(huge, set(), DEFAULT_LIMITS, quick)).toEqual(tooMany);
	});

	test("R7: an object without a prototype is a plain object", () => {
		const bare = Object.create(null) as Record<string, unknown>;
		bare.key = token;
		expect(value(bare)).toMatchObject({
			status: "found",
			value: { key: "[secret hidden]" },
		});
	});
});

describe("R8 limits", () => {
	const limits = (over: Partial<typeof DEFAULT_LIMITS>) => ({
		...DEFAULT_LIMITS,
		...over,
	});

	test("R8: DEFAULT_LIMITS are the Q15 numbers", () => {
		expect(DEFAULT_LIMITS).toEqual({
			maxChars: 2_097_152,
			maxDepth: 64,
			maxNodes: 50_000,
		});
	});

	test("R8: maxChars counts the UTF-16 length of all strings and keys", () => {
		const tight = limits({ maxChars: 10 });
		expect(scanText("12345678901", set(), tight, never)).toEqual({
			status: "unscannable",
			reason: "too-large",
		});
		expect(scanText("1234567890", set(), tight, never).status).toBe("clean");
		expect(scanValue({ abcde: "fghijk" }, set(), tight, never)).toEqual({
			status: "unscannable",
			reason: "too-large",
		});
		expect(scanValue({ abcde: "fghij" }, set(), tight, never).status).toBe(
			"clean",
		);
	});

	test("R8: maxDepth counts nested objects and arrays", () => {
		const tight = limits({ maxDepth: 2 });
		expect(scanValue([["x"]], set(), tight, never).status).toBe("clean");
		expect(scanValue([[["x"]]], set(), tight, never)).toEqual({
			status: "unscannable",
			reason: "too-deep",
		});
	});

	test("R8: maxNodes counts objects, arrays, strings and keys", () => {
		const tight = limits({ maxNodes: 4 });
		expect(scanValue(["a", "b", "c"], set(), tight, never).status).toBe(
			"clean",
		);
		expect(scanValue(["a", "b", "c", "d"], set(), tight, never)).toEqual({
			status: "unscannable",
			reason: "too-many-nodes",
		});
		expect(scanValue({ a: "b", c: "d" }, set(), tight, never)).toEqual({
			status: "unscannable",
			reason: "too-many-nodes",
		});
	});

	const counting = (deadline = Number.POSITIVE_INFINITY) => {
		const clock = { reads: 0, deadline, now: () => clock.reads++ };
		return clock;
	};

	test("R8: reads the clock at least every 64 KiB of text", () => {
		const clock = counting();
		scanText("a ".repeat(4 * 32_768), set(), DEFAULT_LIMITS, clock);
		expect(clock.reads).toBeGreaterThanOrEqual(4);
	});

	test("R8: reads the clock at least every 1024 nodes", () => {
		const clock = counting();
		scanValue(new Array(4096).fill("x"), set(), DEFAULT_LIMITS, clock);
		expect(clock.reads).toBeGreaterThanOrEqual(4);
	});

	test("R8: a passed deadline returns deadline", () => {
		expect(
			scanText("a ".repeat(4 * 32_768), set(), DEFAULT_LIMITS, counting(2)),
		).toEqual({ status: "unscannable", reason: "deadline" });
		expect(
			scanValue(new Array(4096).fill("x"), set(), DEFAULT_LIMITS, counting(1)),
		).toEqual({ status: "unscannable", reason: "deadline" });
	});
});

describe("R1 R2 property", () => {
	const utf8Base64 = (text: string) =>
		btoa(
			Array.from(new TextEncoder().encode(text), (b) =>
				String.fromCharCode(b),
			).join(""),
		);

	test("R1 R2: for 200 random values and positions, no form survives and a second scan is clean", () => {
		const next = random(11);
		const filler = (n: number) =>
			chars(next, n, "abcdefghijklmnopqrstuvwxyz \n");
		const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)];
		for (let i = 0; i < 200; i++) {
			const secret = chars(
				next,
				8 + Math.floor(next() * 40),
				`${BASE62}!#%&*+/=?"\\ é`,
			);
			const known = [{ name: `K${i}`, value: secret }];
			const forms = knownForms(secret);
			const basic = utf8Base64(`${filler(Math.floor(next() * 3))}${secret}x`);
			const embed = pick([
				...forms,
				`Basic ${basic}`,
				basic.replaceAll("+", "-").replaceAll("/", "_"),
			]);
			const text = `${filler(Math.floor(next() * 200))}${embed}${filler(Math.floor(next() * 200))}`;
			const first = scan(text, known);
			expect(first.status).toBe("found");
			if (first.status !== "found") continue;
			for (const form of forms) expect(first.value.includes(form)).toBe(false);
			expect(scan(first.value, known)).toEqual({ status: "clean" });
		}
	});
});

describe("R9 speed", () => {
	test("R9 F16: 2 MiB of adversarial text with 100 known values scans in under 1 s", {
		timeoutMs: 60_000,
	}, () => {
		const next = random(9);
		const known = Array.from({ length: 100 }, (_, i) => ({
			name: `KEY_${i}`,
			value: chars(next, 16 + (i % 25)),
		}));
		const pieces = [
			"a",
			"=",
			"-",
			"eyJ",
			"eyJ-",
			"eyJabcdefghijklm.",
			chars(next, 4096, `${BASE62}+/`),
			"sk-",
			"ghp_",
			"-----BEGIN ",
			"[secret: ",
			"token=",
			"Authorization: Bearer ",
			"a://b:",
			known[0]?.value.slice(0, 12) ?? "",
		];
		const fill = (piece: string, n: number) =>
			piece.repeat(Math.ceil(n / piece.length)).slice(0, n);
		const share = Math.ceil(DEFAULT_LIMITS.maxChars / pieces.length);
		const mixed = pieces
			.map((piece) => fill(piece, share))
			.join("")
			.slice(0, DEFAULT_LIMITS.maxChars);
		// F16: each rejected value used to be reread from every separator inside it.
		const texts: [string, string][] = [
			["mixed", mixed],
			...["pwd=", "pwd:", "auth="].map((sep): [string, string] => [
				sep,
				fill(`${sep.repeat(127)} `, DEFAULT_LIMITS.maxChars),
			]),
		];
		const knownSet = set(known);
		for (const [label, text] of texts) {
			const start = performance.now();
			const result = scanText(text, knownSet, DEFAULT_LIMITS, never);
			const ms = performance.now() - start;
			(globalThis as { console?: { log: (s: string) => void } }).console?.log(
				`R9 ${label}: ${ms.toFixed(0)} ms for ${text.length} characters and ${known.length} known values`,
			);
			expect(text.length).toBe(DEFAULT_LIMITS.maxChars);
			expect(result.status).not.toBe("unscannable");
			expect(ms).toBeLessThan(1000);
		}
	});
});

describe("R10 no leak", () => {
	const values = [
		fake.githubClassic,
		fake.stripeSecret,
		fake.anthropic,
		fake.aws,
		fake.jwt,
		fake.privateKey(),
		fake.secret(),
	];
	const known = values.map((secret, i) => ({
		name: `NAME_${i}`,
		value: secret,
	}));

	test("R10: no value in hits, skipped entries or unscannable results", () => {
		const built = buildKnownSet([
			...known,
			{ name: "SHORT", value: "hunt3r!" },
		]);
		const all = values.join(" | ");
		const results = [
			scanText(all, built.set, DEFAULT_LIMITS, never),
			scanText(`API_KEY=${fake.secret()}`, built.set, DEFAULT_LIMITS, never),
			scanValue(
				{ [fake.githubClassic]: values },
				built.set,
				DEFAULT_LIMITS,
				never,
			),
			scanText(all, built.set, { ...DEFAULT_LIMITS, maxChars: 10 }, never),
			scanText(all, built.set, DEFAULT_LIMITS, { now: () => 1, deadline: 0 }),
			scanValue(
				new Map([[fake.githubClassic, 1]]),
				built.set,
				DEFAULT_LIMITS,
				never,
			),
		];
		const reported = JSON.stringify([
			built.skipped,
			...results.map((r) => (r.status === "found" ? r.hits : r)),
		]);
		for (const secret of [...values, "hunt3r!"]) {
			expect(reported.includes(secret)).toBe(false);
		}
	});

	test("R10: odd input does not throw", () => {
		const odd = buildKnownSet([{ name: "LONE", value: "\ud800abcdefgh" }]);
		expect(
			scanText("x\ud800abcdefghx", odd.set, DEFAULT_LIMITS, never),
		).toEqual({
			status: "found",
			value: "x[secret: LONE]x",
			hits: [{ kind: "known", name: "LONE" }],
		});
	});

	test("R7: an own __proto__ key from JSON stays a key in the copy", () => {
		const parsed = JSON.parse(`{"__proto__": "${fake.npm}"}`);
		const result = value(parsed);
		expect(result.status).toBe("found");
		if (result.status === "found") {
			const copy = result.value as object;
			expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
			expect(Object.getOwnPropertyDescriptor(copy, "__proto__")?.value).toBe(
				"[secret hidden]",
			);
		}
	});
});
