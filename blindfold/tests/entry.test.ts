import type { EngineInterface, ProcessRunInit } from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import {
	detectPlatform,
	EMPTY_MASK,
	type Entered,
	enterNative,
	type Masked,
	type Method,
	maskStep,
	nativeCommand,
	type Platform,
	pickMethod,
	readNative,
	TERMINAL_FIELD,
	TIMEOUT_MS,
} from "../hooks/entry.ts";
import { fakes } from "./fakes.ts";

const fake = fakes(31);
const NAME = "API_TOKEN";
/** Text that would break out of a script built from strings. */
const HOSTILE = `a "quote" $HOME \`id\` back\\slash ' end\nnext line`;

type Call = { noun: string; args: unknown[] };
type Run = (argv: readonly string[], init?: ProcessRunInit) => unknown;

/** A `$` with only `env.get` and `process.run`, recording every call. */
function fakeEntryApi(
	env: Record<string, string | undefined>,
	run: Run,
	options: { envFails?: boolean } = {},
) {
	const calls: Call[] = [];
	const api = {
		env: {
			get: async (name: string) => {
				calls.push({ noun: "env.get", args: [name] });
				if (options.envFails) throw new Error("env refused");
				return env[name];
			},
		},
		process: {
			run: async (argv: readonly string[], init?: ProcessRunInit) => {
				calls.push({ noun: "process.run", args: [argv, init] });
				return run(argv, init);
			},
		},
	} as unknown as EngineInterface;
	return { api, calls };
}

const out = (
	exitCode: number,
	stdout: string,
	stderr = "",
	isStdoutTruncated = false,
) => ({ exitCode, stdout, stderr, isStdoutTruncated });
const cancel = (why: string): Entered => ({ kind: "cancel", why }) as Entered;

describe("R1 platform and method", () => {
	const uname = (exitCode: number, stdout: string) => () =>
		out(exitCode, stdout);
	const cases: [string, Record<string, string>, Run, Platform][] = [
		["OS=Windows_NT is windows", { OS: "Windows_NT" }, uname(0, ""), "windows"],
		["uname Darwin is macos", {}, uname(0, "Darwin\n"), "macos"],
		["uname Linux is linux", {}, uname(0, "Linux\n"), "linux"],
		["another kernel is unknown", {}, uname(0, "FreeBSD\n"), "unknown"],
		["a key of Object is unknown", {}, uname(0, "toString\n"), "unknown"],
		["a failed uname is unknown", {}, uname(1, "Darwin\n"), "unknown"],
		[
			"a uname that does not start is unknown",
			{},
			() => {
				throw new Error("ENOENT");
			},
			"unknown",
		],
	];
	for (const [name, env, run, platform] of cases) {
		test(`R1: ${name}`, async () => {
			expect(await detectPlatform(fakeEntryApi(env, run).api)).toBe(platform);
		});
	}

	test("R1: Windows is read from OS without running uname", async () => {
		const { api, calls } = fakeEntryApi({ OS: "Windows_NT" }, uname(0, ""));
		await detectPlatform(api);
		expect(calls.map((c) => c.noun)).toEqual(["env.get"]);
	});

	test("R1: uname runs by argv", async () => {
		const { api, calls } = fakeEntryApi({}, uname(0, "Darwin\n"));
		await detectPlatform(api);
		expect(calls[1]?.args[0]).toEqual(["uname", "-s"]);
	});

	test("R1: an env refusal is unknown", async () => {
		const { api } = fakeEntryApi({}, uname(0, "Darwin\n"), { envFails: true });
		expect(await detectPlatform(api)).toBe("unknown");
	});

	test("R1: Q35 the terminal field is off until G2", () => {
		expect(TERMINAL_FIELD).toBe(false);
	});

	type Row = [Method, Platform, boolean, string, string];
	// [inputMethod, platform, native was unavailable, with the field on, with it off (Q35)]
	const table: Row[] = [
		["auto", "macos", false, "native", "native"],
		["auto", "macos", true, "unavailable", "unavailable"],
		["auto", "windows", false, "native", "native"],
		["auto", "linux", true, "terminal", "unavailable"],
		["auto", "unknown", false, "terminal", "unavailable"],
		["native", "macos", false, "native", "native"],
		["native", "linux", false, "native", "native"],
		["native", "windows", true, "unavailable", "unavailable"],
		["native", "unknown", false, "unavailable", "unavailable"],
		["terminal", "macos", false, "terminal", "native"],
		["terminal", "windows", true, "terminal", "unavailable"],
		["terminal", "unknown", false, "terminal", "unavailable"],
	];
	for (const [method, platform, failed, on, off] of table) {
		test(`R1: ${method} on ${platform}${failed ? " after no dialog" : ""} is ${on}, ${off} under Q35`, () => {
			expect(pickMethod(method, platform, failed, true)).toBe(on);
			expect(pickMethod(method, platform, failed, false)).toBe(off);
			expect(pickMethod(method, platform, failed)).toBe(off);
		});
	}
});

describe("R2 native commands", () => {
	const value = fake.secret();

	test("R2: macOS passes the name and the reason after --, with 1 fixed script", () => {
		const a = nativeCommand("macos", NAME, HOSTILE);
		const b = nativeCommand("macos", "OTHER", "plain");
		expect(a?.argv.slice(0, 2)).toEqual(["osascript", "-e"]);
		expect(a?.argv.slice(3)).toEqual(["--", NAME, HOSTILE]);
		expect(a?.argv[2]).toBe(b?.argv[2] as string);
		expect(a?.env).toBeUndefined();
	});

	test("R2: the macOS script reads argv and hides the answer", () => {
		const script = nativeCommand("macos", NAME, HOSTILE)?.argv[2] ?? "";
		for (const part of [
			"on run argv",
			"item 1 of argv",
			"item 2 of argv",
			'default answer ""',
			"with hidden answer",
			'with title "blindfold"',
			'buttons {"Cancel", "Save"}',
			"return text returned of",
		]) {
			expect(script).toContain(part);
		}
		expect(script).not.toContain(NAME);
		expect(script).not.toContain("HOME");
	});

	test("R2: Windows passes the name and the reason in env, never in the script", () => {
		const a = nativeCommand("windows", NAME, HOSTILE);
		const b = nativeCommand("windows", "OTHER", "plain");
		expect(a?.argv.slice(0, -1)).toEqual([
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Sta",
			"-Command",
		]);
		expect(a?.argv.at(-1)).toBe(b?.argv.at(-1) as string);
		expect(a?.argv.at(-1)).toContain("UseSystemPasswordChar = $true");
		expect(a?.argv.join(" ")).not.toContain(NAME);
		expect(a?.argv.join(" ")).not.toContain("HOME");
		expect(a?.env).toEqual({ BLINDFOLD_NAME: NAME, BLINDFOLD_REASON: HOSTILE });
	});

	test("R2: Linux with a display runs zenity with the text as 1 argument, markup escaped", () => {
		expect(nativeCommand("linux", NAME, "use <b> & go")?.argv).toEqual([
			"zenity",
			"--entry",
			"--hide-text",
			"--title",
			"blindfold",
			"--text",
			`use &lt;b&gt; &amp; go\n\n${NAME}`,
		]);
	});

	test("R2 (F63): on Linux, kdialog is the fallback when zenity does not start", () => {
		expect(nativeCommand("linux", NAME, "why")?.fallback?.argv).toEqual([
			"kdialog",
			"--title",
			"blindfold",
			"--password",
			`why\n\n${NAME}`,
		]);
		expect(nativeCommand("linux", NAME, "why")?.fallback?.fallback).toBe(
			undefined,
		);
		expect(nativeCommand("macos", NAME, "why")?.fallback).toBe(undefined);
	});

	test("R2: an unknown platform has no dialog", () => {
		expect(nativeCommand("unknown", NAME, "why")).toBeUndefined();
	});

	test("R2: the value is never an argument (it is not known yet)", () => {
		for (const platform of ["macos", "windows", "linux"] as const) {
			expect(
				JSON.stringify(nativeCommand(platform, NAME, "why")),
			).not.toContain(value);
		}
	});
});

describe("R3 reading the answer", () => {
	const value = fake.secret();

	test("R3: exit 0 removes exactly 1 trailing newline", () => {
		expect(readNative("macos", out(0, `${value}\n`))).toEqual({
			kind: "value",
			value,
		});
		expect(readNative("linux", out(0, `${value}\n\n`))).toEqual({
			kind: "value",
			value: `${value}\n`,
		});
	});

	test("R3: Windows removes 1 trailing \\r\\n", () => {
		expect(readNative("windows", out(0, `${value}\r\n`))).toEqual({
			kind: "value",
			value,
		});
	});

	test("R3: off Windows a \\r before the newline is kept", () => {
		expect(readNative("macos", out(0, `${value}\r\n`))).toEqual({
			kind: "value",
			value: `${value}\r`,
		});
	});

	test("R3: inner and trailing spaces are kept (G1, no trim)", () => {
		const spaced = `  ${value} with  spaces  `;
		expect(readNative("macos", out(0, `${spaced}\n`))).toEqual({
			kind: "value",
			value: spaced,
		});
	});

	test("R3: an empty value is cancelled", () => {
		expect(readNative("macos", out(0, "\n"))).toEqual(cancel("cancelled"));
		expect(readNative("windows", out(0, ""))).toEqual(cancel("cancelled"));
	});

	test("R3: macOS -128 is cancelled", () => {
		const stderr = "7:30: execution error: User canceled. (-128)\n";
		expect(readNative("macos", out(1, "", stderr))).toEqual(
			cancel("cancelled"),
		);
	});

	test("R3: Linux exit 1 is the Cancel button", () => {
		expect(readNative("linux", out(1, ""))).toEqual(cancel("cancelled"));
	});

	test("R3: any other exit is failed", () => {
		expect(
			readNative("macos", out(1, "", "execution error: boom (-1700)")),
		).toEqual(cancel("failed"));
		expect(readNative("windows", out(1, ""))).toEqual(cancel("failed"));
		expect(readNative("linux", out(5, ""))).toEqual(cancel("failed"));
		expect(readNative("macos", out(2, `${value}\n`))).toEqual(cancel("failed"));
	});

	test("F55: truncated stdout is failed, whatever the exit code", () => {
		expect(readNative("macos", out(0, `${value}\n`, "", true))).toEqual(
			cancel("failed"),
		);
	});

	test("R3: stderr is never in the result", () => {
		const stderr = `dialog text ${value} (-1700)`;
		for (const code of [0, 1, 2]) {
			expect(
				JSON.stringify(readNative("macos", out(code, "", stderr))),
			).not.toContain("dialog text");
		}
	});
});

describe("R2 R3 R4 enterNative", () => {
	const value = fake.secret(40);
	const macos = { argv: [] as readonly string[] };

	test("R2: runs the platform command with a 300 s timeout and reads its answer", async () => {
		const { api, calls } = fakeEntryApi({}, (argv) => {
			macos.argv = argv;
			return out(0, `${value}\n`);
		});
		expect(await enterNative(api, "macos", NAME, "why")).toEqual({
			kind: "value",
			value,
		});
		expect(TIMEOUT_MS).toBe(300_000);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args[1]).toEqual({ timeoutMs: TIMEOUT_MS });
		expect(macos.argv).toEqual(
			nativeCommand("macos", NAME, "why")?.argv as string[],
		);
	});

	test("R2: Windows gets the name and the reason through env", async () => {
		const { api, calls } = fakeEntryApi({}, () => out(0, `${value}\r\n`));
		expect(await enterNative(api, "windows", NAME, "why")).toEqual({
			kind: "value",
			value,
		});
		expect(calls[0]?.args[1]).toEqual({
			timeoutMs: TIMEOUT_MS,
			env: { BLINDFOLD_NAME: NAME, BLINDFOLD_REASON: "why" },
		});
	});

	test("R2: Linux with DISPLAY or WAYLAND_DISPLAY runs zenity", async () => {
		const programs: string[] = [];
		const run: Run = (argv) => {
			programs.push(argv[0] as string);
			return out(0, `${value}\n`);
		};
		await enterNative(
			fakeEntryApi({ DISPLAY: ":0" }, run).api,
			"linux",
			NAME,
			"why",
		);
		await enterNative(
			fakeEntryApi({ WAYLAND_DISPLAY: "wayland-0" }, run).api,
			"linux",
			NAME,
			"why",
		);
		expect(programs).toEqual(["zenity", "zenity"]);
	});

	test("R2 (F57): Linux with neither DISPLAY nor WAYLAND_DISPLAY is unavailable and runs no program", async () => {
		const { api, calls } = fakeEntryApi({}, () => out(0, `${value}\n`));
		expect(await enterNative(api, "linux", NAME, "why")).toEqual(
			cancel("unavailable"),
		);
		expect(calls.filter((c) => c.noun === "process.run")).toEqual([]);
	});

	/** Runs Linux with a display; `answers` maps a program to its answer, or to an error for one that does not start. */
	const linux = async (
		answers: Record<string, ReturnType<typeof out> | Error>,
		now: () => number = () => 0,
	) => {
		const programs: string[] = [];
		const { api } = fakeEntryApi({ DISPLAY: ":0" }, (argv) => {
			const program = argv[0] as string;
			programs.push(program);
			const answer = answers[program] ?? new Error(`ENOENT: ${program}`);
			if (answer instanceof Error) throw answer;
			return answer;
		});
		return {
			entered: await enterNative(api, "linux", NAME, "why", now),
			programs,
		};
	};

	test("R2 (F63): Linux runs kdialog when zenity does not start, and reads its answer", async () => {
		expect(await linux({ kdialog: out(0, `${value}\n`) })).toEqual({
			entered: { kind: "value", value },
			programs: ["zenity", "kdialog"],
		});
	});

	test("R2 (F63): exit code 1 from kdialog is cancelled", async () => {
		expect(await linux({ kdialog: out(1, "") })).toEqual({
			entered: cancel("cancelled"),
			programs: ["zenity", "kdialog"],
		});
	});

	test("R2 (F63): a zenity cancel never starts kdialog", async () => {
		expect(
			await linux({ zenity: out(1, ""), kdialog: out(0, `${value}\n`) }),
		).toEqual({ entered: cancel("cancelled"), programs: ["zenity"] });
	});

	test("R2 (F63): a zenity timeout never starts kdialog", async () => {
		// The run starts at 0 and rejects at the timeout.
		const clock = [0, TIMEOUT_MS];
		expect(
			await linux(
				{ zenity: new Error("timed out"), kdialog: out(0, `${value}\n`) },
				() => clock.shift() ?? TIMEOUT_MS,
			),
		).toEqual({ entered: cancel("timeout"), programs: ["zenity"] });
	});

	test("R2 (F63): when neither zenity nor kdialog starts, Linux is unavailable", async () => {
		expect(await linux({})).toEqual({
			entered: cancel("unavailable"),
			programs: ["zenity", "kdialog"],
		});
	});

	test("R2: a timeout reject is cancel with timeout", async () => {
		let t = 0;
		const { api } = fakeEntryApi({}, () => {
			t += TIMEOUT_MS;
			throw new Error("timed out");
		});
		expect(await enterNative(api, "macos", NAME, "why", () => t)).toEqual(
			cancel("timeout"),
		);
	});

	test("R2: a program that does not start is unavailable", async () => {
		const { api } = fakeEntryApi({}, () => {
			throw new Error("ENOENT: osascript");
		});
		expect(await enterNative(api, "macos", NAME, "why", () => 0)).toEqual(
			cancel("unavailable"),
		);
	});

	test("R2: an unknown platform runs nothing and is unavailable", async () => {
		const { api, calls } = fakeEntryApi({}, () => out(0, `${value}\n`));
		expect(await enterNative(api, "unknown", NAME, "why")).toEqual(
			cancel("unavailable"),
		);
		expect(calls).toHaveLength(0);
	});

	test("R4: no call to $ holds the value, except the dialog's stdout", async () => {
		for (const platform of ["macos", "windows", "linux"] as const) {
			const { api, calls } = fakeEntryApi({ DISPLAY: ":0" }, () =>
				out(0, `${value}\n`),
			);
			const entered = await enterNative(api, platform, NAME, HOSTILE);
			expect(entered.kind).toBe("value");
			expect(calls.length).toBeGreaterThan(0);
			expect(JSON.stringify(calls)).not.toContain(value);
		}
	});

	test("R4: a failure carries neither the value nor the error text", async () => {
		const { api } = fakeEntryApi({}, () => {
			throw new Error(`boom ${value}`);
		});
		expect(
			JSON.stringify(await enterNative(api, "macos", NAME, "why")),
		).not.toContain(value);
	});

	test("R6: entry reaches the value only through env.get and process.run (Q34)", async () => {
		const { api, calls } = fakeEntryApi({ DISPLAY: ":0" }, () =>
			out(0, `${value}\n`),
		);
		await enterNative(api, "linux", NAME, "why");
		expect(new Set(calls.map((c) => c.noun))).toEqual(
			new Set(["env.get", "process.run"]),
		);
	});
});

describe("R5 terminal field mask", () => {
	const type = (state: Masked, ...steps: string[]) =>
		steps.reduce(maskStep, state);

	test("R5: the field starts empty", () => {
		expect(EMPTY_MASK).toEqual({ value: "", shown: "" });
	});

	test("R5: characters after the dots are added at the end", () => {
		const state = type(EMPTY_MASK, "a", "•b", "••c d");
		expect(state).toEqual({ value: "abc d", shown: "•••••" });
	});

	test("R5: a paste into an empty field is added whole", () => {
		const value = fake.secret(12);
		expect(maskStep(EMPTY_MASK, value)).toEqual({
			value,
			shown: "•".repeat(12),
		});
	});

	test("R5: fewer dots remove that many characters from the end", () => {
		const state = type(EMPTY_MASK, "abcd");
		expect(maskStep(state, "••")).toEqual({ value: "ab", shown: "••" });
		expect(maskStep(state, "")).toEqual(EMPTY_MASK);
	});

	test("R5: the same dots change nothing", () => {
		const state = type(EMPTY_MASK, "abc");
		expect(maskStep(state, "•••")).toEqual(state);
	});

	test("R5: an edit in the middle clears the field", () => {
		const state = type(EMPTY_MASK, "abcd");
		expect(maskStep(state, "••x••")).toEqual(EMPTY_MASK);
		expect(maskStep(state, "•x")).toEqual(EMPTY_MASK);
	});

	test("R5: a paste over the dots clears the field", () => {
		expect(maskStep(type(EMPTY_MASK, "abcd"), "xyz")).toEqual(EMPTY_MASK);
	});

	test("R5: 1 dot per character, a surrogate pair included", () => {
		const state = type(EMPTY_MASK, "a😀");
		expect(state.shown).toBe("••");
		expect(maskStep(state, "•")).toEqual({ value: "a", shown: "•" });
	});
});
