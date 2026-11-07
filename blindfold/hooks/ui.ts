/** The user's view of the env files and the open request: pure functions, then the thin hooks (R1 to R3). Nothing here holds a value (R7). */
import type {
	CommandRunResult,
	EngineInterface,
	Hook,
	RenderElement,
	RenderInput,
} from "claude-code";
import {
	addFile,
	type Enrollment,
	ensureLoaded,
	HIDDEN_NAME,
	HIDDEN_PATH,
	load,
	rootOf,
	type Status,
} from "./enroll.ts";
import {
	detectPlatform,
	type Entered,
	enterNative,
	type Method,
	type Platform,
	pickMethod,
} from "./entry.ts";
import {
	continueRequest,
	type Request,
	type Requests,
	redacted,
	validName,
} from "./request.ts";
import { clockFor, guardText, rewriteCounts } from "./shield.ts";
import {
	type GitProbe,
	probeGit,
	type Saved,
	type SaveMode,
	type Step,
	saveValue,
	spellingOk,
} from "./write.ts";

export type Command =
	| { kind: "open" }
	| { kind: "set" | "add"; name: string }
	| { kind: "dismiss" | "refresh" }
	| { kind: "refused" };

/** R1 (Q39, F64): a name or nothing. `holdsValue` tells whether a name holds a known value; a value must not pass as a name. */
export function parseCommand(
	args: string,
	holdsValue: (name: string) => boolean,
): Command {
	const words = args.split(/\s+/).filter((w) => w !== "");
	const [verb, name] = words;
	if (verb === undefined) return { kind: "open" };
	if ((verb === "dismiss" || verb === "refresh") && words.length === 1) {
		return { kind: verb };
	}
	if (
		(verb === "set" || verb === "add") &&
		words.length === 2 &&
		validName(name) &&
		!holdsValue(name)
	) {
		return { kind: verb, name };
	}
	return { kind: "refused" };
}

/** R1 (F64): the only arguments the stored command line may keep. */
export function canonicalArgs(command: Command): string {
	switch (command.kind) {
		case "set":
		case "add":
			return `${command.kind} ${command.name}`;
		case "dismiss":
		case "refresh":
			return command.kind;
		default:
			return "";
	}
}

/** R3, R5 (F74): the last flow result, kept until the next flow, a Dismiss, or a session end. Each field is a name, a listed file, or a fixed word. */
export type Outcome =
	| { kind: "refused" | "added" | "manual"; name: string; file: string }
	| { kind: "denied" | "cleared" | "repaired" | "choose"; name: string }
	| { kind: "not-saved"; name: string; step: Step; reason: string };

/** R5: 1 fixed text per outcome. */
export function outcomeText(outcome: Outcome): string {
	switch (outcome.kind) {
		case "refused":
			return `blindfold cannot use ${outcome.file}: it is outside the project, a link, or not a regular file.`;
		case "denied":
			return "The env file setting was not saved.";
		case "added":
			return `${outcome.file} added. Run /secrets set ${outcome.name}, or ask Claude again.`;
		case "manual":
			return `Add ${outcome.name}= to ${outcome.file} in your editor, then press Refresh.`;
		case "not-saved":
			return `Not saved: step ${outcome.step}, ${outcome.reason}.`;
		case "cleared":
			return "Not saved: the request was cleared.";
		case "repaired":
			return "Saved. The file was readable by others for a moment.";
		case "choose":
			return `No listed env file can take ${outcome.name}. Run /secrets and pick .env or .env.local.`;
	}
}

/** R3: the outcomes where blindfold tried to save and did not. */
const FAILED: ReadonlySet<Outcome["kind"]> = new Set([
	"refused",
	"denied",
	"not-saved",
	"cleared",
]);

/** R3 (Q40, F74): a degraded shield, then a failed outcome, then an open request. */
export function statusLine(
	status: Status,
	request: Request | undefined,
	outcome: Outcome | undefined,
): string | undefined {
	const unread = status.files.find(
		(f) => f.state.kind === "stale" || f.state.kind === "refused",
	);
	if (unread) {
		return `blindfold: degraded, ${unread.path} could not be read. New values may not be hidden.`;
	}
	if (outcome && FAILED.has(outcome.kind)) {
		return `blindfold: ${outcome.name} not saved, run /secrets`;
	}
	if (request) return `blindfold: ${request.name} requested, run /secrets`;
	return undefined;
}

/** write R3: what git says of a listed file, read by `probe` after each load. */
export type GitState = "not-ignored" | "tracked" | "none";

export type Row = {
	name: string;
	file: string;
	state: "Set" | "Requested" | "Empty" | "Missing" | "Stale" | "Refused";
	hidden: boolean;
	gitWarning?: "not-ignored" | "tracked";
	rewrites: number;
};

const FILE_ROW = {
	missing: "Missing",
	stale: "Stale",
	refused: "Refused",
} as const;

/**
 * R4: 1 row per name in each listed file, 1 row with no name for a file that was not read, and the requested name when it is in no file.
 * A stale file shows no names, so it never reads Set (design 1g). F73: a hidden name or path is no identity, so its row is `hidden`.
 */
export function rowsOf(
	status: Status,
	request: Request | undefined,
	counts: ReadonlyMap<string, number>,
	git: ReadonlyMap<string, GitState>,
): Row[] {
	const pending = request?.state === "pending" ? request.name : undefined;
	const rows = status.files.flatMap(({ path, state }): Row[] => {
		const warning = git.get(path);
		const file = {
			file: path,
			...(warning && warning !== "none" ? { gitWarning: warning } : {}),
		};
		const pathHidden = path === HIDDEN_PATH;
		if (state.kind !== "active") {
			const row = { name: "", state: FILE_ROW[state.kind], rewrites: 0 };
			return [{ ...row, ...file, hidden: pathHidden }];
		}
		return state.names.map(({ name, why }) => ({
			name,
			...file,
			state: why !== "empty" ? "Set" : name === pending ? "Requested" : "Empty",
			hidden: pathHidden || name === HIDDEN_NAME,
			// The hidden name is never a key, so it counts 0.
			rewrites: counts.get(name) ?? 0,
		}));
	});
	if (request && !rows.some((r) => r.name === request.name)) {
		rows.push({
			name: request.name,
			file: "",
			state: "Requested",
			hidden: false,
			rewrites: counts.get(request.name) ?? 0,
		});
	}
	return rows;
}

/** R5 step 1: the first listed file that is active, else the first that is missing. A hidden path is no identity (F73). */
export function targetFile(status: Status): string | undefined {
	const usable = status.files.filter((f) => f.path !== HIDDEN_PATH);
	return (
		usable.find((f) => f.state.kind === "active") ??
		usable.find((f) => f.state.kind === "missing")
	)?.path;
}

export const COMMAND = "secrets";

/** R4: the pane's `requestId`. */
export const PANE_ID = "blindfold";

const STATE_WORDS: Record<Row["state"], string> = {
	Set: "Set",
	Requested: "Requested",
	Empty: "Empty",
	Missing: "Missing",
	Stale: "Stale, could not be read",
	Refused: "Refused, blindfold will not read it",
};

const GIT_WORDS = {
	"not-ignored": "not ignored by git",
	tracked: "tracked by git",
} as const;

/** R4, R6: 1 row in words. A hidden row says only why (F73). */
export function rowText(row: Row): string {
	const label =
		row.name === ""
			? row.file
			: row.file === ""
				? row.name
				: `${row.name} in ${row.file}`;
	if (row.hidden) return `${label}: hidden, because it holds a secret value`;
	const n = row.rewrites;
	return [
		`${label}: ${STATE_WORDS[row.state]}`,
		...(row.file === "" ? ["in no listed file"] : []),
		...(row.gitWarning ? [GIT_WORDS[row.gitWarning]] : []),
		...(n > 0 ? [`${n} ${n === 1 ? "result" : "results"} hidden`] : []),
	].join(", ");
}

/** R1. */
export const COMMAND_SPEC = {
	name: COMMAND,
	description: "Enter a secret Claude asked for, or see your env files.",
	argumentHint: "[set NAME | add NAME | dismiss | refresh]",
};

/** R1 (Q39, F74): the toast and the command's own answer. */
export const REFUSED_COMMAND =
	"blindfold: /secrets takes a name, never a value.";

const FAILED_COMMAND = "blindfold: /secrets failed. Run it again.";

/** What a redraw calls: closures over a hook's `$`, since the host refuses a `$` kept in a variable. */
export type Screen = {
	toast(text: string): void;
	status(text: string | undefined): void;
	invalidate(): void;
	gitStates(paths: readonly string[]): Promise<ReadonlyMap<string, GitState>>;
};

/** A function declaration, since the host follows `$` past an import only into one. */
export function screenOf($: EngineInterface): Screen {
	return {
		toast: (text) => $.ui.toast(text),
		status: (text) => $.ui.status(text),
		invalidate: () => $.ui.invalidate("ui.render"),
		gitStates: (paths) => gitStatesOf($, paths),
	};
}

const shownState = (probe: GitProbe): GitState =>
	probe === "tracked" || probe === "not-ignored" ? probe : "none";

/**
 * R4: each listed path's git state by the read-only write R3 commands, in the session root. A hidden path, or one that
 * fails the write R2 spelling, gets no command and no state, so no argv holds a value. A failed command is `none`.
 */
export async function gitStatesOf(
	$: EngineInterface,
	paths: readonly string[],
): Promise<ReadonlyMap<string, GitState>> {
	const root = await rootOf($);
	if (!root) return new Map();
	const asked = paths.filter((p) => p !== HIDDEN_PATH && spellingOk(p));
	const probes = await Promise.all(
		asked.map((p) => probeGit($, root.real, p).catch(() => "failed" as const)),
	);
	return new Map(asked.map((p, i) => [p, shownState(probes[i] ?? "failed")]));
}

/** R3 (F71): the last flow outcome, and the screen that shows a change made where no hook's `$` is at hand (a load, a request change). */
export function createUi(enrollment: Enrollment, requests: Requests) {
	let outcome: Outcome | undefined;
	let screen: Screen | undefined;
	let toasted: string | undefined;
	let git: ReadonlyMap<string, GitState> = new Map();
	let probes = 0;
	/** F71: a redraw for what the status line does not show (git states, counts). It never throws. */
	const repaint = (): void => {
		try {
			screen?.invalidate();
		} catch {
			// The count change or probe that called it goes on.
		}
	};
	const redraw = (): void => {
		if (!screen) return;
		try {
			const request = requests.current();
			if (request && request.id !== toasted) {
				screen.toast(
					`blindfold: Claude asks for ${request.name}. Run /secrets or use the band.`,
				);
			}
			toasted = request?.id;
			screen.status(statusLine(enrollment.status(), request, outcome));
			screen.invalidate();
		} catch {
			// A redraw never breaks the load or the request change that called it.
		}
	};
	return {
		enrollment,
		requests,
		/** The screen of session.start, kept for the redraws that follow. It does not redraw, so it is safe while drawing. */
		bind(next: Screen): void {
			screen = next;
		},
		outcome: (): Outcome | undefined => outcome,
		setOutcome(next: Outcome | undefined): void {
			outcome = next;
			redraw();
		},
		redraw,
		repaint,
		/** R4: read the git state of the listed files, after a load and never in a render. A newer probe wins over an older one still running. */
		probe(): void {
			const mine = ++probes;
			if (!screen) return;
			const paths = enrollment.status().files.map((f) => f.path);
			screen.gitStates(paths).then(
				(states) => {
					if (mine !== probes) return;
					git = states;
					repaint();
				},
				() => undefined,
			);
		},
		git: (): ReadonlyMap<string, GitState> => git,
		/** R5: true while a flow runs; 1 at a time. */
		busy: false,
		/** R5 (F67): session.end adds 1, so a flow that began before it saves nothing. */
		sessions: 0,
	};
}

export type Ui = ReturnType<typeof createUi>;

/** A name or a reason is short (request R2), so its scan needs no deadline. */
const UNTIMED = { now: () => 0, deadline: Number.POSITIVE_INFINITY };

/** R7 (F77): true when `text` holds a value known now, or any other detector hit (request R2). */
const secretIn = (enrollment: Enrollment) => {
	const set = enrollment.knownSet();
	return (text: string) => guardText(text, set, UNTIMED).kind !== "pass";
};

/** R7 (F77): after each load. A value learned since can turn the request or the outcome into a secret. */
export function rescan(ui: Ui): void {
	const isSecret = secretIn(ui.enrollment);
	ui.requests.redact(isSecret);
	const outcome = ui.outcome();
	if (
		outcome &&
		(isSecret(outcome.name) || ("file" in outcome && isSecret(outcome.file)))
	) {
		ui.setOutcome(undefined);
	}
}

/** R2, R4 (F77): the open request as a render may show it now. */
const shownRequest = (ui: Ui): Request | undefined =>
	redacted(ui.requests.current(), secretIn(ui.enrollment));

/**
 * R5 step 1 (Q41, F34): the file choice when no listed file can take a value, else the line to add by hand (`never`,
 * choice 2). Every caller runs after the first load: the command loads first, and the band and the pane rows exist only after one.
 */
export function addByHand(ui: Ui, name: string): string {
	const file = targetFile(ui.enrollment.status());
	const outcome: Outcome = file
		? { kind: "manual", name, file }
		: { kind: "choose", name };
	ui.setOutcome(outcome);
	return outcomeText(outcome);
}

/** R5 step 1 (Q41): the only files offered; a typed name could hold a value (F66). */
export const CHOICES = [".env", ".env.local"] as const;

/** R5: what the flow does outside this module, as closures, so a test passes fakes. */
export type FlowIo = {
	platform(): Promise<Platform>;
	enter(platform: Platform, name: string, reason: string): Promise<Entered>;
	save(path: string, name: string, value: string): Promise<Saved>;
	addFile(path: string): ReturnType<typeof addFile>;
	toast(text: string): void;
};

/** R5: the plugin options the flow reads (entry R1, write R1). */
export type FlowSettings = { method: Method; save: SaveMode };

/** A function declaration, since the host refuses a `$` kept in a variable and follows it past an import only into one. */
export function flowIoOf($: EngineInterface, enrollment: Enrollment): FlowIo {
	return {
		platform: () => detectPlatform($),
		enter: (platform, name, reason) => enterNative($, platform, name, reason),
		save: (path, name, value) => saveValue($, enrollment, path, name, value),
		addFile: (path) => addFile($, enrollment, path),
		toast: (text) => $.ui.toast(text),
	};
}

/** R5: the text a start answers at once, and the end of the flow, which never rejects. */
export type Flow = { text: string; done: Promise<void> };

export const BUSY = "blindfold is already asking for a value.";

const UNAVAILABLE: Entered = { kind: "cancel", why: "unavailable" };

/** R5, R3: keep the outcome, and toast it, since the flow ends after the surface that started it answered. */
function finish(ui: Ui, io: FlowIo, outcome: Outcome | undefined): void {
	ui.setOutcome(outcome);
	try {
		if (outcome) io.toast(outcomeText(outcome));
	} catch {
		// The pane and the status line still hold it (R6).
	}
}

/** R5 (F67): what must not change while the value is out: the request epoch, the request id, and the session. */
const fenceOf = (ui: Ui): string =>
	`${ui.requests.epoch()} ${ui.requests.current()?.id} ${ui.sessions}`;

/**
 * R5: the flow for 1 name, from the command, the band, and the pane, which do not await `done` (the dialog waits up to
 * 300 s). With `ask`, the start is the answer "Enter it" (Q43).
 */
export function startFlow(
	ui: Ui,
	name: string,
	io: FlowIo,
	settings: FlowSettings,
): Flow {
	if (ui.busy) return { text: BUSY, done: Promise.resolve() };
	const file = targetFile(ui.enrollment.status());
	if (!file || settings.save === "never") {
		return { text: addByHand(ui, name), done: Promise.resolve() };
	}
	ui.busy = true;
	// F81: the last outcome belongs to the flow before.
	ui.setOutcome(undefined);
	const request = ui.requests.current();
	const reason =
		(request?.name === name && request.reason) ||
		`blindfold saves it to ${file}.`;
	return {
		text: `blindfold is asking for ${name}.`,
		done: enterAndSave(ui, io, settings.method, name, file, reason),
	};
}

/** R5 steps 3 and 4. The value lives only in `entered`, never in module state, an outcome, or an error (R7). */
async function enterAndSave(
	ui: Ui,
	io: FlowIo,
	method: Method,
	name: string,
	file: string,
	reason: string,
): Promise<void> {
	const fence = fenceOf(ui);
	try {
		const platform = await io.platform();
		const entered =
			pickMethod(method, platform) === "native"
				? await io.enter(platform, name, reason)
				: UNAVAILABLE;
		if (entered.kind === "cancel") {
			// F70: unavailable before the other cancels, which keep the open request (design 1g). F79: only inside the fence.
			if (entered.why === "unavailable" && fenceOf(ui) === fence) {
				finish(ui, io, { kind: "manual", name, file });
			}
			return;
		}
		if (fenceOf(ui) !== fence) return finish(ui, io, { kind: "cleared", name });
		const saved = await io.save(file, name, entered.value);
		if (fenceOf(ui) !== fence) return;
		finish(
			ui,
			io,
			!saved.ok
				? { kind: "not-saved", name, step: saved.step, reason: saved.reason }
				: saved.warning
					? { kind: "repaired", name }
					: undefined,
		);
	} catch {
		// The error is dropped unread: it could hold the value. F79: only inside the fence.
		if (fenceOf(ui) === fence) finish(ui, io, { kind: "manual", name, file });
	} finally {
		ui.busy = false;
	}
}

/** R5 step 1 (Q42, F68, F69): list the chosen file. `added` reloads the module, so the flow stops there. Never rejects. */
export async function chooseFile(
	ui: Ui,
	name: string,
	file: (typeof CHOICES)[number],
	io: FlowIo,
): Promise<void> {
	if (ui.busy) {
		try {
			io.toast(BUSY);
		} catch {
			// Nothing is left to tell the user with.
		}
		return;
	}
	ui.busy = true;
	const fence = fenceOf(ui);
	try {
		const added = await io.addFile(file).catch(() => "denied" as const);
		// F79: a Dismiss or a session end meanwhile keeps the outcome it cleared.
		if (fenceOf(ui) !== fence) return;
		finish(
			ui,
			io,
			added === "denied"
				? { kind: "denied", name }
				: { kind: added, name, file },
		);
	} finally {
		ui.busy = false;
	}
}

/** R5 step 1: the name the pane offers the file choice for, while no listed file can take a value. */
function choiceFor(ui: Ui): string | undefined {
	if (targetFile(ui.enrollment.status())) return undefined;
	const outcome = ui.outcome();
	return outcome?.kind === "choose"
		? outcome.name
		: ui.requests.current()?.name;
}

/** R1, R2: Dismiss clears the request and the outcome. */
function dismiss(ui: Ui): void {
	ui.requests.clear();
	ui.setOutcome(undefined);
}

type CommandRun = Parameters<Hook<"command.run">>;

/** R1 (F64): masks the arguments before it acts, then answers itself. `list` is for the first-use load. */
export async function onCommand(
	$: CommandRun[0],
	ui: Ui,
	e: CommandRun[1],
	next: CommandRun[2],
	list: string,
	settings: FlowSettings,
): Promise<CommandRunResult> {
	await ensureLoaded($, ui.enrollment, list);
	const clock = clockFor(next.budget.remainingMs, () => performance.now());
	const command = parseCommand(
		e.args,
		(name) => guardText(name, ui.enrollment.knownSet(), clock).kind !== "pass",
	);
	// A registered command has no core run, so next answers "no hook answered it": only the masked args go on, and its answer is dropped.
	await next({ ...e, args: canonicalArgs(command) });
	switch (command.kind) {
		case "open":
			await $.ui.open({ id: PANE_ID, title: "blindfold" });
			return {};
		case "set": {
			const io = flowIoOf($, ui.enrollment);
			return { text: startFlow(ui, command.name, io, settings).text };
		}
		case "add":
			return { text: addByHand(ui, command.name) };
		case "dismiss":
			dismiss(ui);
			return { text: "blindfold: nothing is requested now." };
		case "refresh":
			await load($, ui.enrollment, ui.enrollment.listed() || list);
			return { text: "blindfold read the env files again." };
		case "refused":
			$.ui.toast(REFUSED_COMMAND);
			return { text: REFUSED_COMMAND };
	}
}

/** R1 (F64): a failed hook that never called next still masks the arguments, since a skipped hook lets the command run as typed. */
export async function onCommandCatch(
	_$: CommandRun[0],
	e: CommandRun[1],
	next: CommandRun[2] & { called: boolean },
): Promise<CommandRunResult> {
	if (!next.called) await next({ ...e, args: "" });
	return { text: FAILED_COMMAND };
}

type Band = RenderInput<"AbovePrompt">;

/** R2 (F72): 1 line under the other mods' tree while a request is open and no survey holds the band. */
export async function onBand(
	$: EngineInterface,
	ui: Ui,
	e: Band,
	next: (e: Band) => Promise<RenderElement>,
	settings: FlowSettings,
): Promise<RenderElement> {
	if (e.props.hasSurvey || !ui.requests.current()) return next(e);
	const below = await next(e);
	// F80: the request again, since a Dismiss or a new request can come while next draws.
	const request = shownRequest(ui);
	if (!request) return below;
	const { Box, Button, Text } = $.ui.resolve(e);
	const { id, name, reason, state } = request;
	const asks = `Claude asks for ${name}${reason ? `: ${reason.replace(/\.$/, "")}` : ""}.`;
	const button = (
		key: string,
		hotkey: string,
		label: string,
		onPress: () => unknown,
	) =>
		Button({
			key: `blindfold-${key}`,
			hotkey,
			label,
			plain: true,
			// F80: every band button is for the request it was drawn for.
			onPress: () => {
				if (ui.requests.current()?.id === id) void onPress();
			},
		});
	const toast = (text: string) => $.ui.toast(text);
	const file = targetFile(ui.enrollment.status());
	const enter =
		settings.save === "ask" && file
			? `Enter it here (blindfold saves it to ${file})`
			: "Enter it";
	const pending = file
		? [
				button("enter", "1", enter, () =>
					toast(startFlow(ui, name, flowIoOf($, ui.enrollment), settings).text),
				),
				button("add", "2", "Add it myself", () => toast(addByHand(ui, name))),
			]
		: CHOICES.map((choice, i) =>
				button(`use-${choice}`, `${i + 1}`, `Use ${choice}`, () =>
					chooseFile(ui, name, choice, flowIoOf($, ui.enrollment)),
				),
			);
	const buttons =
		state === "ready"
			? [
					button("continue", "4", "Continue", () =>
						continueRequest($, ui.enrollment, ui.requests, id),
					),
					button("dismiss", "3", "Dismiss", () => dismiss(ui)),
				]
			: [...pending, button("dismiss", "3", "Dismiss", () => dismiss(ui))];
	const said =
		state === "ready"
			? `${asks} ${name} is set.`
			: file
				? asks
				: `${asks} No listed env file can take it.`;
	return Box({
		flexDirection: "column",
		children: [
			below,
			Box({
				flexDirection: "row",
				gap: 1,
				children: [Text({ children: said }), ...buttons],
			}),
		],
	});
}

type PaneInput = RenderInput<"Pane">;

const ACTION_FAILED = "blindfold: that action failed. Run /secrets.";

/**
 * R4, R6: the rows, the last outcome, Forget per file, Refresh, and Continue when the request is ready. It reads module
 * state only: the git states come from `ui.probe`, never from a command here. Below 60 columns each row stacks its
 * actions under its text; from 60 they sit beside it. Letter hotkeys on the terminal only, so none clashes with the
 * band's 1 to 4, which can show at the same time.
 */
export async function onPane(
	$: EngineInterface,
	ui: Ui,
	e: PaneInput,
	next: (e: PaneInput) => Promise<RenderElement>,
	list: string,
	settings: FlowSettings,
): Promise<RenderElement> {
	if (e.requestId !== PANE_ID) return next(e);
	const { Box, Button, Text } = $.ui.resolve(e);
	// F77: a name that holds a value known now gives no row and no action.
	const request = shownRequest(ui);
	const status = ui.enrollment.status();
	const rows = rowsOf(status, request, rewriteCounts(), ui.git());
	const direction = e.props.bodyColumns < 60 ? "column" : "row";
	const keyed = e.surface === "terminal";
	const button = (
		key: string,
		label: string,
		onPress: () => unknown,
		hotkey?: string,
	) =>
		Button({
			key,
			label,
			...(keyed && hotkey ? { hotkey, plain: true as const } : {}),
			onPress: () =>
				Promise.resolve()
					.then(onPress)
					.catch(() => $.ui.toast(ACTION_FAILED)),
		});
	/** F80: an action for the request does nothing once another request is open. */
	const forRequest = (act: () => unknown) => (): unknown =>
		ui.requests.current()?.id === request?.id ? act() : undefined;
	let requestedRow = true;
	const actions = (row: Row) => {
		if (row.hidden || row.name === "") return [];
		const requested = requestedRow && row.name === request?.name;
		if (requested) requestedRow = false;
		const start = () =>
			$.ui.toast(
				startFlow(ui, row.name, flowIoOf($, ui.enrollment), settings).text,
			);
		const enter = button(
			`enter:${row.file}:${row.name}`,
			"Enter value",
			requested ? forRequest(start) : start,
			requested ? "e" : undefined,
		);
		if (!requested) return [enter];
		return [
			enter,
			button(
				"dismiss",
				"Dismiss",
				forRequest(() => dismiss(ui)),
				"d",
			),
		];
	};
	const line = (key: string, children: RenderElement[]) =>
		Box({ key, flexDirection: direction, gap: 1, children });
	const outcome = ui.outcome();
	const chosen = choiceFor(ui);
	const files = status.files.filter((f) => f.path !== HIDDEN_PATH);
	return Box({
		flexDirection: "column",
		children: [
			...rows.map((row, i) =>
				line(`row:${i}`, [Text({ children: rowText(row) }), ...actions(row)]),
			),
			...(rows.length === 0
				? [Text({ children: "No names in the listed env files." })]
				: []),
			...(outcome ? [Text({ children: outcomeText(outcome) })] : []),
			...(chosen
				? [
						line("choose", [
							Text({ children: `Pick the env file for ${chosen}:` }),
							...CHOICES.map((choice) =>
								button(
									`use:${choice}`,
									`Use ${choice}`,
									forRequest(() =>
										chooseFile(ui, chosen, choice, flowIoOf($, ui.enrollment)),
									),
								),
							),
						]),
					]
				: []),
			...(files.length > 0
				? [
						line(
							"files",
							files.map((f) =>
								button(`forget:${f.path}`, `Forget ${f.path}`, () =>
									ui.enrollment.forget(f.path),
								),
							),
						),
					]
				: []),
			line("actions", [
				...(request?.state === "ready"
					? [
							button(
								"continue",
								"Continue",
								() =>
									continueRequest($, ui.enrollment, ui.requests, request.id),
								"c",
							),
						]
					: []),
				button(
					"refresh",
					"Refresh",
					() => load($, ui.enrollment, ui.enrollment.listed() || list),
					"r",
				),
			]),
		],
	});
}
