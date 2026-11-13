import type {
	EngineInterface,
	PromptSubmitArgs,
	PromptSubmitResult,
} from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import {
	createEnrollment,
	type FileStatus,
	load,
	type NameState,
	type Status,
} from "../hooks/enroll";
import { enrollment, register, requests } from "../hooks/register";
import {
	cleanReason,
	continueRequest,
	createRequests,
	DROPPED_TOAST,
	NAME_RULE,
	NAME_SECRET,
	onRequestSecret,
	REASON_HIDDEN,
	type Request,
	statusText,
	TOOL_NAME,
	validName,
} from "../hooks/request";
import { fakeApi, fakes, gate, hooksOf } from "./fakes";

const fake = fakes(41);
const value = fake.secret(24);
const otherValue = fake.secret(24);
const NAME = "STRIPE_API_KEY";
const TOOL = `mcp__blindfold__${TOOL_NAME}`;

const SET_TEXT = `${NAME} is set in .env. Use it by name through the app's env loader.`;
const MISSING_TEXT = `${NAME} is not set. The user was asked to enter it. End your turn. Do not ask the user to paste it in chat.`;
const DEGRADED = " blindfold cannot confirm the env file now.";

const active = (path: string, names: NameState[]): FileStatus => ({
	path,
	state: { kind: "active", names },
});
const statusOf = (
	files: FileStatus[],
	shield: Status["shield"] = "active",
): Status => ({ files, shield });
const setStatus = statusOf([active(".env", [{ name: NAME, hidden: true }])]);
const missingStatus = statusOf([active(".env", [])]);
const emptyStatus = statusOf([
	active(".env", [{ name: NAME, hidden: false, why: "empty" }]),
]);
const staleStatus = statusOf(
	[{ path: ".env", state: { kind: "stale", reason: "read-failed" } }],
	"degraded",
);
const goneStatus = statusOf([{ path: ".env", state: { kind: "missing" } }]);

/** Every answer, toast, and request the tests see, for the R6 check. */
const seen: unknown[] = [];
const keep = <T>(item: T): T => {
	seen.push(item);
	return item;
};

describe("R2 validation", () => {
	test("R2: a name of letters, digits, and _ that starts with a letter or _ is valid, up to 64 characters", () => {
		for (const name of [NAME, "_X", "a", `A${"b".repeat(63)}`]) {
			expect(validName(name)).toBe(true);
		}
	});

	test("R2 (F54): a bad name, __proto__, and a value that is not a string are not valid", () => {
		for (const name of [
			"",
			"1KEY",
			"MY-KEY",
			"MY KEY",
			"KEY=x",
			`A${"b".repeat(64)}`,
			"__proto__",
			42,
			undefined,
			null,
			{ name: NAME },
		]) {
			expect(validName(name)).toBe(false);
		}
	});

	test("R2: the reason loses its control characters and is cut to 120 characters", () => {
		expect(cleanReason("needs\u0000 the\n key\u001b[31m\u007f")).toBe(
			"needs the key[31m",
		);
		expect(cleanReason("x".repeat(200))).toBe("x".repeat(120));
		expect(cleanReason("\n".repeat(10) + "y".repeat(130)).length).toBe(120);
	});

	test("R2: a reason that is not a string is empty", () => {
		expect(cleanReason(undefined)).toBe("");
		expect(cleanReason(7)).toBe("");
	});
});

describe("R3 the answer", () => {
	test("R3: a name set in an active file names that file", () => {
		expect(keep(statusText(NAME, setStatus))).toBe(SET_TEXT);
		const second = statusOf([
			active(".env", []),
			active("config/.env.local", [
				{ name: NAME, hidden: false, why: "too-short" },
			]),
		]);
		expect(statusText(NAME, second)).toBe(
			`${NAME} is set in config/.env.local. Use it by name through the app's env loader.`,
		);
	});

	test("R3: a missing name, a name with an empty value, and a name in a missing file are not set", () => {
		for (const status of [missingStatus, emptyStatus, goneStatus]) {
			expect(keep(statusText(NAME, status))).toBe(MISSING_TEXT);
		}
	});

	test("R3: a degraded shield adds that the file cannot be confirmed, to either text", () => {
		expect(keep(statusText(NAME, staleStatus))).toBe(MISSING_TEXT + DEGRADED);
		const degradedSet = { ...setStatus, shield: "degraded" as const };
		expect(keep(statusText(NAME, degradedSet))).toBe(SET_TEXT + DEGRADED);
	});
});

describe("R4 lifecycle", () => {
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

	test("R4: none -> request_secret for a missing name -> pending, with a random id", () => {
		const requests = createRequests();
		expect(requests.current()).toBeUndefined();
		const asked = requests.ask(NAME, "the payment task");
		expect(asked).toEqual({
			id: asked.id,
			name: NAME,
			reason: "the payment task",
			state: "pending",
		});
		expect(asked.id).toMatch(uuid);
		expect(requests.current()).toEqual(asked);
		expect(requests.ask(NAME, "again").id).not.toBe(asked.id);
	});

	for (const from of ["pending", "ready"] as const) {
		test(`R4: ${from} -> a new request_secret -> the old one is cleared, the new one is pending`, () => {
			const requests = createRequests();
			const old = requests.ask("OLD_TOKEN", "old");
			if (from === "ready") {
				requests.sync(
					statusOf([active(".env", [{ name: "OLD_TOKEN", hidden: true }])]),
				);
			}
			expect(requests.current()?.state).toBe(from);
			const fresh = requests.ask(NAME, "new");
			expect(fresh.id).not.toBe(old.id);
			expect(requests.current()).toEqual({ ...fresh, state: "pending" });
		});
	}

	test("R4: pending -> a status shows the name set in an active file -> ready", () => {
		const requests = createRequests();
		const asked = requests.ask(NAME, "r");
		requests.sync(missingStatus);
		expect(requests.current()?.state).toBe("pending");
		requests.sync(setStatus);
		expect(requests.current()).toEqual({ ...asked, state: "ready" });
	});

	for (const [shows, status] of [
		["missing", missingStatus],
		["empty", emptyStatus],
		["in a stale file", staleStatus],
		["in a file that is gone", goneStatus],
	] as const) {
		test(`R4 (F53): ready -> a status shows the name ${shows} -> pending`, () => {
			const requests = createRequests();
			requests.ask(NAME, "r");
			requests.sync(setStatus);
			expect(requests.current()?.state).toBe("ready");
			requests.sync(status);
			expect(requests.current()?.state).toBe("pending");
		});
	}

	test("R4, R5: ready -> Continue -> cleared, and consume returns it once", () => {
		const requests = createRequests();
		const asked = requests.ask(NAME, "r");
		requests.sync(setStatus);
		expect(requests.consume(setStatus, asked.id)).toEqual({
			...asked,
			state: "ready",
		});
		expect(requests.current()).toBeUndefined();
		expect(requests.consume(setStatus, asked.id)).toBeUndefined();
	});

	test("R5 (F80): consume takes only the id it is given, and leaves another request open", () => {
		const requests = createRequests();
		const old = requests.ask("OLD_KEY", "old");
		const fresh = requests.ask(NAME, "new");
		requests.sync(setStatus);
		expect(requests.consume(setStatus, old.id)).toBeUndefined();
		expect(requests.current()).toEqual({ ...fresh, state: "ready" });
	});

	test("R5 (F53): consume returns nothing when the name is no longer set, and the request is pending again", () => {
		const requests = createRequests();
		const { id } = requests.ask(NAME, "r");
		requests.sync(setStatus);
		expect(requests.consume(emptyStatus, id)).toBeUndefined();
		expect(requests.current()?.state).toBe("pending");
	});

	for (const from of ["pending", "ready"] as const) {
		test(`R4: ${from} -> Dismiss -> cleared`, () => {
			const requests = createRequests();
			requests.ask(NAME, "r");
			if (from === "ready") requests.sync(setStatus);
			requests.clear();
			expect(requests.current()).toBeUndefined();
		});
	}

	test("R4: sync with no open request opens none", () => {
		const requests = createRequests();
		requests.sync(setStatus);
		expect(requests.current()).toBeUndefined();
	});
});

/** A `next` that records a call; the request hook must never call it. */
const nextSpy = () => {
	const calls: unknown[] = [];
	const next = Object.assign(
		async (e: unknown) => {
			calls.push(e);
			return { result: "from next" };
		},
		{ budget: { ms: 10_000, remainingMs: 10_000 }, called: false },
	);
	return { next, calls };
};

const call = async (
	api: EngineInterface,
	input: Record<string, unknown>,
	own = createEnrollment(),
	ownRequests = createRequests(),
) => {
	const { next, calls } = nextSpy();
	const result = keep(
		await onRequestSecret(
			api,
			own,
			ownRequests,
			{ tool: TOOL, tool_use_id: "t17", ...input } as Parameters<
				typeof onRequestSecret
			>[3],
			next,
			".env",
		),
	);
	keep(ownRequests.current());
	return { result, calls, requests: ownRequests };
};

describe("R1, R3 the tool", () => {
	test("R1: session.start registers request_secret, not deferred, with name and reason required", async () => {
		enrollment.drop();
		const { api, tools } = fakeApi({});
		await hooksOf(register, { envFiles: ".env" }).get("session.start")?.(
			api,
			{},
			async (e) => e,
		);
		expect(tools.length).toBe(1);
		const [tool] = tools;
		expect(tool?.name).toBe(TOOL_NAME);
		expect(tool?.isDeferred).toBe(false);
		expect(tool?.inputSchema).toEqual({
			type: "object",
			properties: {
				name: expect.objectContaining({ type: "string" }),
				reason: expect.objectContaining({ type: "string" }),
			},
			required: ["name", "reason"],
			additionalProperties: false,
		});
		expect(typeof tool?.description).toBe("string");
	});

	test("R1: register wires the request hook on its own tool, after the tool.call guard", () => {
		const keys = [...hooksOf(register, { envFiles: ".env" }).keys()];
		const own = keys.indexOf(`tool.call ${JSON.stringify({ tool: TOOL })}`);
		expect(own).toBeGreaterThan(keys.indexOf("tool.call"));
	});

	test("R1, R3, R4: a missing name is answered without next, and a pending request is made", async () => {
		const { api } = fakeApi({ ".env": { text: "OTHER=1\n" } });
		const { result, calls, requests } = await call(api, {
			name: NAME,
			reason: "to charge\u0007 the card",
		});
		expect(result).toEqual({ result: MISSING_TEXT });
		expect(calls).toEqual([]);
		expect(requests.current()).toEqual({
			id: requests.current()?.id,
			name: NAME,
			reason: "to charge the card",
			state: "pending",
		});
	});

	test("R1, R3 (F46): the hook loads the env files first, and a set name makes no request", async () => {
		const { api, reads } = fakeApi({
			".env": { text: `${NAME}=${value}\n` },
		});
		const { result, calls, requests } = await call(api, {
			name: NAME,
			reason: "r",
		});
		expect(reads.length).toBe(1);
		expect(result).toEqual({ result: SET_TEXT });
		expect(calls).toEqual([]);
		expect(requests.current()).toBeUndefined();
	});

	test("R3: a name with an empty value is not set, and a request is made", async () => {
		const { api } = fakeApi({ ".env": { text: `${NAME}=\n` } });
		const { result, requests } = await call(api, { name: NAME, reason: "r" });
		expect(result).toEqual({ result: MISSING_TEXT });
		expect(requests.current()?.state).toBe("pending");
	});

	for (const name of ["MY-KEY", "__proto__", 42]) {
		test(`R2 (F54): the name ${JSON.stringify(name)} is denied with the rule, and no request is made`, async () => {
			const { api } = fakeApi({});
			const own = createRequests();
			const open = own.ask("OPEN_TOKEN", "kept");
			const { result, calls } = await call(
				api,
				{ name, reason: "r" },
				undefined,
				own,
			);
			expect(result).toEqual({ deny: NAME_RULE });
			expect(calls).toEqual([]);
			expect(own.current()).toBe(open);
		});
	}
});

describe("R4 clear and sync in register", () => {
	const setup = async () => {
		enrollment.drop();
		requests.clear();
		const { api } = fakeApi({});
		const hooks = hooksOf(register, { envFiles: ".env" });
		await hooks.get("session.start")?.(api, {}, async (e) => e);
		requests.ask(NAME, "r");
		const $ = {
			...api,
			plugin: { name: "blindfold", dir: "/plugins/blindfold" },
			ui: { toast: () => {} },
		} as unknown as EngineInterface;
		return { hooks, $ };
	};
	const submit = (origin?: unknown) => ({
		text: "hello",
		wait: false,
		...(origin ? { origin } : {}),
	});
	const nextOf = () =>
		Object.assign(async (e: unknown) => e, {
			budget: { ms: 10_000, remainingMs: 10_000 },
			called: false,
		});

	for (const [who, origin] of [
		["the user's own prompt", undefined],
		["a composer prompt", { kind: "composer" }],
		["another plugin's prompt", { kind: "plugin", name: "other" }],
	] as const) {
		test(`R4: ${who} clears the request`, async () => {
			const { hooks, $ } = await setup();
			await hooks.get("prompt.submit")?.($, submit(origin), nextOf());
			expect(requests.current()).toBeUndefined();
		});
	}

	test("R4: blindfold's own submit does not clear the request", async () => {
		const { hooks, $ } = await setup();
		const before = requests.current();
		await hooks.get("prompt.submit")?.(
			$,
			submit({ kind: "plugin", name: "blindfold" }),
			nextOf(),
		);
		expect(requests.current()).toBe(before);
	});

	test("R4: session.end clears the request", async () => {
		const { hooks, $ } = await setup();
		await hooks.get("session.end")?.($, { reason: "other" }, async (e) => e);
		expect(requests.current()).toBeUndefined();
	});

	test("R4, R5: a load that finds the name set makes the request ready, and a later load that finds it gone makes it pending", async () => {
		await setup();
		const { api, sets } = fakeApi({ ".env": { text: `${NAME}=${value}\n` } });
		await load(api, enrollment, ".env");
		expect(requests.current()?.state).toBe("ready");
		await load(
			fakeApi({ ".env": { text: "OTHER=1\n" } }).api,
			enrollment,
			".env",
		);
		expect(requests.current()?.state).toBe("pending");
		expect(sets).toEqual([]);
	});
});

describe("R4 (F62) the epoch fence", () => {
	test("R4 (F62): every clear starts a new epoch, also with no open request; ask does not", () => {
		const own = createRequests();
		const first = own.epoch();
		own.clear();
		const second = own.epoch();
		expect(second).not.toBe(first);
		own.ask(NAME, "r");
		expect(own.epoch()).toBe(second);
	});

	test("R4 (F62): a call that started in an older epoch answers from the status and makes no request", async () => {
		const { api } = fakeApi({ ".env": { text: "OTHER=1\n" } });
		const own = createRequests();
		const open = own.ask("OPEN_TOKEN", "kept");
		const stale = own.epoch() - 1;
		const { next, calls } = nextSpy();
		const result = keep(
			await onRequestSecret(
				api,
				createEnrollment(),
				own,
				{ tool: TOOL, tool_use_id: "t62", name: NAME, reason: "r" },
				next,
				".env",
				stale,
			),
		);
		expect(result).toEqual({ result: MISSING_TEXT });
		expect(calls).toEqual([]);
		expect(own.current()).toBe(open);
	});

	/** The registered tool.call guard, with the request hook as its `next`, while the .env read waits on a gate. */
	const waitingCall = async () => {
		enrollment.drop();
		requests.clear();
		const door = gate();
		const { api } = fakeApi({ ".env": { text: "OTHER=1\n", gate: door.wait } });
		const $ = {
			...api,
			plugin: { name: "blindfold", dir: "/plugins/blindfold" },
			ui: { toast: () => {} },
		} as unknown as EngineInterface;
		const hooks = hooksOf(register, { envFiles: ".env" });
		const own = hooks.get(`tool.call ${JSON.stringify({ tool: TOOL })}`);
		const budget = {
			budget: { ms: 10_000, remainingMs: 10_000 },
			called: false,
		};
		const toOwn = Object.assign(
			async (e: unknown) => own?.($, e, nextSpy().next),
			budget,
		);
		const answer = hooks.get("tool.call")?.(
			$,
			{ tool: TOOL, tool_use_id: "t62", name: NAME, reason: "r" },
			toOwn,
		) as Promise<unknown>;
		return { hooks, $, door, answer, budget };
	};

	test("R4 (F62): with no clear, a call that waited in the guard still makes a request", async () => {
		const { door, answer } = await waitingCall();
		door.open();
		expect(await answer).toEqual({ result: MISSING_TEXT });
		expect(requests.current()?.name).toBe(NAME);
	});

	test("R4 (F62): a user prompt while a call waits in the guard means the call makes no request", async () => {
		const { hooks, $, door, answer, budget } = await waitingCall();
		const cleared = hooks.get("prompt.submit")?.(
			$,
			{ text: "hello", wait: false },
			Object.assign(async (e: unknown) => e, budget),
		);
		door.open();
		await cleared;
		expect(await answer).toEqual({ result: MISSING_TEXT });
		expect(requests.current()).toBeUndefined();
	});

	test("R4 (F62): session.end while a call waits in the guard means the call makes no request", async () => {
		const { hooks, $, door, answer } = await waitingCall();
		await hooks.get("session.end")?.($, { reason: "other" }, async (e) => e);
		door.open();
		expect(await answer).toEqual({ result: MISSING_TEXT });
		expect(requests.current()).toBeUndefined();
	});
});

describe("R5 Continue", () => {
	/** A `$` whose submit answers `answer`, and records each submit, toast, and the open request at the submit. */
	const continueApi = (
		answer: () => Promise<PromptSubmitResult>,
		ownRequests: ReturnType<typeof createRequests>,
	) => {
		const submits: PromptSubmitArgs[] = [];
		const toasts: string[] = [];
		const openAtSubmit: (Request | undefined)[] = [];
		const $ = {
			prompt: {
				submit: (args: PromptSubmitArgs) => {
					submits.push(keep(args));
					openAtSubmit.push(ownRequests.current());
					return answer();
				},
			},
			ui: { toast: (text: string) => toasts.push(keep(text)) },
		} as unknown as EngineInterface;
		return { $, submits, toasts, openAtSubmit };
	};
	/** An enrollment that holds `NAME` with `value`, and a ready request for it. */
	const ready = async (text = `${NAME}=${value}\n`) => {
		const own = createEnrollment();
		const ownRequests = createRequests();
		ownRequests.ask(NAME, "r");
		await load(fakeApi({ ".env": { text } }).api, own, ".env");
		ownRequests.sync(own.status());
		return { own, ownRequests, id: ownRequests.current()?.id ?? "" };
	};
	const entered = async (): Promise<PromptSubmitResult> => ({
		text: "entered",
	});

	test("R5: Continue clears the request, then submits 1 turn that tells Claude the name is set", async () => {
		const { own, ownRequests, id } = await ready();
		expect(ownRequests.current()?.state).toBe("ready");
		const { $, submits, toasts, openAtSubmit } = continueApi(
			entered,
			ownRequests,
		);
		await continueRequest($, own, ownRequests, id);
		expect(submits).toEqual([
			{ text: `${NAME} is now set. Continue the task that needed it.` },
		]);
		expect(openAtSubmit).toEqual([undefined]);
		expect(toasts).toEqual([]);
	});

	test("R5 (F53): Continue twice submits once", async () => {
		const { own, ownRequests, id } = await ready();
		const { $, submits } = continueApi(entered, ownRequests);
		await Promise.all([
			continueRequest($, own, ownRequests, id),
			continueRequest($, own, ownRequests, id),
		]);
		await continueRequest($, own, ownRequests, id);
		expect(submits.length).toBe(1);
	});

	test("R5 (F53): Continue when the name is no longer set submits nothing", async () => {
		const { own, ownRequests, id } = await ready();
		await load(fakeApi({ ".env": { text: `${NAME}=\n` } }).api, own, ".env");
		const { $, submits, toasts } = continueApi(entered, ownRequests);
		await continueRequest($, own, ownRequests, id);
		expect(submits).toEqual([]);
		expect(toasts).toEqual([]);
		expect(ownRequests.current()?.state).toBe("pending");
	});

	test("R5 (F80): a Continue drawn for an older request submits nothing and leaves the open one", async () => {
		const { own, ownRequests, id } = await ready();
		const fresh = ownRequests.ask(NAME, "new");
		ownRequests.sync(own.status());
		const { $, submits } = continueApi(entered, ownRequests);
		await continueRequest($, own, ownRequests, id);
		expect(submits).toEqual([]);
		expect(ownRequests.current()?.id).toBe(fresh.id);
	});

	test("R5 (Q38): a dropped Continue shows the toast once and is not retried", async () => {
		const { own, ownRequests, id } = await ready();
		const { $, submits, toasts } = continueApi(
			async () => ({ drop: "the session was stopped" }),
			ownRequests,
		);
		await continueRequest($, own, ownRequests, id);
		expect(submits.length).toBe(1);
		expect(toasts).toEqual([DROPPED_TOAST]);
		expect(DROPPED_TOAST).toBe("Continue was not sent. Ask Claude again.");
		expect(ownRequests.current()).toBeUndefined();
	});

	test("R5: a submit that rejects shows the same toast, and Continue does not reject", async () => {
		const { own, ownRequests, id } = await ready();
		const { $, submits, toasts } = continueApi(
			() => Promise.reject(new Error("host gone")),
			ownRequests,
		);
		await continueRequest($, own, ownRequests, id);
		expect(submits.length).toBe(1);
		expect(toasts).toEqual([DROPPED_TOAST]);
	});
});

describe("R2 (F65) the name and reason scan", () => {
	const contextOnly = "b9Xq7Lm4Rt2Pv8Nw";

	test("R2 (F65): a context-only secret in the reason is hidden in the request, and the arguments stay", async () => {
		const { api } = fakeApi({ ".env": { text: "OTHER=1\n" } });
		const own = createRequests();
		const reason = `password=${contextOnly}`;
		const e = Object.freeze({
			tool: TOOL,
			tool_use_id: "t65",
			name: NAME,
			reason,
		});
		const result = await onRequestSecret(
			api,
			createEnrollment(),
			own,
			e,
			nextSpy().next,
			".env",
		);
		expect(result).toEqual({ result: MISSING_TEXT });
		expect(own.current()?.reason).toBe(REASON_HIDDEN);
		expect(e.reason).toBe(reason);
		expect(JSON.stringify([result, own.current()]).includes(contextOnly)).toBe(
			false,
		);
	});

	test("R2 (F65): a known value in the reason is hidden in the request", async () => {
		const { api } = fakeApi({
			".env": { text: `API_TOKEN=${otherValue}\n` },
		});
		const { result, requests } = await call(api, {
			name: NAME,
			reason: `use ${otherValue} to charge`,
		});
		expect(result).toEqual({ result: MISSING_TEXT });
		expect(requests.current()?.reason).toBe(REASON_HIDDEN);
		expect(
			JSON.stringify([result, requests.current()]).includes(otherValue),
		).toBe(false);
	});

	test("R2 (F65): a vendor-shaped name is denied with a fixed text, and no request is made", async () => {
		const { api } = fakeApi({});
		const own = createRequests();
		const open = own.ask("OPEN_TOKEN", "kept");
		const name = fake.aws;
		expect(validName(name)).toBe(true);
		const { result, calls } = await call(
			api,
			{ name, reason: "r" },
			undefined,
			own,
		);
		expect(result).toEqual({ deny: NAME_SECRET });
		expect(calls).toEqual([]);
		expect(own.current()).toBe(open);
		expect(JSON.stringify([result, own.current()]).includes(name)).toBe(false);
	});

	test("R2 (F65): a clean reason stays in the request", async () => {
		const { api } = fakeApi({ ".env": { text: "OTHER=1\n" } });
		const { requests } = await call(api, {
			name: NAME,
			reason: "to charge the card",
		});
		expect(requests.current()?.reason).toBe("to charge the card");
	});
});

describe("ui R7 (F77) redact after a load", () => {
	const holds = (secret: string) => (text: string) => text.includes(secret);

	test("ui R7 (F77): a reason that now holds a known value becomes the fixed text, and the request stays open with its id", () => {
		const own = createRequests();
		const changes: string[] = [];
		own.watch(() => changes.push("changed"));
		const asked = own.ask(NAME, `use ${value} for the database`);
		const epoch = own.epoch();
		own.redact(holds(value));
		expect(own.current()).toEqual({ ...asked, reason: REASON_HIDDEN });
		expect(own.epoch()).toBe(epoch);
		expect(changes).toEqual(["changed", "changed"]);
	});

	test("ui R7 (F77): a name that now holds a known value clears the request and starts a new epoch", () => {
		const own = createRequests();
		own.ask(NAME, "r");
		const epoch = own.epoch();
		own.redact(holds(NAME));
		expect(own.current()).toBeUndefined();
		expect(own.epoch()).toBe(epoch + 1);
	});

	test("ui R7 (F77): with no hit, or no request, nothing changes", () => {
		const own = createRequests();
		const changes: string[] = [];
		own.watch(() => changes.push("changed"));
		own.redact(holds(value));
		const asked = own.ask(NAME, "to charge the card");
		own.redact(holds(value));
		expect(own.current()).toBe(asked);
		expect(changes).toEqual(["changed"]);
	});
});

describe("R6 no leak", () => {
	test("R6: no tool answer, toast, submit, or request holds a fake value", async () => {
		const { api } = fakeApi({
			".env": { text: `${NAME}=${value}\nAPI_TOKEN=${otherValue}\n` },
		});
		await call(api, { name: NAME, reason: "r" });
		await call(api, { name: "MISSING_KEY", reason: "r" });
		await call(api, { name: "__proto__", reason: "r" });
		expect(seen.length).toBeGreaterThan(20);
		const text = JSON.stringify(seen);
		expect(text.includes(value)).toBe(false);
		expect(text.includes(otherValue)).toBe(false);
	});
});
