import type {
	AgentSpawnResult,
	CatchHandler,
	ConfigSetResult,
	EngineInterface,
	Hook,
	PromptAttachmentResult,
	PromptContextResult,
	PromptMentionResult,
	PromptSectionResult,
	PromptSubmitResult,
	SessionReceiveResult,
	SessionSendResult,
	SkillPromptResult,
	ToolCallResult,
} from "claude-code";
import type { Clock, Hit, KnownSet, Scan, Unscannable } from "./detect.ts";
import { DEFAULT_LIMITS, scanText, scanValue } from "./detect.ts";
import {
	ENV_FILES_KEY,
	type Enrollment,
	ensureLoaded,
	load,
	parseList,
	refreshIfNamed,
} from "./enroll.ts";

export type Verdict<T> =
	| { kind: "pass" }
	| { kind: "rewrite"; value: T; count: number }
	| { kind: "stop"; reason: Unscannable["reason"] };
/** R4: tool arguments are never rewritten (P2), so a hit that counts refuses the call. */
export type ArgsVerdict =
	| { kind: "pass" }
	| { kind: "refuse" }
	| { kind: "stop"; reason: Unscannable["reason"] };

/** R2: the time a hook keeps for its answer after the scan. */
const RESERVE_MS = 1000;

const expired = (clock: Clock) => clock.now() >= clock.deadline;
const stop = (reason: Unscannable["reason"]) =>
	({ kind: "stop", reason }) as const;
const unscannable = (reason: Unscannable["reason"]): Unscannable => ({
	status: "unscannable",
	reason,
});

function verdict<T>(scan: Scan<T>): Verdict<T> {
	if (scan.status === "clean") return { kind: "pass" };
	if (scan.status === "unscannable") return stop(scan.reason);
	return { kind: "rewrite", value: scan.value, count: scan.hits.length };
}

const isIndex = (key: string, length: number) =>
	/^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length;

/**
 * F41: whatever JSON would lose from the copy while `pass` forwards the original is not plain:
 * a Map, a typed array, or a class (written as `{}`), a symbol key, an array property that is not
 * an index, a key that is not enumerable, a function or a symbol value, and an own `toJSON`.
 * A getter is not plain either, since it may answer the scan and the host differently.
 */
function isPlain(object: object): boolean {
	if (Object.getOwnPropertySymbols(object).length > 0) return false;
	const proto = Object.getPrototypeOf(object);
	const isArray = Array.isArray(object);
	if (
		isArray
			? proto !== Array.prototype
			: proto !== Object.prototype && proto !== null
	) {
		return false;
	}
	const length = isArray ? (object as unknown[]).length : 0;
	return Object.entries(Object.getOwnPropertyDescriptors(object)).every(
		([key, field]) =>
			(isArray && key === "length") ||
			(field.enumerable === true &&
				"value" in field &&
				typeof field.value !== "function" &&
				typeof field.value !== "symbol" &&
				(!isArray || isIndex(key, length))),
	);
}

/**
 * R1: a JSON round trip, and the keys whose value is undefined, which JSON leaves out of an object.
 * A cycle, a BigInt, a throwing `toJSON`, or an object that is not plain gives undefined.
 */
function plainCopy(
	value: unknown,
): { value: unknown; dropped: string[] } | undefined {
	const dropped: string[] = [];
	try {
		const json = JSON.stringify(
			value,
			function (this: Record<string, unknown>, key, field: unknown) {
				// The holder is plain, so this reads data. `field` is what toJSON gave, so the object itself is checked.
				const raw = this[key];
				if (typeof raw === "object" && raw !== null && !isPlain(raw)) {
					throw new TypeError("not plain");
				}
				if (raw === undefined && !Array.isArray(this)) dropped.push(key);
				return field;
			},
		);
		return json === undefined
			? undefined
			: { value: JSON.parse(json), dropped };
	} catch {
		// The error may hold a value, so it is dropped.
		return undefined;
	}
}

function scanPlain(value: unknown, set: KnownSet, clock: Clock): Scan<unknown> {
	// JSON writes nothing for undefined, and undefined holds no text, so it is scanned as it is.
	const copy = value === undefined ? { value, dropped: [] } : plainCopy(value);
	if (copy === undefined) return unscannable("unsupported");
	// The copy is not timed, so the clock is read after it.
	if (expired(clock)) return unscannable("deadline");
	const scan = scanValue(copy.value, set, DEFAULT_LIMITS, clock);
	if (scan.status === "unscannable" || copy.dropped.length === 0) return scan;
	// F41: the original still holds these keys, so they are scanned too. They stay out of a rewrite copy, as their values are undefined.
	const keys = scanValue(copy.dropped, set, DEFAULT_LIMITS, clock);
	if (keys.status !== "found") return keys.status === "clean" ? scan : keys;
	return scan.status === "found"
		? { ...scan, hits: [...scan.hits, ...keys.hits] }
		: { status: "found", value: copy.value, hits: keys.hits };
}

function scanTimed(text: string, set: KnownSet, clock: Clock): Scan<string> {
	// A short text never reads the clock in the scan, so it is read here.
	if (expired(clock)) return unscannable("deadline");
	return scanText(text, set, DEFAULT_LIMITS, clock);
}

export function guardText(
	text: string,
	set: KnownSet,
	clock: Clock,
): Verdict<string> {
	return verdict(scanTimed(text, set, clock));
}

export function guardValue(
	value: unknown,
	set: KnownSet,
	clock: Clock,
): Verdict<unknown> {
	return verdict(scanPlain(value, set, clock));
}

/** Q30: only a context rule hit may pass. Any other hit refuses, a rule added later too. */
const refuses = (hit: Hit) =>
	hit.kind === "known" || !hit.rule.startsWith("context:");

export function guardArgs(
	args: unknown,
	set: KnownSet,
	clock: Clock,
): ArgsVerdict {
	const scan = scanPlain(args, set, clock);
	if (scan.status === "unscannable") return stop(scan.reason);
	return scan.status === "found" && scan.hits.some(refuses)
		? { kind: "refuse" }
		: { kind: "pass" };
}

/** R2: `now` and the deadline are in milliseconds. An unmetered budget (Infinity) never stops. */
export function clockFor(remainingMs: number, now: () => number): Clock {
	const deadline = now() + remainingMs - RESERVE_MS;
	// NaN would never expire, so it fails closed.
	return { now, deadline: Number.isNaN(deadline) ? -Infinity : deadline };
}

/** R4, P3: tells Claude what to do instead. It holds no value and no name (R15). */
export const REFUSED_ARGS =
	"blindfold refused this call because its arguments hold a secret value. Refer to the secret by its env variable name, for example $NAME in a shell command, and never write the value itself.";

const unscannedArgs = (reason: string) =>
	`blindfold refused this call (${reason}): it could not scan the arguments. Shorten or split the call.`;
const withheld = (reason: string) => ({
	deny: `blindfold withheld this result (${reason}). Narrow the call.`,
});

/** R5 (F45): the model reads `<tool> ran, and a plugin withheld its result: <text>` (d.ts:13883), so this starts the text. */
export const MASKED_ERROR =
	"blindfold masked secrets in its error output, which follows:";

type ToolCall = Parameters<Hook<"tool.call">>;

/** R2: `performance.now` is monotonic, so a wall-clock change cannot move the deadline. */
const clockOf = (next: { budget: { remainingMs: number } }) =>
	clockFor(next.budget.remainingMs, () => performance.now());

/** R4: the tool's own arguments, without the keys the engine reserves. */
function argsOf(e: ToolCall[1]): Record<string, unknown> {
	const { tool, tool_use_id, agentId, ...args } = e as Record<string, unknown>;
	return args;
}

type Scanned = { result?: unknown; context?: string[]; text?: string };

/**
 * R5 (Q26): a success is a copy without `ref` and `text`, so core maps the scanned `result` again.
 * F45: core checks an error copy against the success shape and rejects it, so an error is a deny.
 */
function rewritten(
	from: { isError?: true; isReadOnly?: true; text?: string },
	scanned: Scanned,
): ToolCallResult {
	if (from.isError) {
		const masked =
			from.text !== undefined
				? scanned.text
				: typeof scanned.result === "string"
					? scanned.result
					: JSON.stringify(scanned.result);
		return { deny: `${MASKED_ERROR}\n${masked ?? ""}` };
	}
	return {
		result: scanned.result,
		...(scanned.context === undefined ? {} : { context: scanned.context }),
		...(from.isReadOnly ? { isReadOnly: true } : {}),
	} as ToolCallResult;
}

/** ui R4: per known name, the tool results the shield rewrote in this session. Numbers only, in memory. */
const rewrites = new Map<string, number>();

/** ui R4: a read-only view for the pane. */
export const rewriteCounts = (): ReadonlyMap<string, number> => rewrites;

/** ui R4: at session end. */
export const resetRewriteCounts = (): void => rewrites.clear();

let counted = () => {};

/** ui R3 (F71): `listener` runs after each count change and must not throw. 1 listener; a 2nd replaces it. */
export const watchRewrites = (listener: () => void): void => {
	counted = listener;
};

/** ui R4 (F75): 1 per distinct name with a `known` hit, not 1 per hit. */
function countRewrite(hits: readonly Hit[]): void {
	const names = new Set(
		hits.flatMap((h) => (h.kind === "known" ? [h.name] : [])),
	);
	for (const name of names) rewrites.set(name, (rewrites.get(name) ?? 0) + 1);
	if (names.size > 0) counted();
}

/** R5: scan what `next` returned with the set as it is now. */
function guardResult(out: ToolCallResult, set: KnownSet, clock: Clock) {
	const scan: Scan<unknown> =
		out.deny !== undefined
			? scanTimed(out.deny, set, clock)
			: // F37: `text` is what the model reads, so a hit there alone must rewrite too.
				scanPlain(
					{ result: out.result, context: out.context, text: out.text },
					set,
					clock,
				);
	if (scan.status === "unscannable") return withheld(scan.reason);
	// pass keeps the same object, so core keeps `ref`.
	if (scan.status === "clean") return out;
	countRewrite(scan.hits);
	return out.deny !== undefined
		? { deny: scan.value as string }
		: rewritten(out, scan.value as Scanned);
}

/** R4, R5: every tool, MCP tools too. `enrollment` and `list` are parameters, because `register.ts` owns them and imports this module. */
export async function onToolCall(
	$: ToolCall[0],
	enrollment: Enrollment,
	e: ToolCall[1],
	next: ToolCall[2],
	list: string,
): Promise<ToolCallResult> {
	await ensureLoaded($, enrollment, list);
	await refreshIfNamed($, enrollment, e);
	const before = guardArgs(argsOf(e), enrollment.knownSet(), clockOf(next));
	if (before.kind === "refuse") return { deny: REFUSED_ARGS };
	if (before.kind === "stop") return { deny: unscannedArgs(before.reason) };
	// P2: the arguments go on unchanged.
	const out = await next(e);
	// The call may have written a listed file.
	await refreshIfNamed($, enrollment, e);
	return guardResult(out, enrollment.knownSet(), clockOf(next));
}

/** R5, P5: the handler has 1 s, so it does not scan. */
export const onToolCallCatch: CatchHandler<Hook<"tool.call">> = (
	_$,
	_e,
	next,
) =>
	next.called
		? { deny: "blindfold withheld this result." }
		: { deny: "blindfold refused this call." };

/** R15 (Q32): stands in for a refusal text from below that could not be scanned. */
export const unscannedBelow = (reason: string) =>
	`blindfold withheld a refusal text it could not scan (${reason}).`;

/** R15 (Q32): the refusal text at `key` of what `next` answered, masked; the same object when clean or absent. */
function maskBelow<R extends object>(
	out: R,
	key: keyof R & string,
	set: KnownSet,
	clock: Clock,
): R {
	const text = out[key];
	if (typeof text !== "string") return out;
	const verdict = guardText(text, set, clock);
	if (verdict.kind === "pass") return out;
	return {
		...out,
		[key]:
			verdict.kind === "rewrite"
				? verdict.value
				: unscannedBelow(verdict.reason),
	};
}

type Args<
	E extends
		| "prompt.submit"
		| "prompt.context"
		| "prompt.section"
		| "prompt.attachment"
		| "skill.prompt"
		| "prompt.mention"
		| "agent.spawn"
		| "session.send"
		| "session.receive"
		| "session.append"
		| "config.set",
> = Parameters<Hook<E>>;

/** F38: a toast is shown after `next`, so a throw from it must not reach the `.catch`, which would call `next` again with the unmasked `e`. */
function toast($: EngineInterface, text: string): void {
	try {
		$.ui.toast(text);
	} catch {
		// The masked item already stands.
	}
}

/** R3, Q29, P3: the host would not apply a text rewrite, so the prompt cannot go on masked. */
export const PINNED_PROMPT = {
	drop: "blindfold dropped this prompt because it holds a secret value, and this kind of prompt cannot be masked. Refer to the secret by its env variable name, and send it again.",
};

const unscannedPrompt = (reason: string) => ({
	drop: `blindfold dropped this prompt (${reason}): it could not scan it. Shorten it, and send it again.`,
});

/** R15: a count only. */
const hidToast = (count: number) =>
	`blindfold hid ${count} secret${count === 1 ? "" : "s"} in your prompt`;

/** R3: `text` and `context` are scanned together, so the toast counts both. Media in `attachments` is not scanned. R15 (Q32): a drop from below stands as `next` gave it, since a changed drop after next fails the hook (d.ts:9843). */
export async function onPromptSubmit(
	$: Args<"prompt.submit">[0],
	enrollment: Enrollment,
	e: Args<"prompt.submit">[1],
	next: Args<"prompt.submit">[2],
	list: string,
): Promise<PromptSubmitResult> {
	await ensureLoaded($, enrollment, list);
	const verdict = guardValue(
		{ text: e.text, context: e.context },
		enrollment.knownSet(),
		clockOf(next),
	);
	if (verdict.kind === "pass") return next(e);
	if (verdict.kind === "stop") return unscannedPrompt(verdict.reason);
	const copy = verdict.value as { text: string; context?: string[] };
	// Q29: the host applies no text rewrite to a slash command (d.ts:9744), nor to a meta prompt that starts a turn (isMeta).
	if ((e.command || e.isMeta) && copy.text !== e.text) return PINNED_PROMPT;
	const out = await next({ ...e, ...copy });
	// After next, so the toast tells of a prompt that entered.
	if (out.drop === undefined) toast($, hidToast(verdict.count));
	return out;
}

/** R3, P5: a drop after next would fail the hook, so the prompt that entered stands. */
export const onPromptSubmitCatch: CatchHandler<Hook<"prompt.submit">> = (
	_$,
	e,
	next,
) =>
	next.called
		? next(e)
		: { drop: "blindfold dropped this prompt because its check failed." };

/**
 * R6: scans the blocks `next` answers, which is what the model reads. A rewritten
 * `claudeMd` text makes the files behind it unknown to the host, so `instructionFiles` is left out.
 */
export async function onPromptContext(
	$: Args<"prompt.context">[0],
	enrollment: Enrollment,
	e: Args<"prompt.context">[1],
	next: Args<"prompt.context">[2],
	list: string,
): Promise<PromptContextResult> {
	await ensureLoaded($, enrollment, list);
	const out = await next(e);
	const set = enrollment.knownSet();
	const clock = clockOf(next);
	let changed = false;
	const blocks = out.blocks.flatMap((block) => {
		// F39: the name renders as `# name` (d.ts:8916) but routes the block, so it is not rewritten: a hit or a stop leaves the block out.
		const name = guardText(block.name, set, clock);
		const verdict =
			name.kind === "pass" ? guardText(block.text, set, clock) : name;
		if (verdict.kind === "pass") return [block];
		changed = true;
		return verdict.kind === "rewrite" && name.kind === "pass"
			? [{ ...block, text: verdict.value }]
			: [];
	});
	return changed ? { blocks } : out;
}

/** R6, P5: no block is sent. */
export const onPromptContextCatch: CatchHandler<
	Hook<"prompt.context">
> = () => ({
	blocks: [],
});

/** R7 to R9: the `{ text }` that `next` answers, masked, or `withheld` when it cannot be scanned. */
function maskAnswer<R extends { text: string | null }>(
	out: R,
	set: KnownSet,
	clock: Clock,
	withheld: R,
): R {
	if (out.text === null) return out;
	const verdict = guardText(out.text, set, clock);
	if (verdict.kind === "pass") return out;
	return verdict.kind === "rewrite"
		? { ...out, text: verdict.value }
		: withheld;
}

/** R7: the section's text is core's own (d.ts:9643), so the answer of `next` is scanned. */
export async function onPromptSection(
	$: Args<"prompt.section">[0],
	enrollment: Enrollment,
	e: Args<"prompt.section">[1],
	next: Args<"prompt.section">[2],
	list: string,
): Promise<PromptSectionResult> {
	await ensureLoaded($, enrollment, list);
	const out = await next(e);
	return maskAnswer(out, enrollment.knownSet(), clockOf(next), { text: null });
}

export const onPromptSectionCatch: CatchHandler<
	Hook<"prompt.section">
> = () => ({
	text: null,
});

/** R8: only what goes to the model. R13 covers the stored row. */
export async function onPromptAttachment(
	$: Args<"prompt.attachment">[0],
	enrollment: Enrollment,
	e: Args<"prompt.attachment">[1],
	next: Args<"prompt.attachment">[2],
	list: string,
): Promise<PromptAttachmentResult> {
	await ensureLoaded($, enrollment, list);
	const out = await next(e);
	return maskAnswer(out, enrollment.knownSet(), clockOf(next), { text: null });
}

export const onPromptAttachmentCatch: CatchHandler<
	Hook<"prompt.attachment">
> = () => ({ text: null });

const WITHHELD_SKILL = { text: "blindfold withheld this skill text." };

/** R9: the result type allows no null, so a text it cannot scan is replaced. */
export async function onSkillPrompt(
	$: Args<"skill.prompt">[0],
	enrollment: Enrollment,
	e: Args<"skill.prompt">[1],
	next: Args<"skill.prompt">[2],
	list: string,
): Promise<SkillPromptResult> {
	await ensureLoaded($, enrollment, list);
	const out = await next(e);
	return maskAnswer(out, enrollment.knownSet(), clockOf(next), WITHHELD_SKILL);
}

export const onSkillPromptCatch: CatchHandler<Hook<"skill.prompt">> = () =>
	WITHHELD_SKILL;

/** R10, R15: holds no path and no name. */
export const REFUSED_MENTION = {
	deny: "blindfold refused this mention because the file is an env file. Ask for its variable names, never its values.",
};

/** Segments joined by `/`, without empty and `.` segments, in lower case: `./a\b` and `/r/a//b` end the same. Lower case refuses more on a case-sensitive disk, which is the safe side. */
const segments = (path: string) =>
	path
		.replaceAll("\\", "/")
		.split("/")
		.filter((s) => s !== "" && s !== ".")
		.join("/")
		.toLowerCase();

/**
 * Q27: a `.env` or `.env.*` base name, or a path that ends with a listed entry at a segment boundary.
 * `e.path` is absolute and the list is relative to the root, so a suffix match is used; it refuses
 * the same entry under another folder too, which is the safe side.
 */
function isEnvFile(path: string, list: string): boolean {
	const target = segments(path);
	const base = target.slice(target.lastIndexOf("/") + 1);
	if (base === ".env" || base.startsWith(".env.")) return true;
	return parseList(list).some((entry) => {
		const listed = segments(entry.path);
		return (
			listed !== "" && (target === listed || target.endsWith(`/${listed}`))
		);
	});
}

/**
 * R10 (Q27): other files pass, and R8 scans their text. R15 (Q32): a deny from below is masked, since a deny after next holds (d.ts:9450).
 * R10 (F44, Q33): a context from below cannot be changed (d.ts:9439), so a hit or a stop in it refuses.
 */
export async function onPromptMention(
	$: Args<"prompt.mention">[0],
	enrollment: Enrollment,
	e: Args<"prompt.mention">[1],
	next: Args<"prompt.mention">[2],
	list: string,
): Promise<PromptMentionResult> {
	await ensureLoaded($, enrollment, list);
	if (isEnvFile(e.path, enrollment.listed())) return REFUSED_MENTION;
	const out = await next(e);
	const set = enrollment.knownSet();
	const clock = clockOf(next);
	if (
		out.context !== undefined &&
		guardValue(out.context, set, clock).kind !== "pass"
	)
		return REFUSED_MENTION;
	return maskBelow(out, "deny", set, clock);
}

/** R10, P5: a deny after next still holds, since the host forgets a read already made (d.ts:9427). */
export const onPromptMentionCatch: CatchHandler<Hook<"prompt.mention">> = () =>
	REFUSED_MENTION;

/** R11, P3, R15: holds no value and no name. */
export const REFUSED_SPAWN = {
	deny: "blindfold refused this agent because its task holds a secret value. Refer to the secret by its env variable name, and never write the value itself.",
};

/** R11: the task is scanned before the agent starts; it has no masked form, so a hit refuses. R15 (Q32): a deny from below stands as `next` gave it, since a deny after next fails the hook (d.ts:450). */
export async function onAgentSpawn(
	$: Args<"agent.spawn">[0],
	enrollment: Enrollment,
	e: Args<"agent.spawn">[1],
	next: Args<"agent.spawn">[2],
	list: string,
): Promise<AgentSpawnResult> {
	await ensureLoaded($, enrollment, list);
	const verdict = guardValue(
		{ prompt: e.prompt, description: e.description },
		enrollment.knownSet(),
		clockOf(next),
	);
	if (verdict.kind === "pass") return next(e);
	return verdict.kind === "rewrite"
		? REFUSED_SPAWN
		: {
				deny: `blindfold refused this agent (${verdict.reason}): it could not scan its task. Shorten it.`,
			};
}

/** R11, P5: a deny after next would fail the hook (d.ts:447), so the agent that started stands. */
export const onAgentSpawnCatch: CatchHandler<Hook<"agent.spawn">> = (
	_$,
	e,
	next,
) =>
	next.called
		? next(e)
		: { deny: "blindfold refused this agent because its check failed." };

/** R12, P3, R15: the model reads `reason` as the tool's result. */
export const REFUSED_SEND = {
	isDelivered: false,
	reason:
		"blindfold refused this message because it holds a secret value. Refer to the secret by its env variable name, and never write the value itself.",
} as const;

/** R12: a refusal is valid only without next (d.ts:12559). */
export async function onSessionSend(
	$: Args<"session.send">[0],
	enrollment: Enrollment,
	e: Args<"session.send">[1],
	next: Args<"session.send">[2],
	list: string,
): Promise<SessionSendResult> {
	await ensureLoaded($, enrollment, list);
	const verdict = guardText(e.text, enrollment.knownSet(), clockOf(next));
	if (verdict.kind === "pass") {
		// R15 (Q32): the model reads a reason from below as the tool's result.
		const out = await next(e);
		return maskBelow(out, "reason", enrollment.knownSet(), clockOf(next));
	}
	return verdict.kind === "rewrite"
		? REFUSED_SEND
		: {
				isDelivered: false,
				reason: `blindfold refused this message (${verdict.reason}): it could not scan it. Shorten it.`,
			};
}

/** R12, P5: after next the message is queued, so what next gave stands. */
export const onSessionSendCatch: CatchHandler<Hook<"session.send">> = (
	_$,
	e,
	next,
) =>
	next.called
		? next(e)
		: {
				isDelivered: false,
				reason: "blindfold refused this message because its check failed.",
			};

export const WITHHELD_DELIVERY = {
	consumed: "blindfold withheld a message it could not scan.",
};

/** R12 (Q28): a hit is masked, not consumed, so the model still reads the message. */
export async function onSessionReceive(
	$: Args<"session.receive">[0],
	enrollment: Enrollment,
	e: Args<"session.receive">[1],
	next: Args<"session.receive">[2],
	list: string,
): Promise<SessionReceiveResult> {
	await ensureLoaded($, enrollment, list);
	const verdict = guardText(e.text, enrollment.knownSet(), clockOf(next));
	if (verdict.kind === "stop") return WITHHELD_DELIVERY;
	const out = await next(
		verdict.kind === "rewrite" ? { ...e, text: verdict.value } : e,
	);
	// R15 (Q32): the host logs a consumed text from below.
	return maskBelow(out, "consumed", enrollment.knownSet(), clockOf(next));
}

/** R12, P5: after next the delivery is queued as next was given it, so that stands. */
export const onSessionReceiveCatch: CatchHandler<Hook<"session.receive">> = (
	_$,
	e,
	next,
) => (next.called ? next(e) : WITHHELD_DELIVERY);

export const WITHHELD_CONTENT = "[blindfold withheld this content]";

/** R13, R15: no count, no name. */
export const ROTATE_TOAST =
	"blindfold hid a secret that an earlier check missed. Rotate it.";

type Append = Args<"session.append">;
type Block = Append[1]["message"]["content"][number];

const PASS = { kind: "pass" } as const;

/** R13: media may be dropped or moved, not changed (d.ts:11510). */
const isMedia = (block: Block) =>
	block.type === "image" || block.type === "document";

/** Guards each item; the copy keeps every item that passed. A stop in 1 item stops all. */
function guardEach<B>(
	items: readonly B[],
	guard: (item: B) => Verdict<B>,
): Verdict<B[]> {
	let count = 0;
	const value: B[] = [];
	for (const item of items) {
		const verdict = guard(item);
		if (verdict.kind === "stop") return verdict;
		if (verdict.kind === "rewrite") count += verdict.count;
		value.push(verdict.kind === "rewrite" ? verdict.value : item);
	}
	return count > 0 ? { kind: "rewrite", value, count } : PASS;
}

/** R13: a text block and a tool_result's content (a string or blocks). The host puts back thinking, tool_use, and unknown kinds, so they are not scanned. */
function guardBlock(block: Block, set: KnownSet, clock: Clock): Verdict<Block> {
	if (block.type === "text") {
		return guardValue(block, set, clock) as Verdict<Block>;
	}
	if (block.type !== "tool_result") return PASS;
	const verdict = Array.isArray(block.content)
		? guardEach(block.content as Block[], (inner) =>
				isMedia(inner)
					? PASS
					: (guardValue(inner, set, clock) as Verdict<Block>),
			)
		: guardValue(block.content, set, clock);
	return verdict.kind === "rewrite"
		? { ...verdict, value: { ...block, content: verdict.value } }
		: verdict;
}

/** R13, P5: each text block and each tool_result content withheld, without a scan; media and the kinds the host puts back stay. */
function withheldRow(e: Append[1]): Append[1] {
	const content = e.message.content.map((block) => {
		if (block.type === "text") return { type: "text", text: WITHHELD_CONTENT };
		return block.type === "tool_result"
			? { ...block, content: WITHHELD_CONTENT }
			: block;
	});
	return { ...e, message: { ...e.message, content } };
}

/** R13: the 2nd scan before a row is stored. The host skips a hook that answers without next, so every path calls it. */
export async function onSessionAppend(
	$: Append[0],
	enrollment: Enrollment,
	e: Append[1],
	next: Append[2],
	list: string,
) {
	await ensureLoaded($, enrollment, list);
	const set = enrollment.knownSet();
	const clock = clockOf(next);
	const verdict = guardEach(e.message.content, (block) =>
		guardBlock(block, set, clock),
	);
	if (verdict.kind === "pass") return next(e);
	if (verdict.kind === "stop") return next(withheldRow(e));
	const out = await next({
		...e,
		message: { ...e.message, content: verdict.value },
	});
	toast($, ROTATE_TOAST);
	return out;
}

/** R13, P5: before next the row is withheld; after next the row that was stored stands. */
export const onSessionAppendCatch: CatchHandler<Hook<"session.append">> = (
	_$,
	e,
	next,
) => next(next.called ? e : withheldRow(e));

/** R14 (enroll R7): the list next wrote is loaded at once, so a new file is guarded before the plugin reloads. */
export async function onConfigSet(
	$: Args<"config.set">[0],
	enrollment: Enrollment,
	e: Args<"config.set">[1],
	next: Args<"config.set">[2],
): Promise<ConfigSetResult> {
	const out = await next(e);
	if (e.key === ENV_FILES_KEY && typeof out.value === "string") {
		await load($, enrollment, out.value);
	}
	return out;
}
