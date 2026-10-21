import { describe, expect, test } from 'claude-code/testing'

import {
  band,
  cacheTokens,
  classify,
  duration,
  emptyAgg,
  emptyMain,
  keysToPrune,
  MAX_SESSIONS,
  mergeAggs,
  noteCompaction,
  observe,
  parseAgg,
  percent,
  PRUNE_AFTER_MS,
  report,
  resolveTtl,
  savedPct,
  statusText,
  tokens,
  validTtlMinutes,
  warning,
  withLive,
  withSavedPct,
  withTtl,
} from '../hooks/stats.ts'
import type { Agg, Main, Step } from '../hooks/stats.ts'

const MIN = 60_000

const usage = (read: number, input = 0, created = 0, model = 'opus') => ({
  input_tokens: input,
  output_tokens: 10,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: created,
  model,
})

const step = (over: Partial<Step>): Step => ({
  index: 1,
  startedMs: 0,
  endedMs: 0,
  usage: usage(90, 10),
  toolNames: [],
  ...over,
})

const warmMain = (over: Partial<Main> = {}): Main => ({
  ...emptyMain,
  lastStartMs: 1000,
  lastEndMs: 1000,
  lastModel: 'opus',
  lastPrefix: 100,
  ...over,
})

describe('validTtlMinutes', () => {
  test('keeps a number from 1 to 1440', () => {
    expect(validTtlMinutes(1)).toBe(1)
    expect(validTtlMinutes(1.5)).toBe(1.5)
    expect(validTtlMinutes(60)).toBe(60)
    expect(validTtlMinutes(1440)).toBe(1440)
  })

  test('falls back to 60 for anything else', () => {
    for (const bad of [undefined, 0, 0.5, 0.999, -1, 1441, Number.NaN, Infinity, '10', true]) {
      expect(validTtlMinutes(bad)).toBe(60)
    }
  })
})

describe('cacheTokens', () => {
  test('sums the three input counts', () => {
    expect(cacheTokens(usage(80, 5, 15))).toEqual({ read: 80, total: 100 })
  })

  test('skips null usage and a zero denominator', () => {
    expect(cacheTokens(null)).toBeUndefined()
    expect(cacheTokens(usage(0, 0, 0))).toBeUndefined()
  })
})

describe('band', () => {
  test('puts each edge in the upper band', () => {
    const cases: [number, string][] = [
      [0, '<1m'],
      [MIN - 1, '<1m'],
      [MIN, '1-5m'],
      [5 * MIN - 1, '1-5m'],
      [5 * MIN, '5-15m'],
      [15 * MIN - 1, '5-15m'],
      [15 * MIN, '15-30m'],
      [30 * MIN - 1, '15-30m'],
      [30 * MIN, '30-60m'],
      [60 * MIN - 1, '30-60m'],
      [60 * MIN, '>60m'],
      [10 * 60 * MIN, '>60m'],
    ]
    for (const [gap, name] of cases) expect(band(gap)).toBe(name)
  })
})

describe('classify', () => {
  test('first beats every other type', () => {
    expect(classify({ ...emptyMain, isCompactPending: true }, 0, false)).toBe('first')
  })

  test('compact beats model-switch, which beats the gap type', () => {
    expect(classify(warmMain({ isCompactPending: true }), 0, true)).toBe('compact')
    expect(classify(warmMain({ lastToolNames: ['AskUserQuestion'] }), 3, true)).toBe('model-switch')
  })

  test('the first step of a turn is a user gap', () => {
    expect(classify(warmMain({ lastToolNames: ['AskUserQuestion'] }), 0, false)).toBe('user')
  })

  test('the previous tool calls name the gap inside a turn', () => {
    expect(classify(warmMain({ lastToolNames: ['Agent', 'AskUserQuestion'] }), 2, false)).toBe('ask')
    expect(classify(warmMain({ lastToolNames: ['Read', 'Agent'] }), 2, false)).toBe('subagent')
    expect(classify(warmMain({ lastToolNames: ['Read'] }), 2, false)).toBe('tool')
    expect(classify(warmMain(), 2, false)).toBe('tool')
  })
})

describe('observe', () => {
  test('a subagent request goes to agent and leaves the main thread alone', () => {
    const main = warmMain()
    const out = observe(emptyAgg(0), main, step({ agentId: 'a1', index: 0, endedMs: 9 }))
    expect(out.main).toBe(main)
    expect(out.agg.buckets.agent).toEqual({ n: 1, read: 90, total: 100 })
    expect(out.agg.buckets.first.n).toBe(0)
    expect(out.agg.updatedAt).toBe(9)
  })

  test('a subagent request without usage records nothing', () => {
    const agg = emptyAgg(0)
    expect(observe(agg, warmMain(), step({ agentId: 'a1', usage: null })).agg).toBe(agg)
  })

  test('a step with no measurable request changes nothing', () => {
    const agg = emptyAgg(0)
    const main = warmMain({ isCompactPending: true, lastHit: 0.9 })
    for (const usage of [null, { ...step({}).usage!, input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'sonnet' }]) {
      const out = observe(agg, main, step({ usage, startedMs: 4000, endedMs: 5000, toolNames: ['Bash'] }))
      expect(out.agg).toBe(agg)
      expect(out.main).toBe(main)
    }
  })

  test('a first request after a step with no usage is still first', () => {
    const quiet = observe(emptyAgg(0), emptyMain, step({ index: 0, usage: null, endedMs: 100 }))
    const out = observe(quiet.agg, quiet.main, step({ index: 0, startedMs: 20 * MIN, endedMs: 20 * MIN }))
    expect(out.agg.buckets.first.n).toBe(1)
    expect(out.agg.buckets.user.n).toBe(0)
    expect(out.agg.coldMinMs).toBeUndefined()
  })

  test('the first main request has no gap', () => {
    const out = observe(emptyAgg(0), emptyMain, step({ index: 0, startedMs: 100, endedMs: 200 }))
    expect(out.agg.buckets.first.n).toBe(1)
    expect(out.agg.bands['<1m'].n).toBe(0)
    expect(out.main.lastStartMs).toBe(100)
    expect(out.main.lastEndMs).toBe(200)
    expect(out.main.lastHit).toBe(0.9)
    expect(out.main.lastPrefix).toBe(90)
  })

  test('a user gap adds its tokens to its band and widens the observed TTL bounds', () => {
    let agg = emptyAgg(0)
    let main = warmMain({ lastStartMs: 0, lastEndMs: 0, lastPrefix: 1000 })
    // Each request reads `read` and writes `created` tokens to the cache; the next one starts `gapMs` after its end.
    const userStep = (gapMs: number, read: number, created: number) => {
      const startedMs = (main.lastEndMs ?? 0) + gapMs
      const out = observe(agg, main, step({ index: 0, startedMs, endedMs: startedMs, usage: usage(read, 10, created) }))
      agg = out.agg
      main = out.main
    }
    userStep(4 * MIN, 500, 500)
    userStep(3 * MIN, 1000, 0)
    userStep(7 * MIN, 499, 501)
    userStep(9 * MIN, 0, 1000)
    expect(agg.buckets.user).toEqual({ n: 4, read: 1999, total: 4040 })
    expect(agg.bands['1-5m']).toEqual({ n: 2, read: 1500, total: 2020 })
    expect(agg.bands['5-15m']).toEqual({ n: 2, read: 499, total: 2020 })
    expect(agg.warmMaxMs).toBe(4 * MIN)
    expect(agg.coldMinMs).toBe(7 * MIN)
  })

  test('a low hit ratio that read the whole previous prefix is warm evidence', () => {
    const main = warmMain({ lastStartMs: 0, lastEndMs: 0, lastPrefix: 1000 })
    const out = observe(emptyAgg(0), main, step({ index: 0, startedMs: 1000, endedMs: 2000, usage: usage(1000, 9000) }))
    expect(out.agg.warmMaxMs).toBe(1000)
    expect(out.agg.coldMinMs).toBeUndefined()
    expect(out.main.lastHit).toBe(0.1)
    expect(out.main.lastPrefix).toBe(1000)
  })

  test('a high hit ratio that read under half the previous prefix is cold evidence', () => {
    const main = warmMain({ lastStartMs: 0, lastEndMs: 0, lastPrefix: 10_000 })
    const out = observe(emptyAgg(0), main, step({ index: 0, startedMs: 6 * MIN, usage: usage(4000, 0, 100) }))
    expect(out.agg.coldMinMs).toBe(6 * MIN)
    expect(out.agg.warmMaxMs).toBeUndefined()
  })

  test('a previous prefix of 0 gives no TTL evidence but still counts the band', () => {
    const main = warmMain({ lastStartMs: 0, lastEndMs: 0, lastPrefix: 0 })
    const out = observe(emptyAgg(0), main, step({ index: 0, startedMs: 2 * MIN }))
    expect(out.agg.bands['1-5m'].n).toBe(1)
    expect(out.agg.warmMaxMs).toBeUndefined()
    expect(out.agg.coldMinMs).toBeUndefined()
  })

  test('cache age runs from the previous request start, the gap band from its end', () => {
    const main = warmMain({ lastStartMs: 0, lastEndMs: 8 * MIN, lastPrefix: 100 })
    const out = observe(emptyAgg(0), main, step({ index: 0, startedMs: 8 * MIN + 30_000 }))
    expect(out.agg.bands['<1m'].n).toBe(1)
    expect(out.agg.warmMaxMs).toBe(8 * MIN + 30_000)
  })

  test('a gap inside a turn counts no band', () => {
    const out = observe(emptyAgg(0), warmMain(), step({ index: 4, startedMs: 2000 }))
    expect(out.agg.buckets.tool.n).toBe(1)
    expect(Object.values(out.agg.bands).every(t => t.n === 0)).toBe(true)
  })

  test('a new model counts a switch and clears the compact flag', () => {
    const out = observe(emptyAgg(0), warmMain({ isCompactPending: true }), step({ usage: usage(0, 100, 0, 'sonnet') }))
    expect(out.agg.buckets.compact.n).toBe(1)
    expect(out.agg.modelSwitches).toBe(1)
    expect(out.main.isCompactPending).toBe(false)
    expect(out.main.lastModel).toBe('sonnet')
  })
})

test('noteCompaction sets the flag, counts and stamps the time', () => {
  const out = noteCompaction(emptyAgg(0), warmMain(), 77)
  expect(out.main.isCompactPending).toBe(true)
  expect(out.agg.compactions).toBe(1)
  expect(out.agg.updatedAt).toBe(77)
})

describe('parseAgg', () => {
  test('refuses what is not an aggregate', () => {
    for (const bad of [undefined, null, 3, 'x', [], {}, { updatedAt: 'now' }]) {
      expect(parseAgg(bad)).toBeUndefined()
    }
  })

  test('fills missing or bad fields with zero', () => {
    const agg = parseAgg({ updatedAt: 7, buckets: { user: { n: 2, read: 'x', total: 10 } }, bands: { '<1m': -3 }, warmMaxMs: 'big', coldMinMs: 60_000, compactions: 1 })
    expect(agg?.buckets.user).toEqual({ n: 2, read: 0, total: 10 })
    expect(agg?.buckets.tool).toEqual({ n: 0, read: 0, total: 0 })
    expect(agg?.bands['<1m']).toEqual({ n: 0, read: 0, total: 0 })
    expect(agg?.warmMaxMs).toBeUndefined()
    expect(agg?.coldMinMs).toBe(60_000)
    expect(agg?.compactions).toBe(1)
    expect(agg?.modelSwitches).toBe(0)
  })

  test('reads a band stored before 0.3.0 as a bare count: requests with no hit ratio', () => {
    const agg = parseAgg({ updatedAt: 1, bands: { '1-5m': 3, '<1m': { n: 2, read: 5, total: 10 }, '>60m': { n: 'x' } } })
    expect(agg?.bands['1-5m']).toEqual({ n: 3, read: 0, total: 0 })
    expect(agg?.bands['<1m']).toEqual({ n: 2, read: 5, total: 10 })
    expect(agg?.bands['>60m']).toEqual({ n: 0, read: 0, total: 0 })
    expect(report(agg ?? emptyAgg(0))).toContain('| <1m | 2 | 50% |\n| 1-5m | 3 | – |')
  })

  test('reads back its own JSON', () => {
    const { agg } = observe(emptyAgg(0), warmMain(), step({ index: 0, startedMs: 2 * MIN }))
    expect(parseAgg(JSON.parse(JSON.stringify(agg)))).toEqual(agg)
  })
})

test('mergeAggs sums counts and keeps the widest bounds', () => {
  const a: Agg = { ...emptyAgg(1), warmMaxMs: 3 * MIN, coldMinMs: 9 * MIN, compactions: 1 }
  a.buckets.user = { n: 1, read: 5, total: 10 }
  a.bands['1-5m'] = { n: 1, read: 5, total: 10 }
  const b: Agg = { ...emptyAgg(4), warmMaxMs: 4 * MIN, coldMinMs: 8 * MIN, modelSwitches: 2 }
  b.buckets = { ...b.buckets, user: { n: 2, read: 1, total: 4 } }
  b.bands = { ...b.bands, '1-5m': { n: 2, read: 1, total: 4 } }
  const merged = mergeAggs([a, b, emptyAgg(2)])
  expect(merged.buckets.user).toEqual({ n: 3, read: 6, total: 14 })
  expect(merged.bands['1-5m']).toEqual({ n: 3, read: 6, total: 14 })
  expect(merged.warmMaxMs).toBe(4 * MIN)
  expect(merged.coldMinMs).toBe(8 * MIN)
  expect(merged.compactions).toBe(1)
  expect(merged.modelSwitches).toBe(2)
  expect(merged.updatedAt).toBe(4)
})

describe('keysToPrune', () => {
  const now = 100 * 24 * 60 * MIN

  test('picks junk and entries older than 30 days, never the current key', () => {
    const entries: [string, unknown][] = [
      ['session:EDGE', emptyAgg(now - PRUNE_AFTER_MS)],
      ['session:OLD', emptyAgg(now - PRUNE_AFTER_MS - 1)],
      ['session:BAD', 'junk'],
      ['session:ME', 'junk'],
    ]
    expect(keysToPrune(entries, 'session:ME', now)).toEqual(['session:OLD', 'session:BAD'])
  })

  test('keeps the newest sessions, the current one included, within the cap', () => {
    const entries: [string, unknown][] = Array.from({ length: MAX_SESSIONS + 2 }, (_, i) => [`session:${i}`, emptyAgg(now - i)])
    entries.push(['session:ME', emptyAgg(0)])
    const pruned = keysToPrune(entries, 'session:ME', now)
    expect(pruned).toEqual([`session:${MAX_SESSIONS + 1}`, `session:${MAX_SESSIONS}`, `session:${MAX_SESSIONS - 1}`])
    expect(entries.length - pruned.length).toBe(MAX_SESSIONS)
  })

  test('leaves a store under the cap alone', () => {
    expect(keysToPrune([['session:A', emptyAgg(now)]], undefined, now)).toEqual([])
  })
})

test('duration and percent format short values', () => {
  expect(duration(0)).toBe('0s')
  expect(duration(59_999)).toBe('59s')
  expect(duration(192_000)).toBe('3m12s')
  expect(duration(362_000)).toBe('6m02s')
  expect(duration(3_900_000)).toBe('1h05m')
  expect(duration(-5)).toBe('0s')
  expect(percent(97, 100)).toBe('97%')
  expect(percent(0, 0)).toBe('–')
})

test('tokens formats a prefix size', () => {
  expect(tokens(0)).toBe('0')
  expect(tokens(999)).toBe('999')
  expect(tokens(1000)).toBe('1k')
  expect(tokens(141_600)).toBe('142k')
  expect(tokens(999_499)).toBe('999k')
  expect(tokens(999_500)).toBe('1.0M')
  expect(tokens(1_234_567)).toBe('1.2M')
})

describe('statusText', () => {
  const ttlMs = 5 * MIN
  const session = (): Agg => {
    const agg = emptyAgg(0)
    agg.buckets.tool = { n: 2, read: 95, total: 100 }
    return agg
  }

  test('shows nothing before the first request', () => {
    expect(statusText({ nowMs: 9, ttlMs, isInFlight: false, main: emptyMain, session: emptyAgg(0) })).toBeUndefined()
    expect(statusText({ nowMs: 9, ttlMs, isInFlight: true, main: emptyMain, session: emptyAgg(0) })).toBeUndefined()
  })

  test('shows the session hit ratio while a main request is in flight', () => {
    expect(statusText({ nowMs: 9, ttlMs, isInFlight: true, main: warmMain({ lastHit: 0.97 }), session: session() })).toBe('session hit 95%')
  })

  test('counts down to the TTL while idle', () => {
    const main = warmMain({ lastStartMs: 0, lastEndMs: 0, lastHit: 0.97 })
    expect(statusText({ nowMs: 192_000, ttlMs, isInFlight: false, main, session: session() })).toBe('idle 3m12s · last hit 97% · 100 cached · cold in ~1m48s')
    expect(statusText({ nowMs: ttlMs, ttlMs, isInFlight: false, main, session: session() })).toBe('idle 5m00s · last hit 97% · 100 cached · likely cold')
    expect(statusText({ nowMs: 362_000, ttlMs, isInFlight: false, main, session: session() })).toBe('idle 6m02s · last hit 97% · 100 cached · likely cold')
  })

  test('counts the TTL from the request start and the idle time from its end', () => {
    const main = warmMain({ lastStartMs: 0, lastEndMs: 2 * MIN, lastHit: 0.9 })
    expect(statusText({ nowMs: 2 * MIN + 10_000, ttlMs, isInFlight: false, main, session: session() })).toBe('idle 10s · last hit 90% · 100 cached · cold in ~2m50s')
  })

  test('shows the cached prefix size, and omits it when it is 0 or unknown', () => {
    const main = warmMain({ lastStartMs: 0, lastEndMs: 0, lastHit: 0.97, lastPrefix: 141_600 })
    expect(statusText({ nowMs: 192_000, ttlMs, isInFlight: false, main, session: session() })).toBe('idle 3m12s · last hit 97% · 142k cached · cold in ~1m48s')
    expect(statusText({ nowMs: 9, ttlMs, isInFlight: true, main, session: session() })).toBe('session hit 95%')
    for (const lastPrefix of [0, undefined]) {
      const { lastPrefix: _, ...rest } = main
      const m = lastPrefix === undefined ? rest : { ...rest, lastPrefix }
      expect(statusText({ nowMs: 192_000, ttlMs, isInFlight: false, main: m, session: session() })).toBe('idle 3m12s · last hit 97% · cold in ~1m48s')
    }
  })

  test('shows nothing while idle with no sample yet', () => {
    expect(statusText({ nowMs: 9, ttlMs, isInFlight: false, main: warmMain(), session: emptyAgg(0) })).toBeUndefined()
  })
})

describe('warning', () => {
  const hour = 60 * MIN
  const view = (nowMs: number, over: Partial<Main> = {}, ttlMs = hour, isInFlight = false) => ({
    nowMs,
    ttlMs,
    isInFlight,
    main: warmMain({ lastStartMs: 0, lastEndMs: 0, lastHit: 0.97, lastPrefix: 141_600, ...over }),
    session: emptyAgg(0),
  })

  test('warns once the time left falls to the lead time: 5 min for 1 h, TTL / 5 below', () => {
    expect(warning(view(55 * MIN - 1000))).toBeUndefined()
    expect(warning(view(55 * MIN))).toBe('cache goes cold in ~5m00s (142k tokens)')
    expect(warning(view(55 * MIN + 1000))).toBe('cache goes cold in ~4m59s (142k tokens)')
    expect(warning(view(4 * MIN - 1000, {}, 5 * MIN))).toBeUndefined()
    expect(warning(view(4 * MIN, {}, 5 * MIN))).toBe('cache goes cold in ~1m00s (142k tokens)')
  })

  test('stays quiet once warned for this request, when cold, in flight, or with no prefix', () => {
    expect(warning(view(56 * MIN), 0)).toBeUndefined()
    expect(warning(view(56 * MIN), -1)).toBe('cache goes cold in ~4m00s (142k tokens)')
    expect(warning(view(hour))).toBeUndefined()
    expect(warning(view(56 * MIN, {}, hour, true))).toBeUndefined()
    expect(warning(view(56 * MIN, { lastPrefix: 0 }))).toBeUndefined()
    const { lastPrefix: _, ...noPrefix } = view(56 * MIN).main
    expect(warning({ ...view(56 * MIN), main: noPrefix })).toBeUndefined()
    expect(warning({ ...view(56 * MIN), main: emptyMain })).toBeUndefined()
  })
})

test('report is a Markdown table of the buckets with requests, then one of the user gap bands, bounds and counts', () => {
  const agg: Agg = { ...emptyAgg(0), warmMaxMs: 4 * MIN, coldMinMs: 90 * MIN, compactions: 2, modelSwitches: 1 }
  agg.buckets.user = { n: 3, read: 150, total: 200 }
  agg.buckets.tool = { n: 1, read: 0, total: 0 }
  agg.bands['1-5m'] = { n: 3, read: 150, total: 200 }
  agg.bands['>60m'] = { n: 1, read: 0, total: 50 }
  expect(report(agg)).toBe(
    [
      '| Gap type | Requests | Hit |',
      '| --- | ---: | ---: |',
      '| user | 3 | 75% |',
      '| tool | 1 | – |',
      '',
      '| User gap | Requests | Hit |',
      '| --- | ---: | ---: |',
      '| 1-5m | 3 | 75% |',
      '| >60m | 1 | 0% |',
      '',
      'Observed TTL: warm up to 4m00s · cold from 1h30m',
      '',
      'Compactions 2 · model switches 1',
    ].join('\n'),
  )
})

test('report says when there are no requests yet and dashes unknown bounds', () => {
  const text = report(emptyAgg(0))
  expect(text.split('\n')[0]).toBe('No requests yet.')
  expect(text).not.toContain('| Gap type')
  expect(text).toContain('No user gaps yet.')
  expect(text).toContain('Observed TTL: warm up to – · cold from –')
})

describe('cost sums', () => {
  test('main and subagent requests add input, cache read and cache creation', () => {
    const one = observe(emptyAgg(0), emptyMain, step({ index: 0, usage: usage(90, 10, 5) }))
    const two = observe(one.agg, one.main, step({ agentId: 'a1', usage: usage(7, 2, 1) }))
    expect(two.agg.sums).toEqual({ input: 12, read: 97, created: 6 })
  })

  test('parseAgg reads an aggregate stored before the sums as zero sums', () => {
    expect(parseAgg({ updatedAt: 1 })?.sums).toEqual({ input: 0, read: 0, created: 0 })
    expect(parseAgg({ updatedAt: 1, sums: { input: 3, read: 'x', created: -1 } })?.sums).toEqual({ input: 3, read: 0, created: 0 })
  })

  test('mergeAggs adds the sums', () => {
    const a = { ...emptyAgg(0), sums: { input: 1, read: 2, created: 3 } }
    expect(mergeAggs([a, a]).sums).toEqual({ input: 2, read: 4, created: 6 })
  })
})

describe('live cache state', () => {
  const LIVE = { lastStartMs: 2 * MIN, ttlMinutes: 60, prefix: 100, hit: 0.9 }

  test('withLive takes the last main request and the TTL', () => {
    const main = warmMain({ lastStartMs: 2 * MIN, lastHit: 0.9 })
    expect(withLive(emptyAgg(0), main, 60).live).toEqual(LIVE)
  })

  test('withLive keeps the aggregate before a main request with usage', () => {
    const agg = emptyAgg(0)
    expect(withLive(agg, emptyMain, 60)).toBe(agg)
  })

  test('withTtl changes only a stored live TTL that differs', () => {
    const agg = { ...emptyAgg(0), live: LIVE }
    expect(withTtl(agg, 60)).toBe(agg)
    expect(withTtl(agg, 5).live).toEqual({ ...LIVE, ttlMinutes: 5 })
    const none = emptyAgg(0)
    expect(withTtl(none, 5)).toBe(none)
  })

  test('parseAgg reads it back and drops a bad or missing one', () => {
    expect(parseAgg({ updatedAt: 1, live: LIVE })?.live).toEqual(LIVE)
    expect(parseAgg({ updatedAt: 1 })).not.toHaveProperty('live')
    for (const bad of ['x', { ...LIVE, hit: 2 }, { ...LIVE, ttlMinutes: 0 }, { ...LIVE, prefix: 'big' }, { ...LIVE, lastStartMs: -1 }]) {
      expect(parseAgg({ updatedAt: 1, live: bad })).not.toHaveProperty('live')
    }
  })

  test('savedPct is the cost share the cache saved, by the TTL write weight', () => {
    expect(savedPct({ input: 0, read: 900, created: 100 }, 60)).toBe(71)
    expect(savedPct({ input: 0, read: 900, created: 100 }, 5)).toBe(79)
    expect(savedPct({ input: 100, read: 0, created: 0 }, 60)).toBe(0)
    expect(savedPct({ input: 0, read: 0, created: 100 }, 60)).toBe(-100)
    expect(savedPct({ input: 0, read: 0, created: 0 }, 60)).toBeUndefined()
  })

  test('withSavedPct sets live.savedPct from the sums and drops it with no tokens', () => {
    const agg = { ...emptyAgg(0), live: LIVE, sums: { input: 0, read: 900, created: 100 } }
    const out = withSavedPct(agg)
    expect(out.live).toEqual({ ...LIVE, savedPct: 71 })
    expect(withSavedPct(out)).toBe(out)
    expect(withSavedPct({ ...out, sums: { input: 0, read: 0, created: 0 } }).live).toEqual(LIVE)
    const none = emptyAgg(0)
    expect(withSavedPct(none)).toBe(none)
  })

  test('withTtl recomputes savedPct with the new write weight', () => {
    const agg = withSavedPct({ ...emptyAgg(0), live: LIVE, sums: { input: 0, read: 900, created: 100 } })
    expect(withTtl(agg, 5).live).toEqual({ ...LIVE, ttlMinutes: 5, savedPct: 79 })
  })

  test('parseAgg reads savedPct and drops a bad one alone', () => {
    expect(parseAgg({ updatedAt: 1, live: { ...LIVE, savedPct: -12 } })?.live).toEqual({ ...LIVE, savedPct: -12 })
    expect(parseAgg({ updatedAt: 1, live: { ...LIVE, savedPct: 'x' } })?.live).toEqual(LIVE)
    expect(parseAgg({ updatedAt: 1, live: { ...LIVE, savedPct: null } })?.live).toEqual(LIVE)
  })

  test('mergeAggs ignores it', () => {
    const a = { ...emptyAgg(0), live: LIVE }
    expect(mergeAggs([a, a])).not.toHaveProperty('live')
  })
})
