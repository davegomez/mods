import { decodeRec, ENDS, leadMs, maxRefreshes, OUTCOMES, READ_WEIGHT, refreshesAt, SHORT_TTL_MINUTES, SKIPS, writeWeight } from './refresh.ts'
import type { PauseRec, RefreshConfig, RefreshRec, RefreshState } from './refresh.ts'
import { band, BANDS, duration, percent, tokens } from './stats.ts'

const MIN = 60_000
/** Below this many returned pauses the survival estimate near the TTL rests on a handful of points. */
export const MIN_RETURNS = 20
const LEAD_CANDIDATES_S = [60, 120, 300, 600]
const KM_POINTS_MS = [5, 30, 55, 60, 120, 480].map(m => m * MIN)

/** A lead in ms, or off. */
export type Policy = number | 'off'

/** One pause as the replay sees it: the cache age when it ended, and whether the person came back then. */
export type Trace = { ageMs: number; isReturn: boolean; ttlMinutes: number; prefix: number }

/**
 * A pause's cache cost under a policy, in prefix units: 0.1 per refresh, then 0.1 for a warm return or the
 * write weight for a cold one; an exit pays no return. Refresh k runs at k x (TTL - lead), up to the cap.
 */
export function pauseCost(policy: Policy, ttlMinutes: number, endAgeMs: number, isReturn: boolean): number {
  const ttlMs = ttlMinutes * MIN
  let cost = 0
  let warmUntil = ttlMs
  if (policy !== 'off') {
    const stepMs = ttlMs - policy
    for (let k = 1; k <= maxRefreshes(ttlMinutes) && k * stepMs < endAgeMs; k++) {
      cost += READ_WEIGHT
      warmUntil = k * stepMs + ttlMs
    }
  }
  if (!isReturn) return cost
  return cost + (endAgeMs < warmUntil ? READ_WEIGHT : writeWeight(ttlMinutes))
}

/** The offline optimum, knowing the end: nothing for an exit, else the cheaper of refreshing at each expiry or going cold. */
export function optimumCost(ttlMinutes: number, endAgeMs: number, isReturn: boolean): number {
  if (!isReturn) return 0
  const refreshes = Math.floor(endAgeMs / (ttlMinutes * MIN))
  return Math.min(READ_WEIGHT * (refreshes + 1), refreshes === 0 ? Infinity : writeWeight(ttlMinutes))
}

/** Total cost in tokens of a trace set: each pause's prefix-unit cost times its prefix. */
export function replay(traces: readonly Trace[], policyOf: (t: Trace) => Policy): number {
  return traces.reduce((sum, t) => sum + pauseCost(policyOf(t), t.ttlMinutes, t.ageMs, t.isReturn) * t.prefix, 0)
}

export const optimum = (traces: readonly Trace[]) => traces.reduce((sum, t) => sum + optimumCost(t.ttlMinutes, t.ageMs, t.isReturn) * t.prefix, 0)

export type KmPoint = { tMs: number; s: number }

/** Kaplan-Meier survival of "not yet returned" over cache age; exits are censored. Ties put returns before exits. */
export function kaplanMeier(traces: readonly Pick<Trace, 'ageMs' | 'isReturn'>[]): KmPoint[] {
  const sorted = [...traces].sort((a, b) => a.ageMs - b.ageMs || Number(b.isReturn) - Number(a.isReturn))
  const out: KmPoint[] = []
  let atRisk = sorted.length
  let s = 1
  for (let i = 0; i < sorted.length; ) {
    const t = sorted[i]?.ageMs ?? 0
    let events = 0
    let leaving = 0
    while (i < sorted.length && sorted[i]?.ageMs === t) {
      if (sorted[i]?.isReturn === true) events++
      leaving++
      i++
    }
    if (events > 0) {
      s *= 1 - events / atRisk
      out.push({ tMs: t, s })
    }
    atRisk -= leaving
  }
  return out
}

export const survivalAt = (km: readonly KmPoint[], tMs: number) => km.filter(p => p.tMs <= tMs).at(-1)?.s ?? 1

/**
 * Expected cost per pause in prefix units under the survival curve: each return mass at its age, and the mass
 * left past the last return charged every refresh the policy would make with no return (the worst case).
 */
export function expectedCost(km: readonly KmPoint[], policy: Policy, ttlMinutes: number): number {
  let prev = 1
  let sum = 0
  for (const p of km) {
    sum += (prev - p.s) * pauseCost(policy, ttlMinutes, p.tMs, true)
    prev = p.s
  }
  return sum + prev * pauseCost(policy, ttlMinutes, Infinity, false)
}

export type SessionLog = { state: RefreshState; updatedAt: number; isCurrent: boolean }

type Decoded = { pauses: PauseRec[]; refreshes: RefreshRec[]; open: Trace[] }

function decode(sessions: readonly SessionLog[]): Decoded {
  const out: Decoded = { pauses: [], refreshes: [], open: [] }
  for (const s of sessions) {
    for (const raw of s.state.log) {
      const r = decodeRec(raw)
      if (r?.kind === 'pause') out.pauses.push(r)
      else if (r?.kind === 'refresh') out.refreshes.push(r)
    }
    // An open pause of another session never closed (the process ended): an exit at its last write.
    const p = s.state.pause
    if (!s.isCurrent && p !== undefined) out.open.push({ ageMs: Math.max(0, s.updatedAt - p.anchorMs), isReturn: false, ttlMinutes: p.ttlMinutes, prefix: p.prefix })
  }
  return out
}

const EXIT = ENDS.indexOf('exit')

export const tracesOf = (pauses: readonly PauseRec[], open: readonly Trace[]): Trace[] => [
  ...pauses.map(p => ({ ageMs: p.ageMs, isReturn: p.end !== EXIT, ttlMinutes: p.ttlMinutes, prefix: p.prefix })),
  ...open,
]

/** The policy the defaults run at a TTL: the automatic lead, or off at a short TTL when opted out. */
export const defaultPolicy = (ttlMinutes: number, isShortTtlOn = true): Policy => (ttlMinutes > SHORT_TTL_MINUTES || isShortTtlOn ? leadMs(ttlMinutes, 0) : 'off')

const signed = (n: number) => (n < 0 ? `-${tokens(Math.round(-n))}` : tokens(Math.round(n)))
const leadName = (ms: number) => duration(ms)

/** The report's first line; when the short-TTL rule stops refresh it says so, not `Refresh on`. */
export function headLine(config: RefreshConfig, ttl: { minutes: number; source: string }): string {
  const tail = `lead ${leadName(leadMs(ttl.minutes, config.leadSeconds))}${config.leadSeconds === 0 ? ' (auto)' : ''} · TTL ${ttl.minutes}m (${ttl.source})`
  if (config.isOn && !refreshesAt(config, ttl.minutes)) return `Refresh off at TTL ${ttl.minutes}m (refreshShortTtl: false) · ${tail}`
  return `Refresh ${config.isOn ? 'on' : 'off'} · ${tail}`
}

export type AnalysisView = { config: RefreshConfig; ttl: { minutes: number; source: string }; sessions: readonly SessionLog[] }

/** The `/ember-refresh` report as Markdown: hit rate, misses by age, savings, survival, candidates, recommendation. */
export function analyze(v: AnalysisView): string {
  const { pauses, refreshes, open } = decode(v.sessions)
  const traces = tracesOf(pauses, open)
  const returns = traces.filter(t => t.isReturn).length
  const ttl = v.ttl.minutes
  const currentLead = leadMs(ttl, v.config.leadSeconds)
  const head = [
    headLine(v.config, v.ttl),
    `Sample: ${traces.length} pauses (${returns} returned, ${traces.length - returns} exits) · ${refreshes.length} refreshes · ${v.sessions.length} sessions`,
  ]

  const count = (o: string) => refreshes.filter(r => r.outcome === OUTCOMES.indexOf(o as never)).length
  const hits = count('hit')
  const misses = count('miss')
  const lines = [...head, `Refreshes: ${hits} hit · ${misses} miss · ${count('refused')} refused · hit rate ${percent(hits, hits + misses)}`]

  const judged = refreshes.filter(r => r.outcome !== OUTCOMES.indexOf('refused'))
  if (judged.length > 0) {
    const rows = BANDS.map(b => {
      const inBand = judged.filter(r => band(r.ageMs) === b)
      const m = inBand.filter(r => r.outcome === OUTCOMES.indexOf('miss')).length
      return inBand.length > 0 ? `| ${b} | ${inBand.length - m} | ${m} |` : undefined
    }).filter(r => r !== undefined)
    lines.push(['| Refresh age | Hit | Miss |', '| --- | ---: | ---: |', ...rows].join('\n'))
    const firstMiss = Math.min(...judged.filter(r => r.outcome === OUTCOMES.indexOf('miss') && r.read < 0.5 * r.prefix).map(r => r.ageMs))
    if (Number.isFinite(firstMiss) && firstMiss < ttl * MIN) {
      lines.push(`A refresh found the cache gone at ${duration(firstMiss)}, under the ${ttl}m TTL: the real TTL looks shorter (usage credits or an API key give 5m). Check ttlMinutes and promptCacheTtl.`)
    }
  }

  // The running totals outlive the ring buffer; an open pause has paid its refreshes but not settled yet.
  const saved = v.sessions.reduce((sum, x) => sum + x.state.saved - (x.state.pause?.cost ?? 0), 0)
  const avoided = pauses.filter(p => p.end === ENDS.indexOf('warm') && p.refreshes > 0 && p.ageMs >= p.ttlMinutes * MIN).length
  lines.push(`Net saved: ~${signed(saved)} tokens (${avoided} cold rewrites avoided). API-price estimate in input-token units: Anthropic does not publish how fork cache reads count toward plan limits.`)
  const skips = SKIPS.map((name, i) => [name, pauses.filter(p => p.skip === i).length] as const).filter(([name, n]) => n > 0 && name !== 'none')
  if (skips.length > 0) lines.push(`Pauses not refreshed or stopped: ${skips.map(([name, n]) => `${name} ${n}`).join(' · ')}`)

  if (returns < MIN_RETURNS) {
    lines.push(`Not enough data for a recommendation: ${returns} returned pauses, ${MIN_RETURNS} needed. Keep the defaults.`)
    return lines.join('\n\n')
  }

  const km = kaplanMeier(traces)
  lines.push(`Still idle (Kaplan-Meier, exits censored): ${KM_POINTS_MS.map(t => `${duration(t)} ${percent(survivalAt(km, t), 1)}`).join(' · ')}`)

  const meanPrefix = traces.reduce((s, t) => s + t.prefix, 0) / traces.length
  const candidates = [...new Set([currentLead, leadMs(ttl, 0), ...LEAD_CANDIDATES_S.map(s => leadMs(ttl, s))])].sort((a, b) => a - b)
  const policies: Policy[] = ['off', ...candidates]
  const offReplay = replay(traces, () => 'off')
  const offKm = expectedCost(km, 'off', ttl)
  const rows = policies.map(policy => {
    const total = replay(traces, t => (policy === 'off' ? 'off' : t.ttlMinutes === ttl ? policy : defaultPolicy(t.ttlMinutes, v.config.isShortTtlOn)))
    const perPause = (offKm - expectedCost(km, policy, ttl)) * meanPrefix
    return { policy, total, perPause, savedReplay: offReplay - total }
  })
  const name = (p: Policy) => (p === 'off' ? 'off' : `lead ${leadName(p)}${p === leadMs(ttl, 0) ? ' (auto)' : ''}`)
  lines.push(
    [
      '| Policy | Saved per pause (survival) | Replay cost | Saved vs off (replay) |',
      '| --- | ---: | ---: | ---: |',
      ...rows.map(r => `| ${name(r.policy)} | ${r.policy === 'off' ? '–' : signed(r.perPause)} | ${tokens(Math.round(r.total))} | ${r.policy === 'off' ? '–' : signed(r.savedReplay)} |`),
    ].join('\n'),
  )
  lines.push(recommend(rows, currentLead, v.config, ttl, name))
  return lines.join('\n\n')
}

type Row = { policy: Policy; perPause: number; savedReplay: number }

/** The best lead by the survival estimate; off when it saves nothing or the replay of the same pauses disagrees. At a short TTL it speaks to `refreshShortTtl`. */
function recommend(rows: readonly Row[], currentLead: number, config: RefreshConfig, ttl: number, name: (p: Policy) => string): string {
  const on = rows.filter(r => r.policy !== 'off')
  const best = on.reduce((a, b) => (b.perPause > a.perPause + 1e-9 ? b : a))
  const current = on.find(r => r.policy === currentLead) ?? best
  // Within 1% of the best, the configured lead stays: no churn for noise.
  const pick = current.perPause >= best.perPause - Math.abs(best.perPause) * 0.01 ? current : best
  const isShort = ttl <= SHORT_TTL_MINUTES
  if (pick.perPause <= 0 || pick.savedReplay <= 0) {
    if (isShort) {
      const keep = config.isShortTtlOn ? 'set refreshShortTtl to false' : 'keep refreshShortTtl off (refreshShortTtl: false)'
      return `Recommendation: ${keep}. At a ${ttl}m TTL the refreshes cost more than the cold rewrites they avoid.`
    }
    return `Recommendation: turn refresh off (refresh: false). On these pauses it costs more than the cold rewrites it avoids.`
  }
  const lead = pick.policy === 'off' ? 0 : pick.policy
  const setting = pick === current ? 'keep the current lead' : `set refreshLeadSeconds to ${Math.round(lead / 1000)}`
  const turnOn = config.isOn ? 'keep refresh on' : 'turn refresh on (refresh: true)'
  const head = !isShort ? turnOn : config.isShortTtlOn ? `${turnOn}, keep refreshShortTtl on` : `set refreshShortTtl to true${config.isOn ? '' : ' and refresh to true'}`
  return `Recommendation: ${head}, ${setting} (${name(pick.policy)}): about ${signed(pick.perPause)} tokens saved per pause.`
}
