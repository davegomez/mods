import type { Register } from "claude-code";
import { createEnrollment, load } from "./enroll.ts";
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
} from "./shield.ts";

/** The session's env files and known values, shared by every hook of this module instance. */
export const enrollment = createEnrollment();

/** R7: the `classic.SessionStart` sources that begin another conversation in the same process. */
const RESTARTS: readonly string[] = ["clear", "resume", "fork"];

export const register: Register = (on, options) => {
	const list = typeof options.envFiles === "string" ? options.envFiles : ".env";
	/** The list `session.end` dropped, since `/clear`, `/resume`, and `/branch` end the session before `classic.SessionStart`. */
	let ended = list;

	on("session.start", async ($, e, next) => {
		await load($, enrollment, list);
		return next(e);
	});

	on("classic.SessionStart", async ($, e, next) => {
		if (RESTARTS.includes(e.source)) {
			// Read before drop, which clears it. An empty list here means session.end ran first; loading more files is the safe side.
			const current = enrollment.listed() || ended;
			enrollment.drop();
			await load($, enrollment, current);
		}
		return next(e);
	}).catch((_$, e, next) => next(e));

	on("session.end", (_$, e, next) => {
		ended = enrollment.listed();
		enrollment.drop();
		return next(e);
	});

	// R4: no matcher, so every tool and every MCP tool is guarded.
	on("tool.call", ($, e, next) =>
		onToolCall($, enrollment, e, next, list),
	).catch(onToolCallCatch);

	// R3, R6 to R10: no matcher, so every prompt, block, section, attachment, skill, and mention is guarded.
	on("prompt.submit", ($, e, next) =>
		onPromptSubmit($, enrollment, e, next, list),
	).catch(onPromptSubmitCatch);
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
};
