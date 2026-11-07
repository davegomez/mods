import type { EngineInterface } from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import { enrollment, register, requests, ui } from "../hooks/register.ts";
import { DROPPED_TOAST } from "../hooks/request.ts";
import { REFUSED_COMMAND } from "../hooks/ui.ts";
import {
	type FakeCall,
	type FakeElement,
	type FakeFile,
	fakeApi,
	fakes,
	hooksOf,
} from "./fakes.ts";

const fake = fakes(21);
const NAME = "STRIPE_API_KEY";
const COMMAND = `command.run ${JSON.stringify({ command: "secrets" })}`;
const BAND = `ui.render ${JSON.stringify({ component: "AbovePrompt" })}`;
const budget = { budget: { ms: 10_000, remainingMs: 10_000 } };
const NEXT_TEXT =
	"blindfold registered /secrets but no command.run hook answered it";
const OPEN_TOAST = `blindfold: Claude asks for ${NAME}. Run /secrets or use the band.`;
const MANUAL = `Add ${NAME}= to .env in your editor, then press Refresh.`;

const hooks = (list = ".env") => hooksOf(register, { envFiles: list });

/** A fresh session over `files`: the module state cleared, then session.start. `shown` starts after it. */
async function start(files: Record<string, FakeFile>, list = ".env") {
	requests.clear();
	ui.setOutcome(undefined);
	enrollment.drop();
	const made = fakeApi(files);
	await hooks(list).get("session.start")?.(made.api, {}, async (e) => e);
	const before = made.shown.length;
	return { ...made, after: () => made.shown.slice(before) };
}

/** Runs `/secrets args`; returns the hook's answer and each event `next` got. */
async function secrets($: EngineInterface, args: string, list = ".env") {
	const passed: { args: string }[] = [];
	const next = Object.assign(async (e: unknown) => {
		passed.push(e as { args: string });
		return { text: NEXT_TEXT, ref: 7 };
	}, budget);
	const e = {
		command: "secrets",
		args,
		origin: { kind: "composer" },
		presentation: { isFullscreen: true, columns: 120 },
	};
	const answer = await hooks(list).get(COMMAND)?.($, e, next);
	return { answer, passed };
}

const OTHER: FakeElement = { type: "Text", props: { children: "other mod" } };

/** Draws the band; the mods beneath answer `OTHER`. */
async function band($: EngineInterface, hasSurvey = false) {
	const e = {
		surface: "terminal",
		component: "AbovePrompt",
		requestId: "band",
		props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 80 },
	};
	return (await hooks().get(BAND)?.($, e, async () => OTHER)) as FakeElement;
}

/** Every element of a tree, depth first. */
const elements = (node: unknown): FakeElement[] => {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!node || typeof node !== "object") return [];
	const el = node as FakeElement;
	return [el, ...elements(el.props.children)];
};
const buttons = (tree: unknown) =>
	elements(tree).filter((el) => el.type === "Button");
const press = (tree: unknown, key: string) =>
	(
		buttons(tree).find((b) => b.props.key === key)?.props.onPress as
			| ((e: unknown) => unknown)
			| undefined
	)?.({ surface: "terminal" });

const of = (shown: FakeCall[], noun: string) =>
	shown.filter((c) => c.noun === noun).map((c) => c.args[0]);

/** R3 (F71): each status line is followed by a redraw of every drawing. */
const redrawsAfterEachStatus = (shown: FakeCall[]) =>
	shown.every(
		(c, i) =>
			c.noun !== "ui.status" ||
			(shown[i + 1]?.noun === "ui.invalidate" &&
				shown[i + 1]?.args[0] === "ui.render"),
	);

describe("R1 /secrets", () => {
	test("R1: session.start registers secrets with the argument hint", async () => {
		const { shown } = await start({});
		expect(of(shown, "command.register")).toEqual([
			{
				name: "secrets",
				description: expect.any(String),
				argumentHint: "[set NAME | add NAME | dismiss | refresh]",
			},
		]);
	});

	const forms: [string, string][] = [
		["", ""],
		["  set   STRIPE_API_KEY ", `set ${NAME}`],
		["add STRIPE_API_KEY", `add ${NAME}`],
		["dismiss", "dismiss"],
		[" refresh", "refresh"],
		["set", ""],
	];
	for (const [args, canonical] of forms) {
		test(`R1 (F64): "${args}" passes "${canonical}" to next, and answers its own result`, async () => {
			const { api } = await start({ ".env": { text: "OTHER=1\n" } });
			const { answer, passed } = await secrets(api, args);
			expect(passed.map((e) => e.args)).toEqual([canonical]);
			expect(answer).not.toHaveProperty("ref");
			expect(JSON.stringify(answer)).not.toContain(NEXT_TEXT);
		});
	}

	test("R1: no argument opens the pane and prints nothing", async () => {
		const { api, after } = await start({});
		const { answer } = await secrets(api, "");
		expect(of(after(), "ui.open")).toEqual([
			{ id: "blindfold", title: "blindfold" },
		]);
		expect(answer).toEqual({});
	});

	test("R1, R5 step 1: add NAME shows the line to add by hand for the first active file", async () => {
		const list = ".env, .env.local";
		const { api } = await start({ ".env.local": { text: "A=1\n" } }, list);
		const { answer } = await secrets(api, `add ${NAME}`, list);
		const text = `Add ${NAME}= to .env.local in your editor, then press Refresh.`;
		expect(answer).toEqual({ text });
		expect(ui.outcome()).toEqual({
			kind: "manual",
			name: NAME,
			file: ".env.local",
		});
	});

	test("R1, R5 step 1: with no active file, add NAME names the first missing file", async () => {
		const list = ".env, .env.local";
		const { api } = await start({}, list);
		expect(await secrets(api, `add ${NAME}`, list)).toMatchObject({
			answer: { text: MANUAL },
		});
	});

	test("R1: set NAME starts the flow, which until T23 shows the same line as add", async () => {
		const { api } = await start({});
		expect(await secrets(api, `set ${NAME}`)).toMatchObject({
			answer: { text: MANUAL },
		});
		expect(ui.outcome()?.kind).toBe("manual");
	});

	test("R1: dismiss clears the request and the outcome", async () => {
		const { api } = await start({});
		requests.ask(NAME, "to charge the card");
		ui.setOutcome({ kind: "cleared", name: NAME });
		const { answer } = await secrets(api, "dismiss");
		expect(requests.current()).toBeUndefined();
		expect(ui.outcome()).toBeUndefined();
		expect(answer).toEqual({ text: "blindfold: nothing is requested now." });
	});

	test("R1: refresh loads the current list again", async () => {
		const files: Record<string, FakeFile> = { ".env": { text: "A=1\n" } };
		const { api } = await start(files);
		files[".env"] = { text: `A=1\n${NAME}=${fake.secret(24)}\n` };
		const { answer } = await secrets(api, "refresh");
		const [env] = enrollment.status().files;
		expect(
			env?.state.kind === "active" && env.state.names.map((n) => n.name),
		).toEqual(["A", NAME]);
		expect(answer).toEqual({ text: "blindfold read the env files again." });
	});

	test("R1 (Q39, F74): an extra argument is refused with the toast and the same text, and next gets no argument", async () => {
		const value = fake.secret(24);
		const { api, after } = await start({});
		const { answer, passed } = await secrets(api, `set ${NAME} ${value}`);
		expect(REFUSED_COMMAND).toBe(
			"blindfold: /secrets takes a name, never a value.",
		);
		expect(answer).toEqual({ text: REFUSED_COMMAND });
		expect(of(after(), "ui.toast")).toEqual([REFUSED_COMMAND]);
		expect(passed).toEqual([expect.objectContaining({ args: "" })]);
	});

	test("R1 (F64): a name that holds a known value is refused", async () => {
		const value = `V${fake.secret(23)}`;
		const { api } = await start({ ".env": { text: `API_KEY=${value}\n` } });
		const { answer, passed } = await secrets(api, `set ${value}`);
		expect(answer).toEqual({ text: REFUSED_COMMAND });
		expect(passed.map((e) => e.args)).toEqual([""]);
		expect(ui.outcome()).toBeUndefined();
	});

	test("R1 (F64): a hook that failed before next passes no argument from its catch", async () => {
		const value = fake.secret(24);
		const handler = hooks().get(`${COMMAND}.catch`);
		const { api } = fakeApi({});
		for (const called of [false, true]) {
			const passed: { args: string }[] = [];
			const next = Object.assign(
				async (e: unknown) => {
					passed.push(e as { args: string });
					return { text: NEXT_TEXT };
				},
				{ ...budget, called },
			);
			const answer = await handler?.(
				api,
				{ command: "secrets", args: `set ${NAME} ${value}` },
				next,
			);
			expect(passed.map((e) => e.args)).toEqual(called ? [] : [""]);
			expect(answer).toEqual({
				text: "blindfold: /secrets failed. Run it again.",
			});
		}
	});
});

describe("R2 band", () => {
	test("R2: with no open request the band is the tree from next, unchanged", async () => {
		const { api } = await start({});
		expect(await band(api)).toBe(OTHER);
	});

	test("R2 (F72): while a survey holds the band, it is the tree from next, unchanged", async () => {
		const { api } = await start({});
		requests.ask(NAME, "to charge the card");
		expect(await band(api, true)).toBe(OTHER);
	});

	test("R2, R6: a pending request adds 1 line after the other mods' tree: the reason as Text, then 1 Enter it, 2 Add it myself, 3 Dismiss", async () => {
		const { api } = await start({});
		requests.ask(NAME, "to charge the card.");
		const tree = await band(api);
		const [kept, line] = tree.props.children as FakeElement[];
		expect(kept).toBe(OTHER);
		expect(elements(line).filter((el) => el.type === "Text")).toEqual([
			{
				type: "Text",
				props: { children: `Claude asks for ${NAME}: to charge the card.` },
			},
		]);
		expect(
			buttons(line).map((b) => [b.props.key, b.props.hotkey, b.props.label]),
		).toEqual([
			["blindfold-enter", "1", "Enter it"],
			["blindfold-add", "2", "Add it myself"],
			["blindfold-dismiss", "3", "Dismiss"],
		]);
	});

	test("R2, R6: a ready request reads as set, with 4 Continue and 3 Dismiss", async () => {
		const { api } = await start({
			".env": { text: `${NAME}=${fake.secret(24)}\n` },
		});
		requests.ask(NAME, "");
		requests.sync(enrollment.status());
		const tree = await band(api);
		const texts = elements(tree).filter((el) => el.type === "Text");
		expect(texts.at(-1)?.props.children).toBe(
			`Claude asks for ${NAME}. ${NAME} is set.`,
		);
		expect(buttons(tree).map((b) => [b.props.key, b.props.hotkey])).toEqual([
			["blindfold-continue", "4"],
			["blindfold-dismiss", "3"],
		]);
	});

	test("R2, R5: Continue submits from the button handler, and the request is consumed", async () => {
		const { api, after } = await start({
			".env": { text: `${NAME}=${fake.secret(24)}\n` },
		});
		requests.ask(NAME, "r");
		requests.sync(enrollment.status());
		await press(await band(api), "blindfold-continue");
		expect(of(after(), "prompt.submit")).toEqual([
			{ text: `${NAME} is now set. Continue the task that needed it.` },
		]);
		expect(of(after(), "ui.toast")).not.toContain(DROPPED_TOAST);
		expect(requests.current()).toBeUndefined();
	});

	test("R2: Dismiss clears the request and the outcome", async () => {
		const { api } = await start({});
		requests.ask(NAME, "r");
		ui.setOutcome({ kind: "cleared", name: NAME });
		await press(await band(api), "blindfold-dismiss");
		expect(requests.current()).toBeUndefined();
		expect(ui.outcome()).toBeUndefined();
	});

	for (const key of ["blindfold-enter", "blindfold-add"]) {
		test(`R2: ${key} sets the manual outcome and toasts its line`, async () => {
			const { api, after } = await start({});
			requests.ask(NAME, "r");
			await press(await band(api), key);
			expect(ui.outcome()).toEqual({
				kind: "manual",
				name: NAME,
				file: ".env",
			});
			expect(of(after(), "ui.toast")).toContain(MANUAL);
		});
	}

	test("R2: a toast when a request opens, once per request", async () => {
		const { after } = await start({});
		requests.ask(NAME, "r");
		requests.sync(enrollment.status());
		requests.ask(NAME, "r");
		expect(of(after(), "ui.toast")).toEqual([OPEN_TOAST, OPEN_TOAST]);
	});
});

describe("R3 status line and redraw (F71)", () => {
	test("R3, F71: the load at session.start sets the status line, then redraws", async () => {
		const { shown } = await start({ ".env": { readFails: true, text: "" } });
		const lines = of(shown, "ui.status");
		expect(lines.at(-1)).toBe(
			"blindfold: degraded, .env could not be read. New values may not be hidden.",
		);
		expect(redrawsAfterEachStatus(shown)).toBe(true);
	});

	test("R3, F71: ask, clear, a sync after a load, consume, and an outcome each set the line, then redraw", async () => {
		const files: Record<string, FakeFile> = { ".env": { text: "A=1\n" } };
		const { api, after } = await start(files);
		const last = () => of(after(), "ui.status").at(-1);
		const requested = `blindfold: ${NAME} requested, run /secrets`;

		requests.ask(NAME, "r");
		expect(last()).toBe(requested);
		requests.clear();
		expect(last()).toBeUndefined();

		requests.ask(NAME, "r");
		ui.setOutcome({
			kind: "not-saved",
			name: NAME,
			step: "git",
			reason: "tracked",
		});
		expect(last()).toBe(`blindfold: ${NAME} not saved, run /secrets`);
		ui.setOutcome(undefined);
		expect(last()).toBe(requested);

		files[".env"] = { text: `${NAME}=${fake.secret(24)}\n` };
		const count = after().length;
		await secrets(api, "refresh");
		expect(requests.current()?.state).toBe("ready");
		expect(after().length).toBeGreaterThan(count);

		await press(await band(api), "blindfold-continue");
		expect(requests.current()).toBeUndefined();
		expect(last()).toBeUndefined();
		expect(redrawsAfterEachStatus(after())).toBe(true);
	});

	test("R3 (Q40): through the wiring, a degraded shield shows before an open request", async () => {
		const { after } = await start({ ".env": { readFails: true, text: "" } });
		requests.ask(NAME, "r");
		expect(of(after(), "ui.status")).toEqual([
			"blindfold: degraded, .env could not be read. New values may not be hidden.",
		]);
	});

	test("request R4: a /secrets prompt keeps the request; another prompt clears it", async () => {
		const { api } = await start({});
		requests.ask(NAME, "r");
		const prompt = hooks().get("prompt.submit");
		const next = Object.assign(async (e: unknown) => e, budget);
		await prompt?.(
			api,
			{ text: "/secrets", command: { name: "secrets", args: "" } },
			next,
		);
		expect(requests.current()?.name).toBe(NAME);
		await prompt?.(api, { text: "hello" }, next);
		expect(requests.current()).toBeUndefined();
	});
});

describe("R7 no value (F76)", () => {
	/** Every command form, a refusal with the value, and each band state, over `.env` holding `value`. Returns all the user could see. */
	const everything = async (value: string) => {
		const { api, shown } = await start({
			".env": { text: `${NAME}=\nAPI_KEY=${value}\n` },
		});
		const answers: unknown[] = [];
		requests.ask(NAME, "to charge the card");
		answers.push(await band(api));
		for (const args of [
			"",
			`set ${NAME}`,
			`add ${NAME}`,
			"refresh",
			`set ${NAME} ${value}`,
			`set ${value}`,
			value,
		]) {
			answers.push((await secrets(api, args)).answer);
		}
		answers.push(await band(api));
		await press(await band(api), "blindfold-add");
		answers.push((await secrets(api, "dismiss")).answer);
		return JSON.stringify([answers, shown]);
	};

	test("R7: no tree, toast, status line, or command answer holds a value, and 2 values of different lengths show the same", async () => {
		const short = `V${fake.secret(19)}`;
		const long = `V${fake.secret(39)}`;
		const a = await everything(short);
		const b = await everything(long);
		expect(a).not.toContain(short);
		expect(b).not.toContain(long);
		expect(a).toBe(b);
	});
});
