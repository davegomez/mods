import type { EngineInterface } from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import { buildKnownSet, DEFAULT_LIMITS } from "../hooks/detect.ts";
import { createEnrollment, type Enrollment, load } from "../hooks/enroll.ts";
import {
	type ArgsVerdict,
	clockFor,
	guardArgs,
	guardText,
	guardValue,
	onAgentSpawn,
	onAgentSpawnCatch,
	onConfigSet,
	onPromptAttachment,
	onPromptAttachmentCatch,
	onPromptContext,
	onPromptContextCatch,
	onPromptMention,
	onPromptMentionCatch,
	onPromptSection,
	onPromptSectionCatch,
	onPromptSubmit,
	onPromptSubmitCatch,
	onSessionAppend,
	onSessionAppendCatch,
	onSessionReceive,
	onSessionReceiveCatch,
	onSessionSend,
	onSessionSendCatch,
	onSkillPrompt,
	onSkillPromptCatch,
	onToolCall,
	onToolCallCatch,
	PINNED_PROMPT,
	REFUSED_ARGS,
	REFUSED_MENTION,
	REFUSED_SEND,
	REFUSED_SPAWN,
	ROTATE_TOAST,
	unscannedBelow,
	type Verdict,
	WITHHELD_CONTENT,
	WITHHELD_DELIVERY,
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

	const unsupported = { kind: "stop", reason: "unsupported" };

	test("R1 (F41): an array with a property that is not an index is stop with unsupported", () => {
		const input = [] as string[] & { note?: string };
		input.note = known;
		// Frozen, not cloned: the runner's structuredClone drops the property, while Bun's keeps it.
		const payload = Object.freeze(input);
		expect(value(payload)).toEqual(unsupported);
		expect(args({ payload })).toEqual(unsupported);
	});

	test("R1 (F41): a key whose value is undefined is scanned, and stays out of the copy", () => {
		expect(value({ [known]: undefined, note: "plain" })).toEqual({
			kind: "rewrite",
			value: { note: "plain" },
			count: 1,
		});
		expect(args({ [known]: undefined })).toEqual({ kind: "refuse" });
	});

	test("R1 (F41): an optional field set to undefined still passes", () => {
		const input = {
			file_path: "notes.txt",
			offset: undefined,
			list: [undefined],
		};
		expect(value(input)).toEqual({ kind: "pass" });
		expect(args(input)).toEqual({ kind: "pass" });
	});

	test("R1 (F41): a function or a symbol value is stop with unsupported", () => {
		expect(value({ run: () => known })).toEqual(unsupported);
		expect(value({ tag: Symbol(known) })).toEqual(unsupported);
		expect(args({ list: [() => known] })).toEqual(unsupported);
	});

	test("R1 (F41): a toJSON that stands in for its object is stop with unsupported", () => {
		expect(value({ toJSON: () => "plain", note: known })).toEqual(unsupported);
		class Box {
			note = known;
			toJSON() {
				return "plain";
			}
		}
		expect(args({ box: new Box() })).toEqual(unsupported);
	});

	test("R1 (F41): a property that is not enumerable, or a getter, is stop with unsupported", () => {
		const hidden = Object.defineProperty({}, "note", { value: known });
		expect(value(hidden)).toEqual(unsupported);
		let reads = 0;
		const getter = {
			get note() {
				reads += 1;
				return reads === 1 ? "plain" : known;
			},
		};
		expect(args(getter)).toEqual(unsupported);
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

	test("R4 (F36): a vendor token or a known value inside a longer context value refuses", () => {
		expect(
			args({ command: `curl "https://h/api?token=${vendorToken}&page=2"` }),
		).toEqual({ kind: "refuse" });
		expect(args({ new_string: `password=${known}Zq9xT` })).toEqual({
			kind: "refuse",
		});
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
	const files: Record<string, { text: string }> = { ".env": envFile(secret) };
	const { api } = fakeApi(files);
	const enrollment = createEnrollment();
	await load(api, enrollment, ".env");
	return { api, enrollment, files };
}

/** A `next` that runs `atNext`, records what it got, and answers `answer`. `remaining` gives `budget.remainingMs` on each read. */
function nextOf<N = ToolNext>(
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
	) as unknown as N;
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

	test("R4 (F41): data the JSON copy would drop is a deny, and next never runs", async () => {
		const payload = [] as string[] & { note?: string };
		payload.note = envValue;
		for (const e of [
			{ tool: "mcp__fake__send", payload },
			{ tool: "mcp__fake__send", body: { [envValue]: undefined } },
		]) {
			const { result, passed } = await call(e);
			expect(isDeny(result)).toBe(true);
			expect(passed).toEqual([]);
		}
	});

	test("R4 (F41): an ordinary input with an optional field set to undefined goes on as the same e", async () => {
		const e = { tool: "Read", file_path: "notes.txt", offset: undefined };
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

	test("R5 (F37): a hit in text alone is a new object with no ref and no text", async () => {
		const answer = { ref: 13, result: { stdout: "clean" }, text: envValue };
		const { result } = await call(e, answer);
		expect(result).not.toBe(answer);
		expect(result).toEqual({ result: { stdout: "clean" } });
		expect("ref" in result).toBe(false);
		expect("text" in result).toBe(false);
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

/** A `.catch` handler's `next`: `called` says whether the hook had called `next`, and a call answers `answer`. */
const caught = <N = CatchNext>(called: boolean, answer: unknown = {}) => {
	const passed: unknown[] = [];
	const next = Object.assign(
		async (given: unknown) => {
			passed.push(given);
			return answer;
		},
		{ called, error: { kind: "throw" } },
	) as unknown as N;
	return { next, passed };
};

describe("R5 tool.call .catch", () => {
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

/** Every toast the prompt paths show, for the R15 check. */
const toasts: string[] = [];
/** A `$` whose `ui.toast` records into `toasts`. */
const promptApi = () =>
	({
		ui: { toast: (text: string) => void toasts.push(text) },
	}) as unknown as EngineInterface;

/** A `$` whose `ui.toast` throws, for F38. */
const throwingApi = () =>
	({
		ui: {
			toast: () => {
				throw new Error("toast failed");
			},
		},
	}) as unknown as EngineInterface;

const HIDDEN = `[secret: ${ENV_NAME}]`;
const tooLarge = () => "x".repeat(DEFAULT_LIMITS.maxChars + 1);

type SubmitE = Parameters<typeof onPromptSubmit>[2];
type SubmitNext = Parameters<typeof onPromptSubmit>[3];
type SubmitCatchNext = Parameters<typeof onPromptSubmitCatch>[2];

describe("R3 prompt.submit", () => {
	const entered = { text: "entered" };
	const submit = async (
		e: Record<string, unknown>,
		answer: unknown = entered,
	) => {
		const { enrollment } = await setup();
		const { next, passed } = nextOf<SubmitNext>(answer);
		const before = toasts.length;
		const result = await onPromptSubmit(
			promptApi(),
			enrollment,
			{ wait: false, origin: { kind: "user" }, ...e } as unknown as SubmitE,
			next,
		);
		answers.push(result);
		return { result, passed, shown: toasts.slice(before) };
	};

	test("R3: a hit in text and context goes on as the copies, then a toast tells the count", async () => {
		const { result, passed, shown } = await submit({
			text: `use ${envValue} now`,
			context: ["clean block", `ctx ${vendorToken}`],
		});
		expect(passed).toEqual([
			{
				wait: false,
				origin: { kind: "user" },
				text: `use ${HIDDEN} now`,
				context: ["clean block", "ctx [secret hidden]"],
			},
		]);
		expect(result).toBe(entered);
		expect(shown).toEqual(["blindfold hid 2 secrets in your prompt"]);
	});

	test("R3: a hit with no context adds no context, and 1 hit is 1 secret", async () => {
		const { passed, shown } = await submit({ text: envValue });
		expect(passed[0]).toEqual({
			wait: false,
			origin: { kind: "user" },
			text: HIDDEN,
		});
		expect("context" in (passed[0] as object)).toBe(false);
		expect(shown).toEqual(["blindfold hid 1 secret in your prompt"]);
	});

	test("R3: a clean prompt calls next with the same e, and shows no toast", async () => {
		const { enrollment } = await setup();
		const { next, passed } = nextOf<SubmitNext>(entered);
		const e = {
			text: "nothing here",
			context: ["plain"],
			wait: false,
			origin: { kind: "user" },
		} as unknown as SubmitE;
		const before = toasts.length;
		const result = await onPromptSubmit(promptApi(), enrollment, e, next);
		expect(passed).toEqual([e]);
		expect(passed[0]).toBe(e);
		expect(result).toBe(entered);
		expect(toasts.length).toBe(before);
	});

	test("R3 (R2): a prompt it cannot scan is a drop with the reason, and next never runs", async () => {
		const { result, passed, shown } = await submit({ text: tooLarge() });
		expect(Object.keys(result)).toEqual(["drop"]);
		expect(result.drop).toContain("too-large");
		expect(passed).toEqual([]);
		expect(shown).toEqual([]);
	});

	test("R3: a prompt that a hook beneath drops shows no toast", async () => {
		const { result, shown } = await submit({ text: envValue }, { drop: "no" });
		expect(result).toEqual({ drop: "no" });
		expect(shown).toEqual([]);
	});

	test("Q29: a hit in text with e.command set is a drop, and next never runs", async () => {
		const { result, passed, shown } = await submit({
			text: `/deploy ${envValue}`,
			command: { name: "deploy" },
		});
		expect(result).toEqual(PINNED_PROMPT);
		expect(passed).toEqual([]);
		expect(shown).toEqual([]);
	});

	test("Q29: a hit in context alone with e.command set goes on with the masked context", async () => {
		const { passed } = await submit({
			text: "/deploy staging",
			command: { name: "deploy" },
			context: [`ctx ${envValue}`],
		});
		expect((passed[0] as { text: string }).text).toBe("/deploy staging");
		expect((passed[0] as { context: string[] }).context).toEqual([
			`ctx ${HIDDEN}`,
		]);
	});

	test("R3 (F38): a toast that throws still returns the masked result, and next is called once", async () => {
		const { enrollment } = await setup();
		const { next, passed } = nextOf<SubmitNext>(entered);
		const result = await onPromptSubmit(
			throwingApi(),
			enrollment,
			{ text: envValue, wait: false } as unknown as SubmitE,
			next,
		);
		expect(result).toBe(entered);
		expect(passed).toEqual([{ text: HIDDEN, wait: false }]);
	});

	test("R15 (F40, Q32): a drop from below is left as the host requires", async () => {
		// d.ts:9843: a drop after next fails the hook, so it is not pushed to `answers`.
		const { enrollment } = await setup();
		const below = { drop: `Refused ${envValue}` };
		const { next } = nextOf<SubmitNext>(below);
		const result = await onPromptSubmit(
			promptApi(),
			enrollment,
			{ text: "clean", wait: false } as unknown as SubmitE,
			next,
		);
		expect(result).toBe(below);
	});

	test("Q29 (isMeta): a hit in the text of a meta prompt is a drop, because a rewrite may not apply", async () => {
		const { result, passed } = await submit({ text: envValue, isMeta: true });
		expect(result).toEqual(PINNED_PROMPT);
		expect(passed).toEqual([]);
	});

	for (const called of [false, true]) {
		test(`R3 (P5): the .catch ${called ? "keeps what next gave" : "drops before next"}`, async () => {
			const { next, passed } = caught<SubmitCatchNext>(called, entered);
			const e = { text: "x", wait: false } as unknown as SubmitE;
			const result = await onPromptSubmitCatch(promptApi(), e, next);
			answers.push(result);
			if (called) {
				expect(result).toBe(entered);
				expect(passed).toEqual([e]);
			} else {
				expect(Object.keys(result as object)).toEqual(["drop"]);
				expect(passed).toEqual([]);
			}
		});
	}
});

type ContextNext = Parameters<typeof onPromptContext>[3];
type ContextE = Parameters<typeof onPromptContext>[2];

describe("R6 prompt.context", () => {
	const e = { blocks: [] } as unknown as ContextE;
	const context = async (answer: unknown) => {
		const { enrollment } = await setup();
		const { next, passed } = nextOf<ContextNext>(answer);
		const result = await onPromptContext(promptApi(), enrollment, e, next);
		answers.push(result);
		return { result, passed };
	};

	test("R6: a block with a hit is rewritten, and the other blocks are the same objects", async () => {
		const date = { name: "currentDate", text: "today" };
		const answer = {
			blocks: [{ name: "claudeMd", text: `key ${envValue}` }, date],
			instructionFiles: [],
		};
		const { result, passed } = await context(answer);
		expect(passed).toEqual([e]);
		expect(passed[0]).toBe(e);
		expect(result).toEqual({
			blocks: [{ name: "claudeMd", text: `key ${HIDDEN}` }, date],
		});
		expect(result.blocks[1]).toBe(date);
	});

	test("R6: clean blocks are the same object next returned", async () => {
		const answer = { blocks: [{ name: "claudeMd", text: "plain" }] };
		const { result } = await context(answer);
		expect(result).toBe(answer);
	});

	test("R6 (F39): a block whose name holds a hit is left out, with clean text or a hit in it", async () => {
		const date = { name: "currentDate", text: "today" };
		const { result } = await context({
			blocks: [
				{ name: envValue, text: "ordinary context" },
				{ name: `ctx ${vendorToken}`, text: `key ${envValue}` },
				date,
			],
		});
		expect(result).toEqual({ blocks: [date] });
		expect(result.blocks[0]).toBe(date);
	});

	test("R6 (F39, R2): a block whose name it cannot scan is left out", async () => {
		const date = { name: "currentDate", text: "today" };
		const { result } = await context({
			blocks: [{ name: tooLarge(), text: "ordinary context" }, date],
		});
		// Not toEqual: a failed diff of the long name is too large to report.
		expect(result.blocks.length).toBe(1);
		expect(result.blocks[0]).toBe(date);
	});

	test("R6 (R2): a block it cannot scan is left out", async () => {
		const date = { name: "currentDate", text: "today" };
		const { result } = await context({
			blocks: [{ name: "claudeMd", text: tooLarge() }, date],
		});
		expect(result).toEqual({ blocks: [date] });
	});

	for (const called of [false, true]) {
		test(`R6 (P5): the .catch ${called ? "after" : "before"} next sends no block`, async () => {
			const { next, passed } =
				caught<Parameters<typeof onPromptContextCatch>[2]>(called);
			expect(await onPromptContextCatch(promptApi(), e, next)).toEqual({
				blocks: [],
			});
			expect(passed).toEqual([]);
		});
	}
});

/** R7 to R9 share 1 shape: a `{ text }` that `next` answers and the hook masks. */
const textPaths = [
	{
		id: "R7 prompt.section",
		hook: onPromptSection,
		onCatch: onPromptSectionCatch,
		e: { name: "memory", text: "x" },
		withheld: { text: null },
		nullable: true,
	},
	{
		id: "R8 prompt.attachment",
		hook: onPromptAttachment,
		onCatch: onPromptAttachmentCatch,
		e: { type: "file", text: "x", origin: { kind: "engine" } },
		withheld: { text: null },
		nullable: true,
	},
	{
		id: "R9 skill.prompt",
		hook: onSkillPrompt,
		onCatch: onSkillPromptCatch,
		e: { skill: "fake", text: "x", frontmatter: {} },
		withheld: { text: "blindfold withheld this skill text." },
		nullable: false,
	},
];

for (const path of textPaths) {
	const [id, event] = path.id.split(" ");
	type Run = (
		$: EngineInterface,
		enrollment: unknown,
		e: unknown,
		next: unknown,
	) => Promise<{ text: string | null }>;
	type Catch = ($: EngineInterface, e: unknown, next: unknown) => unknown;
	const run = async (answer: unknown) => {
		const { enrollment } = await setup();
		const { next, passed } = nextOf<unknown>(answer);
		const result = await (path.hook as unknown as Run)(
			promptApi(),
			enrollment,
			path.e,
			next,
		);
		answers.push(result);
		return { result, passed };
	};

	describe(path.id, () => {
		test(`${id}: a hit in the text next gave is rewritten, after next got the same e`, async () => {
			const { result, passed } = await run({ text: `a ${envValue} b` });
			expect(passed[0]).toBe(path.e);
			expect(result).toEqual({ text: `a ${HIDDEN} b` });
		});

		test(`${id}: clean text is the same object next returned`, async () => {
			const answer = { text: "plain text" };
			expect((await run(answer)).result).toBe(answer);
			if (path.nullable) {
				const none = { text: null };
				expect((await run(none)).result).toBe(none);
			}
		});

		test(`${id} (R2): text it cannot scan is withheld`, async () => {
			expect((await run({ text: tooLarge() })).result).toEqual(path.withheld);
		});

		for (const called of [false, true]) {
			test(`${id} (P5): the ${event} .catch ${called ? "after" : "before"} next withholds`, async () => {
				const { next, passed } = caught(called, { text: envValue });
				const result = await (path.onCatch as unknown as Catch)(
					promptApi(),
					path.e,
					next,
				);
				answers.push(result);
				expect(result).toEqual(path.withheld);
				expect(passed).toEqual([]);
			});
		}
	});
}

type MentionE = Parameters<typeof onPromptMention>[2];
type MentionNext = Parameters<typeof onPromptMention>[3];

describe("R10 prompt.mention", () => {
	const read = { type: "file" };
	const mention = async (path: string) => {
		const { api } = fakeApi({});
		const enrollment = createEnrollment();
		await load(api, enrollment, "./config/app.secrets,sub\\creds.txt");
		const { next, passed } = nextOf<MentionNext>(read);
		const e = { mention: "x", path } as MentionE;
		const result = await onPromptMention(api, enrollment, e, next);
		answers.push(result);
		return { result, passed, e };
	};

	for (const path of [
		"/repo/.env",
		"/repo/sub/.env",
		"C:\\repo\\sub\\.env",
		"/repo/.env.local",
		"/repo/.ENV",
		"/repo/config/app.secrets",
		"/repo/./config//app.secrets",
		"C:\\repo\\config\\app.secrets",
		"/repo/sub/creds.txt",
	]) {
		test(`R10 (Q27): ${path} is a listed or .env file, so it is a deny, and next never runs`, async () => {
			const { result, passed } = await mention(path);
			expect(result).toEqual(REFUSED_MENTION);
			expect(passed).toEqual([]);
		});
	}

	for (const path of [
		"/repo/notes.md",
		"/repo/.envrc",
		"/repo/my.env",
		"/repo/env.example",
		"/repo/xconfig/app.secrets",
		"/repo/config/app.secrets.bak",
	]) {
		test(`R10 (Q27): ${path} is not an env file, so next gets the same e`, async () => {
			const { result, passed, e } = await mention(path);
			expect(passed).toEqual([e]);
			expect(passed[0]).toBe(e);
			expect(result).toBe(read);
		});
	}

	const mentionBelow = async (answer: unknown) => {
		const { enrollment } = await setup();
		const { next } = nextOf<MentionNext>(answer);
		const e = { mention: "x", path: "/repo/notes.md" } as MentionE;
		const result = await onPromptMention(promptApi(), enrollment, e, next);
		answers.push(result);
		return result;
	};

	test("R15 (F40, Q32): a deny from below with a value is masked, because the debug log reads it", async () => {
		const result = await mentionBelow({ deny: `Read refused ${envValue}` });
		expect(result).toEqual({ deny: `Read refused ${HIDDEN}` });
	});

	test("R15 (F40, Q32): a clean deny from below is the same object", async () => {
		const below = { deny: "Read refused" };
		expect(await mentionBelow(below)).toBe(below);
	});

	test("R15 (F40, Q32): a deny from below it cannot scan is a fixed blindfold deny", async () => {
		const result = await mentionBelow({ deny: tooLarge() });
		expect(Object.keys(result)).toEqual(["deny"]);
		expect(result.deny).toBe(unscannedBelow("too-large"));
	});

	test("R10 (Q27): with no list, a .env base name is still a deny", async () => {
		const { next, passed } = nextOf<MentionNext>(read);
		const result = await onPromptMention(
			promptApi(),
			createEnrollment(),
			{ mention: "x", path: "/repo/.env.production" } as MentionE,
			next,
		);
		expect(result).toEqual(REFUSED_MENTION);
		expect(passed).toEqual([]);
	});

	for (const called of [false, true]) {
		test(`R10 (P5): the .catch ${called ? "after" : "before"} next is a deny`, async () => {
			const { next, passed } = caught<
				Parameters<typeof onPromptMentionCatch>[2]
			>(called, read);
			const result = await onPromptMentionCatch(
				promptApi(),
				{ mention: "x", path: "/repo/notes.md" } as MentionE,
				next,
			);
			answers.push(result);
			expect(result).toEqual(REFUSED_MENTION);
			expect(passed).toEqual([]);
		});
	}
});

type SpawnE = Parameters<typeof onAgentSpawn>[2];
type SpawnNext = Parameters<typeof onAgentSpawn>[3];
type SpawnCatchNext = Parameters<typeof onAgentSpawnCatch>[2];

describe("R11 agent.spawn", () => {
	const started = { model: "haiku", agentId: "a1" };
	const spawnE = (fields: Record<string, unknown>) =>
		({
			tool_use_id: "t1",
			subagentType: "Explore",
			prompt: "find the config loader",
			description: "find loader",
			...fields,
		}) as unknown as SpawnE;
	const spawn = async (e: SpawnE) => {
		const { enrollment } = await setup();
		const { next, passed } = nextOf<SpawnNext>(started);
		const result = await onAgentSpawn(promptApi(), enrollment, e, next);
		answers.push(result);
		return { result, passed };
	};

	for (const field of ["prompt", "description"]) {
		test(`R11: a hit in ${field} is a deny, and next never runs`, async () => {
			const { result, passed } = await spawn(
				spawnE({ [field]: `use ${envValue}` }),
			);
			expect(result).toEqual(REFUSED_SPAWN);
			expect(passed).toEqual([]);
		});
	}

	test("R11: a clean spawn calls next with the same e and returns its answer", async () => {
		const e = spawnE({});
		const { result, passed } = await spawn(e);
		expect(passed[0]).toBe(e);
		expect(result).toBe(started);
	});

	test("R15 (F40, Q32): a deny from below is left as the host requires", async () => {
		// d.ts:450: a deny after next fails the hook, so it is not pushed to `answers`.
		const { enrollment } = await setup();
		const below = { deny: `Refused ${envValue}` };
		const { next } = nextOf<SpawnNext>(below);
		const result = await onAgentSpawn(
			promptApi(),
			enrollment,
			spawnE({}),
			next,
		);
		expect(result).toBe(below);
	});

	test("R11 (R2): a task it cannot scan is a deny with the reason, and next never runs", async () => {
		const { result, passed } = await spawn(spawnE({ prompt: tooLarge() }));
		expect(Object.keys(result)).toEqual(["deny"]);
		expect(result.deny).toContain("too-large");
		expect(passed).toEqual([]);
	});

	for (const called of [false, true]) {
		test(`R11 (P5): the .catch ${called ? "keeps what next gave" : "denies before next"}`, async () => {
			const { next, passed } = caught<SpawnCatchNext>(called, started);
			const e = spawnE({});
			const result = await onAgentSpawnCatch(promptApi(), e, next);
			answers.push(result);
			if (called) {
				expect(result).toBe(started);
				expect(passed).toEqual([e]);
			} else {
				expect(Object.keys(result as object)).toEqual(["deny"]);
				expect(passed).toEqual([]);
			}
		});
	}
});

type SendE = Parameters<typeof onSessionSend>[2];
type SendNext = Parameters<typeof onSessionSend>[3];
type SendCatchNext = Parameters<typeof onSessionSendCatch>[2];

describe("R12 session.send", () => {
	const delivered = { isDelivered: true };
	const sendE = (text: string) =>
		({ to: "peer", text, origin: { kind: "model" } }) as unknown as SendE;
	const send = async (e: SendE, answer: unknown = delivered) => {
		const { enrollment } = await setup();
		const { next, passed } = nextOf<SendNext>(answer);
		const result = await onSessionSend(promptApi(), enrollment, e, next);
		answers.push(result);
		return { result, passed };
	};

	test("R15 (F40, Q32): a reason from below with a value is masked, because the model reads it", async () => {
		const { result } = await send(sendE("hello"), {
			isDelivered: false,
			reason: `No recipient ${envValue}`,
		});
		expect(result).toEqual({
			isDelivered: false,
			reason: `No recipient ${HIDDEN}`,
		});
	});

	test("R15 (F40, Q32): a reason from below it cannot scan is a fixed blindfold reason", async () => {
		const { result } = await send(sendE("hello"), {
			isDelivered: false,
			reason: tooLarge(),
		});
		expect(result).toEqual({
			isDelivered: false,
			reason: unscannedBelow("too-large"),
		});
	});

	test("R12: a hit is isDelivered false with a reason, and next never runs", async () => {
		const { result, passed } = await send(sendE(`key ${envValue}`));
		expect(result).toEqual(REFUSED_SEND);
		expect(passed).toEqual([]);
	});

	test("R12: a clean message calls next with the same e and returns its answer", async () => {
		const e = sendE("hello");
		const { result, passed } = await send(e);
		expect(passed[0]).toBe(e);
		expect(result).toBe(delivered);
	});

	test("R12 (R2): a message it cannot scan is refused with the reason, and next never runs", async () => {
		const { result, passed } = await send(sendE(tooLarge()));
		expect(result.isDelivered).toBe(false);
		expect(result.reason).toContain("too-large");
		expect(passed).toEqual([]);
	});

	for (const called of [false, true]) {
		test(`R12 (P5): the session.send .catch ${called ? "keeps what next gave" : "refuses before next"}`, async () => {
			const { next, passed } = caught<SendCatchNext>(called, delivered);
			const e = sendE("x");
			const result = await onSessionSendCatch(promptApi(), e, next);
			answers.push(result);
			if (called) {
				expect(result).toBe(delivered);
				expect(passed).toEqual([e]);
			} else {
				expect(result).toEqual({
					isDelivered: false,
					reason: expect.any(String),
				});
				expect(passed).toEqual([]);
			}
		});
	}
});

type ReceiveE = Parameters<typeof onSessionReceive>[2];
type ReceiveNext = Parameters<typeof onSessionReceive>[3];
type ReceiveCatchNext = Parameters<typeof onSessionReceiveCatch>[2];

describe("R12 session.receive", () => {
	const queued = { text: "queued" };
	const receiveE = (text: string) =>
		({ origin: { kind: "peer" }, text }) as unknown as ReceiveE;
	const receive = async (e: ReceiveE, answer: unknown = queued) => {
		const { enrollment } = await setup();
		const { next, passed } = nextOf<ReceiveNext>(answer);
		const result = await onSessionReceive(promptApi(), enrollment, e, next);
		answers.push(result);
		return { result, passed };
	};

	for (const text of ["hello", `key ${envValue}`]) {
		test(`R15 (F40, Q32): a consumed text from below with a value is masked after a ${text === "hello" ? "clean" : "masked"} message, because the log reads it`, async () => {
			const { result } = await receive(receiveE(text), {
				consumed: `Handled ${envValue}`,
			});
			expect(result).toEqual({ consumed: `Handled ${HIDDEN}` });
		});
	}

	test("R15 (F40, Q32): a consumed text from below it cannot scan is a fixed blindfold text", async () => {
		const { result } = await receive(receiveE("hello"), {
			consumed: tooLarge(),
		});
		expect(result).toEqual({ consumed: unscannedBelow("too-large") });
	});

	test("Q28: a hit is rewritten, and next gets the masked copy", async () => {
		const { result, passed } = await receive(receiveE(`key ${envValue}`));
		expect(passed).toEqual([
			{ origin: { kind: "peer" }, text: `key ${HIDDEN}` },
		]);
		expect(result).toBe(queued);
	});

	test("R12: a clean message calls next with the same e", async () => {
		const e = receiveE("hello");
		const { result, passed } = await receive(e);
		expect(passed[0]).toBe(e);
		expect(result).toBe(queued);
	});

	test("R12 (R2): a message it cannot scan is consumed, and next never runs", async () => {
		const { result, passed } = await receive(receiveE(tooLarge()));
		expect(result).toEqual(WITHHELD_DELIVERY);
		expect(passed).toEqual([]);
	});

	for (const called of [false, true]) {
		test(`R12 (P5): the session.receive .catch ${called ? "keeps what next gave" : "consumes before next"}`, async () => {
			const { next, passed } = caught<ReceiveCatchNext>(called, queued);
			const e = receiveE("x");
			const result = await onSessionReceiveCatch(promptApi(), e, next);
			answers.push(result);
			if (called) {
				expect(result).toBe(queued);
				expect(passed).toEqual([e]);
			} else {
				expect(result).toEqual(WITHHELD_DELIVERY);
				expect(passed).toEqual([]);
			}
		});
	}
});

type AppendE = Parameters<typeof onSessionAppend>[2];
type AppendNext = Parameters<typeof onSessionAppend>[3];
type AppendCatchNext = Parameters<typeof onSessionAppendCatch>[2];
type Block = { type: string; [field: string]: unknown };

describe("R13 session.append", () => {
	const stored = { message: { type: "user", content: [] }, uuid: "u1" };
	const image = {
		type: "image",
		source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
	};
	const thinking = { type: "thinking", thinking: `saw ${envValue}` };
	const rowE = (content: Block[]) =>
		({
			message: { type: "user", role: "user", content },
			door: "tool-result",
			origin: { kind: "tool", tool: "Bash" },
			uuid: "u1",
		}) as unknown as AppendE;
	const append = async (e: AppendE, $ = promptApi()) => {
		const { enrollment } = await setup();
		const { next, passed } = nextOf<AppendNext>(stored);
		const before = toasts.length;
		const result = await onSessionAppend($, enrollment, e, next);
		answers.push(result);
		const sent = passed[0] as { message: { content: Block[] } } | undefined;
		return {
			result,
			passed,
			content: sent?.message.content,
			shown: toasts.slice(before),
		};
	};

	test("R13: a hit in a text block is rewritten, the rest of e is kept, and a toast says rotate", async () => {
		const e = rowE([{ type: "text", text: `a ${envValue} b` }]);
		const { result, passed, content, shown } = await append(e);
		expect(passed).toEqual([
			{
				...e,
				message: {
					...e.message,
					content: [{ type: "text", text: `a ${HIDDEN} b` }],
				},
			},
		]);
		expect(content).not.toBe(e.message.content);
		expect(result).toBe(stored);
		expect(shown).toEqual([ROTATE_TOAST]);
	});

	test("R13: a string tool_result content is rewritten, and tool_use_id and is_error are kept", async () => {
		const { content } = await append(
			rowE([
				{
					type: "tool_result",
					tool_use_id: "t1",
					is_error: true,
					content: `out ${envValue}`,
				},
			]),
		);
		expect(content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "t1",
				is_error: true,
				content: `out ${HIDDEN}`,
			},
		]);
	});

	test("R13: an array tool_result content has its text blocks rewritten, and its media block left in place", async () => {
		const { content } = await append(
			rowE([
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: [{ type: "text", text: vendorToken }, image],
				},
			]),
		);
		const inner = content?.[0]?.content as Block[];
		expect(inner[0]).toEqual({ type: "text", text: "[secret hidden]" });
		expect(inner[1]).toBe(image);
	});

	test("R13: a media block and a thinking block are left as the same objects", async () => {
		const { content } = await append(
			rowE([image, thinking, { type: "text", text: envValue }]),
		);
		expect(content?.[0]).toBe(image);
		expect(content?.[1]).toBe(thinking);
		expect(content?.[2]).toEqual({ type: "text", text: HIDDEN });
	});

	test("R13: a clean row calls next with the same e, and shows no toast", async () => {
		const e = rowE([
			{ type: "text", text: "plain" },
			{ type: "tool_result", tool_use_id: "t1", content: "ok" },
			thinking,
		]);
		const { result, passed, shown } = await append(e);
		expect(passed[0]).toBe(e);
		expect(result).toBe(stored);
		expect(shown).toEqual([]);
	});

	test("R13 (R2): a row it cannot scan has each text block and tool_result content withheld, and media and thinking kept", async () => {
		const { content, passed, shown } = await append(
			rowE([
				{ type: "text", text: tooLarge() },
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: [{ type: "text", text: "fine" }, image],
				},
				image,
				thinking,
			]),
		);
		expect(passed.length).toBe(1);
		expect(content).toEqual([
			{ type: "text", text: WITHHELD_CONTENT },
			{ type: "tool_result", tool_use_id: "t1", content: WITHHELD_CONTENT },
			image,
			thinking,
		]);
		expect(content?.[2]).toBe(image);
		expect(shown).toEqual([]);
	});

	test("R13 (F38): a toast that throws still returns the result, and next is called once", async () => {
		const { result, passed, content } = await append(
			rowE([{ type: "text", text: envValue }]),
			throwingApi(),
		);
		expect(result).toBe(stored);
		expect(passed.length).toBe(1);
		expect(content).toEqual([{ type: "text", text: HIDDEN }]);
	});

	for (const called of [false, true]) {
		test(`R13 (P5): the .catch ${called ? "returns the result unchanged after" : "withholds the content before"} next`, async () => {
			const { next, passed } = caught<AppendCatchNext>(called, stored);
			const e = rowE([
				{ type: "text", text: envValue },
				{ type: "tool_result", tool_use_id: "t1", content: envValue },
				image,
			]);
			const result = await onSessionAppendCatch(promptApi(), e, next);
			answers.push(result);
			expect(result).toBe(stored);
			expect(passed).toEqual([
				called
					? e
					: {
							...e,
							message: {
								...e.message,
								content: [
									{ type: "text", text: WITHHELD_CONTENT },
									{
										type: "tool_result",
										tool_use_id: "t1",
										content: WITHHELD_CONTENT,
									},
									image,
								],
							},
						},
			]);
		});
	}
});

type ConfigE = Parameters<typeof onConfigSet>[2];
type ConfigNext = Parameters<typeof onConfigSet>[3];

describe("R14 config.set", () => {
	const newValue = fake.secret(24);
	const requestedValue = fake.secret(24);
	/** e asks for requested.env, and next answers the list it wrote, changed.env in the tests, so the two are told apart. */
	const configSet = async (
		key: string,
		answer: unknown,
		atNext: (enrollment: Enrollment) => void = () => {},
	) => {
		const { api, enrollment, files } = await setup();
		files["requested.env"] = envFile(requestedValue);
		files["changed.env"] = envFile(newValue);
		const { next, passed } = nextOf<ConfigNext>(answer, () =>
			atNext(enrollment),
		);
		const e = {
			key,
			value: "requested.env",
			previous: ".env",
		} as unknown as ConfigE;
		const result = await onConfigSet(api, enrollment, e, next);
		const hidden = guardText(newValue, enrollment.knownSet(), never);
		return { result, passed, e, enrollment, hidden };
	};

	test("R14 (enroll R7, F43): blindfold.envFiles loads the list next returned, not e.value, after next", async () => {
		const answer = { value: "changed.env" };
		let gated = 0;
		const { result, passed, e, enrollment, hidden } = await configSet(
			"blindfold.envFiles",
			answer,
			(during) => {
				gated += 1;
				expect(during.listed()).toBe(".env");
				expect(guardText(newValue, during.knownSet(), never).kind).toBe("pass");
			},
		);
		expect(gated).toBe(1);
		expect(passed[0]).toBe(e);
		expect(result).toBe(answer);
		expect(enrollment.listed()).toBe("changed.env");
		expect(hidden.kind).toBe("rewrite");
		expect(guardText(requestedValue, enrollment.knownSet(), never).kind).toBe(
			"pass",
		);
	});

	test("R14: another key loads nothing", async () => {
		const answer = { value: "changed.env" };
		const { result, enrollment, hidden } = await configSet("theme", answer);
		expect(result).toBe(answer);
		expect(enrollment.listed()).toBe(".env");
		expect(hidden.kind).toBe("pass");
	});

	test("R14: a deny from below loads nothing", async () => {
		const answer = { deny: "no" };
		const { result, enrollment } = await configSet(
			"blindfold.envFiles",
			answer,
		);
		expect(result).toBe(answer);
		expect(enrollment.listed()).toBe(".env");
	});
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

	test("R15: no toast, drop, reason, or consumed text holds a fake value or an env name, and a toast holds a count only", () => {
		const texts = (key: string) =>
			answers.filter(
				(a) => typeof (a as Record<string, unknown>)[key] === "string",
			);
		const drops = texts("drop");
		expect(drops.length).toBeGreaterThan(3);
		expect(texts("reason").length).toBeGreaterThan(2);
		expect(texts("consumed").length).toBeGreaterThan(1);
		expect(toasts.length).toBeGreaterThan(1);
		const secrets = [ENV_NAME, envValue, vendorToken];
		for (const item of [
			...drops,
			...texts("reason"),
			...texts("consumed"),
			...toasts,
		]) {
			// Q32: a marker in a masked text from below may hold a name, and nothing else may.
			const json = JSON.stringify(item).replace(/\[secret: \w+\]/g, "");
			for (const secret of secrets) expect(json.includes(secret)).toBe(false);
		}
		for (const toast of toasts) {
			expect(
				toast === ROTATE_TOAST ||
					/^blindfold hid \d+ secrets? in your prompt$/.test(toast),
			).toBe(true);
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
