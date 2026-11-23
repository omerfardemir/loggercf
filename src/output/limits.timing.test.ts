// The Line Limits timing tests: they compare durations, so vitest runs this file after
// every other test file, alone (see vitest.config.ts), with nothing else on the CPU.
import { describe, it, expect, beforeEach } from 'vitest'
import { createLogger, _captureLines, _reset } from '../core/logger'
import { redactKeys } from './redact'
import { bytes, flatFields, limited, nestedFields } from '../testing/limits'

/** How long `fn` takes, in milliseconds. */
const elapsed = (fn: () => void) => {
  const start = performance.now()
  fn()
  return performance.now() - start
}

/**
 * The fastest of 3 lines carrying `fields`, trimmed to 10,000 bytes, in milliseconds.
 *
 * @param {Record<string, unknown>} fields - The fields of the line.
 * @returns {number} The time.
 */
function trimTime(fields: Record<string, unknown>): number {
  const { log } = limited({ maxRecordBytes: 10_000 })
  log((l) => l.info(fields)) // warm up
  return Math.min(...Array.from({ length: 3 }, () => elapsed(() => log((l) => l.info(fields)))))
}

/**
 * The fastest of 3 last-resort lines, from `n` characters of `service` and `message`, in milliseconds.
 *
 * @param {number} n - How many characters.
 * @returns {number} The time.
 */
function lastResortTime(n: number): number {
  const lines = _captureLines()
  const logger = createLogger({ service: 's'.repeat(n), limits: { maxRecordBytes: 1024 } })
  const run = () => logger.info('m'.repeat(n))
  run() // warm up
  const ms = Math.min(...Array.from({ length: 3 }, () => elapsed(run)))
  expect(bytes(lines.at(-1)!)).toBeLessThanOrEqual(1024)
  return ms
}

/**
 * The multi-MB lines `maxRecordBytes` trims from the walk's copy: wide lines
 * of short values (strings, numbers, keys), whose own walk is quick, so a
 * measuring pass shows, and a long string.
 */
const MULTI_MB: [string, () => Record<string, unknown>, number?][] = [
  ['a 20 MB string', () => ({ s: 'x'.repeat(20_000_000) })],
  [
    '2.2 MB, an array of 100k short strings',
    () => ({ list: Array.from({ length: 100_000 }, (_, i) => `item-${i}-zzzzzzzz`) }),
    // On Node 24 this shape measures 1.17x-1.22x alone, and about 1.27x on CI's runners (1.1x
    // on Node 22). Read back, as before #47, it took 2.71x, so 1.4x still catches that.
    1.4,
  ],
  [
    '1.1 MB, an array of 150k numbers',
    () => ({ list: Array.from({ length: 150_000 }, (_, i) => i * 7) }),
  ],
  [
    '1.5 MB, 100k keys',
    () => Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i])),
  ],
  ['1.6 MB of 60-byte fields', () => flatFields(23_000)],
  [
    '2.2 MB, an array of 100k small objects',
    () => ({ list: Array.from({ length: 100_000 }, (_, i) => ({ i, s: 'ab' })) }),
  ],
]

/**
 * How long a line of `fields` takes trimmed to 16,384 bytes, over how long it
 * takes written whole by the same logger without `limits`: the median of 9
 * runs of each, taken in turn, so load on the machine slows both alike.
 *
 * @param {Record<string, unknown>} fields - The fields of the line.
 * @param {boolean} redact - Whether both loggers have a redactor.
 * @returns {number} The ratio.
 */
function trimRatio(fields: Record<string, unknown>, redact: boolean): number {
  const lines = _captureLines()
  const options = { service: 'svc', redact: redact && redactKeys(['password']) }
  const whole = createLogger(options)
  const trimmed = createLogger({ ...options, limits: { maxRecordBytes: 16_384 } })
  const run = (logger: typeof whole) => elapsed(() => logger.info(fields, 'big'))
  run(whole) // warm up
  run(trimmed)
  const times: [number[], number[]] = [[], []]
  for (let i = 0; i < 9; i++) {
    times[0].push(run(whole))
    times[1].push(run(trimmed))
  }
  expect(bytes(lines.at(-1)!)).toBeLessThanOrEqual(16_384)
  return median(times[1]) / median(times[0])
}

/**
 * The middle of an odd number of times.
 *
 * @param {number[]} times - The times.
 * @returns {number} Their median.
 */
const median = (times: number[]): number => {
  const half = times.length >> 1
  // The one with no more than half the others below it, and no more than half above.
  return times.find(
    (t) => times.filter((u) => u < t).length <= half && times.filter((u) => u > t).length <= half,
  )!
}

describe('limits are bounded in time', () => {
  beforeEach(() => _reset())

  it('a 10 MB string, a 100k-item array and 50k fields: each trimmed in well under a second', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['10 MB string', { s: 'x'.repeat(10_000_000) }],
      ['100k-item array', { list: Array.from({ length: 100_000 }, (_, i) => ({ i })) }],
      [
        '50k fields',
        Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, 'v'.repeat(20)])),
      ],
      [
        'deep and wide',
        {
          tree: Array.from({ length: 200 }, (_, i) => ({
            i,
            kids: Array.from({ length: 200 }, (_item, j) => ({ j, s: 'abc'.repeat(5) })),
          })),
        },
      ],
    ]
    for (const [, fields] of cases) {
      const { lines, log } = limited({ maxRecordBytes: 200_000 })
      const ms = elapsed(() => log((l) => l.info(fields, 'big')))
      expect(bytes(lines.at(-1)!)).toBeLessThanOrEqual(200_000)
      expect(ms).toBeLessThan(1_500)
    }
  })

  it('doubling the line about doubles the time: linear, not quadratic', () => {
    const small = trimTime(nestedFields(20_000))
    const large = trimTime(nestedFields(80_000))
    expect(large / small).toBeLessThan(10) // 4x the size: quadratic would be ~16x
  }, 30_000)

  it('trimming the tail of a flat wide object is linear too: 4x the fields, under 10x the time', () => {
    const small = trimTime(flatFields(20_000))
    const large = trimTime(flatFields(80_000))
    expect(large / small).toBeLessThan(10)
  }, 30_000)

  it('the last resort is linear too: 4x the text, under 10x the time', () => {
    expect(lastResortTime(2_000_000) / lastResortTime(500_000)).toBeLessThan(10)
  }, 30_000)

  // Written whole and read back, these took 1.3x to 3.3x as long; now 0.9x to 1.2x, and up to
  // about 1.3x for many short strings on Node 24 (see MULTI_MB). A run that goes over is measured
  // again: a real regression stays over.
  it.each(
    MULTI_MB.flatMap(([name, fields, bound = 1.25]) => [
      [name, fields, false, bound],
      [`${name}, redacted`, fields, true, bound],
    ]) as [string, () => Record<string, unknown>, boolean, number][],
  )(
    'an oversized multi-MB line costs little more than writing it whole does: %s',
    { timeout: 60_000, retry: 2 },
    (_, fields, redact, bound) => {
      expect(trimRatio(fields(), redact)).toBeLessThan(bound)
    },
  )
})
