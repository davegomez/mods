/** The user's view of the env files and the open request: pure functions, then the thin hooks (R1 to R3). Nothing here holds a value (R7). */
import type {
	CommandRunResult,
	EngineInterface,
	Hook,
	RenderElement,
	RenderInput,
} from "claude-code";
import {
	type Enrollment,
	ensureLoaded,
	HIDDEN_NAME,
	HIDDEN_PATH,
	load,
	type Status,
} from "./enroll.ts";
import {
	continueRequest,
	type Request,
	type Requests,
	validName,
} from "./request.ts";
import { clockFor, guardText } from "./shield.ts";
import type { Step } from "./write.ts";

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
	| { kind: "denied" | "cleared" | "repaired"; name: string }
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

/** write R3: what git says of a listed file. T22 fills it after each load. */
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
};

/** A function declaration, since the host follows `$` past an import only into one. */
export function screenOf($: EngineInterface): Screen {
	return {
		toast: (text) => $.ui.toast(text),
		status: (text) => $.ui.status(text),
		invalidate: () => $.ui.invalidate("ui.render"),
	};
}

/** R3 (F71): the last flow outcome, and the screen that shows a change made where no hook's `$` is at hand (a load, a request change). */
export function createUi(enrollment: Enrollment, requests: Requests) {
	let outcome: Outcome | undefined;
	let screen: Screen | undefined;
	let toasted: string | undefined;
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
	};
}

export type Ui = ReturnType<typeof createUi>;

/** R5 (`never`, choice 2): the line to add by hand, kept as the outcome. */
export function addByHand(ui: Ui, name: string): string {
	// shortcut: with no active or missing listed file this names .env; T23 asks for .env or .env.local (R5 step 1).
	const file = targetFile(ui.enrollment.status()) ?? ".env";
	const outcome: Outcome = { kind: "manual", name, file };
	ui.setOutcome(outcome);
	return outcomeText(outcome);
}

/** R5: the flow for 1 name, from the command and the band. */
export function startFlow(ui: Ui, name: string): string {
	// shortcut: shows the line to add by hand, with no dialog and no save; T23 replaces it with the R5 flow.
	return addByHand(ui, name);
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
			await $.ui.open({ id: "blindfold", title: "blindfold" });
			return {};
		case "set":
			return { text: startFlow(ui, command.name) };
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
): Promise<RenderElement> {
	const request = ui.requests.current();
	if (e.props.hasSurvey || !request) return next(e);
	const below = await next(e);
	const { Box, Button, Text } = $.ui.resolve(e);
	const { name, reason, state } = request;
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
			onPress: () => void onPress(),
		});
	const toast = (text: string) => $.ui.toast(text);
	const buttons =
		state === "ready"
			? [
					button("continue", "4", "Continue", () =>
						continueRequest($, ui.enrollment, ui.requests),
					),
					button("dismiss", "3", "Dismiss", () => dismiss(ui)),
				]
			: [
					button("enter", "1", "Enter it", () => toast(startFlow(ui, name))),
					button("add", "2", "Add it myself", () => toast(addByHand(ui, name))),
					button("dismiss", "3", "Dismiss", () => dismiss(ui)),
				];
	return Box({
		flexDirection: "column",
		children: [
			below,
			Box({
				flexDirection: "row",
				gap: 1,
				children: [
					Text({
						children: state === "ready" ? `${asks} ${name} is set.` : asks,
					}),
					...buttons,
				],
			}),
		],
	});
}
