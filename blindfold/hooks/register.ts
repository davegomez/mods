import type { Register } from "claude-code";
import { createEnrollment, load } from "./enroll.ts";
import {
	createRequests,
	isOwnPrompt,
	onRequestSecret,
	TOOL_NAME,
	TOOL_SPEC,
} from "./request.ts";
import {
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
	resetRewriteCounts,
	watchRewrites,
} from "./shield.ts";
import {
	COMMAND,
	COMMAND_SPEC,
	createUi,
	type FlowSettings,
	onBand,
	onCommand,
	onCommandCatch,
	onPane,
	screenOf,
} from "./ui.ts";

/** The session's env files and known values, shared by every hook of this module instance. */
export const enrollment = createEnrollment();

/** request R4: the 1 open request; a module reload starts with none. */
export const requests = createRequests();

/** ui R3: the last flow outcome, and the redraw after each change. */
export const ui = createUi(enrollment, requests);

// request R4, R5: every load, restart, and forget syncs the request, whoever started it. ui R3 (F71): then the status line and a redraw.
// ui R4: then the git state of the listed files, which redraws again when it comes.
enrollment.watch(() => {
	if (requests.current()) requests.sync(enrollment.status());
	ui.redraw();
	ui.probe();
});
requests.watch(ui.redraw);
// ui R3 (F71): a rewrite count the pane shows changed.
watchRewrites(ui.repaint);

const TOOL = `mcp__blindfold__${TOOL_NAME}`;

/** request R4 (F62): the epoch each request_secret call started in, by its tool_use_id, else by its event. */
const startedIn = new Map<unknown, number>();

/** R7: the `classic.SessionStart` sources that begin another conversation in the same process. */
const RESTARTS: readonly string[] = ["clear", "resume", "fork"];

/** An option the user set, or `fallback` when it is none of `allowed`. */
const oneOf = <T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
): T => allowed.find((a) => a === value) ?? fallback;

export const register: Register = (on, options) => {
	const list = typeof options.envFiles === "string" ? options.envFiles : ".env";
	/** ui R5: the defaults are the manifest's. */
	const settings: FlowSettings = {
		method: oneOf(options.inputMethod, ["auto", "native", "terminal"], "auto"),
		save: oneOf(options.saveToEnvFile, ["ask", "always", "never"], "ask"),
	};
	/** The list `session.end` dropped, since `/clear`, `/resume`, and `/branch` end the session before `classic.SessionStart`. */
	let ended = list;

	on("session.start", async ($, e, next) => {
		ui.bind(screenOf($));
		await load($, enrollment, list);
		await $.tool.register(TOOL_SPEC);
		await $.command.register(COMMAND_SPEC);
		return next(e);
	});

	on("classic.SessionStart", async ($, e, next) => {
		if (RESTARTS.includes(e.source)) {
			ui.bind(screenOf($));
			// Read before drop, which clears it. An empty list here means session.end ran first; loading more files is the safe side.
			const current = enrollment.listed() || ended;
			enrollment.drop();
			await load($, enrollment, current);
		}
		return next(e);
	}).catch((_$, e, next) => next(e));

	on("session.end", (_$, e, next) => {
		requests.clear();
		ui.setOutcome(undefined);
		// ui R5 (F67): a flow that began in this session saves nothing after it.
		ui.sessions++;
		resetRewriteCounts();
		ended = enrollment.listed();
		enrollment.drop();
		return next(e);
	});

	// R4: no matcher, so every tool and every MCP tool is guarded.
	// request R4 (F62): the epoch is taken here, before the guard's first await.
	on("tool.call", async ($, e, next) => {
		const key = e.tool_use_id ?? e;
		if (e.tool === TOOL) startedIn.set(key, requests.epoch());
		try {
			return await onToolCall($, enrollment, e, next, list);
		} finally {
			startedIn.delete(key);
		}
	}).catch(onToolCallCatch);

	// request R1: after the guard above, so the guard scans its arguments and its answer.
	on("tool.call", { tool: TOOL }, ($, e, next) =>
		onRequestSecret(
			$,
			enrollment,
			requests,
			e,
			next,
			list,
			startedIn.get(e.tool_use_id ?? e),
		),
	);

	// R3, R6 to R10: no matcher, so every prompt, block, section, attachment, skill, and mention is guarded.
	// request R4: a user prompt clears the request first; blindfold's own Continue and /secrets, which answers the request, do not.
	on("prompt.submit", ($, e, next) => {
		if (!isOwnPrompt(e.origin, $.plugin.name) && e.command?.name !== COMMAND) {
			requests.clear();
		}
		return onPromptSubmit($, enrollment, e, next, list);
	}).catch(onPromptSubmitCatch);
	on("prompt.context", ($, e, next) =>
		onPromptContext($, enrollment, e, next, list),
	).catch(onPromptContextCatch);
	on("prompt.section", ($, e, next) =>
		onPromptSection($, enrollment, e, next, list),
	).catch(onPromptSectionCatch);
	on("prompt.attachment", ($, e, next) =>
		onPromptAttachment($, enrollment, e, next, list),
	).catch(onPromptAttachmentCatch);
	on("skill.prompt", ($, e, next) =>
		onSkillPrompt($, enrollment, e, next, list),
	).catch(onSkillPromptCatch);
	on("prompt.mention", ($, e, next) =>
		onPromptMention($, enrollment, e, next, list),
	).catch(onPromptMentionCatch);

	// R11 to R13: no matcher, so every agent, message, and stored row is guarded.
	on("agent.spawn", ($, e, next) =>
		onAgentSpawn($, enrollment, e, next, list),
	).catch(onAgentSpawnCatch);
	on("session.send", ($, e, next) =>
		onSessionSend($, enrollment, e, next, list),
	).catch(onSessionSendCatch);
	on("session.receive", ($, e, next) =>
		onSessionReceive($, enrollment, e, next, list),
	).catch(onSessionReceiveCatch);
	on("session.append", ($, e, next) =>
		onSessionAppend($, enrollment, e, next, list),
	).catch(onSessionAppendCatch);

	// R14: observes only, and refuses nothing, so it needs no .catch: a failed hook is skipped and the row is written.
	on("config.set", ($, e, next) => onConfigSet($, enrollment, e, next));

	// ui R1 (F64): the .catch masks the arguments too, since a skipped hook lets the command run as typed.
	on("command.run", { command: COMMAND }, ($, e, next) =>
		onCommand($, ui, e, next, list, settings),
	).catch(onCommandCatch);

	// ui R2: the band, shared with other mods.
	on("ui.render", { component: "AbovePrompt" }, ($, e, next) =>
		onBand($, ui, e, next, settings),
	);

	// ui R4: the pane /secrets opens; another mod's pane passes.
	on("ui.render", { component: "Pane" }, ($, e, next) =>
		onPane($, ui, e, next, list, settings),
	);
};
