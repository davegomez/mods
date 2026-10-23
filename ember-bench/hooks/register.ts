import type {
	EngineInterface,
	ModelForkResult,
	ProcessRunResult,
	Register,
	Timer,
} from "claude-code";

import type { Ember } from "./bench.ts";
import {
	ARM_PREFIX,
	armKey,
	bunCandidates,
	EMBER,
	emberOf,
	forkRecord,
	INGEST_EVERY_MS,
	limitsOf,
	OFF,
	OFF_FORK,
	offRefusal,
	sessionRecord,
	UNKNOWN_EMBER,
	USAGE,
} from "./bench.ts";
import type { BenchRecord } from "./record.ts";
import { isRecord, isSessionId } from "./record.ts";

type Live = { timer?: Timer; ember: Ember; isSeen: boolean };

const scriptOf = ($: EngineInterface) => `${$.plugin.root}/scripts/bench.ts`;

const debug = ($: EngineInterface, text: string) =>
	$.ui.log(`ember-bench: ${text}`, { to: "debug" });

/** Starts the script and does not wait for it; tries each bun in turn until one starts. */
function spawnScript($: EngineInterface, args: readonly string[]): void {
	void (async () => {
		for (const bun of bunCandidates(await $.env.get("HOME"))) {
			try {
				for await (const _ of $.process.spawn({
					argv: [bun, scriptOf($), ...args],
				})) {
					// Drained so the child never blocks on a full pipe.
				}
				return;
			} catch {
				// Not startable here: try the next bun.
			}
		}
		debug($, "could not start bun");
	})().catch(() => debug($, "could not start bun"));
}

/** Runs the script and waits for its output; tries each bun in turn until one starts. */
async function runScript(
	$: EngineInterface,
	args: readonly string[],
): Promise<ProcessRunResult> {
	let failure: unknown;
	for (const bun of bunCandidates(await $.env.get("HOME"))) {
		try {
			return await $.process.run([bun, scriptOf($), ...args], {
				timeoutMs: 60_000,
			});
		} catch (e) {
			failure = e;
		}
	}
	throw failure;
}

function send($: EngineInterface, r: BenchRecord): void {
	if (isRecord(r)) spawnScript($, ["record", JSON.stringify(r)]);
	else debug($, "refused an invalid record");
}

const isOffNow = async ($: EngineInterface, session: string) =>
	(await $.store.get(armKey(session))) === OFF;

async function recordSession($: EngineInterface, live: Live): Promise<void> {
	const session = await $.session.id();
	if (!isSessionId(session)) return debug($, "the session id is no UUID");
	const [isOff, version, usage, pluginConfigs] = await Promise.all([
		isOffNow($, session),
		$.session.version(),
		$.session.usage(),
		$.settings.read({ key: "pluginConfigs" }).catch(() => undefined),
	]);
	send(
		$,
		sessionRecord({
			session,
			startedMs: usage.startedAt,
			isOff,
			ccVersion: version.version,
			ember: live.ember,
			pluginConfigs,
		}),
	);
}

function start($: EngineInterface, live: Live): void {
	live.timer?.cancel();
	spawnScript($, ["ingest"]);
	live.timer = $.clock.every(INGEST_EVERY_MS, () => spawnScript($, ["ingest"]));
	recordSession($, live).catch(() => debug($, "could not record the session"));
}

/** Marks, once per load, that ember's calls pass through ember-bench: the proof it runs before ember. */
async function noteSeen($: EngineInterface, live: Live): Promise<void> {
	if (live.isSeen) return;
	live.isSeen = true;
	debug($, "saw a call from ember");
	try {
		const session = await $.session.id();
		send($, { kind: "seen", session, atMs: await $.clock.now() });
	} catch {
		debug($, "could not record a call from ember");
	}
}

const limitsNow = async ($: EngineInterface) =>
	limitsOf((await $.session.usage().catch(() => undefined))?.rateLimits);

async function benchOff($: EngineInterface, live: Live): Promise<string> {
	const session = await $.session.id();
	if (!isSessionId(session)) return "ember-bench: this session has no id yet.";
	const refusal = offRefusal(
		await $.session.turns(),
		await isOffNow($, session),
	);
	if (refusal !== undefined) return refusal;
	await $.store.set(armKey(session), OFF);
	await recordSession($, live);
	return "ember-bench: this session is off. Ember's cache refreshes are refused here, and no refresh request is sent.";
}

async function benchStatus($: EngineInterface): Promise<string> {
	const session = await $.session.id();
	if (!isSessionId(session)) return "ember-bench: this session has no id yet.";
	const arm = `arm: ${(await isOffNow($, session)) ? "off" : "on"}`;
	try {
		const out = await runScript($, ["status", session]);
		return out.exitCode === 0
			? `ember-bench\n${arm}\n${out.stdout.trimEnd()}`
			: `ember-bench\n${arm}\nThe database could not be read.`;
	} catch {
		return `ember-bench\n${arm}\nbun could not be started.`;
	}
}

async function benchDelete($: EngineInterface): Promise<string> {
	let answer: string;
	try {
		answer = await $.ui.ask("Delete all ember-bench data?", ["Delete", "Keep"]);
	} catch {
		answer = "Keep";
	}
	if (answer !== "Delete") return "ember-bench: Nothing was deleted.";
	try {
		const out = await runScript($, ["delete"]);
		if (out.exitCode !== 0) return "ember-bench: the delete failed.";
	} catch {
		return "ember-bench: bun could not be started; nothing was deleted.";
	}
	// The current session keeps its arm: it cannot be chosen again after the first prompt.
	const keep = armKey(await $.session.id());
	for (const key of await $.store.keys())
		if (key.startsWith(ARM_PREFIX) && key !== keep) await $.store.delete(key);
	return "ember-bench: all collected data was deleted. The next ingest collects the transcripts again.";
}

export const register: Register = (on) => {
	const live: Live = { ember: UNKNOWN_EMBER, isSeen: false };

	on("plugin.register", { name: "ember" }, (_, e, next) => {
		live.ember = emberOf(e);
		return next(e);
	});

	on("session.start", async ($, e, next) => {
		start($, live);
		await $.command
			.register({
				name: "bench",
				description:
					"ember-bench: switch this session off before its first prompt, show status, or delete all data",
				argumentHint: "off | status | delete",
				immediate: true,
			})
			.catch(() => debug($, "/bench is taken; it is not available"));
		return next(e);
	});

	// session.start does not fire after /clear, /resume or /branch; this does.
	on(
		"classic.SessionStart",
		{ source: ["clear", "resume", "fork"] },
		($, e, next) => {
			start($, live);
			return next(e);
		},
	).catch((_, e, next) => next(e));

	on("model.fork", async ($, e, next) => {
		if (next.origin.plugin !== EMBER) return next(e);
		void noteSeen($, live);
		const session = await $.session.id();
		const firedMs = await $.clock.now();
		if (await isOffNow($, session)) {
			const none = limitsOf(undefined);
			send(
				$,
				forkRecord({
					session,
					firedMs,
					durationMs: 0,
					result: OFF_FORK,
					isOff: true,
					before: none,
					after: none,
				}),
			);
			return { value: OFF_FORK };
		}
		const before = await limitsNow($);
		const r = await next(e);
		if ("value" in r && r.value !== undefined) {
			const result: ModelForkResult = r.value;
			void (async () => {
				const [endMs, after] = await Promise.all([$.clock.now(), limitsNow($)]);
				send(
					$,
					forkRecord({
						session,
						firedMs,
						durationMs: endMs - firedMs,
						result,
						isOff: false,
						before,
						after,
					}),
				);
			})().catch(() => debug($, "could not record a fork"));
		}
		return r;
		// A failure before next refuses ember's fork: an off session must never send one, and ember retries in 30 s.
	}).catch((_, e, next) =>
		next.called || next.origin.plugin !== EMBER ? next(e) : { value: OFF_FORK },
	);

	on("ui.open", ($, e, next) => {
		if (next.origin.plugin === EMBER) void noteSeen($, live);
		return next(e);
	});

	on("command.run", { command: "ember-probe" }, async ($, e, next) => {
		void (async () => {
			const session = await $.session.id();
			send($, { kind: "probe", session, atMs: await $.clock.now() });
		})().catch(() => debug($, "could not record a probe"));
		return next(e);
	});

	on("command.run", { command: "bench" }, async ($, e) => {
		const arg = e.args.trim();
		const text =
			arg === "off"
				? await benchOff($, live)
				: arg === "status"
					? await benchStatus($)
					: arg === "delete"
						? await benchDelete($)
						: USAGE;
		return { text };
	});
};
