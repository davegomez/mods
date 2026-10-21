import { describe, expect, test } from 'claude-code/testing'

import { analyze, defaultPolicy, expectedCost, kaplanMeier, MIN_RETURNS, optimum, optimumCost, pauseCost, replay, survivalAt } from '../hooks/analysis.ts'
import type { SessionLog, Trace } from '../hooks/analysis.ts'
import { decodeRec, emptyRefresh, encodeRec, leadMs, maxRefreshes, READ_WEIGHT, writeWeight } from '../hooks/refresh.ts'
import type { PauseRec, RefreshRec } from '../hooks/refresh.ts'
import { EXIT_TRACES, TRACES } from './traces.ts'

const MIN = 60_000
const T0 = 1_800_000_000_000
const auto = (t: Trace) => leadMs(t.ttlMinutes, 0)
const byDefault = (t: Trace) => defaultPolicy(t.ttlMinutes, false)

describe('pause cost', () => {
  test('off pays 0.1 for a warm return and the write weight for a cold one', () => {
    expect(pauseCost('off', 60, 30 * MIN, true)).toBe(0.1)
    expect(pauseCost('off', 60, 70 * MIN, true)).toBe(2)
    expect(pauseCost('off', 5, 6 * MIN, true)).toBe(1.25)
    expect(pauseCost('off', 60, 70 * MIN, false)).toBe(0)
  })

  test('refresh k runs at k x (TTL - lead) while the person is away, up to the cap', () => {
    const lead = 5 * MIN
    expect(pauseCost(lead, 60, 54 * MIN, true)).toBe(0.1)
    expect(Math.abs(pauseCost(lead, 60, 58 * MIN, true) - (0.2))).toBeLessThan(1e-9)
    expect(Math.abs(pauseCost(lead, 60, 200 * MIN, true) - (0.4))).toBeLessThan(1e-9)
    expect(Math.abs(pauseCost(lead, 60, Infinity, false) - (maxRefreshes(60) * READ_WEIGHT))).toBeLessThan(1e-9)
    expect(Math.abs(pauseCost(lead, 60, 100 * 60 * MIN, true) - (2 + 2))).toBeLessThan(1e-9)
  })

  test('the offline optimum refreshes at each expiry or goes cold, whichever is cheaper; an exit costs nothing', () => {
    expect(optimumCost(60, 58 * MIN, true)).toBe(0.1)
    expect(Math.abs(optimumCost(60, 70 * MIN, true) - (0.2))).toBeLessThan(1e-9)
    expect(Math.abs(optimumCost(60, 200 * MIN, true) - (0.4))).toBeLessThan(1e-9)
    expect(optimumCost(60, 50 * 60 * MIN, true)).toBe(writeWeight(60))
    expect(optimumCost(60, 50 * 60 * MIN, false)).toBe(0)
  })
})

describe('Kaplan-Meier', () => {
  test('exits are censored and ties put returns first', () => {
    const km = kaplanMeier([
      { ageMs: 1, isReturn: true },
      { ageMs: 2, isReturn: false },
      { ageMs: 2, isReturn: true },
      { ageMs: 3, isReturn: true },
      { ageMs: 4, isReturn: false },
    ])
    expect(km.map(p => [p.tMs, Math.round(p.s * 1000) / 1000])).toEqual([[1, 0.8], [2, 0.6], [3, 0.3]])
    expect([survivalAt(km, 0), survivalAt(km, 2), survivalAt(km, 99)]).toEqual([1, km[1]?.s, km[2]?.s])
  })

  test('the expected cost weighs each return and charges the mass left with every refresh', () => {
    const km = kaplanMeier([{ ageMs: 10 * MIN, isReturn: true }, { ageMs: 70 * MIN, isReturn: true }, { ageMs: 80 * MIN, isReturn: false }])
    expect(Math.abs(expectedCost(km, 'off', 60) - ((1 / 3) * 0.1 + (1 / 3) * 2))).toBeLessThan(1e-9)
    expect(Math.abs(expectedCost(km, 5 * MIN, 60) - ((1 / 3) * 0.1 + (1 / 3) * 0.2 + (1 / 3) * 2))).toBeLessThan(1e-9)
  })
})

describe('replay of recorded and synthetic pause traces', () => {
  for (const [name, traces] of Object.entries(TRACES)) {
    test(`${name}: refresh with refreshShortTtl costs at most 2x the offline optimum`, () => {
      expect(replay(traces, auto) / optimum(traces)).toBeLessThanOrEqual(2 + 1e-9)
    })
  }

  test('the default policy is off at a TTL of 5 min or less and the automatic lead above', () => {
    expect([defaultPolicy(5, false), defaultPolicy(2, false), defaultPolicy(5, true), defaultPolicy(60, false)]).toEqual(['off', 'off', MIN, 5 * MIN])
  })

  test('the default policy costs at most 2x the optimum on every trace but the two 5-min ones where off is not competitive', () => {
    const over = Object.entries(TRACES)
      .filter(([, t]) => replay(t, byDefault) / optimum(t) > 2 + 1e-9)
      .map(([name]) => name)
    expect(over).toEqual(['coffee-5', 'just-after-expiry-5'])
  })

  test('the 1.25x stretch holds on every trace but these five', () => {
    const over = Object.entries(TRACES)
      .filter(([, t]) => replay(t, auto) / optimum(t) > 1.25)
      .map(([name]) => name)
    expect(over).toEqual(['weekend-return-60', 'overnight-return-5', 'mixed-5', 'many-sessions', 'ttl-switch-60-to-5'])
  })

  for (const [name, traces] of Object.entries(EXIT_TRACES)) {
    test(`${name}: with no return, each pause wastes at most one cold rewrite`, () => {
      for (const t of traces) expect(pauseCost(auto(t), t.ttlMinutes, t.ageMs, false)).toBeLessThanOrEqual(writeWeight(t.ttlMinutes) + 1e-9)
    })
  }
})

const pause = (ageMs: number, over: Partial<PauseRec> = {}): number[] =>
  encodeRec({ kind: 'pause', startMs: T0, lenMs: ageMs - 10_000, ageMs, ttlMinutes: 60, source: 0, leadMs: 5 * MIN, prefix: 100_000, refreshes: 0, end: 0, skip: 0, cost: 0, saved: 0, ...over })
const refresh = (ageMs: number, over: Partial<RefreshRec> = {}): number[] =>
  encodeRec({ kind: 'refresh', startMs: T0, ageMs, ttlMinutes: 60, source: 0, leadMs: 5 * MIN, prefix: 100_000, read: 100_000, creation: 0, input: 10, output: 2, outcome: 0, steps: 0, agentSteps: 0, isProbe: 0, ...over })

const session = (log: number[][], over: Partial<SessionLog> = {}): SessionLog => {
  const saved = log.map(r => decodeRec(r)).reduce((sum, r) => sum + (r?.kind === 'pause' ? r.saved : 0), 0)
  return { state: { ...emptyRefresh, log, saved }, updatedAt: T0, isCurrent: false, ...over }
}
const view = (sessions: SessionLog[], ttlMinutes = 60, isShortTtlOn = false) => ({ config: { isOn: true, leadSeconds: 0, isShortTtlOn }, ttl: { minutes: ttlMinutes, source: 'ttlMinutes option' }, sessions })

/** 24 short returns, 4 warm returns after refreshes, 1 exit record and 1 pause left open: enough data, refresh pays. */
const FIXTURE: SessionLog[] = [
  session([...Array.from({ length: 24 }, (_, i) => pause((i + 1) * MIN)), refresh(55 * MIN), refresh(55 * MIN), pause(70 * MIN, { refreshes: 1, cost: 10_030, saved: 179_970 })]),
  session([refresh(55 * MIN), pause(80 * MIN, { refreshes: 1, cost: 10_030, saved: 179_970 }), refresh(55 * MIN), refresh(110 * MIN), pause(150 * MIN, { refreshes: 2, cost: 20_060, saved: 169_940 })]),
  session([pause(65 * MIN, { refreshes: 1, cost: 10_030, saved: 179_970 }), pause(6 * 60 * MIN, { end: 2, refreshes: 6, cost: 60_180, saved: -60_180, skip: 0 })]),
  session([], { updatedAt: T0 + 3 * 60 * MIN, state: { ...emptyRefresh, pause: { startMs: T0, anchorMs: T0, readMs: T0, ttlMinutes: 60, source: 0, leadMs: 5 * MIN, prefix: 100_000, refreshes: 3, tries: 0, cost: 30_090, skip: 0 } } }),
]

describe('analysis output on fixture logs', () => {
  test(`below ${MIN_RETURNS} returned pauses it says there is not enough data`, () => {
    const md = analyze(view([session([pause(10 * MIN), refresh(55 * MIN), refresh(55 * MIN, { outcome: 1, read: 0, creation: 100_000 }), pause(70 * MIN, { end: 1, skip: 12 })])]))
    expect(md).toContain('Refresh on · lead 5m00s (auto) · TTL 60m (ttlMinutes option)')
    expect(md).toContain('Sample: 2 pauses (2 returned, 0 exits) · 2 refreshes · 1 sessions')
    expect(md).toContain('Refreshes: 1 hit · 1 miss · 0 refused · hit rate 50%')
    expect(md).toContain('| 30-60m | 1 | 1 |')
    expect(md).toContain('A refresh found the cache gone at 55m00s, under the 60m TTL')
    expect(md).toContain('Pauses not refreshed or stopped: missed 1')
    expect(md).toContain('Not enough data for a recommendation: 2 returned pauses, 20 needed. Keep the defaults.')
    expect(md).not.toContain('Kaplan-Meier')
  })

  test('with enough data it reports survival, each policy, and a recommendation', () => {
    const md = analyze(view(FIXTURE))
    expect(md).toContain('Sample: 30 pauses (28 returned, 2 exits) · 5 refreshes · 4 sessions')
    expect(md).toContain('Refreshes: 5 hit · 0 miss · 0 refused · hit rate 100%')
    expect(md).toContain('| 30-60m | 4 | 0 |\n| >60m | 1 | 0 |')
    expect(md).toContain('Net saved: ~620k tokens (4 cold rewrites avoided). API-price estimate')
    expect(md).toContain('Still idle (Kaplan-Meier, exits censored): 5m00s 83% · 30m00s 20% · 55m00s 20% · 1h00m 20% · 2h00m 10% · 8h00m 7%')
    expect(md).toContain('| off | – | 1.0M | – |')
    expect(md).toContain('| lead 5m00s (auto) | 10k | 420k | 620k |')
    expect(md).toContain('Recommendation: keep refresh on, keep the current lead (lead 5m00s (auto)): about 10k tokens saved per pause.')
  })

  test('when the refreshes cost more than they save, it recommends off', () => {
    const exits = Array.from({ length: 20 }, () => pause(10 * 60 * MIN, { end: 2, refreshes: 10, cost: 100_000, saved: -100_000 }))
    const md = analyze(view([session([...Array.from({ length: 20 }, (_, i) => pause((i + 1) * MIN)), ...exits.slice(0, 11)])]))
    expect(md).toContain('Recommendation: turn refresh off (refresh: false).')
  })

  const short = (ageMs: number, over: Partial<PauseRec> = {}) => pause(ageMs, { ttlMinutes: 5, leadMs: MIN, skip: 13, ...over })

  test('at a 5 min TTL, when refreshing would save, it says to set refreshShortTtl to true', () => {
    const md = analyze(view([session([...Array.from({ length: 20 }, (_, i) => short(((i + 1) * MIN) / 5)), ...Array.from({ length: 10 }, () => short(6 * MIN, { end: 1 }))])], 5))
    expect(md).toContain('Pauses not refreshed or stopped: short-ttl 30')
    expect(md).toContain('Recommendation: set refreshShortTtl to true, keep the current lead (lead 1m00s (auto))')
  })

  test('at a 5 min TTL, when refreshing would not save, it says to keep refreshShortTtl off', () => {
    const exits = Array.from({ length: 11 }, () => short(10 * 60 * MIN, { end: 2 }))
    const md = analyze(view([session([...Array.from({ length: 20 }, (_, i) => short(((i + 1) * MIN) / 5)), ...exits])], 5))
    expect(md).toContain('Recommendation: keep refreshShortTtl off (refreshShortTtl: false). At a 5m TTL the refreshes cost more than the cold rewrites they avoid.')
    expect(analyze(view([session([...Array.from({ length: 20 }, (_, i) => short(((i + 1) * MIN) / 5)), ...exits])], 5, true))).toContain('Recommendation: set refreshShortTtl to false.')
  })

  test('at a 5 min TTL with too few returns the not-enough-data rule still applies', () => {
    expect(analyze(view([session([short(MIN)])], 5))).toContain('Not enough data for a recommendation: 1 returned pauses, 20 needed. Keep the defaults.')
  })
})
