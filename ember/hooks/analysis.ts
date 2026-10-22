import type {
	PauseRec,
	RefreshConfig,
	RefreshRec,
	RefreshState,
} from "./refresh.ts";
import {
	decodeRec,
	ENDS,
	IDLE_COMPACTION_TTL_MINUTES,
	IDLE_COMPACTION_TTL_SHARE,
	leadMs,
	maxRefreshes,
	OUTCOMES,
	READ_WEIGHT,
	refreshesAt,
	SHORT_TTL_MINUTES,
	SKIPS,
	writeWeight,
} from "./refresh.ts";
import type { Block, Cell, Line, Section, Table, Tone } from "./sections.ts";
import { bold, dim, line, pick, plain } from "./sections.ts";
import { BANDS, band, duration, percent, tokens, ttlLine } from "./stats.ts";

const MIN = 60_000;
/** Below this many returned pauses the survival estimate near the TTL rests on a handful of points. */
export const MIN_RETURNS = 20;
/** A lead must save at least this many tokens per pause more than the current one to be recommended over it. */
export const MIN_GAIN_TOKENS = 500;
const LEAD_CANDIDATES_S = [60, 120, 300, 600];
const KM_POINTS_MS = [5, 30, 55, 60, 120, 480].map((m) => m * MIN);

/** A lead in ms, or off. */
export type Policy = number | "off";

/** One pause as the replay sees it: the cache age when it ended, and whether the person came back then. */
export type Trace = {
	ageMs: number;
	isReturn: boolean;
	ttlMinutes: number;
	prefix: number;
	isIdleCompacted?: boolean;
};

/**
 * A pause's cache cost under a policy, in prefix units: 0.1 per refresh, then 0.1 for a warm return or the
 * write weight for a cold one; an exit pays no return. Refresh k runs at k x (TTL - lead), up to the cap.
 */
export function pauseCost(
	policy: Policy,
	ttlMinutes: number,
	endAgeMs: number,
	isReturn: boolean,
): number {
	const ttlMs = ttlMinutes * MIN;
	let cost = 0;
	let warmUntil = ttlMs;
	if (policy !== "off") {
		const stepMs = ttlMs - policy;
		for (
			let k = 1;
			k <= maxRefreshes(ttlMinutes) && k * stepMs < endAgeMs;
			k++
		) {
			cost += READ_WEIGHT;
			warmUntil = k * stepMs + ttlMs;
		}
	}
	if (!isReturn) return cost;
	return cost + (endAgeMs < warmUntil ? READ_WEIGHT : writeWeight(ttlMinutes));
}

/** The offline optimum, knowing the end: nothing for an exit, else the cheaper of refreshing at each expiry or going cold. */
export function optimumCost(
	ttlMinutes: number,
	endAgeMs: number,
	isReturn: boolean,
): number {
	if (!isReturn) return 0;
	const refreshes = Math.floor(endAgeMs / (ttlMinutes * MIN));
	return Math.min(
		READ_WEIGHT * (refreshes + 1),
		refreshes === 0 ? Infinity : writeWeight(ttlMinutes),
	);
}

/** Total cost in tokens of a trace set: each pause's prefix-unit cost times its prefix. */
export function replay(
	traces: readonly Trace[],
	policyOf: (t: Trace) => Policy,
): number {
	return traces.reduce(
		(sum, t) =>
			sum +
			pauseCost(policyOf(t), t.ttlMinutes, t.ageMs, t.isReturn) * t.prefix,
		0,
	);
}

export const optimum = (traces: readonly Trace[]) =>
	traces.reduce(
		(sum, t) => sum + optimumCost(t.ttlMinutes, t.ageMs, t.isReturn) * t.prefix,
		0,
	);

export type KmPoint = { tMs: number; s: number };

/** Kaplan-Meier survival of "not yet returned" over cache age; exits are censored. Ties put returns before exits. */
export function kaplanMeier(
	traces: readonly Pick<Trace, "ageMs" | "isReturn">[],
): KmPoint[] {
	const sorted = [...traces].sort(
		(a, b) => a.ageMs - b.ageMs || Number(b.isReturn) - Number(a.isReturn),
	);
	const out: KmPoint[] = [];
	let atRisk = sorted.length;
	let s = 1;
	for (let i = 0; i < sorted.length; ) {
		const t = sorted[i]?.ageMs ?? 0;
		let events = 0;
		let leaving = 0;
		while (i < sorted.length && sorted[i]?.ageMs === t) {
			if (sorted[i]?.isReturn === true) events++;
			leaving++;
			i++;
		}
		if (events > 0) {
			s *= 1 - events / atRisk;
			out.push({ tMs: t, s });
		}
		atRisk -= leaving;
	}
	return out;
}

export const survivalAt = (km: readonly KmPoint[], tMs: number) =>
	km.filter((p) => p.tMs <= tMs).at(-1)?.s ?? 1;

/**
 * Expected cost per pause in prefix units under the survival curve: each return mass at its age, and the mass
 * left past the last return charged every refresh the policy would make with no return (the worst case).
 */
export function expectedCost(
	km: readonly KmPoint[],
	policy: Policy,
	ttlMinutes: number,
): number {
	let prev = 1;
	let sum = 0;
	for (const p of km) {
		sum += (prev - p.s) * pauseCost(policy, ttlMinutes, p.tMs, true);
		prev = p.s;
	}
	return sum + prev * pauseCost(policy, ttlMinutes, Infinity, false);
}

export type SessionLog = {
	state: RefreshState;
	updatedAt: number;
	isCurrent: boolean;
};

type Decoded = {
	pauses: PauseRec[];
	refreshes: RefreshRec[];
	open: (Trace & { skip: number })[];
};

function decode(sessions: readonly SessionLog[]): Decoded {
	const out: Decoded = { pauses: [], refreshes: [], open: [] };
	for (const s of sessions) {
		for (const raw of s.state.log) {
			const r = decodeRec(raw);
			if (r?.kind === "pause") out.pauses.push(r);
			else if (r?.kind === "refresh") out.refreshes.push(r);
		}
		// An open pause of another session never closed (the process ended): an exit at its last write.
		const p = s.state.pause;
		if (!s.isCurrent && p !== undefined)
			out.open.push({
				ageMs: Math.max(0, s.updatedAt - p.anchorMs),
				isReturn: false,
				ttlMinutes: p.ttlMinutes,
				prefix: p.prefix,
				skip: p.skip,
				isIdleCompacted: p.idleCompactMs !== undefined,
			});
	}
	return out;
}

const EXIT = ENDS.indexOf("exit");
const IDLE = SKIPS.indexOf("idle compaction");

export const tracesOf = (
	pauses: readonly PauseRec[],
	open: readonly Trace[],
): Trace[] => [
	...pauses.map((p) => ({
		ageMs: p.ageMs,
		isReturn: p.end !== EXIT,
		ttlMinutes: p.ttlMinutes,
		prefix: p.prefix,
		isIdleCompacted: p.idleCompacted === 1,
	})),
	...open,
];

/** The policy the defaults run at a TTL: the automatic lead, or off at a short TTL when opted out. */
export const defaultPolicy = (
	ttlMinutes: number,
	isShortTtlOn = true,
): Policy =>
	ttlMinutes > SHORT_TTL_MINUTES || isShortTtlOn
		? leadMs(ttlMinutes, 0)
		: "off";

const signed = (n: number) =>
	n < 0 ? `-${tokens(Math.round(-n))}` : tokens(Math.round(n));
const leadName = (ms: number) => duration(ms);

const advice = (text: string) =>
	pick(bold("Recommendation:"), plain(` ${text}`));
/** A tone for a count that is only news when above 0. */
const toneIf = (n: number, tone: Tone) => (n > 0 ? tone : undefined);
const signTone = (n: number): Tone | undefined =>
	n > 0 ? "good" : n < 0 ? "bad" : undefined;
const signedCell = (n: number): Cell => {
	const tone = signTone(Math.round(n));
	return tone === undefined ? { text: signed(n) } : { text: signed(n), tone };
};

/** The report's first rows; when the short-TTL rule stops refresh it says so, not `on`. */
export function statusLines(
	config: RefreshConfig,
	ttl: { minutes: number; source: string },
): Line[] {
	const isStopped = config.isOn && !refreshesAt(config, ttl.minutes);
	return [
		{
			label: "Refresh",
			runs:
				config.isOn && !isStopped
					? [bold("on", "good")]
					: [
							bold("off", "warn"),
							...(isStopped
								? [dim(` at TTL ${ttl.minutes}m (refreshShortTtl: false)`)]
								: []),
						],
		},
		{
			label: "Lead",
			runs: [
				bold(leadName(leadMs(ttl.minutes, config.leadSeconds))),
				...(config.leadSeconds === 0 ? [dim(" (auto)")] : []),
			],
		},
		ttlLine(ttl),
	];
}

/**
 * The pauses ember left to idle compaction: a warning for the report's top, and the section's blocks. X, Y and Z
 * cover only the long ones where it was recorded running; a long one with none recorded is named in the warning
 * instead (ember now refreshes those), and with no long pause recorded there is no section. With
 * `"idleCompaction": false` (the full conversation kept): X, refresh at the configured lead, and Y, no refresh (one cold rewrite at return). Idle compaction on the same pauses costs
 * at least Z, one cache read of the conversation per pause that reaches its time; its summary's output and the
 * write at return report no usage ember can see, so X - Z bounds the extra cost of the full conversation from above.
 * X, Y and Z cover only the pauses that reach idle compaction's time: a shorter pause costs the same under both settings.
 */
export function idleCompactionBlocks(
	traces: readonly Trace[],
	config: RefreshConfig,
): { warning: Block[]; blocks: Block[] } {
	const returns = traces.filter((t) => t.isReturn).length;
	const runsAt = duration(
		IDLE_COMPACTION_TTL_SHARE * IDLE_COMPACTION_TTL_MINUTES * MIN,
	);
	const long = traces.filter(
		(t) => t.ageMs >= IDLE_COMPACTION_TTL_SHARE * t.ttlMinutes * MIN,
	);
	const compacted = long.filter((t) => t.isIdleCompacted === true);
	const missed = long.length - compacted.length;
	const top: Block[] =
		missed > 0
			? [
					line({
						text: `${missed} skipped pauses lasted past ${runsAt} with no idle compaction recorded; ember now refreshes such pauses until it sees idle compaction run.`,
						tone: "warn",
					}),
				]
			: [];
	if (traces.length === 0 || (returns >= MIN_RETURNS && compacted.length === 0))
		return { warning: top, blocks: [] };
	if (returns < MIN_RETURNS)
		return {
			warning: top,
			blocks: [
				pick(
					plain(
						`Not enough data for an idle compaction recommendation: ${returns} returned pauses, ${MIN_RETURNS} needed. Keep idle compaction on.`,
					),
				),
			],
		};
	const scope = [
		line(
			bold(`${compacted.length} of ${traces.length} pauses`),
			plain(
				` lasted past ${runsAt} with idle compaction recorded; shorter pauses cost the same either way.`,
			),
		),
	];
	const z = compacted.reduce((sum, t) => sum + READ_WEIGHT * t.prefix, 0);
	const y = replay(compacted, () => "off");
	const zLine: Block = {
		line: {
			runs: [
				plain("Idle compaction on the same pauses: at least "),
				bold(`${tokens(Math.round(z))} tokens`),
				plain(
					`, one cache read of the conversation for each of the ${compacted.length} pauses past ${runsAt}.`,
				),
			],
			note: "Not measured: the summary's output and its write at return.",
		},
	};
	const lost =
		"Not priced: what a summary loses (the detail of the conversation).";
	if (!config.isOn) {
		const blocks = [
			...scope,
			line(
				plain(
					'Refresh is off, so with "idleCompaction": false each of these pauses that outlasts the cache ends in a cold rewrite: replay ',
				),
				bold(`${tokens(Math.round(y))} tokens`),
				plain("."),
			),
			zLine,
			line(dim(lost)),
			advice("keep idle compaction on."),
		];
		return { warning: top, blocks };
	}
	const lead = leadMs(IDLE_COMPACTION_TTL_MINUTES, config.leadSeconds);
	const x = replay(compacted, (t) => leadMs(t.ttlMinutes, config.leadSeconds));
	const perPause = tokens(Math.round((x - z) / compacted.length));
	const keepRefresh =
		y > x
			? ` If you set "idleCompaction": false, keep refresh on: it costs ${tokens(Math.round(y - x))} tokens less than no refresh.`
			: "";
	const blocks = [
		...scope,
		line(
			plain(
				`With "idleCompaction": false, which keeps the full conversation: refresh at lead ${leadName(lead)}${lead === leadMs(IDLE_COMPACTION_TTL_MINUTES, 0) ? " (auto)" : ""} `,
			),
			bold(tokens(Math.round(x))),
			plain(" · no refresh "),
			bold(tokens(Math.round(y))),
			plain(" tokens."),
		),
		zLine,
		x > z
			? {
					line: {
						runs: [
							plain("Keeping the full conversation costs at most "),
							bold(`${tokens(Math.round(x - z))} tokens`, "bad"),
							plain(` more (${perPause} per pause).`),
						],
						note: lost,
					},
				}
			: {
					line: {
						runs: [
							plain(
								"Keeping the full conversation cost no more than idle compaction's own reads on these pauses.",
							),
						],
						note: lost,
					},
				},
		x > z
			? advice(
					`keep idle compaction on unless the full conversation is worth about ${perPause} tokens per pause to you.${keepRefresh}`,
				)
			: advice(
					`"idleCompaction": false keeps the full conversation for no more tokens than idle compaction on these pauses; set it in ~/.claude/settings.json if you want that.${keepRefresh}`,
				),
	];
	return { warning: top, blocks };
}

export type AnalysisView = {
	config: RefreshConfig;
	ttl: { minutes: number; source: string };
	sessions: readonly SessionLog[];
	idleSeenMs?: number;
};

/**
 * At the 1 h TTL with refresh on: whether ember has seen idle compaction run, which decides if it skips long
 * conversations, and how many pauses it left to idle compaction; not seen, those were skipped before.
 */
function idleSeenLine(v: AnalysisView, skipped: number): Line | undefined {
	if (!v.config.isOn || v.ttl.minutes !== IDLE_COMPACTION_TTL_MINUTES)
		return undefined;
	const isSeen = v.idleSeenMs !== undefined;
	return {
		label: "Idle compaction",
		runs: [
			...(v.idleSeenMs === undefined
				? [bold("not seen"), plain(", ember refreshes long conversations too")]
				: [
						bold(`seen ${new Date(v.idleSeenMs).toISOString().slice(0, 10)}`),
						plain(", ember skips the pauses it applies to"),
					]),
			...(skipped > 0
				? [
						plain(" · "),
						bold(String(skipped)),
						plain(` pauses skipped${isSeen ? "" : " earlier"}`),
					]
				: []),
		],
	};
}

/**
 * The `/ember-refresh` report as sections: an untitled one first with the recommendation and any idle compaction
 * warning, then status, refreshes by age, savings, survival, lead options, idle compaction.
 */
export function analyze(v: AnalysisView): Section[] {
	const { pauses, refreshes, open } = decode(v.sessions);
	const traces = tracesOf(pauses, open);
	const skipped = tracesOf(
		pauses.filter((p) => p.skip === IDLE),
		open.filter((t) => t.skip === IDLE),
	);
	const idle = idleCompactionBlocks(skipped, v.config);
	const idleSection: Section[] =
		idle.blocks.length > 0
			? [{ title: "Idle compaction", blocks: idle.blocks }]
			: [];
	const lead = (advised: Block): Section => ({
		blocks: [advised, ...idle.warning],
	});
	const returns = traces.filter((t) => t.isReturn).length;
	const ttl = v.ttl.minutes;
	const currentLead = leadMs(ttl, v.config.leadSeconds);
	const seen = idleSeenLine(v, skipped.length);
	const status: Section = {
		title: "Status",
		blocks: [
			...statusLines(v.config, v.ttl),
			...(seen === undefined ? [] : [seen]),
			{
				label: "Sample",
				runs: [
					bold(`${traces.length} pauses`),
					plain(` (${returns} returned, ${traces.length - returns} exits) · `),
					bold(`${refreshes.length} refreshes`),
					plain(" · "),
					bold(`${v.sessions.length} sessions`),
				],
			},
		].map((l) => ({ line: l })),
	};

	const count = (o: string) =>
		refreshes.filter((r) => r.outcome === OUTCOMES.indexOf(o as never)).length;
	const hits = count("hit");
	const misses = count("miss");
	const refused = count("refused");
	const outcomes: Block[] = [
		line(
			bold(String(hits), toneIf(hits, "good")),
			plain(" hit · "),
			bold(String(misses), toneIf(misses, "bad")),
			plain(" miss · "),
			bold(String(refused), toneIf(refused, "warn")),
			plain(" refused · hit rate "),
			bold(percent(hits, hits + misses)),
		),
	];

	const judged = refreshes.filter(
		(r) => r.outcome !== OUTCOMES.indexOf("refused"),
	);
	if (judged.length > 0) {
		const rows = BANDS.flatMap((b) => {
			const inBand = judged.filter((r) => band(r.ageMs) === b);
			const m = inBand.filter(
				(r) => r.outcome === OUTCOMES.indexOf("miss"),
			).length;
			const h = inBand.length - m;
			return inBand.length > 0
				? [
						{
							cells: [
								{ text: b },
								h > 0
									? { text: String(h), tone: "good" as const }
									: { text: "0" },
								m > 0
									? { text: String(m), tone: "bad" as const }
									: { text: "0" },
							],
						},
					]
				: [];
		});
		outcomes.push({ table: { head: ["Refresh age", "Hit", "Miss"], rows } });
		const firstMiss = Math.min(
			...judged
				.filter(
					(r) =>
						r.outcome === OUTCOMES.indexOf("miss") && r.read < 0.5 * r.prefix,
				)
				.map((r) => r.ageMs),
		);
		if (Number.isFinite(firstMiss) && firstMiss < ttl * MIN) {
			outcomes.push(
				line({
					text: `A refresh found the cache gone at ${duration(firstMiss)}, under the ${ttl}m TTL: the real TTL looks shorter (usage credits or an API key give 5m). Check ttlMinutes and promptCacheTtl.`,
					tone: "warn",
				}),
			);
		}
	}

	// The running totals outlive the ring buffer; an open pause has paid its refreshes but not settled yet.
	const saved = v.sessions.reduce(
		(sum, x) => sum + x.state.saved - (x.state.pause?.cost ?? 0),
		0,
	);
	const avoided = pauses.filter(
		(p) =>
			p.end === ENDS.indexOf("warm") &&
			p.refreshes > 0 &&
			p.ageMs >= p.ttlMinutes * MIN,
	).length;
	const savings: Block[] = [
		{
			line: {
				label: "Net saved",
				runs: [
					bold(`~${signed(saved)} tokens`, signTone(Math.round(saved))),
					plain(` (${avoided} cold rewrites avoided)`),
				],
				note: "API-price estimate in input-token units: Anthropic does not publish how fork cache reads count toward plan limits.",
			},
		},
	];
	// The Status row counts the idle compaction skips when it shows.
	const skips = SKIPS.map(
		(name, i) => [name, pauses.filter((p) => p.skip === i).length] as const,
	).filter(
		([name, n]) =>
			n > 0 &&
			name !== "none" &&
			(name !== "idle compaction" || seen === undefined),
	);
	if (skips.length > 0)
		savings.push({
			line: {
				label: "Not refreshed",
				runs: skips.flatMap(([name, n], i) => [
					plain(`${i > 0 ? " · " : ""}${name} `),
					bold(String(n)),
				]),
			},
		});
	const head: Section[] = [
		status,
		{ title: "Refreshes", blocks: outcomes },
		{ title: "Savings", blocks: savings },
	];

	if (returns < MIN_RETURNS) {
		return [
			lead(
				pick(
					plain(
						`Not enough data for a recommendation: ${returns} returned pauses, ${MIN_RETURNS} needed. Keep the defaults.`,
					),
				),
			),
			...head,
			...idleSection,
		];
	}

	const km = kaplanMeier(traces);
	const survival: Section = {
		title: "Idle time (survival)",
		blocks: [
			line(dim("Share of pauses still idle after each time")),
			{
				table: {
					head: ["Idle for", ...KM_POINTS_MS.map((t) => duration(t))],
					rows: [
						{
							cells: [
								{ text: "Still idle" },
								...KM_POINTS_MS.map((t) => ({
									text: percent(survivalAt(km, t), 1),
								})),
							],
						},
					],
				},
			},
		],
	};

	const meanPrefix = traces.reduce((s, t) => s + t.prefix, 0) / traces.length;
	const candidates = [
		...new Set([
			currentLead,
			leadMs(ttl, 0),
			...LEAD_CANDIDATES_S.map((s) => leadMs(ttl, s)),
		]),
	].sort((a, b) => a - b);
	const policies: Policy[] = ["off", ...candidates];
	const offReplay = replay(traces, () => "off");
	const offKm = expectedCost(km, "off", ttl);
	const rows = policies.map((policy) => {
		const total = replay(traces, (t) =>
			policy === "off"
				? "off"
				: t.ttlMinutes === ttl
					? policy
					: defaultPolicy(t.ttlMinutes, v.config.isShortTtlOn),
		);
		const perPause = (offKm - expectedCost(km, policy, ttl)) * meanPrefix;
		return { policy, total, perPause, savedReplay: offReplay - total };
	});
	const running = refreshesAt(v.config, ttl) ? currentLead : "off";
	const name = (p: Policy, isRow = false) => {
		const tags = [
			...(p !== "off" && p === leadMs(ttl, 0) ? ["auto"] : []),
			...(isRow && p === running ? ["current"] : []),
		];
		return `${p === "off" ? "off" : `lead ${leadName(p)}`}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`;
	};
	const advised = recommend(rows, currentLead, v.config, ttl, name);
	const none = { text: "–" };
	const options: Table = {
		head: ["Policy", "Saved/pause", "Replay cost", "Saved vs off"],
		rows: rows.map((r) => ({
			cells: [
				{ text: name(r.policy, true) },
				r.policy === "off" ? none : signedCell(r.perPause),
				{ text: tokens(Math.round(r.total)) },
				r.policy === "off" ? none : signedCell(r.savedReplay),
			],
			isPick: r.policy === advised.policy,
			isCurrent: r.policy === running,
		})),
		legend: "▸ recommended · • current",
	};
	return [
		lead(advised.block),
		...head,
		survival,
		{
			title: "Lead options",
			blocks: [
				{ table: options },
				line(
					dim(
						"Saved vs off replays every pause in the sample, skipped ones too, as if each refresh hit; Net saved counts only the refreshes ember ran.",
					),
				),
			],
		},
		...idleSection,
	];
}

type Row = { policy: Policy; perPause: number; savedReplay: number };

/**
 * The best lead by the survival estimate; the current lead stays unless the best saves more than 1% and at least
 * MIN_GAIN_TOKENS per pause more. Off when it saves nothing or the replay of the same pauses disagrees. At a short
 * TTL it speaks to `refreshShortTtl`.
 */
function recommend(
	rows: readonly Row[],
	currentLead: number,
	config: RefreshConfig,
	ttl: number,
	name: (p: Policy) => string,
): { policy: Policy; block: Block } {
	const on = rows.filter((r) => r.policy !== "off");
	const best = on.reduce((a, b) => (b.perPause > a.perPause + 1e-9 ? b : a));
	const current = on.find((r) => r.policy === currentLead) ?? best;
	// Within 1% of the best, or a gain under the minimum while the current lead pays, the configured lead stays: no churn for noise.
	const gain = best.perPause - current.perPause;
	const isCurrentPaying = current.perPause > 0 && current.savedReplay > 0;
	const pick =
		gain <= Math.abs(best.perPause) * 0.01 ||
		(isCurrentPaying && gain < MIN_GAIN_TOKENS)
			? current
			: best;
	const isShort = ttl <= SHORT_TTL_MINUTES;
	if (pick.perPause <= 0 || pick.savedReplay <= 0) {
		if (isShort) {
			const keep = config.isShortTtlOn
				? "set refreshShortTtl to false"
				: "keep refreshShortTtl off (refreshShortTtl: false)";
			return {
				policy: "off",
				block: advice(
					`${keep}. At a ${ttl}m TTL the refreshes cost more than the cold rewrites they avoid.`,
				),
			};
		}
		return {
			policy: "off",
			block: advice(
				"turn refresh off (refresh: false). On these pauses it costs more than the cold rewrites it avoids.",
			),
		};
	}
	const lead = pick.policy === "off" ? 0 : pick.policy;
	const isKept = pick === current;
	const setting = isKept
		? "keep the current lead"
		: `set refreshLeadSeconds to ${Math.round(lead / 1000)}`;
	const turnOn = config.isOn
		? "keep refresh on"
		: "turn refresh on (refresh: true)";
	const head = !isShort
		? turnOn
		: config.isShortTtlOn
			? `${turnOn}, keep refreshShortTtl on`
			: `set refreshShortTtl to true${config.isOn ? "" : " and refresh to true"}`;
	return {
		policy: pick.policy,
		block: {
			pick: {
				runs: [
					bold("Recommendation:"),
					plain(` ${head}, ${setting} (${name(pick.policy)}): about `),
					bold(`${signed(isKept ? pick.perPause : gain)} tokens`, "good"),
					plain(
						isKept
							? " saved per pause versus refresh off."
							: ` per pause more than ${name(current.policy)}.`,
					),
				],
			},
		},
	};
}
