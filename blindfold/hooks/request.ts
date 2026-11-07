/** Claude asks for a secret by name; blindfold answers the name's real state, never a value, and keeps 1 open request. */
import type {
	EngineInterface,
	Hook,
	PromptOrigin,
	ToolCallResult,
	ToolSpec,
} from "claude-code";
import { isValidName } from "./dotenv.ts";
import { type Enrollment, ensureLoaded, type Status } from "./enroll.ts";
import { clockFor, guardText } from "./shield.ts";

export const TOOL_NAME = "request_secret";

/** R1, Q37: not deferred, so Claude sees it without a ToolSearch and asks instead of asking for a paste. */
export const TOOL_SPEC: ToolSpec = {
	name: TOOL_NAME,
	description:
		"Ask the user for a secret, such as an API key, token, or password, by its env variable name. The user enters it outside the chat, and you never see the value. Answers whether the name is set now. Never ask the user to paste a secret in the chat.",
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "The env variable name, such as STRIPE_API_KEY.",
			},
			reason: {
				type: "string",
				description: "Why the task needs it, in 1 short sentence.",
			},
		},
		required: ["name", "reason"],
		additionalProperties: false,
	},
	isDeferred: false,
};

/** R2: the rule, without the name, which could be a value. */
export const NAME_RULE =
	"request_secret refused the name: use letters, digits, and _, start with a letter or _, keep it to 64 characters, and do not use __proto__.";

/** R2 (F65): fixed, so it holds no part of the name. */
export const NAME_SECRET =
	"request_secret refused the name: it looks like a secret. Pass the env variable name, such as STRIPE_API_KEY.";

/** R2 (F65): the request reason when the reason held a detector hit. */
export const REASON_HIDDEN = "(reason hidden: it held a secret)";

export const DROPPED_TOAST = "Continue was not sent. Ask Claude again.";

const MAX_REASON = 120;

/** R2 (F54): the request rule and the rule `dotenv` writes by. */
export function validName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) &&
		isValidName(name)
	);
}

/** R2: no control characters, at most 120 code points. */
export function cleanReason(reason: unknown): string {
	if (typeof reason !== "string") return "";
	return [...reason.replace(/\p{Cc}/gu, "")].slice(0, MAX_REASON).join("");
}

/** R3: the first active file where `name` has a value that is not empty. */
function setIn(name: string, status: Status): string | undefined {
	return status.files.find(
		({ state }) =>
			state.kind === "active" &&
			state.names.some((n) => n.name === name && n.why !== "empty"),
	)?.path;
}

/** R3: a name and a file path, never a value. */
export function statusText(name: string, status: Status): string {
	const path = setIn(name, status);
	const text =
		path === undefined
			? `${name} is not set. The user was asked to enter it. End your turn. Do not ask the user to paste it in chat.`
			: `${name} is set in ${path}. Use it by name through the app's env loader.`;
	return status.shield === "degraded"
		? `${text} blindfold cannot confirm the env file now.`
		: text;
}

export type Request = {
	id: string;
	name: string;
	reason: string;
	state: "pending" | "ready";
};

/** R4: at most 1 open request. Each clear starts a new epoch (F62). */
export function createRequests() {
	let open: Request | undefined;
	let epoch = 0;
	let changed = () => {};
	const sync = (status: Status): void => {
		if (open) {
			const state = setIn(open.name, status) ? "ready" : "pending";
			if (state !== open.state) {
				open = { ...open, state };
				changed();
			}
		}
	};
	return {
		/** R4: supersedes any open request. */
		ask(name: string, reason: string): Request {
			open = { id: crypto.randomUUID(), name, reason, state: "pending" };
			changed();
			return open;
		},
		/** R4 (F53): ready while the status shows the name set in an active file, else pending. */
		sync,
		/** R5 (F53): the request once, only when the status shows its name set; it is cleared before any submit. */
		consume(status: Status): Request | undefined {
			sync(status);
			const ready = open?.state === "ready" ? open : undefined;
			if (ready) {
				open = undefined;
				changed();
			}
			return ready;
		},
		clear(): void {
			const had = open;
			open = undefined;
			epoch++;
			if (had) changed();
		},
		/** ui R3 (F71): `listener` runs after each change of the open request. 1 listener; a 2nd replaces it. */
		watch(listener: () => void): void {
			changed = listener;
		},
		/** R4 (F62): a call that started in an older epoch makes no request. */
		epoch(): number {
			return epoch;
		},
		current(): Request | undefined {
			return open;
		},
	};
}

export type Requests = ReturnType<typeof createRequests>;

/** R4: a prompt blindfold submitted itself is not the user's. */
export const isOwnPrompt = (origin: PromptOrigin | undefined, plugin: string) =>
	origin?.kind === "plugin" && origin.name === plugin;

type ToolCall = Parameters<Hook<"tool.call">>;

/**
 * R1, R3: answers the call itself, since a call no hook answers fails. `list` is for the first-use load (F46).
 * R4 (F62): `epoch` is the one the call started in, taken before the chain's first await.
 */
export async function onRequestSecret(
	$: ToolCall[0],
	enrollment: Enrollment,
	requests: Requests,
	e: ToolCall[1],
	next: { budget: { remainingMs: number } },
	list: string,
	epoch = requests.epoch(),
): Promise<ToolCallResult> {
	await ensureLoaded($, enrollment, list);
	const { name, reason } = e as Record<string, unknown>;
	if (!validName(name)) return { deny: NAME_RULE };
	// R2 (F65): every rule kind, and a scan that cannot finish counts as a hit.
	const clean = (text: string) =>
		guardText(
			text,
			enrollment.knownSet(),
			clockFor(next.budget.remainingMs, () => performance.now()),
		).kind === "pass";
	if (!clean(name)) return { deny: NAME_SECRET };
	const status = enrollment.status();
	if (epoch === requests.epoch() && setIn(name, status) === undefined) {
		const cut = cleanReason(reason);
		// The raw reason too, so a secret the cut splits is still found.
		const safe = clean(cut) && (typeof reason !== "string" || clean(reason));
		requests.ask(name, safe ? cut : REASON_HIDDEN);
	}
	return { result: statusText(name, status) };
}

/** R5: from a button handler, never a hook, because the submit waits for an idle session. Never rejects. No retry (Q38). */
export async function continueRequest(
	$: EngineInterface,
	enrollment: Enrollment,
	requests: Requests,
): Promise<void> {
	const request = requests.consume(enrollment.status());
	if (!request) return;
	const out = await $.prompt
		.submit({
			text: `${request.name} is now set. Continue the task that needed it.`,
		})
		.catch(() => ({ drop: "failed" }));
	if (out.drop === undefined) return;
	try {
		$.ui.toast(DROPPED_TOAST);
	} catch {
		// Nothing is left to tell the user with.
	}
}
