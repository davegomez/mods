import type {
	EngineInterface,
	ModelForkResult,
	Register,
	Timer,
	TurnStepInput,
	TurnStepResult,
} from "claude-code";

import { analyze } from "./analysis.ts";
import { pane } from "./pane.tsx";
import type {
	End,
	Fired,
	IdleCompactInputs,
	Judged,
	Pause,
	RefreshConfig,
	RefreshState,
} from "./refresh.ts";
import {
	applyRefresh,
	COLD_READ_SHARE,
	closePause,
	effectiveTtl,
	emptyRefresh,
	idleCompactionApplies,
	idleCompactionLapsed,
	isIdleCompactionEvidence,
	isRefreshPlanned,
	judgeFork,
	openPause,
	parseIdleSeen,
	planRefresh,
	REFRESH_PROMPT,
	refreshConfig,
	skipCode,
} from "./refresh.ts";
import type { Agg, Main, StatusView, Ttl } from "./stats.ts";
import {
	emptyAgg,
	emptyMain,
	keysToPrune,
	mergeAggs,
	noteCompaction,
	observe,
	parseAgg,
	percent,
	report,
	resolveTtl,
	statusText,
	tokens,
	validTtlMinutes,
	warning,
	withLive,
	withRefreshLive,
	withSavedPct,
	withTtl,
} from "./stats.ts";

const KEY_PREFIX = "session:";
/** Store-wide, read by every session: when idle compaction was last seen running on this machine. */
const IDLE_KEY = "idleCompactionSeenMs";
const PANE = "ember";
const REFRESH_PANE = "ember-refresh";

type Tab = "session" | "all";

type Live = {
	optionMinutes: number;
	ttl: Ttl;
	agg: Agg;
	main: Main;
	/** The measured session's store key; undefined until its aggregate is read. */
	key?: string;
	/** Bumped at each session bind; a sample started under an older one is dropped. */
	gen: number;
	isInFlight: boolean;
	/** What the status line shows now; null until the first refresh sets or clears it. */
	shown: string | undefined | null;
	/** The main request start the cold warning was last shown for. */
	warnedStartMs?: number;
	timer?: Timer;
	/** The latest unsaved aggregate per key, written one `store.set` at a time. */
	pending: Map<string, Agg>;
	isWriting: boolean;
	/** The other sessions' aggregates, read when the pane opens and when tab 2 is pressed. */
	others: Agg[];
	tab: Tab;
	config: RefreshConfig;
	idle: IdleCompactInputs;
	/** The store-wide idle compaction evidence as last read or written; undefined: not seen. */
	idleSeenMs?: number;
	isInteractive: boolean;
	/** The running main turn, from its `turn.start` to its `turn.complete`. */
	turnId?: string;
	/** Main-conversation compactions running now: no refresh starts while one may replace the prefix. */
	compacting: number;
	/** ember's own fork while it runs, with the steps that reached `turn.step` meanwhile. */
	refreshing?: Fired;
	/** The clock at the last tick, for the places that cannot wait for it. */
	nowMs: number;
};

const stateOf = (live: Live): RefreshState => live.agg.refresh ?? emptyRefresh;
const ttlOf = (live: Live, state = live.agg.refresh): Ttl =>
	effectiveTtl(live.ttl, state);

/** Re-reads the store-wide evidence, never awaited by a hook; a local write that lands meanwhile wins. */
async function readIdleSeen($: EngineInterface, live: Live): Promise<void> {
	const before = live.idleSeenMs;
	try {
		const seen = parseIdleSeen(await $.store.get(IDLE_KEY));
		if (live.idleSeenMs !== before || seen === before) return;
		live.idleSeenMs = seen;
		$.ui.invalidate("ui.render");
	} catch {
		$.ui.log("ember: could not read idle compaction evidence", { to: "debug" });
	}
}

/** Sets or clears the store-wide evidence; never awaited. */
function writeIdleSeen(
	$: EngineInterface,
	live: Live,
	seenMs: number | undefined,
): void {
	live.idleSeenMs = seenMs;
	const write =
		seenMs === undefined
			? $.store.delete(IDLE_KEY)
			: $.store.set(IDLE_KEY, seenMs);
	write.catch(() =>
		$.ui.log("ember: could not save idle compaction evidence", { to: "debug" }),
	);
}

/** Closes the pause; one left to idle compaction that outlasted its time with none seen clears the evidence. */
function close(
	$: EngineInterface,
	live: Live,
	s: RefreshState,
	end: End,
	atMs: number,
): RefreshState {
	if (
		s.pause !== undefined &&
		idleCompactionLapsed(s.pause, s.pause.returnMs ?? atMs)
	)
		writeIdleSeen($, live, undefined);
	return closePause(s, end, atMs);
}

/** Binds the current session: its key, its stored aggregate or an empty one, and a fresh main thread. */
async function bind($: EngineInterface, live: Live): Promise<void> {
	endPause($, live, "exit", live.nowMs);
	const gen = ++live.gen;
	live.key = undefined;
	live.agg = emptyAgg(0);
	live.main = emptyMain;
	live.others = [];
	live.turnId = undefined;
	$.ui.invalidate("ui.render");
	try {
		const key = `${KEY_PREFIX}${await $.session.id()}`;
		const stored =
			parseAgg(await $.store.get(key)) ?? emptyAgg(await $.clock.now());
		if (gen !== live.gen) return;
		live.key = key;
		// A pause left open by a process that ended without a session end: an exit at its last write.
		const open = stored.refresh?.pause;
		live.agg =
			open === undefined || stored.refresh === undefined
				? stored
				: {
						...stored,
						refresh: close(
							$,
							live,
							stored.refresh,
							"exit",
							Math.max(open.startMs, stored.updatedAt),
						),
					};
		if (live.agg !== stored) save($, live);
	} catch {
		$.ui.log("ember: could not load its stats", { to: "debug" });
	}
}

/** Reads the TTL and idle compaction inputs; each read that fails counts as unset, so the next rule applies. */
async function readTtl($: EngineInterface, live: Live): Promise<void> {
	const unset = () => undefined;
	const [
		force5m,
		envTtl,
		settingTtl,
		enable1h,
		idleSetting,
		autoCompact,
		disableAuto,
		minTokens,
	] = await Promise.all([
		$.env.get("FORCE_PROMPT_CACHING_5M").catch(unset),
		$.env.get("CLAUDE_CODE_PROMPT_CACHE_TTL").catch(unset),
		$.settings.read({ key: "promptCacheTtl" }).catch(unset),
		$.env.get("ENABLE_PROMPT_CACHING_1H").catch(unset),
		$.settings.read({ key: "idleCompaction" }).catch(unset),
		$.settings.read({ key: "autoCompactEnabled" }).catch(unset),
		$.env.get("DISABLE_AUTO_COMPACT").catch(unset),
		$.env.get("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS").catch(unset),
	]);
	live.ttl = resolveTtl({
		...(force5m === undefined ? {} : { force5m }),
		...(envTtl === undefined ? {} : { envTtl }),
		settingTtl,
		...(enable1h === undefined ? {} : { enable1h }),
		optionMinutes: live.optionMinutes,
	});
	live.idle = {
		setting: idleSetting,
		autoCompact,
		...(disableAuto === undefined ? {} : { disableAuto }),
		...(minTokens === undefined ? {} : { minTokens }),
	};
}

async function prune($: EngineInterface, live: Live): Promise<void> {
	try {
		const entries: [string, unknown][] = [];
		for (const key of await $.store.keys()) {
			if (key.startsWith(KEY_PREFIX))
				entries.push([key, await $.store.get(key)]);
		}
		for (const key of keysToPrune(entries, live.key, await $.clock.now()))
			await $.store.delete(key);
	} catch {
		$.ui.log("ember: could not prune its stats", { to: "debug" });
	}
}

/** Queues the current aggregate; never awaited, so no hook waits for the store. */
function save($: EngineInterface, live: Live): void {
	if (live.key === undefined) return;
	live.pending.set(live.key, live.agg);
	flush($, live);
}

/** Writes the oldest pending key's latest aggregate, then the next, with one `store.set` in flight. */
function flush($: EngineInterface, live: Live): void {
	const first = live.pending.entries().next();
	if (live.isWriting || first.done === true) return;
	const [key, agg] = first.value;
	live.pending.delete(key);
	live.isWriting = true;
	$.store
		.set(key, agg)
		.catch(() => $.ui.log("ember: could not save its stats", { to: "debug" }))
		.finally(() => {
			live.isWriting = false;
			flush($, live);
		});
}

/** Puts the TTL into the stored live state; saves only when it changed. */
function applyTtl($: EngineInterface, live: Live): void {
	const agg = withTtl(live.agg, ttlOf(live).minutes);
	if (agg === live.agg) return;
	live.agg = agg;
	save($, live);
}

/** Sets the refresh state with the live fields the status line reads, then saves. */
function setRefresh(
	$: EngineInterface,
	live: Live,
	state: RefreshState,
	nowMs: number,
): void {
	const agg = withRefreshLive(
		{
			...live.agg,
			updatedAt: Math.max(live.agg.updatedAt, nowMs),
			refresh: state,
		},
		state.pause?.refreshes ?? 0,
		state.saved,
	);
	live.agg = withTtl(agg, ttlOf(live, state).minutes);
	save($, live);
}

/** Closes an open pause (an exit, or a return whose warmth is unknown). */
function endPause(
	$: EngineInterface,
	live: Live,
	end: End,
	nowMs: number,
): void {
	const s = stateOf(live);
	if (s.pause === undefined || live.key === undefined) return;
	setRefresh(
		$,
		live,
		close($, live, s, end, Math.max(s.pause.startMs, nowMs)),
		nowMs,
	);
}

async function record(
	$: EngineInterface,
	live: Live,
	e: TurnStepInput,
	result: TurnStepResult,
	startedMs: number,
	gen: number,
): Promise<void> {
	try {
		const endedMs = await $.clock.now();
		if (gen !== live.gen) return;
		const before = live.agg;
		const out = observe(live.agg, live.main, {
			...(e.agentId === undefined ? {} : { agentId: e.agentId }),
			index: e.index,
			startedMs,
			endedMs,
			usage: result.usage,
			toolNames: result.toolUses.map((use) => use.name),
		});
		live.agg =
			out.main === live.main
				? out.agg
				: withLive(out.agg, out.main, ttlOf(live).minutes);
		live.main = out.main;
		// The first main step after the person came back tells whether the cache was still warm.
		const p = stateOf(live).pause;
		let state = stateOf(live);
		if (e.agentId === undefined && p?.returnMs !== undefined) {
			const read = result.usage?.cache_read_input_tokens;
			const end: End =
				read === undefined
					? "unknown"
					: read >= COLD_READ_SHARE * p.prefix
						? "warm"
						: "cold";
			state = close($, live, state, end, endedMs);
			live.agg = { ...live.agg, refresh: state };
		}
		live.agg = withSavedPct(
			withRefreshLive(live.agg, state.pause?.refreshes ?? 0, state.saved),
		);
		if (live.agg !== before) {
			save($, live);
			$.ui.invalidate("ui.render");
		}
	} catch {
		$.ui.log("ember: could not record a sample", { to: "debug" });
	}
}

async function compacted(
	$: EngineInterface,
	live: Live,
	isIdle: boolean,
): Promise<void> {
	try {
		const nowMs = await $.clock.now();
		const out = noteCompaction(live.agg, live.main, nowMs);
		live.agg = out.agg;
		live.main = out.main;
		// A new transcript replaces the cached prefix: refreshing the old one would buy nothing. A pause left to
		// idle compaction keeps its reason when that compaction ran, or after a return, so /ember-refresh can replay it.
		const p = stateOf(live).pause;
		if (
			p !== undefined &&
			(p.skip !== skipCode("idle compaction") ||
				(!isIdle && p.returnMs === undefined))
		)
			live.agg = {
				...live.agg,
				refresh: {
					...stateOf(live),
					pause: { ...p, skip: skipCode("compacted") },
				},
			};
		save($, live);
	} catch {
		$.ui.log("ember: could not record a compaction", { to: "debug" });
	}
}

/** Records idle compaction seen in the open pause, there and store-wide. */
async function idleCompacted(
	$: EngineInterface,
	live: Live,
	pauseStartMs: number,
): Promise<void> {
	try {
		const nowMs = await $.clock.now();
		writeIdleSeen($, live, nowMs);
		const s = stateOf(live);
		if (s.pause?.startMs === pauseStartMs)
			setRefresh(
				$,
				live,
				{ ...s, pause: { ...s.pause, idleCompactMs: nowMs } },
				nowMs,
			);
	} catch {
		$.ui.log("ember: could not record an idle compaction", { to: "debug" });
	}
}

/** Opens the pause after a main turn ends; a return the turn's steps did not settle closes as unknown first. */
function turnEnded(
	$: EngineInterface,
	live: Live,
	isAborted: boolean,
	nowMs: number,
): void {
	let s = stateOf(live);
	if (s.pause !== undefined) s = close($, live, s, "unknown", nowMs);
	const { lastStartMs, lastEndMs, lastPrefix = 0 } = live.main;
	if (lastStartMs !== undefined && lastEndMs !== undefined) {
		const ttl = ttlOf(live, s);
		const pause = openPause(
			{ startMs: lastStartMs, endMs: lastEndMs, prefix: lastPrefix },
			{
				config: live.config,
				ttlMinutes: ttl.minutes,
				source: ttl.source,
				isInteractive: live.isInteractive,
				isAborted,
				isIdleCompaction:
					live.idleSeenMs !== undefined &&
					idleCompactionApplies(
						live.idle,
						ttl.minutes,
						live.isInteractive,
						lastPrefix,
					),
				isCompactPending: live.main.isCompactPending,
				isPaused: s.isPaused,
			},
		);
		s = { ...s, pause };
	}
	setRefresh($, live, s, nowMs);
}

/** Starts a refresh when the open pause asks for one and the main thread is idle: no turn, no request, no fork. */
function maybeRefresh($: EngineInterface, live: Live, nowMs: number): void {
	const s = stateOf(live);
	const p = s.pause;
	if (
		p === undefined ||
		live.key === undefined ||
		live.refreshing !== undefined ||
		live.turnId !== undefined ||
		live.isInFlight ||
		live.compacting > 0
	)
		return;
	const plan = planRefresh(p, nowMs);
	if (plan.kind === "stop")
		setRefresh(
			$,
			live,
			{ ...s, pause: { ...p, skip: skipCode(plan.skip) } },
			nowMs,
		);
	else if (plan.kind === "fire") void forkRefresh($, live, p, nowMs, false);
	else if (plan.kind === "rescue") {
		// Idle compaction did not come in time: the evidence is stale, and the cache is refreshed before it expires.
		writeIdleSeen($, live, undefined);
		setRefresh($, live, { ...s, pause: plan.pause }, nowMs);
		void forkRefresh($, live, plan.pause, nowMs, false);
	}
}

function probeText(j: Judged, prefix: number, run: Fired): string {
	if (j.outcome === "none") return "ember probe: nothing to fork yet";
	const steps = `fork steps seen ${run.steps} (${run.agentSteps} with an agent id)`;
	if (j.outcome === "refused")
		return `ember probe: the fork was refused · ${steps}`;
	return `ember probe: ${j.outcome} · read ${percent(j.read, prefix)} of ${tokens(prefix)} · created ${tokens(j.creation)} · ${steps}`;
}

/** Sends one fork over the main transcript and folds its usage in. It cannot be aborted, so it is never started mid-turn. */
async function forkRefresh(
	$: EngineInterface,
	live: Live,
	pause: Pause,
	firedMs: number,
	isProbe: boolean,
): Promise<void> {
	const gen = live.gen;
	const run: Fired = { pause, firedMs, steps: 0, agentSteps: 0, isProbe };
	live.refreshing = run;
	let result: ModelForkResult | undefined;
	try {
		result = await $.model.fork({ prompt: REFRESH_PROMPT });
	} catch {
		result = undefined;
	} finally {
		if (live.refreshing === run) live.refreshing = undefined;
	}
	if (gen !== live.gen) return;
	try {
		const s = stateOf(live);
		const isCurrent =
			s.pause !== undefined && s.pause.startMs === pause.startMs;
		const j = judgeFork(result, pause.prefix);
		const out = applyRefresh(s, run, j, isCurrent);
		if (out.isHit && isCurrent && live.main.lastStartMs !== undefined) {
			// The read restarted the entry's TTL: the countdown and the next TTL evidence run from here.
			live.main = {
				...live.main,
				lastStartMs: Math.max(live.main.lastStartMs, firedMs),
			};
			live.agg = withLive(live.agg, live.main, ttlOf(live, out.state).minutes);
		}
		setRefresh($, live, out.state, Math.max(live.nowMs, firedMs));
		$.ui.invalidate("ui.render");
		if (out.isPausedNow) {
			$.ui.log(
				"ember: cache refresh paused for this session after 2 misses in a row",
				{ to: "debug" },
			);
			$.ui.toast(
				"ember: cache refresh paused after 2 misses in a row. Run /ember-refresh for details.",
			);
		}
		if (isProbe) $.ui.toast(probeText(j, pause.prefix, run));
	} catch {
		$.ui.log("ember: could not record a refresh", { to: "debug" });
	}
}

function viewOf(live: Live, nowMs: number): StatusView {
	return {
		nowMs,
		ttlMs: ttlOf(live).minutes * 60_000,
		isInFlight: live.isInFlight,
		main: live.main,
		session: live.agg,
	};
}

async function tick($: EngineInterface, live: Live): Promise<void> {
	try {
		const nowMs = await $.clock.now();
		live.nowMs = nowMs;
		maybeRefresh($, live, nowMs);
		const view = viewOf(live, nowMs);
		// A terminal status line command can read the stored live state; VS Code runs none, so this stands in there.
		const isVscode = (await $.session.surfaces()).includes("vscode");
		const text = isVscode ? statusText(view) : undefined;
		if (text !== live.shown) {
			live.shown = text;
			$.ui.status(text);
		}
		// While a refresh will run before expiry, the cache is not going cold: no warning. Read after the await,
		// so a refresh that ended meanwhile counts.
		const warn = isRefreshPlanned(stateOf(live).pause)
			? undefined
			: warning(viewOf(live, nowMs), live.warnedStartMs);
		if (warn !== undefined) {
			live.warnedStartMs = live.main.lastStartMs;
			$.ui.toast(warn);
		}
	} catch {
		// The next tick tries again.
	}
}

/** Reads the other sessions' aggregates, then redraws; a failed read leaves none, so the pane shows this session. */
async function loadOthers($: EngineInterface, live: Live): Promise<void> {
	const gen = live.gen;
	let others: Agg[] = [];
	try {
		for (const key of await $.store.keys()) {
			if (!key.startsWith(KEY_PREFIX) || key === live.key) continue;
			const agg = parseAgg(await $.store.get(key));
			if (agg !== undefined) others.push(agg);
		}
	} catch {
		others = [];
		$.ui.log("ember: could not read other sessions", { to: "debug" });
	}
	if (gen !== live.gen) return;
	live.others = others;
	$.ui.invalidate("ui.render");
}

const analysisOf = (live: Live) =>
	analyze({
		config: live.config,
		ttl: ttlOf(live),
		...(live.idleSeenMs === undefined ? {} : { idleSeenMs: live.idleSeenMs }),
		sessions: [
			{ state: stateOf(live), updatedAt: live.agg.updatedAt, isCurrent: true },
			...live.others.map((a) => ({
				state: a.refresh ?? emptyRefresh,
				updatedAt: a.updatedAt,
				isCurrent: false,
			})),
		],
	});

export const register: Register = (on, options) => {
	const optionMinutes = validTtlMinutes(options.ttlMinutes);
	const live: Live = {
		optionMinutes,
		ttl: { minutes: optionMinutes, source: "ttlMinutes option" },
		agg: emptyAgg(0),
		main: emptyMain,
		gen: 0,
		isInFlight: false,
		shown: null,
		pending: new Map(),
		isWriting: false,
		others: [],
		tab: "session",
		config: refreshConfig(options),
		idle: {},
		isInteractive: false,
		compacting: 0,
		nowMs: 0,
	};

	on("session.start", async ($, e, next) => {
		live.isInteractive = e.isInteractive;
		void readIdleSeen($, live);
		await Promise.all([bind($, live), readTtl($, live)]);
		applyTtl($, live);
		$.clock.after(0, () => void prune($, live));
		live.timer?.cancel();
		live.timer = $.clock.every(1000, () => void tick($, live));
		const taken = (name: string) => () =>
			$.ui.log(`ember: /${name} is taken; it is not available`, {
				to: "debug",
			});
		await $.command
			.register({
				name: "ember",
				description:
					"Open a pane with prompt cache hit ratios by gap type, this session and all sessions",
				immediate: true,
			})
			.catch(taken("ember"));
		await $.command
			.register({
				name: "ember-refresh",
				description:
					"Open a pane that analyzes the cache refresh log and recommends a lead time or off",
				immediate: true,
			})
			.catch(taken("ember-refresh"));
		await $.command
			.register({
				name: "ember-probe",
				description:
					"Spends usage: refresh the prompt cache once now and show what the fork read",
				immediate: true,
			})
			.catch(taken("ember-probe"));
		return next(e);
	});

	// session.start does not fire after /clear, /resume or /branch; this does.
	on(
		"classic.SessionStart",
		{ source: ["clear", "resume", "fork"] },
		async ($, e, next) => {
			void readIdleSeen($, live);
			await Promise.all([bind($, live), readTtl($, live)]);
			applyTtl($, live);
			return next(e);
		},
	).catch((_, e, next) => next(e));

	on("session.end", async ($, e, next) => {
		try {
			endPause($, live, "exit", await $.clock.now());
		} catch {
			$.ui.log("ember: could not close the idle pause", { to: "debug" });
		}
		return next(e);
	});

	on("turn.start", async ($, e, next) => {
		// ember's own fork, if it raises a turn of its own, is not the person coming back.
		if (
			e.agentId === undefined &&
			!(live.refreshing !== undefined && e.text === REFRESH_PROMPT)
		) {
			live.turnId = e.turnId;
			// Another session may have seen or cleared idle compaction; read before this turn's pause opens.
			void readIdleSeen($, live);
			try {
				const nowMs = await $.clock.now();
				const s = stateOf(live);
				if (s.pause !== undefined && s.pause.returnMs === undefined)
					live.agg = {
						...live.agg,
						refresh: { ...s, pause: { ...s.pause, returnMs: nowMs } },
					};
			} catch {
				$.ui.log("ember: could not note a return", { to: "debug" });
			}
		}
		return next(e);
	});

	on("turn.complete", async ($, e, next) => {
		if (e.agentId === undefined && e.turnId === live.turnId) {
			live.turnId = undefined;
			try {
				turnEnded($, live, e.isAborted, await $.clock.now());
			} catch {
				$.ui.log("ember: could not open an idle pause", { to: "debug" });
			}
		}
		return next(e);
	});

	on("turn.step", async function* ($, e, next) {
		const run = live.refreshing;
		// A step outside the running main turn while ember's fork runs is the fork's: counted, never measured.
		if (run !== undefined && e.turnId !== live.turnId) {
			run.steps++;
			if (e.agentId !== undefined) run.agentSteps++;
			return yield* next(e);
		}
		const gen = live.gen;
		const startedMs = await $.clock.now();
		const isMain = e.agentId === undefined;
		if (isMain) live.isInFlight = true;
		try {
			const result = yield* next(e);
			if (startedMs !== undefined)
				await record($, live, e, result, startedMs, gen);
			return result;
		} finally {
			if (isMain) live.isInFlight = false;
		}
	});

	on("session.compact", async ($, e, next) => {
		const p = stateOf(live).pause;
		const isIdle = isIdleCompactionEvidence(
			e,
			p,
			live.turnId !== undefined || live.isInFlight,
		);
		const isMain = e.agentId === undefined;
		if (isMain) live.compacting++;
		try {
			const result = await next(e);
			// Only a main-thread compaction that installed a new transcript resets the main cache prefix.
			if (isMain && e.trigger !== "precompute" && result.skip === undefined)
				await compacted($, live, isIdle);
			if (isIdle && p !== undefined && result.skip === undefined)
				await idleCompacted($, live, p.startMs);
			return result;
		} finally {
			if (isMain) live.compacting--;
		}
	}).catch((_, e, next) => next(e));

	on("ui.render", { component: "Pane" }, ($, e, next) => {
		if (e.requestId !== PANE && e.requestId !== REFRESH_PANE) return next(e);
		const id = e.requestId;
		const onClose = () => {
			$.ui
				.close({ id })
				.catch(() =>
					$.ui.log("ember: could not close its pane", { to: "debug" }),
				);
		};
		if (id === REFRESH_PANE)
			return pane(
				{ title: "ember refresh", sections: analysisOf(live), onClose },
				$.ui.resolve(e),
			);
		const hasOthers = live.others.length > 0;
		const isAll = hasOthers && live.tab === "all";
		const pick = (tab: Tab) => {
			live.tab = tab;
			$.ui.invalidate("ui.render");
			if (tab === "all") void loadOthers($, live);
		};
		return pane(
			{
				title: "ember",
				tabs: hasOthers
					? [
							{
								key: "tab-session",
								label: "This session",
								hotkey: "1",
								isActive: !isAll,
								onPress: () => pick("session"),
							},
							{
								key: "tab-all",
								label: "All sessions",
								hotkey: "2",
								isActive: isAll,
								onPress: () => pick("all"),
							},
						]
					: [],
				sections: report(
					isAll ? mergeAggs([live.agg, ...live.others]) : live.agg,
					ttlOf(live),
				),
				onClose,
			},
			$.ui.resolve(e),
		);
	});

	on("command.run", { command: "ember" }, async ($) => {
		void loadOthers($, live);
		try {
			await $.ui.open({
				id: PANE,
				title: "ember",
				focus: true,
				closeOnEscape: true,
				// The tallest narrow drawing: header, status and both tables stacked; inline the frame fits a shorter tree.
				rows: 26,
			});
		} catch {
			$.ui.log("ember: could not open its pane", { to: "debug" });
		}
		return {};
	});

	on("command.run", { command: "ember-refresh" }, async ($) => {
		void loadOthers($, live);
		try {
			await $.ui.open({
				id: REFRESH_PANE,
				title: "ember refresh",
				focus: true,
				closeOnEscape: true,
				// Its report runs long (survival, lead options, idle compaction); the layout caps the ask at what it spares.
				rows: 40,
			});
		} catch {
			$.ui.log("ember: could not open its refresh pane", { to: "debug" });
		}
		return {};
	});

	// The live probe: one refresh now, on the same path as the timed ones. It spends usage, so it runs only when asked.
	on("command.run", { command: "ember-probe" }, async ($) => {
		const p = stateOf(live).pause;
		const why =
			p === undefined || p.returnMs !== undefined
				? "no idle pause yet; finish a turn first"
				: p.prefix <= 0
					? "the last request cached nothing"
					: live.refreshing !== undefined
						? "a refresh is running"
						: live.turnId !== undefined || live.isInFlight
							? "a turn is running"
							: undefined;
		if (why !== undefined || p === undefined) {
			$.ui.toast(`ember probe: ${why ?? ""}`);
			return {};
		}
		const nowMs = await $.clock.now();
		$.clock.after(0, () => void forkRefresh($, live, p, nowMs, true));
		return {};
	});
};
