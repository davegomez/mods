import type { ModelForkResult } from 'claude-code'

const MIN = 60_000

/** A cache read costs 0.1 of an input token; prices below are in input-token units. */
export const READ_WEIGHT = 0.1
/** Output tokens cost 5 input tokens on current Claude models; an assumption of the cost estimate. */
export const OUTPUT_WEIGHT = 5
/** A refresh hits when its cache read is at least this share of the last main prefix. */
export const HIT_READ_SHARE = 0.9
/** A refresh read under this share of the prefix found the entry gone: TTL evidence. */
export const COLD_READ_SHARE = 0.5
/** The most cache creation a hit may show: the fork prompt is a few tokens, the rest is slack. */
export const CREATION_TOLERANCE = 1024
export const MISS_LIMIT = 2
export const MAX_TRIES = 3
export const RETRY_MS = 30_000
/** No refresh starts this close to expiry: it would reach the API after the entry lapsed. */
export const LATE_MARGIN_MS = 5_000
export const MIN_LEAD_SECONDS = 10
export const MAX_LEAD_SECONDS = 3600
/** Records kept per session: about 2.4 kB, so 500 sessions stay near 1.2 MB of the store's 4 MiB. */
export const LOG_LIMIT = 32
export const REFRESH_PROMPT = 'Reply with the single word ok.'

export const SOURCES = ['ttlMinutes option', 'FORCE_PROMPT_CACHING_5M', 'CLAUDE_CODE_PROMPT_CACHE_TTL', 'promptCacheTtl', 'ENABLE_PROMPT_CACHING_1H', 'refresh miss'] as const
export const SKIPS = ['none', 'off', 'no prefix', 'idle compaction', 'paused', 'interrupted', 'compacted', 'nothing to fork', 'not interactive', 'capped', 'late', 'refused', 'missed', 'short-ttl'] as const
export const ENDS = ['warm', 'cold', 'exit', 'unknown'] as const
export const OUTCOMES = ['hit', 'miss', 'refused'] as const

export type Skip = (typeof SKIPS)[number]
export type End = (typeof ENDS)[number]
export type Outcome = (typeof OUTCOMES)[number]
export const skipCode = (s: Skip) => SKIPS.indexOf(s)
export const endCode = (e: End) => ENDS.indexOf(e)
export const sourceCode = (source: string) => Math.max(0, SOURCES.indexOf(source as (typeof SOURCES)[number]))

/** At or under this TTL each refresh buys only a few minutes, so `refreshShortTtl: false` can turn refresh off here. */
export const SHORT_TTL_MINUTES = 5

export type RefreshConfig = { isOn: boolean; leadSeconds: number; isShortTtlOn: boolean }

/** The options as validated: refresh is on unless `false`; short-TTL refresh on unless `false`; a lead outside 10 to 3600 s is 0, the automatic lead. */
export function refreshConfig(options: { refresh?: unknown; refreshLeadSeconds?: unknown; refreshShortTtl?: unknown }): RefreshConfig {
  const lead = options.refreshLeadSeconds
  const isValid = typeof lead === 'number' && Number.isFinite(lead) && lead >= MIN_LEAD_SECONDS && lead <= MAX_LEAD_SECONDS
  return { isOn: options.refresh !== false, leadSeconds: isValid ? lead : 0, isShortTtlOn: options.refreshShortTtl !== false }
}

/** Whether refresh runs at this TTL: on, and the TTL is above 5 min or short-TTL refresh is not turned off. */
export const refreshesAt = (config: RefreshConfig, ttlMinutes: number) => config.isOn && (ttlMinutes > SHORT_TTL_MINUTES || config.isShortTtlOn)

/** The API's write price for the TTL: 1.25 for the 5-minute cache, 2 for the 1-hour one. */
export const writeWeight = (ttlMinutes: number) => (ttlMinutes <= 5 ? 1.25 : 2)

/** Ski rental: refresh while the pause's refresh reads cost at most one cold rewrite (20 at 1 h, 12 at 5 min). */
export const maxRefreshes = (ttlMinutes: number) => Math.floor(writeWeight(ttlMinutes) / READ_WEIGHT + 1e-9)

export const autoLeadMs = (ttlMinutes: number) => Math.min(5 * MIN, (ttlMinutes * MIN) / 5)

/** The asked lead when it leaves at least 10 s of TTL before it, else the automatic one. */
export function leadMs(ttlMinutes: number, leadSeconds: number): number {
  const asked = leadSeconds * 1000
  return asked > 0 && asked <= ttlMinutes * MIN - MIN_LEAD_SECONDS * 1000 ? asked : autoLeadMs(ttlMinutes)
}

/** One idle pause of the main thread, numbers only. */
export type Pause = {
  /** The end of the last main response: the human pause runs from here. */
  startMs: number
  /** The start of the main request that wrote the cache entry. */
  anchorMs: number
  /** The start of the last request that read the entry: the TTL runs from here. */
  readMs: number
  ttlMinutes: number
  source: number
  leadMs: number
  prefix: number
  /** Refreshes that reached the API (hit or miss). */
  refreshes: number
  /** Refused fork calls in a row. */
  tries: number
  retryAtMs?: number
  /** What the refreshes cost, input-token units. */
  cost: number
  /** Why no more refreshes run in this pause; 0 while they may. */
  skip: number
  /** When the person's next turn started. */
  returnMs?: number
}

/** The refresh state a session stores. */
export type RefreshState = {
  log: number[][]
  missStreak: number
  isPaused: boolean
  /** The smallest refresh age that found the entry gone. */
  coldAtMs?: number
  /** Net input tokens saved this session (negative: refresh cost more). */
  saved: number
  pause?: Pause
}

export const emptyRefresh: RefreshState = { log: [], missStreak: 0, isPaused: false, saved: 0 }

const PAUSE_FIELDS = ['startMs', 'lenMs', 'ageMs', 'ttlMinutes', 'source', 'leadMs', 'prefix', 'refreshes', 'end', 'skip', 'cost', 'saved'] as const
const REFRESH_FIELDS = ['startMs', 'ageMs', 'ttlMinutes', 'source', 'leadMs', 'prefix', 'read', 'creation', 'input', 'output', 'outcome', 'steps', 'agentSteps', 'isProbe'] as const
type Fields<F extends readonly string[]> = { [K in F[number]]: number }
export type PauseRec = { kind: 'pause' } & Fields<typeof PAUSE_FIELDS>
export type RefreshRec = { kind: 'refresh' } & Fields<typeof REFRESH_FIELDS>
export type Rec = PauseRec | RefreshRec

export function encodeRec(r: Rec): number[] {
  return r.kind === 'pause' ? [0, ...PAUSE_FIELDS.map(f => Math.round(r[f]))] : [1, ...REFRESH_FIELDS.map(f => Math.round(r[f]))]
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function decodeRec(v: unknown): Rec | undefined {
  if (!Array.isArray(v) || !v.every(isNum)) return undefined
  const [kind, ...rest] = v as number[]
  const fields = kind === 0 ? PAUSE_FIELDS : kind === 1 ? REFRESH_FIELDS : undefined
  if (fields === undefined || rest.length !== fields.length) return undefined
  return { kind: kind === 0 ? 'pause' : 'refresh', ...Object.fromEntries(fields.map((f, i) => [f, rest[i]])) } as Rec
}

/** Appends a record, keeping the newest LOG_LIMIT. */
export const pushLog = (log: readonly number[][], r: Rec): number[][] => [...log, encodeRec(r)].slice(-LOG_LIMIT)

/** Idle compaction runs only on the 1-hour cache. */
export const IDLE_COMPACTION_TTL_MINUTES = 60

export type IdleCompactInputs = { setting?: unknown; autoCompact?: unknown; disableAuto?: string; minTokens?: string }

/**
 * Whether Claude Code's idle compaction may run in this pause (1 h TTL, interactive, not turned off, context at
 * its threshold). It fires about 54 min after the last request, before a refresh would; ember yields to it.
 * The prefix stands in for the context size; 90% of the threshold counts, so a near miss yields too.
 */
export function idleCompactionApplies(i: IdleCompactInputs, ttlMinutes: number, isInteractive: boolean, prefix: number): boolean {
  if (ttlMinutes !== IDLE_COMPACTION_TTL_MINUTES || !isInteractive || i.setting === false || i.autoCompact === false) return false
  if (i.disableAuto === '1' || i.disableAuto === 'true') return false
  const asked = Number(i.minTokens)
  const threshold = Number.isInteger(asked) && asked > 0 ? Math.max(100_000, asked) : 200_000
  return prefix >= 0.9 * threshold
}

export type PauseContext = {
  config: RefreshConfig
  ttlMinutes: number
  source: string
  isInteractive: boolean
  isAborted: boolean
  isIdleCompaction: boolean
  isCompactPending: boolean
  isPaused: boolean
}

/** Opens the pause after a main turn: logged always, refreshed only when nothing skips it. */
export function openPause(last: { startMs: number; endMs: number; prefix: number }, c: PauseContext): Pause {
  const skip: Skip = !c.config.isOn
    ? 'off'
    : !refreshesAt(c.config, c.ttlMinutes)
      ? 'short-ttl'
      : !c.isInteractive
        ? 'not interactive'
        : c.isAborted
          ? 'interrupted'
          : last.prefix <= 0
            ? 'no prefix'
            : c.isCompactPending
              ? 'compacted'
              : c.isPaused
                ? 'paused'
                : c.isIdleCompaction
                  ? 'idle compaction'
                  : 'none'
  return {
    startMs: last.endMs,
    anchorMs: last.startMs,
    readMs: last.startMs,
    ttlMinutes: c.ttlMinutes,
    source: sourceCode(c.source),
    leadMs: leadMs(c.ttlMinutes, c.config.leadSeconds),
    prefix: last.prefix,
    refreshes: 0,
    tries: 0,
    cost: 0,
    skip: skipCode(skip),
  }
}

export type Plan = { kind: 'wait' } | { kind: 'fire' } | { kind: 'stop'; skip: Skip }

/** What the pause asks for now. The caller checks that the main thread is idle and no refresh runs. */
export function planRefresh(p: Pause, nowMs: number): Plan {
  if (p.skip !== 0 || p.returnMs !== undefined) return { kind: 'wait' }
  if (p.refreshes >= maxRefreshes(p.ttlMinutes)) return { kind: 'stop', skip: 'capped' }
  const expiresMs = p.readMs + p.ttlMinutes * MIN
  // A machine that slept past the slot finds the entry gone: a fork then would only rewrite it.
  if (nowMs >= expiresMs - LATE_MARGIN_MS) return { kind: 'stop', skip: 'late' }
  if (nowMs < expiresMs - p.leadMs || nowMs < (p.retryAtMs ?? 0)) return { kind: 'wait' }
  return { kind: 'fire' }
}

/** True while a refresh will still run before this pause's entry expires, so no cold warning is due. */
export const isRefreshPlanned = (p: Pause | undefined): boolean =>
  p !== undefined && p.skip === 0 && p.returnMs === undefined && p.refreshes < maxRefreshes(p.ttlMinutes)

export type Judged = { outcome: Outcome | 'none'; read: number; creation: number; input: number; output: number }

/** Reads a fork's result: hit, miss, refused (no answer to judge), or none (nothing to fork, no request made). */
export function judgeFork(r: ModelForkResult | undefined, prefix: number): Judged {
  const zero = { read: 0, creation: 0, input: 0, output: 0 }
  if (r === undefined) return { outcome: 'refused', ...zero }
  if (!r.isAnswered && r.reason === 'nothing-to-fork') return { outcome: 'none', ...zero }
  const u = r.usage
  const tokens = { read: u.cache_read_input_tokens, creation: u.cache_creation_input_tokens, input: u.input_tokens, output: u.output_tokens }
  if (!r.isAnswered && (r.reason === 'api-error' || r.reason === 'aborted')) return { outcome: 'refused', ...tokens }
  const isHit = prefix > 0 && tokens.read >= HIT_READ_SHARE * prefix && tokens.creation <= CREATION_TOLERANCE
  return { outcome: isHit ? 'hit' : 'miss', ...tokens }
}

export const refreshCost = (j: Judged, ttlMinutes: number) =>
  READ_WEIGHT * j.read + writeWeight(ttlMinutes) * j.creation + j.input + OUTPUT_WEIGHT * j.output

export type Fired = { pause: Pause; firedMs: number; steps: number; agentSteps: number; isProbe: boolean }

export type Applied = { state: RefreshState; isHit: boolean; isPausedNow: boolean }

/**
 * Folds one refresh into the session state. `isCurrent`: its pause is still the open one; otherwise the
 * person came back while it ran, and only its record and cost remain. A probe moves no cap or breaker.
 */
export function applyRefresh(s: RefreshState, f: Fired, j: Judged, isCurrent: boolean): Applied {
  const p = isCurrent && s.pause !== undefined ? s.pause : f.pause
  const none: Applied = { state: s, isHit: false, isPausedNow: false }
  if (j.outcome === 'none') return isCurrent ? { ...none, state: { ...s, pause: { ...p, skip: skipCode('nothing to fork') } } } : none
  const ageMs = f.firedMs - f.pause.readMs
  const cost = refreshCost(j, p.ttlMinutes)
  const log = pushLog(s.log, {
    kind: 'refresh',
    startMs: f.firedMs,
    ageMs,
    ttlMinutes: p.ttlMinutes,
    source: p.source,
    leadMs: p.leadMs,
    prefix: p.prefix,
    read: j.read,
    creation: j.creation,
    input: j.input,
    output: j.output,
    outcome: OUTCOMES.indexOf(j.outcome),
    steps: f.steps,
    agentSteps: f.agentSteps,
    isProbe: f.isProbe ? 1 : 0,
  })
  const isGone = j.outcome === 'miss' && j.read < COLD_READ_SHARE * p.prefix
  const coldAtMs = isGone ? Math.min(ageMs, s.coldAtMs ?? ageMs) : s.coldAtMs
  let out: RefreshState = { ...s, log, ...(coldAtMs === undefined ? {} : { coldAtMs }) }
  if (!isCurrent) return { state: { ...out, saved: out.saved - cost }, isHit: false, isPausedNow: false }

  if (j.outcome === 'refused') {
    const tries = p.tries + 1
    const pause = { ...p, tries, retryAtMs: f.firedMs + RETRY_MS, ...(tries >= MAX_TRIES && !f.isProbe ? { skip: skipCode('refused') } : {}) }
    return { state: { ...out, pause }, isHit: false, isPausedNow: false }
  }
  const isHit = j.outcome === 'hit'
  const counted = f.isProbe ? 0 : 1
  const pause: Pause = {
    ...p,
    refreshes: p.refreshes + counted,
    tries: 0,
    cost: p.cost + cost,
    ...(isHit ? { readMs: Math.max(p.readMs, f.firedMs) } : { skip: skipCode('missed') }),
  }
  if (f.isProbe) return { state: { ...out, pause: isHit ? pause : { ...pause, skip: p.skip } }, isHit, isPausedNow: false }
  const missStreak = isHit ? 0 : s.missStreak + 1
  const isPausedNow = !s.isPaused && missStreak >= MISS_LIMIT
  out = { ...out, pause, missStreak, isPaused: s.isPaused || isPausedNow }
  return { state: out, isHit, isPausedNow }
}

/** Closes the open pause into a record: a return (warm, cold, unknown) or an exit, and settles its savings. */
export function closePause(s: RefreshState, end: End, atMs: number): RefreshState {
  const p = s.pause
  if (p === undefined) return s
  const endMs = p.returnMs ?? atMs
  const ageMs = endMs - p.anchorMs
  const wouldBeCold = ageMs >= p.ttlMinutes * MIN
  const avoided = end === 'warm' && wouldBeCold && p.refreshes > 0 ? (writeWeight(p.ttlMinutes) - READ_WEIGHT) * p.prefix : 0
  const saved = avoided - p.cost
  const log = pushLog(s.log, {
    kind: 'pause',
    startMs: p.startMs,
    lenMs: Math.max(0, endMs - p.startMs),
    ageMs: Math.max(0, ageMs),
    ttlMinutes: p.ttlMinutes,
    source: p.source,
    leadMs: p.leadMs,
    prefix: p.prefix,
    refreshes: p.refreshes,
    end: endCode(end),
    skip: p.skip,
    cost: p.cost,
    saved,
  })
  const { pause: _closed, ...rest } = s
  return { ...rest, log, saved: s.saved + saved }
}

/** The TTL to plan with: after a refresh found the entry gone before the resolved TTL, the 5-minute one. */
export function effectiveTtl<T extends { minutes: number; source: string }>(ttl: T, s: RefreshState | undefined): T | { minutes: number; source: string } {
  const cold = s?.coldAtMs
  return cold !== undefined && ttl.minutes > 5 && cold < ttl.minutes * MIN ? { minutes: 5, source: 'refresh miss' } : ttl
}

const optNum = (v: unknown, min = 0) => (isNum(v) && v >= min ? v : undefined)

function parsePause(v: unknown): Pause | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  const keys = ['startMs', 'anchorMs', 'readMs', 'ttlMinutes', 'source', 'leadMs', 'prefix', 'refreshes', 'tries', 'cost', 'skip'] as const
  const nums = keys.map(k => optNum(o[k]))
  if (nums.some(n => n === undefined) || (o.ttlMinutes as number) <= 0) return undefined
  const p = Object.fromEntries(keys.map((k, i) => [k, nums[i]])) as Omit<Pause, 'retryAtMs' | 'returnMs'>
  const retryAtMs = optNum(o.retryAtMs)
  const returnMs = optNum(o.returnMs)
  return { ...p, ...(retryAtMs === undefined ? {} : { retryAtMs }), ...(returnMs === undefined ? {} : { returnMs }) }
}

/** Reads a stored refresh state defensively; bad records are dropped. */
export function parseRefresh(v: unknown): RefreshState | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  const log = (Array.isArray(o.log) ? o.log : []).filter(r => decodeRec(r) !== undefined).slice(-LOG_LIMIT) as number[][]
  const coldAtMs = optNum(o.coldAtMs)
  const pause = parsePause(o.pause)
  return {
    log,
    missStreak: optNum(o.missStreak) ?? 0,
    isPaused: o.isPaused === true,
    saved: isNum(o.saved) ? o.saved : 0,
    ...(coldAtMs === undefined ? {} : { coldAtMs }),
    ...(pause === undefined ? {} : { pause }),
  }
}
