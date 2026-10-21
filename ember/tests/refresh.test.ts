import { describe, expect, test } from 'claude-code/testing'
import type { ModelForkResult, ModelUsage } from 'claude-code'

import {
  applyRefresh,
  closePause,
  decodeRec,
  effectiveTtl,
  emptyRefresh,
  encodeRec,
  idleCompactionApplies,
  isRefreshPlanned,
  judgeFork,
  leadMs,
  LOG_LIMIT,
  maxRefreshes,
  openPause,
  parseRefresh,
  planRefresh,
  pushLog,
  refreshConfig,
  skipCode,
  SKIPS,
  writeWeight,
} from '../hooks/refresh.ts'
import type { Fired, Judged, Pause, PauseContext, PauseRec, RefreshRec, RefreshState } from '../hooks/refresh.ts'

const MIN = 60_000
const T0 = 1_800_000_000_000
const P = 100_000

const ctx = (over: Partial<PauseContext> = {}): PauseContext => ({
  config: { isOn: true, leadSeconds: 0, isShortTtlOn: true },
  ttlMinutes: 60,
  source: 'ttlMinutes option',
  isInteractive: true,
  isAborted: false,
  isIdleCompaction: false,
  isCompactPending: false,
  isPaused: false,
  ...over,
})

const SHORT_OFF = { config: { isOn: true, leadSeconds: 0, isShortTtlOn: false } }
const pauseAt = (ttlMinutes = 60, over: Partial<PauseContext> = {}, prefix = P): Pause =>
  openPause({ startMs: T0, endMs: T0 + 10_000, prefix }, ctx({ ttlMinutes, ...over }))

const usage = (read: number, creation = 0, input = 10, output = 2): ModelUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: creation,
})
const answered = (u: ModelUsage): ModelForkResult => ({ isAnswered: true, text: 'ok', usage: u })
const hit: Judged = { outcome: 'hit', read: P, creation: 0, input: 10, output: 2 }
const miss: Judged = { outcome: 'miss', read: 0, creation: P, input: 10, output: 2 }
const fired = (pause: Pause, firedMs: number, isProbe = false): Fired => ({ pause, firedMs, steps: 0, agentSteps: 0, isProbe })

describe('options', () => {
  test('refresh is on by default, off only for false; a lead outside 10 to 3600 s is automatic', () => {
    expect(refreshConfig({})).toEqual({ isOn: true, leadSeconds: 0, isShortTtlOn: true })
    expect(refreshConfig({ refresh: false, refreshLeadSeconds: 90 })).toEqual({ isOn: false, leadSeconds: 90, isShortTtlOn: true })
    expect(refreshConfig({ refresh: 'no' }).isOn).toBe(true)
    for (const bad of [5, 3601, -1, Number.NaN, '60']) expect(refreshConfig({ refreshLeadSeconds: bad }).leadSeconds).toBe(0)
  })

  test('short-TTL refresh is on by default, off only for false', () => {
    expect(refreshConfig({ refreshShortTtl: false }).isShortTtlOn).toBe(false)
    for (const other of [true, 'false', 0, null, undefined]) expect(refreshConfig({ refreshShortTtl: other }).isShortTtlOn).toBe(true)
  })
})

describe('refresh timing', () => {
  test('the automatic lead is 5 min at a 60 min TTL and 1 min at a 5 min TTL; an asked lead under the TTL wins', () => {
    expect(leadMs(60, 0)).toBe(5 * MIN)
    expect(leadMs(5, 0)).toBe(MIN)
    expect(leadMs(60, 90)).toBe(90_000)
    expect(leadMs(5, 290)).toBe(290_000)
    expect(leadMs(5, 291)).toBe(MIN)
    expect(leadMs(5, 600)).toBe(MIN)
  })

  for (const [ttl, lead] of [[60, 5 * MIN], [5, MIN]] as const) {
    test(`at a ${ttl} min TTL it fires ${lead / MIN} min before expiry, never in the last 5 s`, () => {
      const p = pauseAt(ttl)
      const due = T0 + ttl * MIN - lead
      expect(planRefresh(p, due - 1)).toEqual({ kind: 'wait' })
      expect(planRefresh(p, due)).toEqual({ kind: 'fire' })
      expect(planRefresh(p, T0 + ttl * MIN - 5_001)).toEqual({ kind: 'fire' })
      expect(planRefresh(p, T0 + ttl * MIN - 5_000)).toEqual({ kind: 'stop', skip: 'late' })
    })
  }

  test('a set lead moves the slot; after a hit the next slot runs from the refresh', () => {
    const p = openPause({ startMs: T0, endMs: T0, prefix: P }, ctx({ config: { isOn: true, leadSeconds: 120, isShortTtlOn: true } }))
    expect(planRefresh(p, T0 + 58 * MIN - 1).kind).toBe('wait')
    expect(planRefresh(p, T0 + 58 * MIN).kind).toBe('fire')
    const after = applyRefresh({ ...emptyRefresh, pause: p }, fired(p, T0 + 58 * MIN), hit, true).state.pause as Pause
    expect(after.readMs).toBe(T0 + 58 * MIN)
    expect(planRefresh(after, T0 + 116 * MIN - 1).kind).toBe('wait')
    expect(planRefresh(after, T0 + 116 * MIN).kind).toBe('fire')
  })

  test('a refused fork retries after 30 s, and stops the pause after 3', () => {
    let s: RefreshState = { ...emptyRefresh, pause: pauseAt() }
    const refused: Judged = { outcome: 'refused', read: 0, creation: 0, input: 0, output: 0 }
    s = applyRefresh(s, fired(s.pause as Pause, T0 + 55 * MIN), refused, true).state
    expect(planRefresh(s.pause as Pause, T0 + 55 * MIN + 29_999).kind).toBe('wait')
    expect(planRefresh(s.pause as Pause, T0 + 55 * MIN + 30_000).kind).toBe('fire')
    s = applyRefresh(s, fired(s.pause as Pause, T0 + 56 * MIN), refused, true).state
    s = applyRefresh(s, fired(s.pause as Pause, T0 + 57 * MIN), refused, true).state
    expect(s.pause?.skip).toBe(skipCode('refused'))
    expect(s.pause?.refreshes).toBe(0)
    expect(s.missStreak).toBe(0)
  })

  test('nothing to fork stops the pause without a record', () => {
    const s = applyRefresh({ ...emptyRefresh, pause: pauseAt() }, fired(pauseAt(), T0 + 55 * MIN), { ...hit, outcome: 'none' }, true).state
    expect(s.pause?.skip).toBe(skipCode('nothing to fork'))
    expect(s.log).toEqual([])
  })
})

describe('ski-rental cap', () => {
  test('20 refreshes at 1 h (2 x write / 0.1), 12 at 5 min (1.25 / 0.1)', () => {
    expect([writeWeight(60), maxRefreshes(60), writeWeight(5), maxRefreshes(5)]).toEqual([2, 20, 1.25, 12])
  })

  for (const ttl of [60, 5]) {
    test(`a pause with no return stops after ${maxRefreshes(ttl)} hits at ${ttl} min`, () => {
      let s: RefreshState = { ...emptyRefresh, pause: pauseAt(ttl) }
      let fires = 0
      for (let now = T0; now < T0 + 48 * 60 * MIN; now += 1000) {
        const p = s.pause as Pause
        const plan = planRefresh(p, now)
        if (plan.kind === 'fire') {
          fires++
          s = applyRefresh(s, fired(p, now), hit, true).state
        } else if (plan.kind === 'stop') {
          s = { ...s, pause: { ...p, skip: skipCode(plan.skip) } }
          break
        }
      }
      expect(fires).toBe(maxRefreshes(ttl))
      expect(s.pause?.skip).toBe(skipCode('capped'))
      expect(isRefreshPlanned(s.pause)).toBe(false)
    })
  }
})

describe('miss detection and the circuit breaker', () => {
  test('a hit reads >= 90% of the prefix and creates <= 1024 tokens; anything else that answered is a miss', () => {
    expect(judgeFork(answered(usage(90_000, 1024)), P).outcome).toBe('hit')
    expect(judgeFork(answered(usage(89_999)), P).outcome).toBe('miss')
    expect(judgeFork(answered(usage(P, 1025)), P).outcome).toBe('miss')
    expect(judgeFork({ isAnswered: false, reason: 'empty-reply', usage: usage(P) }, P).outcome).toBe('hit')
    expect(judgeFork(answered(usage(0)), 0).outcome).toBe('miss')
  })

  test('errors, aborts and a rejected call are refused; nothing to fork is none', () => {
    expect(judgeFork({ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage(0) }, P).outcome).toBe('refused')
    expect(judgeFork({ isAnswered: false, reason: 'aborted', usage: usage(0) }, P).outcome).toBe('refused')
    expect(judgeFork(undefined, P).outcome).toBe('refused')
    expect(judgeFork({ isAnswered: false, reason: 'nothing-to-fork' }, P).outcome).toBe('none')
  })

  test('2 misses in a row pause refresh for the session once; a hit between resets the streak', () => {
    let s: RefreshState = { ...emptyRefresh, pause: pauseAt() }
    let out = applyRefresh(s, fired(pauseAt(), T0 + 55 * MIN), miss, true)
    expect([out.state.missStreak, out.isPausedNow, out.state.pause?.skip]).toEqual([1, false, skipCode('missed')])
    s = { ...out.state, pause: pauseAt() }
    out = applyRefresh(s, fired(pauseAt(), T0 + 55 * MIN), hit, true)
    expect(out.state.missStreak).toBe(0)
    s = { ...out.state, pause: pauseAt() }
    s = applyRefresh(s, fired(pauseAt(), T0 + 55 * MIN), miss, true).state
    s = { ...s, pause: pauseAt() }
    out = applyRefresh(s, fired(pauseAt(), T0 + 55 * MIN), miss, true)
    expect([out.state.missStreak, out.isPausedNow, out.state.isPaused]).toEqual([2, true, true])
    out = applyRefresh({ ...out.state, pause: pauseAt() }, fired(pauseAt(), T0 + 55 * MIN), miss, true)
    expect(out.isPausedNow).toBe(false)
    expect(openPause({ startMs: T0, endMs: T0, prefix: P }, ctx({ isPaused: true })).skip).toBe(skipCode('paused'))
  })

  test('a miss that found the entry gone is TTL evidence, and the plan TTL drops to 5 min', () => {
    const s = applyRefresh({ ...emptyRefresh, pause: pauseAt() }, fired(pauseAt(), T0 + 55 * MIN), miss, true).state
    expect(s.coldAtMs).toBe(55 * MIN)
    expect(effectiveTtl({ minutes: 60, source: 'ttlMinutes option' }, s)).toEqual({ minutes: 5, source: 'refresh miss' })
    expect(effectiveTtl({ minutes: 5, source: 'promptCacheTtl' }, s)).toEqual({ minutes: 5, source: 'promptCacheTtl' })
    const written = applyRefresh({ ...emptyRefresh, pause: pauseAt() }, fired(pauseAt(), T0 + 55 * MIN), { ...miss, read: P }, true).state
    expect(written.coldAtMs).toBeUndefined()
  })

  test('a probe moves neither the cap nor the breaker', () => {
    const out = applyRefresh({ ...emptyRefresh, pause: pauseAt() }, fired(pauseAt(), T0 + MIN, true), miss, true)
    expect([out.state.missStreak, out.state.pause?.refreshes, out.state.pause?.skip]).toEqual([0, 0, 0])
    const rec = decodeRec(out.state.log[0]) as RefreshRec
    expect(rec.isProbe).toBe(1)
  })

  test('a refresh that ends after the person came back logs its cost against the saving', () => {
    const out = applyRefresh({ ...emptyRefresh }, fired(pauseAt(), T0 + 55 * MIN), hit, false)
    expect(out.state.log.length).toBe(1)
    expect(Math.round(out.state.saved)).toBe(Math.round(-(0.1 * P + 10 + 10)))
    expect(out.state.pause).toBeUndefined()
  })
})

describe('pauses', () => {
  test('a pause opens skipped for each reason, in order', () => {
    const skipOf = (over: Partial<PauseContext>, prefix = P) => SKIPS[openPause({ startMs: T0, endMs: T0, prefix }, ctx(over)).skip]
    expect(skipOf({})).toBe('none')
    expect(skipOf({ config: { isOn: false, leadSeconds: 0, isShortTtlOn: true } })).toBe('off')
    expect(skipOf({ ttlMinutes: 5, ...SHORT_OFF })).toBe('short-ttl')
    expect(skipOf({ ttlMinutes: 5, isInteractive: false, ...SHORT_OFF })).toBe('short-ttl')
    expect(skipOf({ isInteractive: false })).toBe('not interactive')
    expect(skipOf({ isAborted: true })).toBe('interrupted')
    expect(skipOf({}, 0)).toBe('no prefix')
    expect(skipOf({ isCompactPending: true })).toBe('compacted')
    expect(skipOf({ isIdleCompaction: true })).toBe('idle compaction')
  })

  test('at a TTL of 5 min or less the defaults refresh; refreshShortTtl: false turns it off', () => {
    for (const ttl of [5, 2]) {
      const p = pauseAt(ttl, SHORT_OFF)
      expect(SKIPS[p.skip]).toBe('short-ttl')
      expect(planRefresh(p, T0 + (ttl - 1) * MIN).kind).toBe('wait')
      expect(isRefreshPlanned(p)).toBe(false)
      expect(SKIPS[pauseAt(ttl).skip]).toBe('none')
      expect(planRefresh(pauseAt(ttl), T0 + (ttl - leadMs(ttl, 0) / MIN) * MIN).kind).toBe('fire')
    }
    expect(SKIPS[pauseAt(6, SHORT_OFF).skip]).toBe('none')
  })

  test('after a miss moves the plan TTL to 5 min, the next pause is short-ttl when opted out', () => {
    const s = applyRefresh({ ...emptyRefresh, pause: pauseAt() }, fired(pauseAt(), T0 + 55 * MIN), miss, true).state
    const ttl = effectiveTtl({ minutes: 60, source: 'ttlMinutes option' }, s)
    expect(SKIPS[pauseAt(ttl.minutes, SHORT_OFF).skip]).toBe('short-ttl')
    expect(SKIPS[pauseAt(ttl.minutes).skip]).toBe('none')
  })

  test('short-ttl is appended to the skip list, so stored indexes keep their meaning', () => {
    expect(SKIPS.indexOf('missed')).toBe(12)
    expect(skipCode('short-ttl')).toBe(13)
  })

  test('a skipped pause never fires and never suppresses the cold warning', () => {
    const p = pauseAt(60, {}, 0)
    expect(planRefresh(p, T0 + 55 * MIN).kind).toBe('wait')
    expect(isRefreshPlanned(p)).toBe(false)
    expect(isRefreshPlanned(pauseAt())).toBe(true)
  })

  test('closing settles the saving: a warm return past the TTL saves (2 - 0.1) x prefix less the refresh cost', () => {
    let s = applyRefresh({ ...emptyRefresh, pause: pauseAt() }, fired(pauseAt(), T0 + 55 * MIN), hit, true).state
    const cost = s.pause?.cost ?? 0
    s = closePause({ ...s, pause: { ...(s.pause as Pause), returnMs: T0 + 70 * MIN } }, 'warm', T0 + 70 * MIN + 500)
    const rec = decodeRec(s.log.at(-1)) as PauseRec
    expect(rec).toMatchObject({ kind: 'pause', ageMs: 70 * MIN, lenMs: 70 * MIN - 10_000, refreshes: 1, end: 0 })
    expect(Math.round(s.saved)).toBe(Math.round(1.9 * P - cost))
    expect(rec.saved).toBe(Math.round(1.9 * P - cost))
    expect(s.pause).toBeUndefined()
  })

  test('a warm return before the TTL or an exit only costs the refreshes', () => {
    const s = applyRefresh({ ...emptyRefresh, pause: pauseAt() }, fired(pauseAt(), T0 + 55 * MIN), hit, true).state
    const cost = s.pause?.cost ?? 0
    expect(Math.round(closePause({ ...s, pause: { ...(s.pause as Pause), returnMs: T0 + 58 * MIN } }, 'warm', T0).saved)).toBe(Math.round(-cost))
    expect(Math.round(closePause(s, 'exit', T0 + 9 * 60 * MIN).saved)).toBe(Math.round(-cost))
    expect(closePause(emptyRefresh, 'exit', T0)).toBe(emptyRefresh)
  })
})

describe('idle compaction', () => {
  test('applies at 1 h, interactive, near its 200k threshold, unless turned off', () => {
    expect(idleCompactionApplies({}, 60, true, 180_000)).toBe(true)
    expect(idleCompactionApplies({}, 60, true, 179_999)).toBe(false)
    expect(idleCompactionApplies({}, 5, true, 500_000)).toBe(false)
    expect(idleCompactionApplies({}, 60, false, 500_000)).toBe(false)
    expect(idleCompactionApplies({ setting: false }, 60, true, 500_000)).toBe(false)
    expect(idleCompactionApplies({ autoCompact: false }, 60, true, 500_000)).toBe(false)
    expect(idleCompactionApplies({ disableAuto: '1' }, 60, true, 500_000)).toBe(false)
    expect(idleCompactionApplies({ minTokens: '50000' }, 60, true, 90_000)).toBe(true)
    expect(idleCompactionApplies({ minTokens: '400000' }, 60, true, 300_000)).toBe(false)
  })
})

describe('the log ring buffer', () => {
  const pauseRec: PauseRec = { kind: 'pause', startMs: T0, lenMs: 9 * 3600_000, ageMs: 9 * 3600_000, ttlMinutes: 60, source: 0, leadMs: 300_000, prefix: 999_999, refreshes: 20, end: 2, skip: 9, cost: 2_000_000, saved: -2_000_000 }
  const refreshRec: RefreshRec = { kind: 'refresh', startMs: T0, ageMs: 3_300_000, ttlMinutes: 60, source: 0, leadMs: 300_000, prefix: 999_999, read: 999_999, creation: 1024, input: 99, output: 9, outcome: 0, steps: 1, agentSteps: 1, isProbe: 0 }

  test('records round-trip as numbers only; anything else is dropped', () => {
    expect(decodeRec(encodeRec(pauseRec))).toEqual(pauseRec)
    expect(decodeRec(encodeRec(refreshRec))).toEqual(refreshRec)
    expect(encodeRec(refreshRec).every(n => typeof n === 'number')).toBe(true)
    for (const bad of [[2, 1], [0, 1, 2], [1, ...encodeRec(refreshRec).slice(1, -1), 'x'], 'junk', null]) expect(decodeRec(bad)).toBeUndefined()
  })

  test(`keeps the newest ${LOG_LIMIT} records per session`, () => {
    let log: number[][] = []
    for (let i = 0; i < LOG_LIMIT + 10; i++) log = pushLog(log, { ...refreshRec, startMs: T0 + i })
    expect(log.length).toBe(LOG_LIMIT)
    expect((decodeRec(log[0]) as RefreshRec).startMs).toBe(T0 + 10)
    expect(parseRefresh({ log: [...log, ...log, 'junk'] })?.log.length).toBe(LOG_LIMIT)
  })

  test('500 sessions of full logs of the widest records stay under 2 MiB, half the store limit', () => {
    let log: number[][] = []
    for (let i = 0; i < LOG_LIMIT; i++) log = pushLog(log, i % 2 === 0 ? pauseRec : refreshRec)
    const state: RefreshState = { log, missStreak: 1, isPaused: true, coldAtMs: 3_300_000, saved: -12_345_678, pause: { ...pauseAt(), returnMs: T0 } }
    const store = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`session:${'x'.repeat(36)}${i}`, { refresh: state }]))
    expect(JSON.stringify(store).length).toBeLessThan(2 * 1024 * 1024)
  })

  test('parseRefresh reads a stored state back and refuses junk', () => {
    const state: RefreshState = { log: [encodeRec(refreshRec)], missStreak: 1, isPaused: true, coldAtMs: 5, saved: -3, pause: { ...pauseAt(), retryAtMs: 7, returnMs: 9 } }
    expect(parseRefresh(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(parseRefresh('junk')).toBeUndefined()
    expect(parseRefresh({ pause: { startMs: 'x' } })).toEqual(emptyRefresh)
  })
})
