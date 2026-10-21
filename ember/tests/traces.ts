import type { Trace } from '../hooks/analysis.ts'

const MIN = 60_000
const HOUR = 60 * MIN

/** A seeded generator (mulberry32), so every trace is the same on every run. */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const spread = (n: number, fromMs: number, toMs: number, ttlMinutes: number, prefix = 100_000, isReturn = true): Trace[] =>
  Array.from({ length: n }, (_, i) => ({ ageMs: fromMs + ((toMs - fromMs) * (i + 0.5)) / n, isReturn, ttlMinutes, prefix }))

/** A day of work: mostly short gaps, some meetings and lunches, a few overnight returns and exits. */
function mixed(seed: number, n: number, ttlMinutes: number, prefix = 100_000): Trace[] {
  const r = rng(seed)
  return Array.from({ length: n }, () => {
    const u = r()
    const v = r()
    if (u < 0.7) return { ageMs: Math.exp(Math.log(20_000) + v * Math.log(30)), isReturn: true, ttlMinutes, prefix } // 20 s to 10 min
    if (u < 0.85) return { ageMs: (10 + 40 * v) * MIN, isReturn: true, ttlMinutes, prefix }
    if (u < 0.92) return { ageMs: (55 + 65 * v) * MIN, isReturn: true, ttlMinutes, prefix }
    if (u < 0.97) return { ageMs: (2 + 14 * v) * HOUR, isReturn: true, ttlMinutes, prefix }
    return { ageMs: (1 + 11 * v) * HOUR, isReturn: false, ttlMinutes, prefix }
  })
}

/** The store's two real `user` gaps (5-15m and a warm one at 29m03s, prefix ~27k), then synthetic traces. */
export const TRACES: Record<string, Trace[]> = {
  'seed-real': [
    { ageMs: 10 * MIN, isReturn: true, ttlMinutes: 60, prefix: 27_000 },
    { ageMs: 1_743_206, isReturn: true, ttlMinutes: 60, prefix: 27_000 },
  ],
  'short-60': spread(40, MIN, 50 * MIN, 60),
  'around-expiry-60': spread(20, 50 * MIN, 70 * MIN, 60),
  'just-after-expiry-60': spread(20, 60 * MIN, 75 * MIN, 60),
  'lunch-60': spread(20, 1.5 * HOUR, 3 * HOUR, 60),
  'overnight-return-60': spread(10, 10 * HOUR, 16 * HOUR, 60),
  'weekend-return-60': spread(5, 60 * HOUR, 64 * HOUR, 60),
  'short-5': spread(40, 30_000, 4.5 * MIN, 5),
  'coffee-5': spread(30, 5 * MIN, 30 * MIN, 5),
  'just-after-expiry-5': spread(20, 5 * MIN, 7 * MIN, 5),
  'overnight-return-5': spread(10, 8 * HOUR, 14 * HOUR, 5),
  'mixed-60': mixed(1, 200, 60),
  'mixed-5': mixed(2, 200, 5),
  'many-sessions': Array.from({ length: 12 }, (_, i) => mixed(100 + i, 40, i % 2 === 0 ? 60 : 5, 20_000 + i * 35_000)).flat(),
  'ttl-switch-60-to-5': [...mixed(3, 60, 60), ...mixed(4, 60, 5)],
}

/** Only exits: the optimum pays nothing, so no ratio exists; the cap bounds the waste per pause. */
export const EXIT_TRACES: Record<string, Trace[]> = {
  'exit-overnight-60': spread(10, 2 * HOUR, 12 * HOUR, 60, 100_000, false),
  'exit-overnight-5': spread(10, 2 * HOUR, 12 * HOUR, 5, 100_000, false),
}
