import type { Register } from "claude-code";
import { createEnrollment, load } from "./enroll.ts";
import { onToolCall, onToolCallCatch } from "./shield.ts";

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
	on("tool.call", ($, e, next) => onToolCall($, enrollment, e, next)).catch(
		onToolCallCatch,
	);
};
