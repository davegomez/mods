import { describe, expect, test } from 'claude-code/testing'

import { analyze, defaultPolicy, headLine, expectedCost, kaplanMeier, MIN_RETURNS, optimum, optimumCost, pauseCost, replay, survivalAt } from '../hooks/analysis.ts'
import type { SessionLog, Trace } from '../hooks/analysis.ts'
import { decodeRec, emptyRefresh, encodeRec, leadMs, maxRefreshes, READ_WEIGHT, writeWeight } from '../hooks/refresh.ts'
import type { PauseRec, RefreshRec } from '../hooks/refresh.ts'
import { EXIT_TRACES, TRACES } from './traces.ts'

const MIN = 60_000
const T0 = 1_800_000_000_000
const auto = (t: Trace) => leadMs(t.ttlMinutes, 0)
const byDefault = (t: Trace) => defaultPolicy(t.ttlMinutes)

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
    test(`${name}: the default policy costs at most 2x the offline optimum`, () => {
      expect(replay(traces, byDefault) / optimum(traces)).toBeLessThanOrEqual(2 + 1e-9)
    })
  }

  test('the default policy is the automatic lead at every TTL; opted out, it is off at 5 min or less', () => {
    expect([defaultPolicy(5), defaultPolicy(60), defaultPolicy(5, false), defaultPolicy(2, false), defaultPolicy(60, false)]).toEqual([MIN, 5 * MIN, 'off', 'off', 5 * MIN])
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
  encodeRec({ kind: 'pause', startMs: T0, lenMs: ageMs - 10_000, ageMs, ttlMinutes: 60, source: 0, leadMs: 5 * MIN, prefix: 100_000, refreshes: 0, end: 0, skip: 0, cost: 0, saved: 0, idleCompacted: 0, ...over })
const refresh = (ageMs: number, over: Partial<RefreshRec> = {}): number[] =>
  encodeRec({ kind: 'refresh', startMs: T0, ageMs, ttlMinutes: 60, source: 0, leadMs: 5 * MIN, prefix: 100_000, read: 100_000, creation: 0, input: 10, output: 2, outcome: 0, steps: 0, agentSteps: 0, isProbe: 0, ...over })

const session = (log: number[][], over: Partial<SessionLog> = {}): SessionLog => {
  const saved = log.map(r => decodeRec(r)).reduce((sum, r) => sum + (r?.kind === 'pause' ? r.saved : 0), 0)
  return { state: { ...emptyRefresh, log, saved }, updatedAt: T0, isCurrent: false, ...over }
}
const view = (sessions: SessionLog[], ttlMinutes = 60, isShortTtlOn = true) => ({ config: { isOn: true, leadSeconds: 0, isShortTtlOn }, ttl: { minutes: ttlMinutes, source: 'ttlMinutes option' }, sessions })

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

  test('at a 5 min TTL, when refreshing would save, it says to keep refreshShortTtl on, or to set it to true when opted out', () => {
    const log = [session([...Array.from({ length: 20 }, (_, i) => short(((i + 1) * MIN) / 5)), ...Array.from({ length: 10 }, () => short(6 * MIN, { end: 1 }))])]
    const md = analyze(view(log, 5, false))
    expect(md).toContain('Refresh off at TTL 5m (refreshShortTtl: false) · lead 1m00s (auto) · TTL 5m (ttlMinutes option)')
    expect(md).toContain('Pauses not refreshed or stopped: short-ttl 30')
    expect(md).toContain('Recommendation: set refreshShortTtl to true, keep the current lead (lead 1m00s (auto))')
    expect(analyze(view(log, 5))).toContain('Recommendation: keep refresh on, keep refreshShortTtl on, keep the current lead (lead 1m00s (auto))')
  })

  test('at a 5 min TTL, when refreshing would not save, it says to keep refreshShortTtl off', () => {
    const exits = Array.from({ length: 11 }, () => short(10 * 60 * MIN, { end: 2 }))
    const md = analyze(view([session([...Array.from({ length: 20 }, (_, i) => short(((i + 1) * MIN) / 5)), ...exits])], 5, false))
    expect(md).toContain('Recommendation: keep refreshShortTtl off (refreshShortTtl: false). At a 5m TTL the refreshes cost more than the cold rewrites they avoid.')
    expect(analyze(view([session([...Array.from({ length: 20 }, (_, i) => short(((i + 1) * MIN) / 5)), ...exits])], 5, true))).toContain('Recommendation: set refreshShortTtl to false.')
  })

  test('the first line says refresh is off when the short-TTL rule stops it', () => {
    const ttl = (minutes: number) => ({ minutes, source: 'ttlMinutes option' })
    const config = (isOn: boolean, isShortTtlOn: boolean) => ({ isOn, leadSeconds: 0, isShortTtlOn })
    expect(headLine(config(true, false), ttl(5))).toBe('Refresh off at TTL 5m (refreshShortTtl: false) · lead 1m00s (auto) · TTL 5m (ttlMinutes option)')
    expect(headLine(config(true, false), ttl(2))).toMatch(/^Refresh off at TTL 2m \(refreshShortTtl: false\)/)
    expect(headLine(config(true, true), ttl(5))).toBe('Refresh on · lead 1m00s (auto) · TTL 5m (ttlMinutes option)')
    expect(headLine(config(true, false), ttl(6))).toMatch(/^Refresh on · /)
    expect(headLine(config(false, false), ttl(5))).toMatch(/^Refresh off · /)
  })

  test('with no pause left to idle compaction there is no idle compaction section', () => {
    expect(analyze(view(FIXTURE))).not.toContain('pauses skipped')
  })

  test('at a 60 min TTL with refresh on it says whether ember has seen idle compaction run', () => {
    expect(analyze({ ...view(FIXTURE), idleSeenMs: Date.UTC(2026, 9, 21, 12) })).toContain('Idle compaction: seen 2026-10-21, ember skips the pauses it applies to.')
    expect(analyze(view(FIXTURE))).toContain('Idle compaction: not seen, ember refreshes long conversations too.')
    expect(analyze(view(FIXTURE, 5))).not.toContain('Idle compaction')
    expect(analyze({ ...view(FIXTURE), config: { isOn: false, leadSeconds: 0, isShortTtlOn: true } })).not.toContain('Idle compaction')
  })

  const idle = (ageMs: number, over: Partial<PauseRec> = {}) => pause(ageMs, { prefix: 250_000, skip: 3, idleCompacted: 1, ...over })
  const idleOpen = (ageMs: number) =>
    session([], { updatedAt: T0 + ageMs, state: { ...emptyRefresh, pause: { startMs: T0, anchorMs: T0, readMs: T0, ttlMinutes: 60, source: 0, leadMs: 5 * MIN, prefix: 250_000, refreshes: 0, tries: 0, cost: 0, skip: 3, idleCompactMs: T0 + 54 * MIN } } })

  // 15 warm returns at 10 min, 5 cold returns at 70 min, and 1 pause left open for 10 h (an exit); prefix 250k.
  const IDLE_LOG = [session([...Array.from({ length: 15 }, () => idle(10 * MIN)), ...Array.from({ length: 5 }, () => idle(70 * MIN, { end: 1 }))]), idleOpen(10 * 60 * MIN)]

  test('it prices keeping the full conversation against a lower bound of idle compaction, and never claims a saving', () => {
    const md = analyze(view(IDLE_LOG))
    expect(md).toContain('Pauses not refreshed or stopped: idle compaction 20')
    // Only the 6 pauses past 54 min count (5 at 70 min, the 10 h one); the 15 at 10 min cost the same either way.
    // X, refresh at 5 min lead: 5 x (refresh 0.1 + warm 0.1) + 10 refreshes (55, 110, ..., 550 min) x 0.1 = 2.0 prefixes = 500k.
    // Y, no refresh: 5 x 2 + exit 0 = 10 prefixes = 2.5M.
    expect(md).toContain(
      'Idle compaction: 21 pauses skipped (20 returned, 1 exits). 6 of 21 pauses lasted past 54m00s with idle compaction recorded; shorter pauses cost the same either way. With "idleCompaction": false, which keeps the full conversation: refresh at lead 5m00s (auto) 500k · no refresh 2.5M tokens.',
    )
    // Z: the 6 pauses past 54 min (5 at 70 min, the 10 h one) x 0.1 = 0.6 prefixes = 150k.
    expect(md).toContain(
      "Idle compaction on the same pauses: at least 150k tokens, one cache read of the conversation for each of the 6 pauses past 54m00s. Not measured: the summary's output and its write at return.",
    )
    // X - Z = 350k; per long pause 350k / 6 = 58.3k. Y - X = 2.0M.
    expect(md).toContain('Keeping the full conversation costs at most 350k tokens more (58k per pause). Not priced: what a summary loses (the detail of the conversation).')
    expect(md).toContain(
      'Recommendation: keep idle compaction on unless the full conversation is worth about 58k tokens per pause to you. If you set "idleCompaction": false, keep refresh on: it costs 2.0M tokens less than no refresh.',
    )
    expect(md).not.toContain('"idleCompaction": false in')
    expect(md).not.toContain('/ember-probe')
    expect(md.indexOf('Idle compaction: 21')).toBeGreaterThan(md.indexOf('Recommendation: keep refresh on'))
  })

  test('long skipped pauses with no idle compaction recorded are left out of X, Y and Z, and named', () => {
    // As IDLE_LOG, but 2 of the 5 pauses at 70 min saw no idle compaction: 4 long pauses remain, Z = 4 x 0.1 x 250k.
    const log = [session([...Array.from({ length: 15 }, () => idle(10 * MIN)), ...Array.from({ length: 5 }, (_, i) => idle(70 * MIN, { end: 1, idleCompacted: i < 2 ? 0 : 1 }))]), idleOpen(10 * 60 * MIN)]
    const md = analyze(view(log))
    expect(md).toContain(
      'Idle compaction: 21 pauses skipped (20 returned, 1 exits). 2 lasted past 54m00s with no idle compaction recorded; ember now refreshes such pauses until it sees idle compaction run. 4 of 21 pauses lasted past 54m00s with idle compaction recorded;',
    )
    expect(md).toContain('at least 100k tokens, one cache read of the conversation for each of the 4 pauses past 54m00s.')
  })

  test('records from before ember recorded idle compaction count as none recorded, and no setting advice follows', () => {
    const old = (ageMs: number, end = 0) => idle(ageMs, { end }).slice(0, -1)
    const md = analyze(view([session([...Array.from({ length: 15 }, () => old(10 * MIN)), ...Array.from({ length: 5 }, () => old(70 * MIN, 1))])]))
    expect(md).toContain(
      'Idle compaction: 20 pauses skipped (20 returned, 0 exits). 5 lasted past 54m00s with no idle compaction recorded; ember now refreshes such pauses until it sees idle compaction run.',
    )
    expect(md).not.toContain('None lasted')
    expect(md).not.toContain('at least')
    expect(md).not.toContain('Recommendation: keep idle compaction')
    expect(md).not.toContain('"idleCompaction": false')
  })

  test('it replays at the configured lead', () => {
    // Refreshes at 58, 116, ..., 580 min: the same counts as at 5 min, so X = 500k.
    expect(analyze({ ...view(IDLE_LOG), config: { isOn: true, leadSeconds: 120, isShortTtlOn: true } })).toContain('refresh at lead 2m00s 500k')
  })

  test('pauses shorter than the idle compaction time are left out of X, Y and Z, and no refresh advice when refresh costs no less', () => {
    // 20 warm returns at 53 min (left out) and 1 exit at 54 min. X: the exit, no refresh before 55 min = 0; Y: 0; Z: 0.1 x 250k = 25k.
    const md = analyze(view([session([...Array.from({ length: 20 }, () => idle(53 * MIN)), idle(54 * MIN, { end: 2 })])]))
    expect(md).toContain('1 of 21 pauses lasted past 54m00s with idle compaction recorded; shorter pauses cost the same either way.')
    expect(md).toContain('refresh at lead 5m00s (auto) 0 · no refresh 0 tokens.')
    expect(md).toContain('at least 25k tokens, one cache read of the conversation for each of the 1 pauses past 54m00s.')
    expect(md).toContain("Keeping the full conversation cost no more than idle compaction's own reads on these pauses.")
    expect(md).not.toContain('keep refresh on: it costs')
  })

  test('when no pause lasted until idle compaction runs, it says the setting made no difference', () => {
    // 20 warm returns at 10 min and 1 exit at 30 min: none reaches 54 min.
    const md = analyze(view([session([...Array.from({ length: 20 }, () => idle(10 * MIN)), idle(30 * MIN, { end: 2 })])]))
    expect(md).toContain(
      'Idle compaction: 21 pauses skipped (20 returned, 1 exits). None lasted past 54m00s, so idle compaction did not run on these pauses and the setting made no difference. Keep idle compaction on.',
    )
    expect(md).not.toContain('refresh at lead')
    expect(md).not.toContain('at least')
    expect(md).not.toContain('Recommendation: keep idle compaction')
    expect(md).not.toContain('"idleCompaction": false')
  })

  test('when keeping the full conversation costs no more than idle compaction reads, it says so', () => {
    // 20 warm returns and 2 exits, all at 54.5 min, all long. X: 20 x 0.1 = 500k; Z: 22 x 0.1 = 550k.
    const at = 54.5 * MIN
    const md = analyze(view([session([...Array.from({ length: 20 }, () => idle(at)), idle(at, { end: 2 }), idle(at, { end: 2 })])]))
    expect(md).toContain('22 of 22 pauses lasted past 54m00s with idle compaction recorded')
    expect(md).toContain('refresh at lead 5m00s (auto) 500k · no refresh 500k tokens.')
    expect(md).toContain('at least 550k tokens')
    expect(md).toContain("Keeping the full conversation cost no more than idle compaction's own reads on these pauses. Not priced: what a summary loses (the detail of the conversation).")
    expect(md).toContain('Recommendation: "idleCompaction": false keeps the full conversation for no more tokens than idle compaction on these pauses; set it in ~/.claude/settings.json if you want that.')
    expect(md).not.toContain('costs at most')
  })

  test('with refresh off it says each long pause would end in a cold rewrite and to keep idle compaction on', () => {
    const md = analyze({ ...view(IDLE_LOG), config: { isOn: false, leadSeconds: 0, isShortTtlOn: true } })
    expect(md).toContain(
      // Y over the 6 long pauses: 5 x 2 = 2.5M.
      'Idle compaction: 21 pauses skipped (20 returned, 1 exits). 6 of 21 pauses lasted past 54m00s with idle compaction recorded; shorter pauses cost the same either way. Refresh is off, so with "idleCompaction": false each of these pauses that outlasts the cache ends in a cold rewrite: replay 2.5M tokens.',
    )
    expect(md).toContain('Idle compaction on the same pauses: at least 150k tokens')
    expect(md).toContain('Not priced: what a summary loses (the detail of the conversation).')
    expect(md).toContain('Recommendation: keep idle compaction on.')
    expect(md).not.toContain('refresh at lead')
    expect(md).not.toContain('keep refresh on: it costs')
    expect(md).not.toContain('"idleCompaction": false keeps')
  })

  test(`below ${MIN_RETURNS} returned idle compaction pauses it shows the count and says there is not enough data`, () => {
    const md = analyze(view([session([idle(10 * MIN), idle(70 * MIN, { end: 1 }), idle(20 * MIN, { end: 2 })])]))
    expect(md).toContain('Idle compaction: 3 pauses skipped (2 returned, 1 exits).')
    expect(md).toContain('Not enough data for an idle compaction recommendation: 2 returned pauses, 20 needed. Keep idle compaction on.')
    expect(md).not.toContain('refresh at lead')
    expect(md).not.toContain('at least')
    expect(md).not.toContain('Not priced')
  })

  test('at a 5 min TTL with too few returns the not-enough-data rule still applies', () => {
    expect(analyze(view([session([short(MIN)])], 5))).toContain('Not enough data for a recommendation: 1 returned pauses, 20 needed. Keep the defaults.')
  })
})
