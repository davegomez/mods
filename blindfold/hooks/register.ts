import type { Register } from "claude-code";
import { createEnrollment, load } from "./enroll.ts";

/** The session's env files and known values, shared by every hook of this module instance. */
export const enrollment = createEnrollment();

/** R7: the `classic.SessionStart` sources that begin another conversation in the same process. */
const RESTARTS: readonly string[] = ["clear", "resume", "fork"];

export const register: Register = (on, options) => {
	const list = typeof options.envFiles === "string" ? options.envFiles : ".env";

	on("session.start", async ($, e, next) => {
		await load($, enrollment, list);
		return next(e);
	});

	on("classic.SessionStart", async ($, e, next) => {
		if (RESTARTS.includes(e.source)) {
			enrollment.drop();
			await load($, enrollment, list);
		}
		return next(e);
	});

	on("session.end", (_$, e, next) => {
		enrollment.drop();
		return next(e);
	});
};
