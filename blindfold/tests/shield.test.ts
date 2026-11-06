import { describe, expect, test } from "claude-code/testing";
import { buildKnownSet, DEFAULT_LIMITS } from "../hooks/detect.ts";
import { createEnrollment, load } from "../hooks/enroll.ts";
import {
	type ArgsVerdict,
	clockFor,
	guardArgs,
	guardText,
	guardValue,
	onToolCall,
	onToolCallCatch,
	REFUSED_ARGS,
	type Verdict,
} from "../hooks/shield.ts";
import { fakeApi, fakes } from "./fakes.ts";

const fake = fakes(11);
const NAME = "FAKE_SHIELD_KEY";
const known = fake.secret(24);
const vendorToken = fake.githubClassic;
const privateKey = fake.privateKey();
const contextValue = fake.secret(24);
const { set } = buildKnownSet([{ name: NAME, value: known }]);
const never = { now: () => 0, deadline: Number.POSITIVE_INFINITY };

/** Every verdict the tests see, for the R15 check. */
const seen: (Verdict<unknown> | ArgsVerdict)[] = [];
const keep = <V extends Verdict<unknown> | ArgsVerdict>(verdict: V): V => {
	seen.push(verdict);
	return verdict;
};
const text = (value: string) => keep(guardText(value, set, never));
const value = (input: unknown) => keep(guardValue(input, set, never));
const args = (input: unknown) => keep(guardArgs(input, set, never));

function cycle(): Record<string, unknown> {
	const node: Record<string, unknown> = { note: known };
	node.self = node;
	return node;
}

describe("R1 plain copy", () => {
	test("R1: a cycle is stop with unsupported", () => {
		expect(value(cycle())).toEqual({ kind: "stop", reason: "unsupported" });
	});

	test("R1: a BigInt is stop with unsupported", () => {
		expect(value({ n: BigInt(1), note: known })).toEqual({
			kind: "stop",
			reason: "unsupported",
		});
	});

	test("R1: a throwing toJSON is stop with unsupported", () => {
		const input = {
			toJSON() {
				throw new Error(`${NAME}=${known}`);
			},
		};
		expect(value(input)).toEqual({ kind: "stop", reason: "unsupported" });
	});

	test("R1: an object JSON would empty, such as a Map, is stop with unsupported", () => {
		expect(value({ env: new Map([[NAME, known]]) })).toEqual({
			kind: "stop",
			reason: "unsupported",
		});
		expect(value([new Uint8Array(4)])).toEqual({
			kind: "stop",
			reason: "unsupported",
		});
	});

	test("R1: a symbol key is stop with unsupported", () => {
		expect(value({ [Symbol("k")]: known })).toEqual({
			kind: "stop",
			reason: "unsupported",
		});
	});

	test("R1: a rewrite returns the scanned copy, not the original", () => {
		const original = { note: `key ${known}`, list: [known, "plain"] };
		const verdict = value(original);
		if (verdict.kind !== "rewrite") throw new Error(verdict.kind);
		expect(verdict.value).not.toBe(original);
		expect(original.note).toBe(`key ${known}`);
		original.note = "changed";
		original.list.push("more");
		expect(verdict.value).toEqual({
			note: `key [secret: ${NAME}]`,
			list: [`[secret: ${NAME}]`, "plain"],
		});
		expect(verdict.count).toBe(2);
	});

	test("R1: a clean value is pass with no value", () => {
		expect(value({ note: "nothing here", n: 3, list: [true, null] })).toEqual({
			kind: "pass",
		});
	});

	test("R1: undefined is pass", () => {
		expect(value(undefined)).toEqual({ kind: "pass" });
	});

	test("R1: guardText rewrites a hit, passes clean text, and stops on too-large", () => {
		expect(text(`a ${known} b ${vendorToken}`)).toEqual({
			kind: "rewrite",
			value: `a [secret: ${NAME}] b [secret hidden]`,
			count: 2,
		});
		expect(text("nothing to hide here")).toEqual({ kind: "pass" });
		expect(text("x".repeat(DEFAULT_LIMITS.maxChars + 1))).toEqual({
			kind: "stop",
			reason: "too-large",
		});
	});
});

describe("R2 time", () => {
	const at = (start: number) => {
		let t = start;
		return { now: () => t, set: (next: number) => (t = next) };
	};
	const deadline = { kind: "stop", reason: "deadline" };

	test("R2: remainingMs 0 is already past the deadline", () => {
		const fakeNow = at(50_000);
		const clock = clockFor(0, fakeNow.now);
		expect(clock.deadline).toBe(49_000);
		expect(keep(guardText("long enough text", set, clock))).toEqual(deadline);
		expect(keep(guardText("", set, clock))).toEqual(deadline);
		expect(keep(guardValue({ a: 1 }, set, clock))).toEqual(deadline);
		expect(keep(guardArgs({ a: 1 }, set, clock))).toEqual(deadline);
	});

	test("R2: remainingMs 1000 leaves no time to scan", () => {
		const fakeNow = at(50_000);
		const clock = clockFor(1000, fakeNow.now);
		expect(clock.deadline).toBe(50_000);
		expect(keep(guardText("long enough text", set, clock))).toEqual(deadline);
	});

	test("R2: remainingMs 5000 scans until 1000 ms before the end", () => {
		const fakeNow = at(50_000);
		const clock = clockFor(5000, fakeNow.now);
		expect(clock.deadline).toBe(54_000);
		expect(keep(guardText("long enough text", set, clock))).toEqual({
			kind: "pass",
		});
		fakeNow.set(53_999);
		expect(keep(guardValue({ a: "text" }, set, clock))).toEqual({
			kind: "pass",
		});
		fakeNow.set(54_000);
		expect(keep(guardText("long enough text", set, clock))).toEqual(deadline);
	});

	test("R2: an unmetered budget never stops, and NaN stops at once", () => {
		const unmetered = clockFor(Number.POSITIVE_INFINITY, () => 0);
		expect(keep(guardText("long enough text", set, unmetered))).toEqual({
			kind: "pass",
		});
		const broken = clockFor(Number.NaN, () => 0);
		expect(keep(guardText("long enough text", set, broken))).toEqual(deadline);
	});

	test("R2: 2 Mi characters of pwd=& end or stop inside a 9,000 ms budget", () => {
		const input = "pwd=&".repeat(Math.floor(DEFAULT_LIMITS.maxChars / 5));
		const clock = clockFor(10_000, () => performance.now());
		const start = performance.now();
		const verdict = keep(guardText(input, set, clock));
		const ms = performance.now() - start;
		(globalThis as { console?: { log: (s: string) => void } }).console?.log(
			`R2 speed: ${ms.toFixed(0)} ms for ${input.length} characters`,
		);
		expect(input.length).toBeGreaterThan(DEFAULT_LIMITS.maxChars - 5);
		const ended =
			verdict.kind !== "stop" ||
			(verdict as { reason: string }).reason === "deadline";
		expect(ended).toBe(true);
		expect(ms).toBeLessThan(9000);
	});
});

describe("Q30 argument filter", () => {
	test("Q30: a known value in a nested object and array refuses", () => {
		expect(
			args({ command: "run", options: { lines: ["echo", `x ${known} y`] } }),
		).toEqual({ kind: "refuse" });
	});

	test("Q30: a private key block refuses", () => {
		expect(args({ file_path: "/tmp/k", content: privateKey })).toEqual({
			kind: "refuse",
		});
	});

	test("Q30: a vendor token in an array of objects refuses", () => {
		expect(args({ headers: [{ name: "x", value: vendorToken }] })).toEqual({
			kind: "refuse",
		});
	});

	test("Q30: a context rule hit alone in a nested field passes", () => {
		const input = {
			edits: [{ old_string: "a", new_string: `password = "${contextValue}"` }],
		};
		expect(value(input).kind).toBe("rewrite");
		expect(args(input)).toEqual({ kind: "pass" });
	});

	test("Q30: a context hit beside a vendor token still refuses", () => {
		expect(
			args({ a: `password = "${contextValue}"`, b: [vendorToken] }),
		).toEqual({ kind: "refuse" });
	});

	test("Q30: clean arguments pass, and an unscannable copy is stop", () => {
		expect(args({ command: "ls -la", flags: [1, true] })).toEqual({
			kind: "pass",
		});
		expect(args(cycle())).toEqual({ kind: "stop", reason: "unsupported" });
	});
});

/** The handler tests use their own env file, so its name and values are fake too. */
const ENV_NAME = "FAKE_TOOL_KEY";
const envValue = fake.secret(24);
const freshValue = fake.secret(24);
const envFile = (secret: string) => ({ text: `${ENV_NAME}=${secret}\n` });

type ToolNext = Parameters<typeof onToolCall>[3];
type CatchNext = Parameters<typeof onToolCallCatch>[2];

/** Every result the handlers return, for the R15 check. */
const answers: unknown[] = [];

/** A fresh enrollment over a fake `.env`, loaded the way `session.start` does. */
async function setup(secret = envValue) {
	const files = { ".env": envFile(secret) };
	const { api } = fakeApi(files);
	const enrollment = createEnrollment();
	await load(api, enrollment, ".env");
	return { api, enrollment, files };
}

/** A `next` that runs `atNext`, records what it got, and answers `answer`. `remaining` gives `budget.remainingMs` on each read. */
function nextOf(
	answer: unknown,
	atNext: () => void = () => {},
	remaining: () => number = () => 10_000,
) {
	const passed: unknown[] = [];
	const next = Object.assign(
		async (given: unknown) => {
			passed.push(given);
			atNext();
			return answer;
		},
		{
			budget: {
				ms: 10_000,
				get remainingMs() {
					return remaining();
				},
			},
		},
	) as unknown as ToolNext;
	return { next, passed };
}

async function call(
	e: Record<string, unknown>,
	answer: unknown = { ref: 1, result: { stdout: "ok" }, text: "ok" },
	options: {
		atNext?: (files: Record<string, { text: string }>) => void;
		remaining?: () => number;
	} = {},
) {
	const { api, enrollment, files } = await setup();
	const { next, passed } = nextOf(
		answer,
		() => options.atNext?.(files),
		options.remaining,
	);
	const result = await onToolCall(
		api,
		enrollment,
		e as Parameters<typeof onToolCall>[2],
		next,
	);
	answers.push(result);
	return { result: result as Record<string, unknown>, passed, answer };
}

const isDeny = (result: Record<string, unknown>) =>
	Object.keys(result).length === 1 && typeof result.deny === "string";

describe("R4 tool.call before next", () => {
	const secrets = {
		"a known value": () => envValue,
		"a private key block": () => privateKey,
		"a vendor token": () => vendorToken,
	};
	const shapes = {
		"a flat field": (s: string) => ({
			tool: "Bash",
			tool_use_id: "t1",
			command: `echo ${s}`,
		}),
		"a nested object": (s: string) => ({
			tool: "MultiEdit",
			tool_use_id: "t2",
			edits: [{ old_string: "a", new_string: { note: [s] } }],
		}),
		"an MCP argument": (s: string) => ({
			tool: "mcp__fake__send",
			tool_use_id: "t3",
			agentId: "a1",
			body: { headers: { token: s } },
		}),
	};
	for (const [secret, make] of Object.entries(secrets)) {
		for (const [shape, build] of Object.entries(shapes)) {
			test(`R4 (P2): ${secret} in ${shape} is a deny, and next never runs`, async () => {
				const { result, passed } = await call(build(make()));
				expect(isDeny(result)).toBe(true);
				expect(result.deny).toBe(REFUSED_ARGS);
				expect(passed).toEqual([]);
			});
		}
	}

	test("R4 (Q30, P2): a context rule hit alone passes, and next gets the same e", async () => {
		const e = {
			tool: "Edit",
			tool_use_id: "t4",
			new_string: `password = "${contextValue}"`,
		};
		const { result, passed, answer } = await call(e);
		expect(passed.length).toBe(1);
		expect(passed[0]).toBe(e);
		expect(result).toBe(answer);
	});

	test("R4: the arguments are scanned without tool, tool_use_id, and agentId", async () => {
		const e = { tool: "Read", tool_use_id: envValue, agentId: vendorToken };
		const { passed } = await call(e);
		expect(passed[0]).toBe(e);
	});

	test("R4 (R2): arguments too large to scan are a deny with the reason, and next never runs", async () => {
		const e = {
			tool: "Bash",
			command: "x".repeat(DEFAULT_LIMITS.maxChars + 1),
		};
		const { result, passed } = await call(e);
		expect(isDeny(result)).toBe(true);
		expect(result.deny).toContain("too-large");
		expect(passed).toEqual([]);
	});

	test("R4 (R2): no time left before next is a deny with deadline", async () => {
		const { result, passed } = await call(
			{ tool: "Bash", command: "ls" },
			undefined,
			{ remaining: () => 0 },
		);
		expect(result.deny).toContain("deadline");
		expect(passed).toEqual([]);
	});

	test("R4 (enroll R7): refreshIfNamed runs before the scan, so a new value in a listed file refuses the same call", async () => {
		const { api, enrollment, files } = await setup();
		files[".env"] = envFile(freshValue);
		const { next, passed } = nextOf({ result: "ok" });
		const result = await onToolCall(
			api,
			enrollment,
			{
				tool: "Bash",
				command: `grep ${freshValue} .env`,
			} as Parameters<typeof onToolCall>[2],
			next,
		);
		answers.push(result);
		expect(result).toEqual({ deny: REFUSED_ARGS });
		expect(passed).toEqual([]);
	});
});

describe("R5 tool.call after next", () => {
	const e = { tool: "Bash", tool_use_id: "t5", command: "cat notes.txt" };

	test("R5: a clean result is the same object next returned", async () => {
		const answer = {
			ref: 7,
			result: { stdout: "clean" },
			text: "clean",
			isReadOnly: true,
		};
		const { result, passed } = await call(e, answer);
		expect(passed[0]).toBe(e);
		expect(result).toBe(answer);
	});

	test("R5 (Q26): a hit in result and context is a new object with no ref and no text, and keeps isError and isReadOnly", async () => {
		const answer = {
			ref: 8,
			result: { stdout: `out ${envValue}` },
			text: `out ${envValue}`,
			context: [`ctx ${vendorToken}`],
			isError: true,
			isReadOnly: true,
		};
		const { result } = await call(e, answer);
		expect(result).toEqual({
			result: { stdout: `out [secret: ${ENV_NAME}]` },
			context: ["ctx [secret hidden]"],
			isError: true,
			isReadOnly: true,
		});
		expect("ref" in result).toBe(false);
		expect("text" in result).toBe(false);
	});

	test("R5 (Q26): a rewrite of a success adds no isError, isReadOnly, or context", async () => {
		const answer = { ref: 9, result: `out ${envValue}`, text: "x" };
		const { result } = await call(e, answer);
		expect(result).toEqual({ result: `out [secret: ${ENV_NAME}]` });
	});

	test("R5: a deny from below with a hit is masked, and a clean deny is the same object", async () => {
		const masked = await call(e, { deny: `no: ${envValue}` });
		expect(masked.result).toEqual({ deny: `no: [secret: ${ENV_NAME}]` });
		const clean = { deny: "not allowed" };
		const kept = await call(e, clean);
		expect(kept.result).toBe(clean);
	});

	test("R5 (R2): a result too large to scan is withheld with the reason", async () => {
		const answer = {
			ref: 10,
			result: "x".repeat(DEFAULT_LIMITS.maxChars + 1),
			text: "x",
		};
		const { result } = await call(e, answer);
		expect(result).toEqual({
			deny: "blindfold withheld this result (too-large). Narrow the call.",
		});
	});

	test("R5 (R2): the clock is read again after next, so no time left withholds", async () => {
		let left = 10_000;
		const { result } = await call(
			e,
			{ ref: 11, result: "ok", text: "ok" },
			{ atNext: () => (left = 0), remaining: () => left },
		);
		expect(result).toEqual({
			deny: "blindfold withheld this result (deadline). Narrow the call.",
		});
	});

	test("R5 (enroll R7): refreshIfNamed runs after next, so a value the call wrote to a listed file is masked", async () => {
		const answer = { ref: 12, result: `wrote ${freshValue}`, text: "x" };
		const { result, passed } = await call(
			{ tool: "Bash", command: "./rotate.sh .env" },
			answer,
			{ atNext: (files) => (files[".env"] = envFile(freshValue)) },
		);
		expect(passed.length).toBe(1);
		expect(result).toEqual({ result: `wrote [secret: ${ENV_NAME}]` });
	});
});

describe("R5 tool.call .catch", () => {
	const caught = (called: boolean) => {
		const passed: unknown[] = [];
		const next = Object.assign(async (given: unknown) => passed.push(given), {
			called,
			error: { kind: "throw" },
		}) as unknown as CatchNext;
		return { next, passed };
	};

	for (const called of [false, true]) {
		test(`R5 (P5): the .catch ${called ? "withholds after" : "refuses before"} next, and runs nothing`, async () => {
			const { api } = fakeApi({});
			const { next, passed } = caught(called);
			const result = await onToolCallCatch(
				api,
				{ tool: "Bash", command: "ls" } as Parameters<typeof onToolCall>[2],
				next,
			);
			answers.push(result);
			expect(result).toEqual({
				deny: called
					? "blindfold withheld this result."
					: "blindfold refused this call.",
			});
			expect(passed).toEqual([]);
		});
	}
});

describe("R15 no leak", () => {
	test("R15: no deny text holds a fake value or an env name", () => {
		const denies = answers.filter(
			(a) => typeof (a as { deny?: unknown }).deny === "string",
		);
		expect(denies.length).toBeGreaterThan(15);
		const secrets = [
			ENV_NAME,
			NAME,
			envValue,
			freshValue,
			known,
			vendorToken,
			privateKey,
			contextValue,
		];
		for (const deny of denies) {
			// P1: a marker in a masked deny from below may hold a name, and nothing else may.
			const json = JSON.stringify(deny).replace(/\[secret: \w+\]/g, "");
			for (const secret of secrets) expect(json.includes(secret)).toBe(false);
		}
	});

	test("R15: no verdict but a rewrite copy holds a fake value or an env name", () => {
		expect(seen.length).toBeGreaterThan(20);
		const secrets = [NAME, known, vendorToken, privateKey, contextValue];
		for (const verdict of seen) {
			const json = JSON.stringify(
				verdict.kind === "rewrite" ? { ...verdict, value: null } : verdict,
			);
			for (const secret of secrets) expect(json.includes(secret)).toBe(false);
		}
	});
});
