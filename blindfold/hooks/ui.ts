/** The user's view of the env files and the open request. This part is pure; the hooks come in T21 to T23. Nothing here holds a value (R7). */
import { HIDDEN_NAME, HIDDEN_PATH, type Status } from "./enroll.ts";
import { type Request, validName } from "./request.ts";
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
