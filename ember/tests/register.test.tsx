import type {
	ModelForkResult,
	On,
	RenderSurface,
	TurnStepInput,
	TurnStepResult,
	TurnUsage,
} from "claude-code";
import type { Engine, MockClock } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";

import { decodeRec, REFRESH_PROMPT } from "../hooks/refresh";
import type { Sums } from "../hooks/stats";
import { savedPct } from "../hooks/stats";
import { flat, layout } from "./pane-text";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type World = {
	clock: MockClock;
	store: Map<string, unknown>;
	statuses: (string | undefined)[];
	logs: string[];
	toasts: string[];
	env: Record<string, string>;
	settings: Record<string, unknown>;
	debug: string[];
	reply: { usage: TurnUsage | null; toolNames: string[]; holdMs: number };
	id: string;
	/** Each `store.set` as it reached the store: the key and the `n` of its first bucket. */
	sets: string[];
	/** How long the next `store.set` waits before it answers. */
	setHoldMs: number;
	/** How long a `store.get` of another session's key waits before it answers. */
	otherGetHoldMs: number;
	isStarted: boolean;
	surfaces: RenderSurface[];
	opens: unknown[];
	closes: unknown[];
	/** The prompt of each `$.model.fork`, in order. */
	forks: string[];
	/** What the next forks answer; `throw` rejects the call. */
	fork: ModelForkResult | "throw";
	forkHoldMs: number;
	/** The agent ids of the steps a fork raises at `turn.step` while it runs (null: no agent id). */
	forkSteps: (string | null)[];
	/** Lets a `/compact` through; by default the core mock blocks it. */
	isManualAllowed: boolean;
	/** How long the next compaction runs before it answers. */
	compactHoldMs: number;
	/** The transcript file's text at any path; undefined: no such file. */
	transcript?: string;
	/** The file size `fs.stat` answers; absent, the transcript's length. */
	transcriptSize?: number;
	/** Each `process.run` argv, in order. */
	runs: (readonly string[])[];
	/** How long each next `process.run` waits before it answers, first first. */
	runHolds: number[];
	/** `deny`: the call is refused; `exit`: tail exits 1. */
	runFails?: "deny" | "exit";
	failStat: boolean;
	/** Each `fs.read` path, in order. */
	fsReads: string[];
	engine?: Engine;
};

type Options = {
	entries?: Record<string, unknown>;
	failStoreSet?: boolean;
	failStoreKeys?: boolean;
	failCommandRegister?: boolean;
	failEnv?: boolean;
	failSettings?: boolean;
	failToast?: boolean;
	env?: Record<string, string>;
	settings?: Record<string, unknown>;
	below?: string;
	surfaces?: RenderSurface[];
};

function world(on: On, options: Options = {}): World {
	const clock = mock.clock(on, { now: T0 });
	const store = new Map(Object.entries(options.entries ?? {}));
	const w: World = {
		clock,
		store,
		statuses: [],
		logs: [],
		toasts: [],
		env: options.env ?? {},
		settings: options.settings ?? {},
		debug: [],
		reply: { usage: null, toolNames: [], holdMs: 0 },
		id: "S1",
		sets: [],
		setHoldMs: 0,
		otherGetHoldMs: 0,
		isStarted: false,
		surfaces: options.surfaces ?? ["vscode"],
		opens: [],
		closes: [],
		forks: [],
		fork: forkHit(),
		forkHoldMs: 0,
		forkSteps: [],
		isManualAllowed: false,
		compactHoldMs: 0,
		runs: [],
		runHolds: [],
		failStat: false,
		fsReads: [],
	};

	on("process.run", async (_, e) => {
		w.runs.push(e.argv);
		const text = w.transcript;
		const holdMs = w.runHolds.shift() ?? 0;
		if (holdMs > 0) await clock.sleep(holdMs);
		if (w.runFails === "deny") return { deny: "not permitted" };
		const bytes = Number(e.argv[2]);
		const isRead = text !== undefined && w.runFails !== "exit";
		return {
			value: {
				exitCode: isRead ? 0 : 1,
				stdout: isRead ? text.slice(-bytes) : "",
				stderr: "",
				isStdoutTruncated: false,
				isStderrTruncated: false,
			},
		};
	});
	on("fs.stat", () =>
		w.failStat || w.transcript === undefined
			? { deny: "ENOENT" }
			: {
					value: {
						kind: "file",
						size: w.transcriptSize ?? w.transcript.length,
						mtimeMs: 0,
						isLink: false,
					},
				},
	);
	on("fs.read", (_, e) => {
		w.fsReads.push(e.path);
		return w.transcript === undefined
			? { deny: "ENOENT" }
			: { value: w.transcript };
	});
	on("classic.Stop", () => ({ additionalContext: ["from core"] }));

	on("store.get", async (_, e) => {
		if (w.otherGetHoldMs > 0 && e.key !== `session:${w.id}`)
			await clock.sleep(w.otherGetHoldMs);
		return { value: store.get(e.key) };
	});
	on("store.set", async (_, e) => {
		if (options.failStoreSet === true) return { deny: "disk full" };
		const holdMs = w.setHoldMs;
		w.setHoldMs = 0;
		if (holdMs > 0) await clock.sleep(holdMs);
		const value = JSON.parse(JSON.stringify(e.value)) as Stored;
		w.sets.push(
			`${e.key} ${Object.values(value.buckets ?? {}).reduce((n, b) => n + b.n, 0)}`,
		);
		store.set(e.key, value);
		return { value: undefined };
	});
	on("store.delete", (_, e) => {
		store.delete(e.key);
		return { value: undefined };
	});
	on("store.keys", () =>
		options.failStoreKeys === true
			? { deny: "unreadable" }
			: { value: [...store.keys()] },
	);
	on("session.id", () => ({ value: w.id }));
	on("session.start", (_, e) => {
		w.isStarted = true;
		return { cwd: e.cwd };
	});
	on("classic.SessionStart", () => ({ additionalContext: ["from core"] }));
	on("session.compact", async (_, e) => {
		const holdMs = w.compactHoldMs;
		w.compactHoldMs = 0;
		if (holdMs > 0) await clock.sleep(holdMs);
		return e.trigger === "manual" && !w.isManualAllowed
			? { skip: "blocked" }
			: { messages: e.messages };
	});
	on("command.register", (_, e) =>
		options.failCommandRegister === true
			? { deny: "taken" }
			: { value: { command: e.name } },
	);
	on("env.get", (_, e) =>
		options.failEnv === true
			? { deny: "unreadable" }
			: { value: w.env[e.name] },
	);
	on("settings.read", () =>
		options.failSettings === true
			? { deny: "unreadable" }
			: { value: w.settings },
	);
	on("ui.toast", (_, e) => {
		if (options.failToast === true) return { deny: "no toasts" };
		w.toasts.push(e.text);
		return { value: undefined };
	});
	on("ui.status", (_, e) => {
		w.statuses.push(e.text);
		return { value: undefined };
	});
	on("ui.log", (_, e) => {
		(e.to === "debug" ? w.debug : w.logs).push(e.text);
		return { value: undefined };
	});
	on("ui.open", (_, e) => {
		w.opens.push(e);
		return { value: { isPlaced: true } };
	});
	on("ui.close", (_, e) => {
		w.closes.push(e);
		return { value: undefined };
	});
	on("session.surfaces", () => ({ value: w.surfaces }));
	on("model.fork", async (_, e) => {
		w.forks.push(e.prompt);
		if (w.forkHoldMs > 0) await clock.sleep(w.forkHoldMs);
		for (const [i, agentId] of w.forkSteps.entries()) {
			if (w.engine !== undefined)
				await drain(w.engine, {
					turnId: `fork-${w.forks.length}`,
					index: i,
					model: "opus",
					messageCount: 1,
					...(agentId === null ? {} : { agentId }),
				});
		}
		if (w.fork === "throw") throw new Error("blocked model");
		return { value: w.fork };
	});
	on("turn.start", (_, e) => ({ turnId: e.turnId }));
	on("turn.complete", () => ({ text: "" }));
	on("session.end", (_, e) => ({ sessionId: e.sessionId }));
	on("ui.render", ($, e) => {
		const { Box, Text } = $.ui.resolve(e);
		return options.below === undefined ? <Box /> : <Text>{options.below}</Text>;
	});
	on("turn.step", async function* (_, e) {
		if (w.reply.holdMs > 0) await clock.sleep(w.reply.holdMs);
		const result: TurnStepResult = {
			turnId: e.turnId,
			index: e.index,
			answer: "",
			toolUses: w.reply.toolNames.map((name) => ({ name, input: {} })),
			stopReason: "end_turn",
			usage: w.reply.usage,
		};
		return result;
	});
	return w;
}

const forkHit = (read = 141_600, creation = 0): ModelForkResult => ({
	isAnswered: true,
	text: "ok",
	usage: {
		input_tokens: 12,
		output_tokens: 2,
		cache_read_input_tokens: read,
		cache_creation_input_tokens: creation,
	},
});

const usage = (read: number, total = 100, model = "opus"): TurnUsage => ({
	input_tokens: total - read,
	output_tokens: 5,
	cache_read_input_tokens: read,
	cache_creation_input_tokens: 0,
	model,
});

async function drain($: Engine, input: TurnStepInput): Promise<TurnStepResult> {
	const stream = $.turn.step(input);
	let item = await stream.next();
	while (item.done !== true) item = await stream.next();
	return item.value;
}

async function step(
	$: Engine,
	w: World,
	input: Partial<TurnStepInput>,
	reply: Partial<World["reply"]> = {},
): Promise<TurnStepResult> {
	w.reply = { usage: usage(90), toolNames: [], holdMs: 0, ...reply };
	return drain($, {
		turnId: "t",
		index: 1,
		model: "opus",
		messageCount: 1,
		...input,
	});
}

const start = async ($: Engine, w: World) => {
	w.engine = $;
	await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
	await w.clock.settle();
};

const SUMMARY = [{ role: "user" as const, text: "summary", toolUses: [] }];

const runEmber = ($: Engine) =>
	$.command.run({
		command: "ember",
		args: "",
		origin: { kind: "composer" },
		presentation: { isFullscreen: false, columns: 80 },
	});

type Stored = {
	buckets: Record<string, { n: number }>;
	bands: Record<string, { n: number }>;
	compactions: number;
	modelSwitches: number;
	warmMaxMs?: number;
	coldMinMs?: number;
	updatedAt: number;
	live?: unknown;
	sums: Sums;
};

const PANE = {
	plugin: "ember",
	component: "Pane",
	requestId: "ember",
	props: {
		title: "ember",
		isFocused: true,
		bodyColumns: 100,
		placement: "dock",
		scroll: { offset: 0, bodyRows: 30 },
		view: {},
	},
} as const;

const mountPane = (
	$: Engine,
	surface: "terminal" | "desktop" = "terminal",
	requestId = "ember",
	bodyColumns = 100,
) =>
	$.ui.mount({
		...PANE,
		props: { ...PANE.props, bodyColumns },
		requestId,
		surface,
		viewport: { columns: bodyColumns + 25, rows: 40 },
	});

/** The pane's TTL row and its report as text, read from one drawing. */
async function paneOf($: Engine, surface: "terminal" | "desktop" = "terminal") {
	const ui = await mountPane($, surface);
	const text = flat(await ui.drawn());
	await ui.unmount();
	return { ttl: text.split("\n").find((l) => l.startsWith("TTL ")), text };
}

const stored = (w: World, id = "S1") => w.store.get(`session:${id}`) as Stored;

test("every gap type lands in its bucket", async ($, on) => {
	const w = world(on);
	await start($, w);

	await step($, w, { turnId: "t1", index: 0 }, { toolNames: ["Read"] });
	await w.clock.advance(1000);
	await step(
		$,
		w,
		{ turnId: "t1", index: 1 },
		{ toolNames: ["AskUserQuestion"] },
	);
	await w.clock.advance(40_000);
	await step($, w, { turnId: "t1", index: 2 }, { toolNames: ["Agent"] });
	await step($, w, { turnId: "t1", index: 0, agentId: "a1" });
	await step($, w, { turnId: "t1", index: 1, agentId: "a1" }, { usage: null });
	await step($, w, { turnId: "t1", index: 3 }, { toolNames: [] });
	await w.clock.advance(3 * MIN);
	await step($, w, { turnId: "t2", index: 0 }, { usage: usage(97) });
	await $.session.compact({ trigger: "auto", messages: SUMMARY });
	await $.session.compact({
		trigger: "auto",
		agentId: "a1",
		messages: SUMMARY,
	});
	await $.session.compact({ trigger: "manual", messages: SUMMARY });
	await $.session.compact({ trigger: "precompute", messages: SUMMARY });
	await w.clock.settle();
	expect(stored(w).compactions).toBe(1);
	expect(stored(w).updatedAt).toBe(w.clock.now());
	await w.clock.advance(MIN);
	await step(
		$,
		w,
		{ turnId: "t3", index: 0 },
		{ usage: usage(0, 100, "sonnet") },
	);
	await step(
		$,
		w,
		{ turnId: "t3", index: 1 },
		{ usage: usage(80, 100, "haiku") },
	);
	await w.clock.settle();

	const s = stored(w);
	const counts = Object.fromEntries(
		Object.entries(s.buckets).map(([k, v]) => [k, v.n]),
	);
	expect(counts).toEqual({
		first: 1,
		user: 1,
		ask: 1,
		subagent: 1,
		tool: 1,
		compact: 1,
		"model-switch": 1,
		agent: 1,
	});
	expect(s.bands["1-5m"]?.n).toBe(1);
	expect(s.warmMaxMs).toBe(3 * MIN);
	expect(s.coldMinMs).toBeUndefined();
	expect(s.compactions).toBe(1);
	expect(s.modelSwitches).toBe(2);
});

test(
	"the status line follows the main thread",
	{ options: { ttlMinutes: 5 } },
	async ($, on) => {
		const w = world(on);
		await start($, w);
		await w.clock.advance(1000);
		expect(w.statuses).toEqual([undefined]);

		await step($, w, { index: 0 }, { usage: usage(97) });
		await w.clock.advance(1000);
		expect(w.statuses.at(-1)).toBe(
			"idle 1s · last hit 97% · 97 cached · cold in ~4m59s",
		);

		const inFlight = step(
			$,
			w,
			{ index: 0 },
			{ usage: usage(50), holdMs: 5000 },
		);
		await w.clock.advance(1000);
		expect(w.statuses.at(-1)).toBe("session hit 97%");
		const shown = w.statuses.length;
		await w.clock.advance(1000);
		expect(w.statuses.length).toBe(shown);
		await w.clock.advance(3000);
		await inFlight;

		await w.clock.advance(5 * MIN);
		expect(w.statuses.at(-1)).toBe(
			"idle 5m · last hit 50% · 50 cached · likely cold",
		);
	},
);

test("a subagent request leaves the main status idle", async ($, on) => {
	const w = world(on);
	await start($, w);
	await step($, w, { index: 0 });
	const sub = step($, w, { index: 0, agentId: "a1" }, { holdMs: 3000 });
	await w.clock.advance(2000);
	expect(w.statuses.at(-1)).toBe(
		"idle 2s · last hit 90% · 90 cached · cold in ~59m58s",
	);
	await w.clock.advance(1000);
	await sub;
});

test(
	"the TTL option sets the countdown",
	{ options: { ttlMinutes: 2 } },
	async ($, on) => {
		const w = world(on);
		await start($, w);
		await step($, w, { index: 0 });
		await w.clock.advance(MIN);
		expect(w.statuses.at(-1)).toBe(
			"idle 1m · last hit 90% · 90 cached · cold in ~1m",
		);
	},
);

test("/ember opens the ember pane, returns no text and logs no report", async ($, on) => {
	const w = world(on);
	await start($, w);
	expect(await runEmber($)).toEqual({});
	expect(w.opens).toEqual([
		{
			id: "ember",
			title: "ember",
			focus: true,
			closeOnEscape: true,
			rows: 26,
		},
	]);
	expect(w.logs).toEqual([]);
});

const OLD = {
	updatedAt: T0 - DAY,
	buckets: { user: { n: 2, read: 20, total: 200 } },
	bands: { ">60m": 2 },
	coldMinMs: 90 * MIN,
	compactions: 3,
};

for (const surface of ["terminal", "desktop"] as const) {
	test(`the pane shows the TTL and this session's table, no tabs with one session (${surface})`, async ($, on) => {
		const w = world(on);
		await start($, w);
		await step($, w, { index: 0 });
		await runEmber($);
		await w.clock.settle();
		const ui = await mountPane($, surface);
		const md = flat(await ui.drawn());
		expect(md).toContain("\nTTL 60m (ttlMinutes option)\n");
		expect(md).toContain("Gap type Requests Hit");
		expect(md).toContain("\nfirst 1 90%");
		expect(md).not.toContain("\nuser ");
		expect(await ui.find({ key: "tab-all" })).toBeUndefined();
		expect(await ui.find({ key: "tab-session" })).toBeUndefined();
		await ui.unmount();
	});

	test(`with a stored second session, tab 2 shows the merged counts (${surface})`, async ($, on) => {
		const w = world(on, { entries: { "session:OLD": OLD } });
		await start($, w);
		await step($, w, { index: 0 });
		await w.clock.advance(2 * MIN);
		await step($, w, { turnId: "t2", index: 0 }, { usage: usage(98) });
		await runEmber($);
		await w.clock.settle();

		const ui = await mountPane($, surface);
		expect(await ui.find({ key: "tab-session" })).toBeDefined();
		expect(await ui.find({ key: "tab-all" })).toBeDefined();
		expect(flat(await ui.drawn())).toContain("\nuser 1 98%");

		await ui.press({ key: "tab-all" });
		await w.clock.settle();
		const all = flat(await ui.drawn());
		expect(all).toContain("\nfirst 1 90%");
		expect(all).toContain("\nuser 3 39%");
		expect(all).toContain("Observed TTL warm up to 2m · cold from 1h30m");
		expect(all).toContain("Compactions 3\nModel switches 0");
		// OLD stored its bands as bare counts: requests counted, no hit ratio.
		expect(all).toContain("\n1-5m 1 98%\n>60m 2 –");

		await ui.press({ key: "tab-session" });
		await w.clock.settle();
		expect(flat(await ui.drawn())).toContain("\nuser 1 98%");
		expect(w.debug).toEqual([]);
		await ui.unmount();
	});
}

test("another pane id goes to the engine", async ($, on) => {
	const w = world(on, { below: "engine pane" });
	await start($, w);
	const ui = await mountPane($, "terminal", "other");
	expect(await ui.find({ type: "Text", text: /engine pane/ })).toBeDefined();
	expect(await ui.find({ key: "close" })).toBeUndefined();
	await ui.unmount();
});

describe("the pane chrome and layout", () => {
	/** This session (90% first, 98% user) and OLD's stored one, the pane open. */
	const seeded = async ($: Engine, on: On) => {
		const w = world(on, { entries: { "session:OLD": OLD } });
		await start($, w);
		await step($, w, { index: 0 });
		await w.clock.advance(2 * MIN);
		await step($, w, { turnId: "t2", index: 0 }, { usage: usage(98) });
		await runEmber($);
		await w.clock.settle();
		return w;
	};

	test("a header row holds the bold title and the tabs at the left, Close at the right", async ($, on) => {
		await seeded($, on);
		const ui = await mountPane($);
		const [head] = layout(await ui.drawn(), 100);
		expect(head?.startsWith("ember  1: This session  2: All sessions ")).toBe(
			true,
		);
		expect(head?.endsWith(" q: Close")).toBe(true);
		expect(head).toHaveLength(100);
		expect(
			(await ui.find({ type: "Text", text: "ember" }))?.props,
		).toMatchObject({ weight: "bold", color: "claude" });
		expect((await ui.find({ key: "close" }))?.props).toMatchObject({
			label: "Close",
			hotkey: "q",
			plain: true,
			role: "dismiss",
		});
		await ui.unmount();
	});

	for (const id of ["ember", "ember-refresh"])
		test(`Close closes the ${id} pane`, async ($, on) => {
			const w = await seeded($, on);
			const ui = await mountPane($, "terminal", id);
			expect(flat(await ui.drawn()).split("\n")[0]).toBe(
				`${id === "ember" ? "ember" : "ember refresh"}${id === "ember" ? " 1: This session 2: All sessions" : ""} q: Close`,
			);
			await ui.press({ key: "close" });
			expect(w.closes).toEqual([{ id, origin: { kind: "plugin" } }]);
			expect(w.debug).toEqual([]);
			await ui.unmount();
		});

	test("a wide pane draws the status and both hit tables side by side; a narrow one wraps them", async ($, on) => {
		await seeded($, on);
		const titles = ["Status", "Cache hit by gap type", "Cache hit by user gap"];
		const wide = await mountPane($, "terminal", "ember", 180);
		const wideLines = layout(await wide.drawn(), 180);
		expect(wideLines.some((l) => titles.every((t) => l.includes(t)))).toBe(
			true,
		);
		expect(
			(await wide.findAll({ type: "Box" })).filter(
				(b) => b.props.flexWrap === "wrap",
			),
		).toHaveLength(1);
		await wide.unmount();

		const narrow = await mountPane($, "terminal", "ember", 70);
		const lines = layout(await narrow.drawn(), 70);
		expect(lines.filter((l) => l.length > 70)).toEqual([]);
		expect(lines.find((l) => l.includes("Status"))?.trim()).toBe("Status");
		expect(
			lines.some(
				(l) =>
					l.includes("Cache hit by gap type") &&
					l.includes("Cache hit by user gap"),
			),
		).toBe(true);
		await narrow.unmount();
	});

	test("a hit rate is green from 80% and red below 50%; the request counts stay plain", async ($, on) => {
		await seeded($, on);
		const ui = await mountPane($);
		const colorOf = async (text: string) =>
			(await ui.findAll({ type: "Text", text }))
				.filter((t) => t.text === text)
				.map((t) => t.props.color);
		expect(await colorOf("90%")).toEqual(["success"]);
		expect(await colorOf("98%")).toEqual(["success", "success"]);
		expect(await colorOf("1")).toEqual([undefined, undefined, undefined]);
		await ui.press({ key: "tab-all" });
		expect(await colorOf("39%")).toEqual(["error"]);
		await ui.unmount();
	});

	test("the status section shows the TTL and the observed bounds as label/value rows", async ($, on) => {
		await seeded($, on);
		const ui = await mountPane($);
		await ui.press({ key: "tab-all" });
		const text = flat(await ui.drawn());
		expect(text).toContain(
			"Status\nTTL 60m (ttlMinutes option)\nObserved TTL warm up to 2m · cold from 1h30m\nCompactions 3\nModel switches 0",
		);
		for (const label of ["TTL", "Observed TTL", "Compactions"])
			expect(
				(await ui.find({ type: "Text", text: label }))?.props,
			).toMatchObject({ dimColor: true });
		// Only the status rows draw these values bold; a table's request count is plain.
		for (const value of ["60m", "2m", "1h30m", "3"])
			expect(
				(await ui.findAll({ type: "Text", text: value })).some(
					(t) => t.text === value && t.props.weight === "bold",
				),
			).toBe(true);
		await ui.unmount();
	});
});

test("session.start prunes stale and unreadable session keys", async ($, on) => {
	const w = world(on, {
		entries: {
			"session:OLD": { updatedAt: T0 - 31 * DAY },
			"session:NEW": { updatedAt: T0 - 29 * DAY },
			"session:BAD": "junk",
			"session:S1": { updatedAt: T0 - 40 * DAY, compactions: 4 },
			other: { updatedAt: 0 },
		},
	});
	await start($, w);
	expect([...w.store.keys()].sort()).toEqual([
		"other",
		"session:NEW",
		"session:S1",
	]);

	await step($, w, { index: 0 });
	await w.clock.settle();
	expect(stored(w).compactions).toBe(4);
});

test("session.start keeps at most 500 session keys, the newest and its own", async ($, on) => {
	const entries: Record<string, unknown> = {
		"session:S1": { updatedAt: T0 - 20 * DAY },
	};
	for (let i = 0; i < 502; i++)
		entries[`session:K${i}`] = { updatedAt: T0 - i };
	const w = world(on, { entries });
	await start($, w);
	const keys = [...w.store.keys()];
	expect(keys.length).toBe(500);
	expect(keys).toContain("session:S1");
	expect(keys).toContain("session:K498");
	expect(keys).not.toContain("session:K499");
});

test("session.start waits for no store call but its own session read", async ($, on) => {
	const w = world(on, {
		entries: { "session:OLD": { updatedAt: T0 - 31 * DAY } },
	});
	w.otherGetHoldMs = 12_000;
	let isDone = false;
	const started = $.session
		.start({ cwd: "/", surface: "terminal", isInteractive: true })
		.then(() => (isDone = true));
	await w.clock.settle();
	expect(isDone).toBe(true);
	expect(w.isStarted).toBe(true);
	expect(w.store.has("session:OLD")).toBe(true);
	await w.clock.advance(12_000);
	expect(w.store.has("session:OLD")).toBe(false);
	await started;
});

test("a slow store write does not hold the step, and writes coalesce to the latest", async ($, on) => {
	const w = world(on);
	await start($, w);
	w.setHoldMs = 12_000;
	await step($, w, { index: 0, agentId: "a1" });
	await step($, w, { index: 1, agentId: "a1" });
	await step($, w, { index: 2, agentId: "a1" });
	expect(w.sets).toEqual([]);
	await w.clock.advance(12_000);
	expect(w.sets).toEqual(["session:S1 1", "session:S1 3"]);
	expect(stored(w).buckets.agent?.n).toBe(3);
});

test("a denied store write leaves the turn untouched and logs to debug", async ($, on) => {
	const w = world(on, { failStoreSet: true });
	await start($, w);
	const result = await step(
		$,
		w,
		{ turnId: "t9", index: 0 },
		{ toolNames: ["Bash"] },
	);
	expect(result).toEqual({
		turnId: "t9",
		index: 0,
		answer: "",
		toolUses: [{ name: "Bash", input: {} }],
		stopReason: "end_turn",
		usage: usage(90),
	});
	await w.clock.advance(1000);
	expect(w.statuses.at(-1)).toBe(
		"idle 1s · last hit 90% · 90 cached · cold in ~59m59s",
	);
	expect(w.debug).toEqual(["ember: could not save its stats"]);
	expect(w.logs).toEqual([]);
});

test("the countdown runs from the start of the last request", async ($, on) => {
	const w = world(on);
	await start($, w);
	const long = step($, w, { index: 0 }, { holdMs: 2 * MIN });
	await w.clock.advance(2 * MIN);
	await long;
	await w.clock.advance(10_000);
	expect(w.statuses.at(-1)).toBe(
		"idle 10s · last hit 90% · 90 cached · cold in ~57m50s",
	);
});

test("a step with no usage leaves the status countdown where it was", async ($, on) => {
	const w = world(on);
	await start($, w);
	await step($, w, { index: 0 });
	await w.clock.advance(MIN);
	await step($, w, { index: 1 }, { usage: null, toolNames: ["Bash"] });
	await w.clock.advance(1000);
	expect(w.statuses.at(-1)).toBe(
		"idle 1m01s · last hit 90% · 90 cached · cold in ~58m59s",
	);
});

for (const source of ["clear", "resume", "fork"] as const) {
	test(`a ${source} rebinds the session key and starts the main thread over`, async ($, on) => {
		const w = world(on, {
			entries: {
				"session:S2": {
					updatedAt: T0 - DAY,
					buckets: { user: { n: 4, read: 0, total: 4 } },
				},
			},
		});
		await start($, w);
		await step($, w, { index: 0 });
		await w.clock.advance(1000);
		w.id = "S2";
		expect(await $.classic.SessionStart({ source })).toEqual({
			additionalContext: ["from core"],
		});
		await w.clock.advance(1000);
		expect(w.statuses.at(-1)).toBeUndefined();

		await step($, w, { turnId: "t2", index: 0 });
		await w.clock.settle();
		expect(stored(w, "S1").buckets.first?.n).toBe(1);
		expect(stored(w, "S1").buckets.user?.n).toBe(0);
		expect(stored(w, "S2").buckets.first?.n).toBe(1);
		expect(stored(w, "S2").buckets.user?.n).toBe(4);
	});
}

test("startup and compact session starts keep the session key", async ($, on) => {
	const w = world(on);
	await start($, w);
	await step($, w, { index: 0 });
	w.id = "S2";
	await $.classic.SessionStart({ source: "compact" });
	await $.classic.SessionStart({ source: "startup" });
	await step($, w, { turnId: "t2", index: 0 });
	await w.clock.settle();
	expect(stored(w).buckets.user?.n).toBe(1);
	expect(w.store.has("session:S2")).toBe(false);
});

test("a request in flight across a session change writes into neither session", async ($, on) => {
	const w = world(on);
	await start($, w);
	const sub = step($, w, { index: 0, agentId: "a1" }, { holdMs: 5000 });
	await w.clock.advance(1000);
	w.id = "S2";
	await $.classic.SessionStart({ source: "clear" });
	await w.clock.advance(4000);
	await sub;
	await w.clock.settle();
	expect(w.store.has("session:S1")).toBe(false);
	expect(w.store.has("session:S2")).toBe(false);
	expect((await paneOf($)).text).toContain(
		"Cache hit by gap type\nNo requests yet.",
	);
});

test("a write still running for the old session is not lost on a session change", async ($, on) => {
	const w = world(on);
	await start($, w);
	w.setHoldMs = 5000;
	await step($, w, { index: 0 });
	await step($, w, { index: 1 });
	w.id = "S2";
	await $.classic.SessionStart({ source: "clear" });
	await step($, w, { turnId: "t2", index: 0 });
	await w.clock.advance(5000);
	expect(w.sets).toEqual(["session:S1 1", "session:S1 2", "session:S2 1"]);
});

test("a taken command name does not stop the status line", async ($, on) => {
	const w = world(on, { failCommandRegister: true });
	await start($, w);
	await step($, w, { index: 0 });
	await w.clock.advance(1000);
	expect(w.statuses.at(-1)).toBe(
		"idle 1s · last hit 90% · 90 cached · cold in ~59m59s",
	);
});

test("an unreadable store still reports this session, with no tabs", async ($, on) => {
	const w = world(on, { failStoreKeys: true, entries: { "session:OLD": OLD } });
	await start($, w);
	await step($, w, { index: 0 });
	expect(await runEmber($)).toEqual({});
	await w.clock.settle();
	const ui = await mountPane($);
	expect(flat(await ui.drawn())).toContain("\nfirst 1 90%");
	expect(await ui.find({ key: "tab-all" })).toBeUndefined();
	expect(w.debug).toContain("ember: could not read other sessions");
	await ui.unmount();
});

test(
	"an environment variable sets the TTL over the option",
	{ options: { ttlMinutes: 30 } },
	async ($, on) => {
		const w = world(on, {
			env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" },
			settings: { promptCacheTtl: "1h" },
		});
		await start($, w);
		await step($, w, { index: 0 });
		await w.clock.advance(1000);
		expect(w.statuses.at(-1)).toBe(
			"idle 1s · last hit 90% · 90 cached · cold in ~4m59s",
		);
		expect((await paneOf($)).ttl).toBe("TTL 5m (CLAUDE_CODE_PROMPT_CACHE_TTL)");
	},
);

test("unreadable environment falls through to the promptCacheTtl setting", async ($, on) => {
	const w = world(on, { failEnv: true, settings: { promptCacheTtl: "5m" } });
	await start($, w);
	expect((await paneOf($)).ttl).toBe("TTL 5m (promptCacheTtl)");
});

test(
	"unreadable settings fall through to ENABLE_PROMPT_CACHING_1H",
	{ options: { ttlMinutes: 5 } },
	async ($, on) => {
		const w = world(on, {
			failSettings: true,
			env: { ENABLE_PROMPT_CACHING_1H: "1" },
		});
		await start($, w);
		expect((await paneOf($)).ttl).toBe("TTL 60m (ENABLE_PROMPT_CACHING_1H)");
	},
);

test("a clear reads the TTL again", async ($, on) => {
	const w = world(on);
	await start($, w);
	w.env.FORCE_PROMPT_CACHING_5M = "1";
	await $.classic.SessionStart({ source: "clear" });
	expect((await paneOf($)).ttl).toBe("TTL 5m (FORCE_PROMPT_CACHING_5M)");
});

const bigUsage = (): TurnUsage => ({
	...usage(90),
	cache_creation_input_tokens: 141_510,
});

test("one toast warns before the cache goes cold, again after a new request", async ($, on) => {
	const w = world(on);
	await start($, w);
	await step($, w, { index: 0 }, { usage: bigUsage() });
	await w.clock.advance(55 * MIN - 1000);
	expect(w.toasts).toEqual([]);
	await w.clock.advance(1000);
	expect(w.toasts).toEqual(["cache goes cold in ~5m (142k tokens)"]);
	expect(w.statuses.at(-1)).toBe(
		"idle 55m · last hit 0% · 142k cached · cold in ~5m",
	);
	await w.clock.advance(10 * MIN);
	expect(w.toasts.length).toBe(1);

	await step($, w, { turnId: "t2", index: 0 }, { usage: bigUsage() });
	await w.clock.advance(56 * MIN);
	expect(w.toasts).toEqual([
		"cache goes cold in ~5m (142k tokens)",
		"cache goes cold in ~5m (142k tokens)",
	]);
});

test("a refused toast leaves the status line running", async ($, on) => {
	const w = world(on, { failToast: true });
	await start($, w);
	await step($, w, { index: 0 }, { usage: bigUsage() });
	await w.clock.advance(56 * MIN);
	expect(w.toasts).toEqual([]);
	expect(w.statuses.at(-1)).toBe(
		"idle 56m · last hit 0% · 142k cached · cold in ~4m",
	);
});

test("the status line is not set unless VS Code is attached", async ($, on) => {
	const w = world(on, { surfaces: ["terminal", "desktop"] });
	await start($, w);
	await step($, w, { index: 0 });
	await w.clock.advance(2000);
	expect(w.statuses.every((s) => s === undefined)).toBe(true);

	w.surfaces = ["terminal", "vscode"];
	await w.clock.advance(1000);
	expect(w.statuses.at(-1)).toBe(
		"idle 3s · last hit 90% · 90 cached · cold in ~59m57s",
	);
});

test(
	"a main sample stores the live cache state; a subagent sample changes only its saving",
	{ options: { ttlMinutes: 5 } },
	async ($, on) => {
		const w = world(on);
		await start($, w);
		expect(w.store.has("session:S1")).toBe(false);
		await w.clock.advance(1000);
		const running = step(
			$,
			w,
			{ index: 0 },
			{ usage: bigUsage(), holdMs: 2000 },
		);
		await w.clock.advance(2000);
		await running;
		await w.clock.settle();
		const live = {
			lastStartMs: T0 + 1000,
			ttlMinutes: 5,
			prefix: 141_600,
			hit: 90 / 141_610,
		};
		expect(stored(w).live).toEqual({
			...live,
			savedPct: savedPct(stored(w).sums, 5),
		});

		await step($, w, { index: 0, agentId: "a1" }, { usage: usage(10) });
		await w.clock.settle();
		expect(stored(w).buckets.agent?.n).toBe(1);
		expect(stored(w).live).toEqual({
			...live,
			savedPct: savedPct(stored(w).sums, 5),
		});
	},
);

test("a TTL read at session start or a clear updates the stored live TTL", async ($, on) => {
	const live = { lastStartMs: T0 - MIN, ttlMinutes: 60, prefix: 100, hit: 0.9 };
	const w = world(on, {
		env: { FORCE_PROMPT_CACHING_5M: "1" },
		entries: {
			"session:S1": { updatedAt: T0 - MIN, live },
			"session:S2": { updatedAt: T0 - MIN, live },
		},
	});
	await start($, w);
	expect(stored(w).live).toEqual({ ...live, ttlMinutes: 5 });

	w.id = "S2";
	await $.classic.SessionStart({ source: "resume" });
	await w.clock.settle();
	expect(stored(w, "S2").live).toEqual({ ...live, ttlMinutes: 5 });
});

test("an unchanged TTL writes nothing at session start", async ($, on) => {
	const live = { lastStartMs: T0 - MIN, ttlMinutes: 60, prefix: 100, hit: 0.9 };
	const w = world(on, {
		entries: { "session:S1": { updatedAt: T0 - MIN, live } },
	});
	await start($, w);
	expect(w.sets).toEqual([]);
});

const REFRESH_TOAST =
	"ember: cache refresh paused after 2 misses in a row. Run /ember-refresh for details.";
const prefixUsage = (read: number, creation: number): TurnUsage => ({
	input_tokens: 10,
	output_tokens: 5,
	cache_read_input_tokens: read,
	cache_creation_input_tokens: creation,
	model: "opus",
});

/** One main turn: its start, one step with usage (141,600 cached by default), its end. */
async function turn(
	$: Engine,
	w: World,
	turnId: string,
	reply: Partial<World["reply"]> = {},
	isAborted = false,
) {
	await $.turn.start({ text: "go", turnId });
	await step($, w, { turnId, index: 0 }, { usage: bigUsage(), ...reply });
	await $.turn.complete({
		answer: "",
		durationMs: 1,
		isAborted,
		turnId,
		reason: isAborted ? "aborted" : "answer",
	});
	await w.clock.settle();
}

type StoredRefresh = {
	log: number[][];
	pause?: { skip: number; refreshes: number };
	missStreak: number;
	isPaused: boolean;
	coldAtMs?: number;
};
type LiveRefresh = {
	lastStartMs: number;
	nextRefreshMs?: number;
	refreshSkip?: number;
};
const refreshOf = (w: World, id = "S1") =>
	(w.store.get(`session:${id}`) as { refresh: StoredRefresh }).refresh;
const recs = (w: World) => refreshOf(w).log.map(decodeRec);

describe("cache refresh", () => {
	test("an idle pause refreshes 5 min before a 60 min TTL, with no cold toast, and the countdown starts over", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		await w.clock.advance(55 * MIN - 1000);
		expect(w.forks).toEqual([]);
		await w.clock.advance(1000);
		await w.clock.settle();
		expect(w.forks).toEqual([REFRESH_PROMPT]);
		expect(stored(w).live).toMatchObject({
			lastStartMs: T0 + 55 * MIN,
			ttlMinutes: 60,
			prefix: 141_600,
			refreshes: 1,
		});
		await w.clock.advance(1000);
		expect(w.statuses.at(-1)).toBe(
			"idle 55m01s · last hit 0% · 142k cached · cold in ~59m59s",
		);
		expect(w.toasts).toEqual([]);
		await w.clock.advance(55 * MIN - 1000);
		expect(w.forks.length).toBe(2);
	});

	test("a refresh that reads the full prefix is a hit even when it caches the last response (creation 2192)", async ($, on) => {
		const w = world(on);
		await start($, w);
		w.fork = forkHit(141_600, 2192);
		await turn($, w, "t1");
		await w.clock.advance(55 * MIN);
		await w.clock.settle();
		expect(stored(w).live).toMatchObject({
			lastStartMs: T0 + 55 * MIN,
			refreshes: 1,
		});
		expect(refreshOf(w).missStreak).toBe(0);
		await w.clock.advance(55 * MIN);
		expect(w.forks.length).toBe(2);
	});

	test(
		"with refreshShortTtl: false a 5m TTL is not refreshed: the cold toast shows and the pause logs short-ttl",
		{ options: { refreshShortTtl: false } },
		async ($, on) => {
			const w = world(on, { settings: { promptCacheTtl: "5m" } });
			await start($, w);
			await turn($, w, "t1");
			await w.clock.advance(6 * MIN);
			expect(w.forks).toEqual([]);
			expect(w.toasts).toEqual(["cache goes cold in ~1m (142k tokens)"]);
			expect(refreshOf(w).pause?.skip).toBe(13);
			await turn($, w, "t2");
			expect(recs(w)[0]).toMatchObject({
				kind: "pause",
				end: 1,
				skip: 13,
				refreshes: 0,
				ageMs: 6 * MIN,
			});
		},
	);

	test("by default a 5m TTL setting refreshes 1 min before expiry", async ($, on) => {
		const w = world(on, { settings: { promptCacheTtl: "5m" } });
		await start($, w);
		await turn($, w, "t1");
		await w.clock.advance(4 * MIN - 1000);
		expect(w.forks).toEqual([]);
		await w.clock.advance(1000);
		expect(w.forks.length).toBe(1);
	});

	test("the cap stops a pause with no return after 12 refreshes at a 5 min TTL", async ($, on) => {
		const w = world(on, { settings: { promptCacheTtl: "5m" } });
		await start($, w);
		await turn($, w, "t1");
		await w.clock.advance(90 * MIN);
		expect(w.forks.length).toBe(12);
		expect(w.toasts).toEqual(["cache goes cold in ~1m (142k tokens)"]);
	});

	test(
		"with refresh off nothing forks and the cold toast shows as before",
		{ options: { refresh: false } },
		async ($, on) => {
			const w = world(on);
			await start($, w);
			await turn($, w, "t1");
			await w.clock.advance(56 * MIN);
			expect(w.forks).toEqual([]);
			expect(w.toasts).toEqual(["cache goes cold in ~5m (142k tokens)"]);
			expect(recs(w)).toEqual([]);
			await turn($, w, "t2");
			expect(recs(w)[0]).toMatchObject({
				kind: "pause",
				end: 1,
				skip: 1,
				refreshes: 0,
				ageMs: 56 * MIN,
			});
		},
	);

	test(
		"a set lead moves the refresh",
		{ options: { refreshLeadSeconds: 120 } },
		async ($, on) => {
			const w = world(on);
			await start($, w);
			await turn($, w, "t1");
			await w.clock.advance(58 * MIN - 1000);
			expect(w.forks).toEqual([]);
			await w.clock.advance(1000);
			expect(w.forks.length).toBe(1);
		},
	);

	test("ember's own fork steps stay out of every bucket and are counted in its record", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		w.forkSteps = ["fork-agent", null];
		await w.clock.advance(55 * MIN);
		await w.clock.settle();
		const counts = Object.fromEntries(
			Object.entries(stored(w).buckets).map(([k, v]) => [k, v.n]),
		);
		expect(counts).toEqual({
			first: 1,
			user: 0,
			ask: 0,
			subagent: 0,
			tool: 0,
			compact: 0,
			"model-switch": 0,
			agent: 0,
		});
		expect(recs(w)[0]).toMatchObject({
			kind: "refresh",
			outcome: 0,
			steps: 2,
			agentSteps: 1,
			ageMs: 55 * MIN,
			read: 141_600,
		});
	});

	test("a turn started while the fork runs is measured, closes the pause, and starts no second refresh", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		w.forkHoldMs = 10_000;
		await w.clock.advance(55 * MIN);
		expect(w.forks.length).toBe(1);
		await w.clock.advance(2000);
		await $.turn.start({ text: "back", turnId: "t2" });
		await step(
			$,
			w,
			{ turnId: "t2", index: 0 },
			{ usage: prefixUsage(141_600, 100) },
		);
		await $.turn.complete({
			answer: "",
			durationMs: 1,
			isAborted: false,
			turnId: "t2",
			reason: "answer",
		});
		await w.clock.advance(10_000);
		await w.clock.settle();
		expect(stored(w).buckets.user?.n).toBe(1);
		expect(w.forks.length).toBe(1);
		expect(recs(w).map((r) => r?.kind)).toEqual(["pause", "refresh"]);
		expect(recs(w)[0]).toMatchObject({
			end: 0,
			refreshes: 0,
			ageMs: 55 * MIN + 2000,
		});
	});

	test("after Esc the pause is not refreshed and the cold toast shows", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1", {}, true);
		await w.clock.advance(56 * MIN);
		expect(w.forks).toEqual([]);
		expect(w.toasts).toEqual(["cache goes cold in ~5m (142k tokens)"]);
	});

	test("a refused fork retries after 30 s and stops after 3; a rejected call counts as refused", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		w.fork = {
			isAnswered: false,
			reason: "api-error",
			status: 529,
			error: "overloaded",
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		};
		await w.clock.advance(55 * MIN + 29_000);
		expect(w.forks.length).toBe(1);
		await w.clock.advance(1000);
		expect(w.forks.length).toBe(2);
		w.fork = "throw";
		await w.clock.advance(30_000);
		await w.clock.advance(60_000);
		expect(w.forks.length).toBe(3);
		expect(refreshOf(w).pause?.skip).toBe(11);
		expect(refreshOf(w).missStreak).toBe(0);
		expect(w.toasts.length).toBe(1);
	});

	test("two misses in a row pause refresh for the session, with one toast pointing to /ember-refresh", async ($, on) => {
		const w = world(on);
		await start($, w);
		w.fork = forkHit(100_000, 41_600);
		await turn($, w, "t1");
		await w.clock.advance(56 * MIN);
		await turn($, w, "t2");
		await w.clock.advance(56 * MIN);
		expect(w.forks.length).toBe(2);
		// After each miss no refresh is planned for that pause, so the cold warning is due again.
		expect(w.toasts).toEqual([
			"cache goes cold in ~5m (142k tokens)",
			REFRESH_TOAST,
			"cache goes cold in ~5m (142k tokens)",
		]);
		expect(w.debug).toContain(
			"ember: cache refresh paused for this session after 2 misses in a row",
		);
		await turn($, w, "t3");
		await w.clock.advance(120 * MIN);
		expect(w.forks.length).toBe(2);
		expect(refreshOf(w).isPaused).toBe(true);
		expect(refreshOf(w).pause?.skip).toBe(4);
	});

	test(
		"with refreshShortTtl: false, a refresh miss that moves the plan to 5 min stops the refreshes",
		{ options: { refreshShortTtl: false } },
		async ($, on) => {
			const w = world(on);
			await start($, w);
			await turn($, w, "t1");
			w.fork = forkHit(0, 141_600);
			await w.clock.advance(55 * MIN);
			await w.clock.settle();
			w.fork = forkHit();
			await turn($, w, "t2");
			await w.clock.advance(10 * MIN);
			expect(w.forks.length).toBe(1);
			expect(refreshOf(w).pause?.skip).toBe(13);
		},
	);

	test("a TTL that drops to 5 min mid-session: a refresh that found the cache gone moves the plan to 5 min", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		w.fork = forkHit(0, 141_600);
		await w.clock.advance(55 * MIN);
		await w.clock.settle();
		expect(stored(w).live).toMatchObject({ ttlMinutes: 5 });
		expect((await paneOf($)).ttl).toBe("TTL 5m (refresh miss)");
		w.fork = forkHit();
		await turn($, w, "t2");
		await w.clock.advance(4 * MIN);
		expect(w.forks.length).toBe(2);
		expect(refreshOf(w).missStreak).toBe(0);
	});

	test("a prefix of 0 is never refreshed", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1", { usage: prefixUsage(0, 0) });
		await w.clock.advance(2 * 60 * MIN);
		expect(w.forks).toEqual([]);
	});

	test("with evidence ember yields to idle compaction when it may run, and refreshes when it is off", async ($, on) => {
		const w = world(on, { entries: { idleCompactionSeenMs: T0 - DAY } });
		await start($, w);
		await turn($, w, "t1", { usage: prefixUsage(0, 250_000) });
		await w.clock.advance(56 * MIN);
		expect(w.forks).toEqual([]);
		expect(refreshOf(w).pause?.skip).toBe(3);

		w.settings = { idleCompaction: false };
		await $.classic.SessionStart({ source: "resume" });
		await turn($, w, "t2", { usage: prefixUsage(0, 250_000) });
		await w.clock.advance(55 * MIN);
		expect(w.forks.length).toBe(1);
	});

	test("an idle compaction in a pause ember left to it keeps the pause in the idle compaction sample", async ($, on) => {
		const w = world(on, { entries: { idleCompactionSeenMs: T0 - DAY } });
		await start($, w);
		await turn($, w, "t1", { usage: prefixUsage(0, 250_000) });
		await w.clock.advance(54 * MIN);
		await $.session.compact({ trigger: "auto", messages: SUMMARY });
		await w.clock.settle();
		expect(refreshOf(w).pause?.skip).toBe(3);
		expect(stored(w).compactions).toBe(1);
		expect(w.store.get("idleCompactionSeenMs")).toBe(T0 + 54 * MIN);
		await w.clock.advance(16 * MIN);
		await turn($, w, "t2", { usage: prefixUsage(0, 20_000) });
		expect(recs(w)[0]).toMatchObject({
			kind: "pause",
			skip: 3,
			idleCompacted: 1,
		});
		expect(w.store.get("idleCompactionSeenMs")).toBe(T0 + 54 * MIN);
	});

	test("a compaction during the pause stops its refreshes", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		await w.clock.advance(30 * MIN);
		await $.session.compact({ trigger: "auto", messages: SUMMARY });
		await w.clock.advance(30 * MIN);
		expect(w.forks).toEqual([]);
		expect(refreshOf(w).pause?.skip).toBe(6);
	});

	test("a warm return after a refresh closes the pause and live shows the saving", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		await w.clock.advance(70 * MIN);
		await turn($, w, "t2", { usage: prefixUsage(141_600, 100) });
		const cost = 0.1 * 141_600 + 12 + 5 * 2;
		expect(recs(w)[1]).toMatchObject({
			kind: "pause",
			end: 0,
			refreshes: 1,
			ageMs: 70 * MIN,
		});
		expect(stored(w).live).toMatchObject({
			savedTokens: Math.round(1.9 * 141_600 - cost),
		});
		expect(
			(stored(w).live as { refreshes?: number }).refreshes,
		).toBeUndefined();
	});

	test("a session end closes the open pause as an exit", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		await w.clock.advance(10 * MIN);
		await $.session.end({
			reason: "prompt_input_exit",
			sessionId: "S1",
			resume: { id: "S1" },
		});
		await w.clock.settle();
		expect(refreshOf(w).pause).toBeUndefined();
		expect(recs(w)[0]).toMatchObject({ kind: "pause", end: 2 });
	});

	test("a pause a dead process left open closes as an exit at its last write on resume", async ($, on) => {
		const pause = {
			startMs: T0 - 2 * MIN,
			anchorMs: T0 - 3 * MIN,
			readMs: T0 - 3 * MIN,
			ttlMinutes: 60,
			source: 0,
			leadMs: 5 * MIN,
			prefix: 100,
			refreshes: 0,
			tries: 0,
			cost: 0,
			skip: 0,
		};
		const w = world(on, {
			entries: {
				"session:S1": {
					updatedAt: T0 - MIN,
					refresh: { log: [], missStreak: 0, isPaused: false, saved: 0, pause },
				},
			},
		});
		await start($, w);
		expect(refreshOf(w).pause).toBeUndefined();
		expect(recs(w)[0]).toMatchObject({ kind: "pause", end: 2, ageMs: 2 * MIN });
	});

	test("live carries the next refresh time, moves it after a refresh, and drops it on a return", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		const first = stored(w).live as LiveRefresh;
		expect(first.nextRefreshMs).toBe(first.lastStartMs + 55 * MIN);
		expect(first.refreshSkip).toBeUndefined();
		await w.clock.advance(55 * MIN);
		await w.clock.settle();
		expect(stored(w).live).toMatchObject({
			lastStartMs: T0 + 55 * MIN,
			nextRefreshMs: T0 + 110 * MIN,
		});
		await $.turn.start({ text: "back", turnId: "t2" });
		await w.clock.settle();
		expect(stored(w).live).not.toHaveProperty("nextRefreshMs");
		expect(stored(w).live).not.toHaveProperty("refreshSkip");
	});

	test(
		"with refresh off live carries skip 1 and no refresh time",
		{ options: { refresh: false } },
		async ($, on) => {
			const w = world(on);
			await start($, w);
			await turn($, w, "t1");
			expect(stored(w).live).toMatchObject({ refreshSkip: 1 });
			expect(stored(w).live).not.toHaveProperty("nextRefreshMs");
		},
	);

	test("a compaction in the pause sets live skip 6 and drops the refresh time", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		await w.clock.advance(30 * MIN);
		await $.session.compact({ trigger: "auto", messages: SUMMARY });
		await w.clock.settle();
		expect(stored(w).live).toMatchObject({ refreshSkip: 6 });
		expect(stored(w).live).not.toHaveProperty("nextRefreshMs");
	});

	test("a pause left to idle compaction carries skip 3 and the rescue time", async ($, on) => {
		const w = world(on, { entries: { idleCompactionSeenMs: T0 - DAY } });
		await start($, w);
		await turn($, w, "t1", { usage: prefixUsage(0, 250_000) });
		const live = stored(w).live as LiveRefresh;
		expect(live.refreshSkip).toBe(3);
		expect(live.nextRefreshMs).toBe(live.lastStartMs + 57.5 * MIN);
	});

	test("a pause a dead process left open drops its live refresh fields on resume", async ($, on) => {
		const live = {
			lastStartMs: T0 - 3 * MIN,
			ttlMinutes: 60,
			prefix: 100,
			hit: 1,
			refreshes: 1,
			nextRefreshMs: T0 + 52 * MIN,
			refreshSkip: 3,
		};
		const pause = {
			startMs: T0 - 2 * MIN,
			anchorMs: T0 - 3 * MIN,
			readMs: T0 - 3 * MIN,
			ttlMinutes: 60,
			source: 0,
			leadMs: 5 * MIN,
			prefix: 100,
			refreshes: 1,
			tries: 0,
			cost: 0,
			skip: 0,
		};
		const w = world(on, {
			entries: {
				"session:S1": {
					updatedAt: T0 - MIN,
					live,
					refresh: { log: [], missStreak: 0, isPaused: false, saved: 0, pause },
				},
			},
		});
		await start($, w);
		expect(stored(w).live).toEqual({
			lastStartMs: T0 - 3 * MIN,
			ttlMinutes: 60,
			prefix: 100,
			hit: 1,
		});
	});

	test("/ember-refresh opens a pane with the analysis", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1");
		expect(
			await $.command.run({
				command: "ember-refresh",
				args: "",
				origin: { kind: "composer" },
				presentation: { isFullscreen: false, columns: 80 },
			}),
		).toEqual({});
		expect(w.opens).toEqual([
			{
				id: "ember-refresh",
				title: "ember refresh",
				focus: true,
				closeOnEscape: true,
				rows: 40,
			},
		]);
		await w.clock.settle();
		const ui = await mountPane($, "terminal", "ember-refresh");
		const md = flat(await ui.drawn());
		expect(md).toContain(
			"Refresh on\nLead 5m (auto)\nTTL 60m (ttlMinutes option)",
		);
		expect(md).toContain(
			"Not enough data for a recommendation: 0 returned pauses, 20 needed.",
		);
		await ui.unmount();
	});

	test("/ember-probe refreshes once now and toasts what the fork read; with no pause it says why", async ($, on) => {
		const w = world(on);
		await start($, w);
		const probe = () =>
			$.command.run({
				command: "ember-probe",
				args: "",
				origin: { kind: "composer" },
				presentation: { isFullscreen: false, columns: 80 },
			});
		await probe();
		expect(w.toasts).toEqual([
			"ember probe: no idle pause yet; finish a turn first",
		]);
		await turn($, w, "t1");
		w.forkSteps = [null];
		await probe();
		await w.clock.settle();
		expect(w.forks.length).toBe(1);
		expect(w.toasts.at(-1)).toBe(
			"ember probe: hit · read 100% of 142k · created 0 · fork steps seen 1 (0 with an agent id)",
		);
		expect(recs(w)[0]).toMatchObject({ kind: "refresh", isProbe: 1 });
		expect(refreshOf(w).pause?.refreshes).toBe(0);
	});
});

describe("idle compaction evidence", () => {
	const KEY = "idleCompactionSeenMs";
	const big = { usage: prefixUsage(0, 250_000) };

	test("with no evidence in the store, a pause idle compaction applies to is refreshed", async ($, on) => {
		const w = world(on, {
			entries: { "session:S1": { updatedAt: T0 - MIN, compactions: 2 } },
		});
		await start($, w);
		await turn($, w, "t1", big);
		await w.clock.advance(55 * MIN);
		expect(w.forks.length).toBe(1);
		expect(w.store.has(KEY)).toBe(false);
	});

	test("an idle auto compaction before the refresh stops it and is recorded; the next such pause is skipped", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1", big);
		await w.clock.advance(54 * MIN);
		await $.session.compact({ trigger: "auto", messages: SUMMARY });
		await w.clock.advance(10 * MIN);
		expect(w.forks).toEqual([]);
		expect(w.store.get(KEY)).toBe(T0 + 54 * MIN);
		await turn($, w, "t2", big);
		expect(recs(w)[0]).toMatchObject({
			kind: "pause",
			skip: 6,
			idleCompacted: 1,
		});
		expect(refreshOf(w).pause?.skip).toBe(3);
		await w.clock.advance(56 * MIN);
		expect(w.forks).toEqual([]);
	});

	test("a precompute while idle is evidence", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1", big);
		await w.clock.advance(54 * MIN);
		await $.session.compact({ trigger: "precompute", messages: SUMMARY });
		await w.clock.settle();
		expect(w.store.get(KEY)).toBe(T0 + 54 * MIN);
	});

	test("a manual compaction, a subagent one, and one during a turn are not evidence", async ($, on) => {
		const w = world(on);
		w.isManualAllowed = true;
		await start($, w);
		await turn($, w, "t1", big);
		await w.clock.advance(54 * MIN);
		await $.session.compact({ trigger: "manual", messages: SUMMARY });
		await $.session.compact({
			trigger: "auto",
			agentId: "a1",
			messages: SUMMARY,
		});
		await $.turn.start({ text: "go", turnId: "t2" });
		await $.session.compact({ trigger: "auto", messages: SUMMARY });
		await w.clock.settle();
		expect(w.store.has(KEY)).toBe(false);
	});

	test("a skipped pause a dead process left open past the rescue time clears the evidence when it closes", async ($, on) => {
		const pause = {
			startMs: T0 - 70 * MIN,
			anchorMs: T0 - 70 * MIN,
			readMs: T0 - 70 * MIN,
			ttlMinutes: 60,
			source: 0,
			leadMs: 5 * MIN,
			prefix: 250_000,
			refreshes: 0,
			tries: 0,
			cost: 0,
			skip: 3,
		};
		const w = world(on, {
			entries: {
				[KEY]: T0 - DAY,
				"session:S1": {
					updatedAt: T0 - 10 * MIN,
					refresh: { log: [], missStreak: 0, isPaused: false, saved: 0, pause },
				},
			},
		});
		await start($, w);
		expect(recs(w)[0]).toMatchObject({
			kind: "pause",
			end: 2,
			skip: 3,
			idleCompacted: 0,
		});
		expect(w.store.has(KEY)).toBe(false);
		await turn($, w, "t1", big);
		expect(refreshOf(w).pause?.skip).toBe(0);
	});

	test("with no idle compaction by 57 m 30 s ember clears the evidence and refreshes, then at the usual lead; the return is warm", async ($, on) => {
		const w = world(on, { entries: { [KEY]: T0 - DAY } });
		w.fork = forkHit(250_000);
		await start($, w);
		await turn($, w, "t1", big);
		expect(refreshOf(w).pause?.skip).toBe(3);
		await w.clock.advance(57.5 * MIN - 1000);
		expect(w.forks).toEqual([]);
		expect(w.store.get(KEY)).toBe(T0 - DAY);
		await w.clock.advance(1000);
		await w.clock.settle();
		expect(w.forks).toEqual([REFRESH_PROMPT]);
		expect(w.store.has(KEY)).toBe(false);
		expect(refreshOf(w).pause).toMatchObject({ skip: 0, refreshes: 1 });
		await w.clock.advance(55 * MIN);
		await w.clock.settle();
		expect(w.forks.length).toBe(2);
		await w.clock.advance(7.5 * MIN);
		await turn($, w, "t2", { usage: prefixUsage(250_000, 0) });
		expect(recs(w).filter((r) => r?.kind === "pause")).toEqual([
			expect.objectContaining({
				end: 0,
				skip: 0,
				refreshes: 2,
				idleCompacted: 0,
				ageMs: 120 * MIN,
			}),
		]);
		expect(refreshOf(w).pause?.skip).toBe(0);
		expect(w.toasts).toEqual([]);
	});

	for (const [atMin, holdMs] of [
		[54, 0],
		[57, MIN],
	] as const) {
		test(`an idle compaction starting at ${atMin} m, running ${holdMs / 1000} s, is seen: no rescue, the evidence kept`, async ($, on) => {
			const w = world(on, { entries: { [KEY]: T0 - DAY } });
			await start($, w);
			await turn($, w, "t1", big);
			await w.clock.advance(atMin * MIN);
			w.compactHoldMs = holdMs;
			const compaction = $.session.compact({
				trigger: "auto",
				messages: SUMMARY,
			});
			await w.clock.advance(holdMs);
			await compaction;
			await w.clock.settle();
			await w.clock.advance(10 * MIN);
			expect(w.forks).toEqual([]);
			expect(w.store.get(KEY)).toBe(T0 + atMin * MIN + holdMs);
			expect(refreshOf(w).pause?.skip).toBe(3);
		});
	}

	test("an idle compaction after the rescue still stops the refreshes and records the evidence again", async ($, on) => {
		const w = world(on, { entries: { [KEY]: T0 - DAY } });
		w.fork = forkHit(250_000);
		await start($, w);
		await turn($, w, "t1", big);
		await w.clock.advance(58 * MIN);
		expect(w.forks.length).toBe(1);
		await $.session.compact({ trigger: "auto", messages: SUMMARY });
		await w.clock.settle();
		expect(w.store.get(KEY)).toBe(T0 + 58 * MIN);
		await w.clock.advance(60 * MIN);
		expect(w.forks.length).toBe(1);
		await turn($, w, "t2", { usage: prefixUsage(0, 20_000) });
		expect(recs(w).find((r) => r?.kind === "pause")).toMatchObject({
			skip: 6,
			refreshes: 1,
			idleCompacted: 1,
		});
	});

	test(
		"with refresh off nothing is rescued and the evidence stays",
		{ options: { refresh: false } },
		async ($, on) => {
			const w = world(on, { entries: { [KEY]: T0 - DAY } });
			await start($, w);
			await turn($, w, "t1", big);
			await w.clock.advance(70 * MIN);
			await turn($, w, "t2", big);
			expect(w.forks).toEqual([]);
			expect(w.store.get(KEY)).toBe(T0 - DAY);
		},
	);

	test("a turn running at the rescue time: no rescue; its own request reads the cache, and the next pause is left to idle compaction again", async ($, on) => {
		const w = world(on, { entries: { [KEY]: T0 - DAY } });
		await start($, w);
		await turn($, w, "t1", big);
		await w.clock.advance(57 * MIN);
		await $.turn.start({ text: "go", turnId: "t2" });
		await w.clock.advance(MIN);
		expect(w.forks).toEqual([]);
		await step(
			$,
			w,
			{ turnId: "t2", index: 0 },
			{ usage: prefixUsage(250_000, 0) },
		);
		await $.turn.complete({
			answer: "",
			durationMs: 1,
			isAborted: false,
			turnId: "t2",
			reason: "answer",
		});
		await w.clock.settle();
		expect(recs(w)[0]).toMatchObject({
			kind: "pause",
			end: 0,
			skip: 3,
			refreshes: 0,
		});
		expect(w.store.get(KEY)).toBe(T0 - DAY);
		expect(refreshOf(w).pause?.skip).toBe(3);
	});

	test("a manual compaction in a skipped pause replaces the prefix: no rescue, the evidence stays", async ($, on) => {
		const w = world(on, { entries: { [KEY]: T0 - DAY } });
		w.isManualAllowed = true;
		await start($, w);
		await turn($, w, "t1", big);
		await w.clock.advance(30 * MIN);
		await $.session.compact({ trigger: "manual", messages: SUMMARY });
		await w.clock.advance(40 * MIN);
		expect(w.forks).toEqual([]);
		expect(refreshOf(w).pause?.skip).toBe(6);
		expect(w.store.get(KEY)).toBe(T0 - DAY);
	});

	test("a 5 min TTL is never left to idle compaction, so it refreshes as usual and nothing is rescued", async ($, on) => {
		const w = world(on, {
			entries: { [KEY]: T0 - DAY },
			settings: { promptCacheTtl: "5m" },
		});
		await start($, w);
		await turn($, w, "t1", big);
		expect(refreshOf(w).pause?.skip).toBe(0);
		await w.clock.advance(4 * MIN);
		expect(w.forks.length).toBe(1);
		expect(w.store.get(KEY)).toBe(T0 - DAY);
	});

	test("/ember-refresh counts a rescued pause as refreshed, not as left to idle compaction", async ($, on) => {
		const w = world(on, { entries: { [KEY]: T0 - DAY } });
		w.fork = forkHit(250_000);
		await start($, w);
		await turn($, w, "t1", big);
		await w.clock.advance(30 * MIN);
		await turn($, w, "t2", big);
		await w.clock.advance(70 * MIN);
		await turn($, w, "t3", { usage: prefixUsage(250_000, 0) });
		expect(
			recs(w)
				.filter((r) => r?.kind === "pause")
				.map((r) => r?.kind === "pause" && [r.skip, r.refreshes]),
		).toEqual([
			[3, 0],
			[0, 1],
		]);
		const ui = await mountPane($, "terminal", "ember-refresh");
		expect(flat(await ui.drawn())).toContain(
			"· 1 pauses skipped earlier\nSample",
		);
		await ui.unmount();
	});

	test("the evidence is store-wide: each turn reads what another session wrote or cleared", async ($, on) => {
		const w = world(on);
		await start($, w);
		await turn($, w, "t1", big);
		expect(refreshOf(w).pause?.skip).toBe(0);
		w.store.set(KEY, T0);
		await turn($, w, "t2", big);
		expect(refreshOf(w).pause?.skip).toBe(3);
		w.store.delete(KEY);
		await turn($, w, "t3", big);
		expect(refreshOf(w).pause?.skip).toBe(0);
	});

	test("/ember-refresh says, from session start, whether idle compaction was seen", async ($, on) => {
		const w = world(on, { entries: { [KEY]: Date.UTC(2026, 9, 21, 12) } });
		await start($, w);
		const ui = await mountPane($, "terminal", "ember-refresh");
		expect(flat(await ui.drawn())).toContain(
			"Idle compaction seen 2026-10-21, ember skips the pauses it applies to\nSample",
		);
		await ui.unmount();
	});
});

describe("TTL detection", () => {
	const PATH = "/Users/secret-user/.claude/projects/secret-project/S1.jsonl";
	const TAIL = ["tail", "-c", "1048576", "--", PATH];
	/** An assistant record whose usage wrote these 5-minute and 1-hour cache tokens, with private text around it. */
	const written = (m5: number, h1: number) =>
		JSON.stringify({
			type: "assistant",
			cwd: "/Users/secret-user/secret-project",
			message: {
				content: [{ type: "text", text: "the secret answer" }],
				usage: {
					cache_creation: {
						ephemeral_1h_input_tokens: h1,
						ephemeral_5m_input_tokens: m5,
					},
				},
			},
		});
	const transcript = (...lines: string[]) =>
		[
			JSON.stringify({ type: "user", message: { content: "a secret prompt" } }),
			...lines,
			"",
		].join("\n");
	const FIVE = transcript(written(1007, 0));
	const HOUR = transcript(written(0, 1007));
	const stop = (
		$: Engine,
		over: {
			agent_id?: string;
			stop_hook_active?: boolean;
			transcript_path?: string;
		} = {},
	) =>
		$.classic.Stop({ stop_hook_active: false, transcript_path: PATH, ...over });
	/** How long after a main turn's Stop the transcript read starts. */
	const DELAY = 2000;
	/** Whether any text of the transcript or its path reached the store, a log, a toast or the status line. */
	const leaks = (w: World) =>
		JSON.stringify([
			[...w.store],
			w.logs,
			w.debug,
			w.toasts,
			w.statuses,
		]).includes("secret");

	test("after a main turn, the transcript's newest cache write sets the TTL, shown as detected", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await turn($, w, "t1");
		expect(await stop($)).toEqual({ additionalContext: ["from core"] });
		await w.clock.advance(DELAY);
		expect(w.runs).toEqual([TAIL]);
		expect(w.fsReads).toEqual([]);
		expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
		expect(stored(w).live).toMatchObject({ ttlMinutes: 5 });
		expect(leaks(w)).toBe(false);
	});

	test("a detected TTL goes before the environment and the setting", async ($, on) => {
		const w = world(on, {
			env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" },
			settings: { promptCacheTtl: "5m" },
		});
		w.transcript = HOUR;
		await start($, w);
		await stop($);
		await w.clock.advance(DELAY);
		expect((await paneOf($)).ttl).toBe("TTL 60m (detected)");
		await $.classic.SessionStart({ source: "clear" });
		await w.clock.settle();
		expect((await paneOf($)).ttl).toBe("TTL 60m (detected)");
	});

	test("a subagent's stop, a stop a stop hook continues, and no transcript read nothing", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await stop($, { agent_id: "a1" });
		await stop($, { stop_hook_active: true });
		await stop($, { transcript_path: "" });
		await $.classic.SessionStart({ source: "clear" });
		await w.clock.advance(DELAY);
		expect(w.runs).toEqual([]);
		expect((await paneOf($)).ttl).toBe("TTL 60m (ttlMinutes option)");
	});

	test("the read starts 2 s after a main turn's stop: none before, one after", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await turn($, w, "t1");
		await stop($);
		await w.clock.advance(DELAY - 1);
		expect(w.runs).toEqual([]);
		expect((await paneOf($)).ttl).toBe("TTL 60m (ttlMinutes option)");
		await w.clock.advance(1);
		expect(w.runs).toEqual([TAIL]);
		expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
		await w.clock.advance(10 * MIN);
		expect(w.runs).toEqual([TAIL]);
	});

	test("a second stop inside the delay replaces the pending read: one read, 2 s after the last stop", async ($, on) => {
		const w = world(on);
		w.transcript = HOUR;
		await start($, w);
		await stop($);
		await w.clock.advance(DELAY / 2);
		w.transcript = FIVE;
		await stop($);
		await w.clock.advance(DELAY - 1);
		expect(w.runs).toEqual([]);
		await w.clock.advance(1);
		expect(w.runs).toEqual([TAIL]);
		expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
		await w.clock.advance(10 * MIN);
		expect(w.runs.length).toBe(1);
	});

	const leaves: [string, ($: Engine) => Promise<unknown>][] = [
		[
			"a session end",
			($) =>
				$.session.end({
					reason: "prompt_input_exit",
					sessionId: "S1",
					resume: { id: "S1" },
				}),
		],
		["a clear", ($) => $.classic.SessionStart({ source: "clear" })],
		[
			"a reload",
			($) =>
				$.session.start({ cwd: "/", surface: "terminal", isInteractive: true }),
		],
	];
	for (const [name, leave] of leaves) {
		test(`${name} inside the delay drops the pending read`, async ($, on) => {
			const w = world(on);
			w.transcript = FIVE;
			await start($, w);
			await turn($, w, "t1");
			await stop($);
			await w.clock.advance(DELAY / 2);
			await leave($);
			await w.clock.advance(10 * MIN);
			expect(w.runs).toEqual([]);
			expect((await paneOf($)).ttl).toBe("TTL 60m (ttlMinutes option)");
		});
	}

	test("a turn that starts inside the delay keeps the read; the returned pause keeps its TTL, the next pause takes the new one", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await turn($, w, "t1");
		await stop($);
		await w.clock.advance(DELAY / 2);
		await $.turn.start({ text: "back", turnId: "t2" });
		await w.clock.advance(DELAY / 2);
		expect(w.runs).toEqual([TAIL]);
		expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
		expect(refreshOf(w).pause).toMatchObject({
			ttlMinutes: 60,
			source: 0,
			returnMs: T0 + DELAY / 2,
		});
		await step($, w, { turnId: "t2", index: 0 }, { usage: bigUsage() });
		await $.turn.complete({
			answer: "",
			durationMs: 1,
			isAborted: false,
			turnId: "t2",
			reason: "answer",
		});
		await w.clock.settle();
		expect(refreshOf(w).pause).toMatchObject({ ttlMinutes: 5, source: 6 });
	});

	test("a read logs to debug, as fixed text, whether the tail held a cache write and the TTL it found", async ($, on) => {
		const w = world(on);
		w.transcript = transcript(written(0, 0));
		await start($, w);
		await stop($);
		await w.clock.advance(DELAY);
		expect(w.debug).toEqual(["ember: no cache write in the transcript tail"]);
		w.transcript = FIVE;
		await stop($);
		await w.clock.advance(DELAY);
		w.transcript = HOUR;
		await stop($);
		await w.clock.advance(DELAY);
		expect(w.debug).toEqual([
			"ember: no cache write in the transcript tail",
			"ember: detected TTL 5m",
			"ember: detected TTL 60m",
		]);
		expect(w.logs).toEqual([]);
		expect(leaks(w)).toBe(false);
	});

	test("a resume reads the resumed transcript", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await $.classic.SessionStart({ source: "resume", transcript_path: PATH });
		await w.clock.settle();
		expect(w.runs).toEqual([TAIL]);
		expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
	});

	test("a change in the middle of the session plans the open pause and the next with the new TTL", async ($, on) => {
		const w = world(on);
		w.transcript = HOUR;
		await start($, w);
		await turn($, w, "t1");
		await stop($);
		await w.clock.advance(DELAY);
		await turn($, w, "t2");
		expect(refreshOf(w).pause).toMatchObject({ ttlMinutes: 60, source: 6 });
		w.transcript = transcript(written(0, 1007), written(1007, 0));
		await stop($);
		await w.clock.advance(DELAY);
		expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
		expect(refreshOf(w).pause).toMatchObject({ ttlMinutes: 5, source: 6 });
		await turn($, w, "t3");
		expect(refreshOf(w).pause).toMatchObject({ ttlMinutes: 5, source: 6 });
		// The automatic lead at 5 min is 1 min: the refresh runs 4 min after the request.
		await w.clock.advance(4 * MIN);
		await w.clock.settle();
		expect(w.forks).toEqual([REFRESH_PROMPT]);
		expect(w.runs.length).toBe(2);
	});

	test("a read that finds no cache write keeps the last detected TTL, and no tick reads", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await stop($);
		await w.clock.advance(DELAY);
		w.transcript = transcript(written(0, 0));
		await stop($);
		await w.clock.advance(10 * MIN);
		expect(w.runs.length).toBe(2);
		expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
	});

	for (const fails of ["deny", "exit"] as const) {
		test(`a process call that fails (${fails}) falls back to reading a transcript up to 1 MiB whole`, async ($, on) => {
			const w = world(on);
			w.transcript = FIVE;
			w.runFails = fails;
			await start($, w);
			w.transcriptSize = 1_048_576;
			await stop($);
			await w.clock.advance(DELAY);
			expect(w.fsReads).toEqual([PATH]);
			expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
			expect(leaks(w)).toBe(false);
		});
	}

	test("a fallback never reads a transcript over 1 MiB, and the configured TTL stays", async ($, on) => {
		const w = world(on, { settings: { promptCacheTtl: "1h" } });
		w.transcript = FIVE;
		w.transcriptSize = 1_048_577;
		w.runFails = "deny";
		await start($, w);
		await stop($);
		await w.clock.advance(DELAY);
		expect(w.fsReads).toEqual([]);
		expect((await paneOf($)).ttl).toBe("TTL 60m (promptCacheTtl)");
		expect(w.debug).toEqual([
			"ember: could not read the transcript for the TTL",
		]);
		expect(leaks(w)).toBe(false);
	});

	test("with neither the process nor the file, detection returns nothing and logs no path", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		w.runFails = "deny";
		w.failStat = true;
		await start($, w);
		await stop($);
		await w.clock.advance(DELAY);
		expect(w.fsReads).toEqual([]);
		expect((await paneOf($)).ttl).toBe("TTL 60m (ttlMinutes option)");
		expect(w.debug).toEqual([
			"ember: could not read the transcript for the TTL",
		]);
		expect(leaks(w)).toBe(false);
	});

	test("a read that lands after the session changed is dropped", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		w.runHolds = [5000];
		await stop($);
		await w.clock.advance(DELAY);
		await $.classic.SessionStart({ source: "clear" });
		await w.clock.advance(5000);
		await w.clock.settle();
		expect(w.runs).toEqual([TAIL]);
		expect((await paneOf($)).ttl).toBe("TTL 60m (ttlMinutes option)");
	});

	test("an older read that lands after a newer one is dropped", async ($, on) => {
		const w = world(on);
		w.transcript = HOUR;
		await start($, w);
		w.runHolds = [5000, 0];
		await stop($);
		await w.clock.advance(DELAY);
		w.transcript = FIVE;
		await stop($);
		await w.clock.advance(DELAY);
		expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
		await w.clock.advance(5000);
		await w.clock.settle();
		expect(w.runs.length).toBe(2);
		expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
	});

	type OpenPause = Record<string, number>;
	const openOf = (w: World) => refreshOf(w).pause as OpenPause | undefined;
	const liveOf = (w: World) =>
		stored(w).live as LiveRefresh & { ttlMinutes: number };

	test("a read that lands after the pause opened plans it again on 5 min, with one save", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await turn($, w, "t1");
		const opened = openOf(w);
		expect(opened).toMatchObject({
			ttlMinutes: 60,
			source: 0,
			leadMs: 5 * MIN,
		});
		const sets = w.sets.length;
		await stop($);
		await w.clock.advance(DELAY);
		expect(w.sets.length).toBe(sets + 1);
		expect(openOf(w)).toEqual({
			...opened,
			ttlMinutes: 5,
			source: 6,
			leadMs: MIN,
		});
		const live = liveOf(w);
		expect(live).toMatchObject({
			ttlMinutes: 5,
			nextRefreshMs: live.lastStartMs + 4 * MIN,
		});
		expect(live).not.toHaveProperty("refreshSkip");
		await w.clock.advance(4 * MIN);
		await w.clock.settle();
		expect(w.forks).toEqual([REFRESH_PROMPT]);
		expect(w.toasts).toEqual([]);
	});

	test("a read of 60 min after a pause opened on 5 min moves its refresh to 5 min before the hour", async ($, on) => {
		const w = world(on, { settings: { promptCacheTtl: "5m" } });
		w.transcript = HOUR;
		await start($, w);
		await turn($, w, "t1");
		expect(openOf(w)).toMatchObject({ ttlMinutes: 5, leadMs: MIN });
		await stop($);
		await w.clock.advance(DELAY);
		expect(openOf(w)).toMatchObject({
			ttlMinutes: 60,
			source: 6,
			leadMs: 5 * MIN,
			skip: 0,
		});
		const live = liveOf(w);
		expect(live).toMatchObject({
			ttlMinutes: 60,
			nextRefreshMs: live.lastStartMs + 55 * MIN,
		});
		await w.clock.advance(4 * MIN);
		expect(w.forks).toEqual([]);
	});

	test("a read of the TTL already detected changes nothing and saves nothing", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await turn($, w, "t1");
		await stop($);
		await w.clock.advance(DELAY);
		await turn($, w, "t2");
		const opened = openOf(w);
		const sets = w.sets.length;
		await stop($);
		await w.clock.advance(DELAY);
		expect(w.runs.length).toBe(2);
		expect(w.sets.length).toBe(sets);
		expect(openOf(w)).toEqual(opened);
	});

	const refused: ModelForkResult = {
		isAnswered: false,
		reason: "api-error",
		status: 529,
		error: "overloaded",
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
	};
	const touches: {
		name: string;
		atMs: number;
		options?: Options;
		fork?: ModelForkResult;
		reply?: Partial<World["reply"]>;
		touch: ($: Engine, w: World) => Promise<unknown>;
		after: OpenPause;
	}[] = [
		{
			name: "one refresh done",
			atMs: 55 * MIN,
			touch: async (_, w) => w.clock.settle(),
			after: { refreshes: 1 },
		},
		{
			name: "one refused try",
			atMs: 55 * MIN,
			fork: refused,
			touch: async (_, w) => w.clock.settle(),
			after: { refreshes: 0, tries: 1 },
		},
		{
			name: "the person returned",
			atMs: MIN,
			touch: ($) => $.turn.start({ text: "back", turnId: "t2" }),
			after: { returnMs: T0 + MIN },
		},
		{
			name: "idle compaction seen",
			atMs: 20 * MIN,
			options: { entries: { idleCompactionSeenMs: T0 - DAY } },
			reply: { usage: prefixUsage(0, 250_000) },
			touch: ($) => $.session.compact({ trigger: "auto", messages: SUMMARY }),
			after: { skip: 3, idleCompactMs: T0 + 20 * MIN },
		},
	];
	for (const c of touches) {
		test(`a pause with work done in it (${c.name}) keeps its TTL; the next pause takes the new one`, async ($, on) => {
			const w = world(on, c.options);
			w.transcript = FIVE;
			if (c.fork !== undefined) w.fork = c.fork;
			await start($, w);
			await turn($, w, "t1", c.reply);
			await w.clock.advance(c.atMs);
			await c.touch($, w);
			// The read lands after the touch: started here, it reads as one held from the turn's end.
			await stop($);
			await w.clock.advance(DELAY);
			expect(w.runs.length).toBe(1);
			expect((await paneOf($)).ttl).toBe("TTL 5m (detected)");
			expect(openOf(w)).toMatchObject({ ttlMinutes: 60, ...c.after });
			await turn($, w, "t3", c.reply);
			expect(openOf(w)).toMatchObject({ ttlMinutes: 5, source: 6 });
		});
	}

	test(
		"with refreshShortTtl: false a detected 5 min skips the open pause as short-ttl, and the cold toast shows",
		{ options: { refreshShortTtl: false } },
		async ($, on) => {
			const w = world(on);
			w.transcript = FIVE;
			await start($, w);
			await turn($, w, "t1");
			await stop($);
			await w.clock.advance(DELAY);
			expect(openOf(w)).toMatchObject({ ttlMinutes: 5, skip: 13 });
			expect(liveOf(w)).toMatchObject({ refreshSkip: 13 });
			expect(liveOf(w)).not.toHaveProperty("nextRefreshMs");
			await w.clock.advance(6 * MIN);
			expect(w.forks).toEqual([]);
			expect(w.toasts).toEqual(["cache goes cold in ~1m (142k tokens)"]);
		},
	);

	test("a detected 60 min with idle compaction evidence leaves the open pause to idle compaction", async ($, on) => {
		const w = world(on, {
			settings: { promptCacheTtl: "5m" },
			entries: { idleCompactionSeenMs: T0 - DAY },
		});
		w.transcript = HOUR;
		await start($, w);
		await turn($, w, "t1", { usage: prefixUsage(0, 250_000) });
		expect(openOf(w)).toMatchObject({ ttlMinutes: 5, skip: 0 });
		await stop($);
		await w.clock.advance(DELAY);
		expect(openOf(w)).toMatchObject({ ttlMinutes: 60, skip: 3 });
		const live = liveOf(w);
		expect(live).toMatchObject({
			refreshSkip: 3,
			nextRefreshMs: live.lastStartMs + 57.5 * MIN,
		});
	});

	test("an interrupted turn's pause stays interrupted on the new TTL", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await turn($, w, "t1", {}, true);
		await stop($);
		await w.clock.advance(DELAY);
		expect(openOf(w)).toMatchObject({ ttlMinutes: 5, skip: 5 });
		expect(liveOf(w)).not.toHaveProperty("nextRefreshMs");
	});

	test("a read that lands after the new TTL expired stops the pause late: no fork and no cold toast", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await turn($, w, "t1");
		w.runHolds = [6 * MIN];
		await stop($);
		await w.clock.advance(DELAY);
		await w.clock.advance(6 * MIN);
		await w.clock.settle();
		expect(openOf(w)).toMatchObject({ ttlMinutes: 5 });
		await w.clock.advance(1000);
		await w.clock.settle();
		expect(openOf(w)).toMatchObject({ ttlMinutes: 5, skip: 10 });
		expect(liveOf(w)).toMatchObject({ refreshSkip: 10 });
		expect(liveOf(w)).not.toHaveProperty("nextRefreshMs");
		await w.clock.advance(10 * MIN);
		expect(w.forks).toEqual([]);
		expect(w.toasts).toEqual([]);
	});

	test("a read that lands after the session changed leaves the new session's pause as it is", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await turn($, w, "t1");
		w.runHolds = [5000];
		await stop($);
		await w.clock.advance(DELAY);
		await $.classic.SessionStart({ source: "clear" });
		await turn($, w, "t2");
		const opened = openOf(w);
		await w.clock.advance(5000);
		await w.clock.settle();
		expect(openOf(w)).toEqual(opened);
		expect(opened).toMatchObject({ ttlMinutes: 60, source: 0 });
	});

	test("an older read that lands after a newer one leaves the pause the newer one planned", async ($, on) => {
		const w = world(on);
		w.transcript = FIVE;
		await start($, w);
		await turn($, w, "t1");
		w.runHolds = [5000, 0];
		await stop($);
		await w.clock.advance(DELAY);
		w.transcript = HOUR;
		await stop($);
		await w.clock.advance(DELAY);
		const planned = openOf(w);
		expect(planned).toMatchObject({
			ttlMinutes: 60,
			source: 6,
			leadMs: 5 * MIN,
		});
		await w.clock.advance(5000);
		await w.clock.settle();
		expect(openOf(w)).toEqual(planned);
	});

	describe("a refresh miss and a later 60 min read", () => {
		const read = async ($: Engine, w: World) => {
			await stop($);
			await w.clock.advance(DELAY);
			return (await paneOf($)).ttl;
		};
		const probe = ($: Engine) =>
			$.command.run({
				command: "ember-probe",
				args: "",
				origin: { kind: "composer" },
				presentation: { isFullscreen: false, columns: 80 },
			});
		/** 60 min detected after t1, then the refresh at 55 min finds the entry gone. */
		async function missAfterHour($: Engine, w: World) {
			w.transcript = HOUR;
			await start($, w);
			await turn($, w, "t1");
			expect(await read($, w)).toBe("TTL 60m (detected)");
			w.fork = forkHit(0, 141_600);
			await w.clock.advance(55 * MIN);
			await w.clock.settle();
			w.fork = forkHit();
			expect((await paneOf($)).ttl).toBe("TTL 5m (refresh miss)");
			expect(refreshOf(w)).toMatchObject({ coldAtMs: 55 * MIN, missStreak: 1 });
			// The person comes back a minute later: the next main request starts after the miss.
			await w.clock.advance(MIN);
		}

		test("a main turn after the miss that reads 60 again ends the override: the open pause and the next plan on 60, with one save", async ($, on) => {
			const w = world(on);
			await missAfterHour($, w);
			await turn($, w, "t2");
			const opened = openOf(w);
			expect(opened).toMatchObject({ ttlMinutes: 5, source: 5, leadMs: MIN });
			const sets = w.sets.length;
			await stop($);
			await w.clock.advance(DELAY);
			expect(w.sets.length).toBe(sets + 1);
			expect((await paneOf($)).ttl).toBe("TTL 60m (detected)");
			expect(refreshOf(w)).not.toHaveProperty("coldAtMs");
			expect(refreshOf(w).missStreak).toBe(1);
			expect(openOf(w)).toEqual({
				...opened,
				ttlMinutes: 60,
				source: 6,
				leadMs: 5 * MIN,
			});
			expect(liveOf(w)).toMatchObject({ ttlMinutes: 60 });
			await w.clock.advance(4 * MIN);
			expect(w.forks.length).toBe(1);
			await turn($, w, "t3");
			expect(openOf(w)).toMatchObject({ ttlMinutes: 60, source: 6 });
		});

		test("reads with no main turn after the miss keep the override: a Stop the fork raises, one after a probe hit, a resume", async ($, on) => {
			const w = world(on);
			w.transcript = HOUR;
			await start($, w);
			await turn($, w, "t1");
			expect(await read($, w)).toBe("TTL 60m (detected)");
			w.fork = forkHit(0, 141_600);
			w.forkHoldMs = 10_000;
			w.runHolds = [20_000];
			await w.clock.advance(55 * MIN);
			// A Stop raised while the fork runs; its read lands after the miss.
			await stop($);
			await w.clock.advance(DELAY + 20_000);
			await w.clock.settle();
			expect((await paneOf($)).ttl).toBe("TTL 5m (refresh miss)");
			w.fork = forkHit();
			w.forkHoldMs = 0;
			expect(await read($, w)).toBe("TTL 5m (refresh miss)");
			// A probe hit moves the countdown to the fork; that is no main request.
			await probe($);
			await w.clock.settle();
			expect(w.toasts.at(-1)).toMatch(/^ember probe: hit/);
			expect(await read($, w)).toBe("TTL 5m (refresh miss)");
			await $.classic.SessionStart({ source: "resume", transcript_path: PATH });
			await w.clock.settle();
			expect((await paneOf($)).ttl).toBe("TTL 5m (refresh miss)");
			expect(refreshOf(w).coldAtMs).toBe(55 * MIN);
			await turn($, w, "t2");
			expect(await read($, w)).toBe("TTL 60m (detected)");
		});

		test("the main start is taken when the delayed read starts: a main turn inside the delay ends the override", async ($, on) => {
			const w = world(on);
			await missAfterHour($, w);
			// A Stop with no main turn after the miss; its read waits, and a main turn ends meanwhile.
			await stop($);
			await turn($, w, "t2");
			expect((await paneOf($)).ttl).toBe("TTL 5m (refresh miss)");
			await w.clock.advance(DELAY);
			expect(w.runs.length).toBe(2);
			expect((await paneOf($)).ttl).toBe("TTL 60m (detected)");
			expect(refreshOf(w)).not.toHaveProperty("coldAtMs");
		});

		test("after a reload with a stored miss, a read before any main turn keeps it and one after a main turn ends it", async ($, on) => {
			const w = world(on, {
				entries: {
					"session:S1": {
						updatedAt: T0 - MIN,
						refresh: {
							log: [],
							missStreak: 1,
							isPaused: false,
							saved: 0,
							coldAtMs: 55 * MIN,
						},
					},
				},
			});
			w.transcript = HOUR;
			await start($, w);
			expect((await paneOf($)).ttl).toBe("TTL 5m (refresh miss)");
			expect(await read($, w)).toBe("TTL 5m (refresh miss)");
			await turn($, w, "t1");
			expect(await read($, w)).toBe("TTL 60m (detected)");
			expect(refreshOf(w)).not.toHaveProperty("coldAtMs");
			expect(refreshOf(w).missStreak).toBe(1);
		});

		test("a detected 5 min ends nothing; a later 60 min read after a main turn does", async ($, on) => {
			const w = world(on);
			await missAfterHour($, w);
			w.transcript = FIVE;
			await turn($, w, "t2");
			expect(await read($, w)).toBe("TTL 5m (detected)");
			expect(refreshOf(w).coldAtMs).toBe(55 * MIN);
			w.transcript = HOUR;
			await turn($, w, "t3");
			expect(await read($, w)).toBe("TTL 60m (detected)");
			expect(refreshOf(w)).not.toHaveProperty("coldAtMs");
		});

		test("with no detection the override stays", async ($, on) => {
			const w = world(on);
			await missAfterHour($, w);
			w.transcript = transcript(written(0, 0));
			await turn($, w, "t2");
			expect(await read($, w)).toBe("TTL 5m (refresh miss)");
			delete w.transcript;
			await turn($, w, "t3");
			expect(await read($, w)).toBe("TTL 5m (refresh miss)");
			expect(refreshOf(w).coldAtMs).toBe(55 * MIN);
		});

		test("a second miss after the end sets the override again, and the breaker trips at 2 misses in a row", async ($, on) => {
			const w = world(on);
			await missAfterHour($, w);
			await turn($, w, "t2");
			expect(await read($, w)).toBe("TTL 60m (detected)");
			w.fork = forkHit(0, 141_600);
			await w.clock.advance(55 * MIN);
			await w.clock.settle();
			expect(w.forks.length).toBe(2);
			expect((await paneOf($)).ttl).toBe("TTL 5m (refresh miss)");
			expect(refreshOf(w)).toMatchObject({
				coldAtMs: 55 * MIN,
				missStreak: 2,
				isPaused: true,
			});
			expect(w.toasts).toContain(REFRESH_TOAST);
		});
	});
});
