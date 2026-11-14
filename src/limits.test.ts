import { describe, it, expect, beforeEach } from 'vitest'
import { createLogger, runWithLogger, getLogger, _captureLines, _reset } from './logger'
import { omitErrorKeys } from './omit'
import { fitLine, fitValue, utf8Bytes } from './limits'
import { redactKeys } from './redact'
import type { LineLimits } from './types'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

/** How long `fn` takes, in milliseconds. */
const elapsed = (fn: () => void) => {
  const start = performance.now()
  fn()
  return performance.now() - start
}

/** The bytes of a line, as the platform counts them. */
const bytes = (line: string) => Buffer.byteLength(line, 'utf8')

/** A line without the values that differ from one call to the next. */
const strip = (line: string) => line.replace(/"(time|spanId)":"[^"]+"/g, '')

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
 * `n` fields whose values are small objects of 30 to 79 characters.
 *
 * @param {number} n - How many fields.
 * @returns {Record<string, unknown>} The fields.
 */
const nestedFields = (n: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`k${i}`, { s: 'v'.repeat(30 + (i % 50)) }]),
  )

/**
 * `n` flat fields of 60 characters.
 *
 * @param {number} n - How many fields.
 * @returns {Record<string, unknown>} The fields.
 */
const flatFields = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v'.repeat(60)]))

/**
 * A 60-byte string, different for each `i`.
 *
 * @param {number} i - Which one.
 * @returns {string} The string.
 */
const sixtyBytes = (i: number): string => `${String(i).padStart(5, '0')}${'v'.repeat(55)}`

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
const MULTI_MB: [string, () => Record<string, unknown>][] = [
  ['a 20 MB string', () => ({ s: 'x'.repeat(20_000_000) })],
  [
    '2.2 MB, an array of 100k short strings',
    () => ({ list: Array.from({ length: 100_000 }, (_, i) => `item-${i}-zzzzzzzz`) }),
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

/** A logger with `limits`, inside a Logging Context, and the lines it writes. */
function limited(limits: LineLimits) {
  const lines = _captureLines()
  const logger = createLogger(
    { service: 'svc', environment: 'production', version: '1.0.0', limits },
    { region: 'eu' },
  )
  const log = (fn: (l: typeof logger) => void) =>
    runWithLogger({ logger, traceparent: TRACEPARENT }, () => fn(getLogger()))
  const parsed = (i = lines.length - 1) => JSON.parse(lines[i]) as Record<string, any>
  return { lines, log, parsed }
}

describe('limits.maxStringLength', () => {
  beforeEach(() => _reset())

  it('cuts every longer string value, at any depth, with a marker holding its length', () => {
    const { log, parsed } = limited({ maxStringLength: 10 })
    log((l) =>
      l.info({ short: 'abc', long: 'x'.repeat(50), nested: { list: ['y'.repeat(20), 'ok'] } }),
    )
    expect(parsed()).toMatchObject({
      short: 'abc',
      long: 'xxxxxxxxxx…[truncated from 50 chars]',
      nested: { list: ['yyyyyyyyyy…[truncated from 20 chars]', 'ok'] },
    })
  })

  it('cuts message and err.message, but never time, level, the trace IDs, service, environment, version or err.type', () => {
    const { log, parsed } = limited({ maxStringLength: 3 })
    class VeryLongErrorName extends Error {}
    log((l) => l.error(new VeryLongErrorName('a long message'), 'the line message'))
    const line = parsed()
    expect(line.time).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(line).toMatchObject({
      level: 'ERROR',
      message: 'the…[truncated from 16 chars]',
      service: 'svc',
      environment: 'production',
      version: '1.0.0',
      region: 'eu…'.slice(0, 2), // 2 characters: not cut
      traceId: '0af7651916cd43dd8448eb211c80319c',
      err: { type: 'VeryLongErrorName', message: 'a l…[truncated from 14 chars]' },
    })
    expect(line.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(line.err.stack).toMatch(/…\[truncated from \d+ chars\]$/)
  })

  it('cuts on the full walk too (a line with a repeat), and the texts of a BigInt or a function', () => {
    const { log, parsed } = limited({ maxStringLength: 5 })
    const shared = { s: 'z'.repeat(30) }
    log((l) => l.info({ p: shared, q: shared, n: 10n ** 30n, m: new Map([['k', 'v'.repeat(9)]]) }))
    expect(parsed()).toMatchObject({
      p: { s: 'zzzzz…[truncated from 30 chars]' },
      q: { s: 'zzzzz…[truncated from 30 chars]' },
      n: '10000…[truncated from 31 chars]',
      m: [['k', 'vvvvv…[truncated from 9 chars]']],
    })
  })

  it('never splits a surrogate pair', () => {
    const { log, parsed } = limited({ maxStringLength: 3 })
    log((l) => l.info({ s: 'ab😀cd' }))
    expect(parsed().s).toBe('ab…[truncated from 6 chars]')
  })

  it('keeps keys whole', () => {
    const { log, parsed } = limited({ maxStringLength: 3 })
    log((l) => l.info({ ['k'.repeat(10)]: 1 }))
    expect(parsed()).toHaveProperty('k'.repeat(10), 1)
  })

  it('without limits, nothing is cut', () => {
    const lines = _captureLines()
    const huge = 'h'.repeat(2_000_000)
    createLogger({ service: 'svc' }).info({ huge })
    expect(JSON.parse(lines[0]).huge).toBe(huge)
  })

  it('rejects a value that is not an integer >= 1', () => {
    for (const bad of [0, -1, 1.5, NaN, '10'])
      expect(() =>
        createLogger({ service: 's', limits: { maxStringLength: bad as never } }),
      ).toThrow(`invalid limits.maxStringLength ${bad}`)
  })
})

describe('limits.maxRecordBytes', () => {
  beforeEach(() => _reset())

  it('a line that fits is untouched', () => {
    const { lines, log } = limited({ maxRecordBytes: 2048 })
    log((l) => l.info({ a: 'x'.repeat(100) }, 'small'))
    const unlimited = _captureLines()
    runWithLogger(
      {
        logger: createLogger(
          { service: 'svc', environment: 'production', version: '1.0.0' },
          { region: 'eu' },
        ),
        traceparent: TRACEPARENT,
      },
      () => getLogger().info({ a: 'x'.repeat(100) }, 'small'),
    )
    expect(strip(lines[0])).toBe(strip(unlimited[0]))
  })

  it('trims the largest values first, and keeps the Protected Fields whole', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 4096 })
    log((l) =>
      l.error(
        {
          small: 'keep me',
          medium: 'm'.repeat(1500),
          big: { rows: Array.from({ length: 500 }, (_, i) => ({ i, name: `row ${i}` })) },
          text: 't'.repeat(3000),
        },
        'the message',
      ),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(4096)
    const line = parsed()
    expect(line).toMatchObject({
      level: 'ERROR',
      message: 'the message',
      service: 'svc',
      environment: 'production',
      version: '1.0.0',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      small: 'keep me',
      region: 'eu',
    })
    expect(line.big).toMatch(/^\[Trimmed: \d+ bytes\]$/)
    // The two largest are gone or cut; what is left of the line still fits.
    expect(typeof line.text).toBe('string')
    expect(line.text.length).toBeLessThan(3000)
  })

  it('cuts one large string just enough, and says how long it was', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 2048 })
    log((l) => l.info({ payload: 'p'.repeat(5000), other: 'q'.repeat(100) }, 'm'))
    expect(bytes(lines[0])).toBeLessThanOrEqual(2048)
    expect(bytes(lines[0])).toBeGreaterThan(2000)
    expect(parsed().payload).toMatch(/^p+…\[truncated from 5000 chars\]$/)
    expect(parsed().other).toBe('q'.repeat(100))
  })

  it('an array of many small items keeps the first ones, and says how many went', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 4096 })
    log((l) => l.info({ ids: Array.from({ length: 5000 }, (_, i) => i) }, 'm'))
    expect(bytes(lines[0])).toBeLessThanOrEqual(4096)
    expect(bytes(lines[0])).toBeGreaterThan(4000)
    const ids = parsed().ids as unknown[]
    expect(ids.slice(0, 3)).toEqual([0, 1, 2])
    expect(ids.at(-1)).toMatch(/^\[Trimmed: \d+ items, \d+ bytes\]$/)
    expect(ids.length).toBeGreaterThan(500)
  })

  it('trims inside err, but keeps err.type and err.message', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 1024 })
    const err = Object.assign(new Error('the error message'), {
      body: 'b'.repeat(5000),
      code: 'E_CODE',
    })
    err.stack = 's'.repeat(3000)
    log((l) => l.error(err, 'failed'))
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    expect(parsed().err).toMatchObject({
      type: 'Error',
      message: 'the error message',
      code: 'E_CODE',
    })
  })

  it('counts UTF-8 bytes exactly: multi-byte text, escapes and emoji', () => {
    const texts = [
      'é'.repeat(3000),
      '中'.repeat(3000),
      '😀'.repeat(3000),
      '"\\\n\u0001'.repeat(1500),
    ]
    for (const text of texts) {
      const { lines, log } = limited({ maxRecordBytes: 2000 })
      log((l) => l.info({ text, keep: 'k' }, 'm'))
      const line = lines.at(-1)!
      expect(bytes(line)).toBeLessThanOrEqual(2000)
      expect(bytes(line)).toBeGreaterThan(1900) // cut just enough, not to the bone
      expect(JSON.parse(line).keep).toBe('k')
      expect(utf8Bytes(line)).toBe(bytes(line))
    }
  })

  it('many small fields: the leading ones are kept, the tail is one "[Trimmed]" entry', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 4096 })
    log((l) =>
      l.warn(
        Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])),
        'too many fields',
      ),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(4096)
    expect(bytes(lines[0])).toBeGreaterThan(4000) // trimmed just enough
    const line = parsed()
    expect(line).toMatchObject({
      level: 'WARN',
      message: 'too many fields',
      service: 'svc',
      environment: 'production',
      version: '1.0.0',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentSpanId: 'b7ad6b7169203331',
      region: 'eu',
      k0: 0,
      k1: 1,
    })
    expect(line.logError).toBeUndefined()
    const keys = Object.keys(line)
    expect(keys.at(-1)).toBe('[Trimmed]')
    const marker = /^\[Trimmed: (\d+) keys, (\d+) bytes\]$/.exec(line['[Trimmed]'])
    expect(marker).not.toBeNull()
    // The keys kept are the first ones, in order, and the marker counts the rest.
    const kept = keys.filter((k) => /^k\d+$/.test(k))
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => `k${i}`))
    expect(kept.length).toBeGreaterThan(300)
    expect(kept.length + Number(marker![1])).toBe(5000)
  })

  it('20k fields of 60 bytes at 200 KB keep their leading fields whole', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 200_000 })
    log((l) =>
      l.info(
        Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, sixtyBytes(i)])),
      ),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(200_000)
    expect(bytes(lines[0])).toBeGreaterThan(199_000)
    const line = parsed()
    expect(line.logError).toBeUndefined()
    expect(line.k0).toBe(sixtyBytes(0))
    expect(line.k1000).toBe(sixtyBytes(1000))
    expect(lines[0]).not.toContain('truncated from')
    expect(line['[Trimmed]']).toMatch(/^\[Trimmed: \d+ keys, \d+ bytes\]$/)
  })

  it('an Error with 50k properties keeps type, message and its leading properties', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 4096 })
    const err = Object.assign(
      new Error('the error message'),
      Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`p${i}`, i])),
    )
    err.stack = 'at here'
    log((l) => l.error(err, 'failed'))
    expect(bytes(lines[0])).toBeLessThanOrEqual(4096)
    const line = parsed()
    expect(line.logError).toBeUndefined()
    expect(line.err).toMatchObject({
      type: 'Error',
      message: 'the error message',
      stack: 'at here',
      p0: 0,
      p1: 1,
    })
    expect(line.err['[Trimmed]']).toMatch(/^\[Trimmed: \d+ keys, \d+ bytes\]$/)
  })

  it('a wide object nested in a field is trimmed inside, keeping its leading keys', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 2048 })
    log((l) =>
      l.info({
        before: 'b',
        wide: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`w${i}`, i])),
        after: 'a',
      }),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(2048)
    const line = parsed()
    expect(line.before).toBe('b')
    expect(line.after).toBe('a')
    expect(line.wide).toMatchObject({ w0: 0, w1: 1 })
    expect(line.wide['[Trimmed]']).toMatch(/^\[Trimmed: \d+ keys, \d+ bytes\]$/)
  })

  it('never trims a Protected Field, however many fields follow it', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 1024 })
    log((l) =>
      l.info(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`f${i}`, i])), 'kept'),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    expect(parsed()).toMatchObject({
      level: 'INFO',
      message: 'kept',
      service: 'svc',
      environment: 'production',
      version: '1.0.0',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      f0: 0,
    })
  })

  it('a field named "[Trimmed]" is not overwritten by the marker', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 2048 })
    log((l) =>
      l.info({
        '[Trimmed]': 'mine',
        ...Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i])),
      }),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(2048)
    expect(parsed()['[Trimmed]']).toBe('mine')
    expect(parsed()['[Trimmed]_']).toMatch(/^\[Trimmed: \d+ keys, \d+ bytes\]$/)
  })

  it('counts exact UTF-8 when it trims keys: emoji, CJK and escapes in keys and values', () => {
    const makers: ((i: number) => [string, unknown])[] = [
      (i) => [`😀${i}`, '中文'.repeat(10)],
      (i) => [`k"${i}\\`, '"\\\n\u0001é'.repeat(8)],
      (i) => [`é${i}`, i],
    ]
    for (const make of makers) {
      const { lines, log } = limited({ maxRecordBytes: 3000 })
      log((l) => l.info(Object.fromEntries(Array.from({ length: 4000 }, (_, i) => make(i)))))
      const line = lines.at(-1)!
      expect(bytes(line)).toBeLessThanOrEqual(3000)
      expect(bytes(line)).toBeGreaterThan(2800)
      expect(utf8Bytes(line)).toBe(bytes(line))
      expect(JSON.parse(line)['[Trimmed]']).toMatch(/^\[Trimmed: \d+ keys/)
    }
  })

  it('values of a few hundred bytes keep the leading ones whole, then one "[Trimmed]" entry', () => {
    const cases: [string, number][] = [
      ['é'.repeat(150), 4096],
      ['😀"\n€'.repeat(20), 2048],
    ]
    for (const [text, max] of cases) {
      const { lines, log, parsed } = limited({ maxRecordBytes: max })
      log((l) =>
        l.info(Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, text])), 'm'),
      )
      expect(bytes(lines[0])).toBeLessThanOrEqual(max)
      const line = parsed()
      expect(line.logError).toBeUndefined()
      expect(line.k0).toBe(text)
      expect(line.k1).toBe(text)
      expect(Object.keys(line).at(-1)).toBe('[Trimmed]')
      expect(line['[Trimmed]']).toMatch(/^\[Trimmed: \d+ keys, \d+ bytes\]$/)
      // No value became a marker: every one of them is whole.
      const kept = Object.keys(line).filter((k) => /^k\d+$/.test(k))
      expect(kept.length).toBeGreaterThan(5)
      for (const key of kept) expect(line[key]).toBe(text)
      expect(lines[0]).not.toContain('truncated from')
    }
  })

  it('still cuts the one huge value first, and keeps the medium ones whole', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 12_000 })
    const medium = 'é'.repeat(100)
    log((l) =>
      l.info(
        {
          before: medium,
          huge: 'h'.repeat(20_000),
          ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, medium])),
        },
        'm',
      ),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(12_000)
    expect(bytes(lines[0])).toBeGreaterThan(11_000)
    const line = parsed()
    expect(line.huge).toMatch(/^h+…\[truncated from 20000 chars\]$/)
    expect(line.before).toBe(medium)
    expect(line.k39).toBe(medium)
    expect(line['[Trimmed]']).toBeUndefined()
  })

  it('a wide object of medium values nested in a field keeps its leading values whole', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 4096 })
    const text = 'x'.repeat(200)
    log((l) =>
      l.info({
        wide: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`w${i}`, text])),
        after: 'a',
      }),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(4096)
    const line = parsed()
    expect(line.after).toBe('a')
    expect(line.wide.w0).toBe(text)
    expect(line.wide['[Trimmed]']).toMatch(/^\[Trimmed: \d+ keys, \d+ bytes\]$/)
    expect(lines[0]).not.toContain('truncated from')
  })

  it('the marker takes the key "[Trimmed]" when the user\'s one is among the keys it drops', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 2048 })
    log((l) =>
      l.info({
        ...Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i])),
        '[Trimmed]': 'mine',
      }),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(2048)
    const line = parsed()
    expect(line['[Trimmed]']).toMatch(/^\[Trimmed: \d+ keys, \d+ bytes\]$/)
    expect(line['[Trimmed]_']).toBeUndefined()
    expect(lines[0]).not.toContain('"mine"')
  })

  it('a message too large on its own is cut last, with the marker', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 1024 })
    log((l) => l.error(new Error('e'.repeat(5000)), 'm'.repeat(5000)))
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    const line = parsed()
    expect(line.message).toMatch(/^m*…\[truncated from 5000 chars\]$/)
    expect(line.err.message).toMatch(/^e*…\[truncated from 5000 chars\]$/)
    expect(line.err.type).toBe('Error')
    expect(line.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
  })

  it('the last resort keeps the trace IDs and cuts a huge service, with the marker', () => {
    const lines = _captureLines()
    const logger = createLogger({
      service: 's'.repeat(5000),
      environment: 'production',
      version: '1.0.0',
      limits: { maxRecordBytes: 1024 },
    })
    runWithLogger({ logger, traceparent: TRACEPARENT }, () => getLogger().info('x'))
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    expect(JSON.parse(lines[0])).toEqual({
      time: expect.any(String),
      level: 'INFO',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: expect.any(String),
      parentSpanId: 'b7ad6b7169203331',
      service: expect.stringMatching(/^s+…\[truncated from 5000 chars\]$/),
      environment: 'production',
      version: '1.0.0',
      message: 'x',
      logError: 'line over maxRecordBytes (1024)',
    })
  })

  it('the last resort cuts every huge Protected Field and err.type, and keeps the trace IDs', () => {
    const lines = _captureLines()
    const logger = createLogger({
      service: 's'.repeat(5000),
      environment: 'e'.repeat(5000),
      version: 'v'.repeat(5000),
      limits: { maxRecordBytes: 1024 },
    })
    class Boom extends Error {}
    Object.defineProperty(Boom, 'name', { value: 'T'.repeat(5000) })
    runWithLogger({ logger, traceparent: TRACEPARENT }, () =>
      getLogger().error(new Boom('b'.repeat(5000)), 'm'.repeat(5000)),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    const line = JSON.parse(lines[0])
    expect(line.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(line.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(line.parentSpanId).toBe('b7ad6b7169203331')
    expect(line.logError).toBe('line over maxRecordBytes (1024)')
    const cases = [
      [line.service, 's'],
      [line.environment, 'e'],
      [line.version, 'v'],
      [line.message, 'm'],
      [line.err.type, 'T'],
    ] as const
    for (const [value, ch] of cases)
      expect(value).toMatch(new RegExp(`^${ch}+…\\[truncated from 5000 chars\\]$`))
    expect(Object.keys(line.err)).toEqual(['type'])
  })

  it('the last resort never splits a surrogate pair or an escape', () => {
    for (const text of ['😀'.repeat(3000), '"\\\n'.repeat(2000), '中'.repeat(3000)]) {
      const lines = _captureLines()
      createLogger({ service: text, limits: { maxRecordBytes: 1024 } }).info(text)
      expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
      const line = JSON.parse(lines[0])
      expect(line.service).toMatch(/…\[truncated from \d+ chars\]$/)
      expect(line.service).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
      expect(line.service).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/)
    }
  })

  it('the last resort stays within the limit when the trace IDs and time are escaped characters', () => {
    const control = '\u0001'.repeat(64) // 6 bytes each in JSON
    const record = {
      time: control,
      level: 'INFO',
      traceId: control,
      spanId: control,
      parentSpanId: control,
    }
    const line = fitLine(`{"time":"x","broken":${'['.repeat(5000)}`, record, 1024)
    expect(bytes(line)).toBeLessThanOrEqual(1024)
    // The trace IDs go first; time fits without them.
    expect(JSON.parse(line)).toEqual({
      time: control,
      level: 'INFO',
      logError: 'line over maxRecordBytes (1024)',
    })
  })

  it('the last resort trims time and level to fit when nothing else can go', () => {
    const control = '\u0001'.repeat(64)
    const record = { time: control, level: '\u0001'.repeat(16), traceId: control }
    const line = fitLine(`{"time":"x","broken":${'['.repeat(5000)}`, record, 200)
    expect(bytes(line)).toBeLessThanOrEqual(200)
    const parsed = JSON.parse(line)
    expect(parsed.logError).toBe('line over maxRecordBytes (200)')
    expect(parsed.traceId).toBeUndefined()
    expect(parsed.time.length).toBeGreaterThan(0)
    expect(control.startsWith(parsed.time)).toBe(true)
    expect('\u0001'.repeat(16).startsWith(parsed.level)).toBe(true)
  })

  it('the last resort never gives message a second cut marker', () => {
    const lines = _captureLines()
    const logger = createLogger({
      service: 's'.repeat(5000),
      environment: 'e'.repeat(5000),
      version: 'v'.repeat(5000),
      limits: { maxStringLength: 300, maxRecordBytes: 1024 },
    })
    logger.info('m'.repeat(5000))
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    const { message } = JSON.parse(lines[0])
    expect(message).toMatch(/^m+…\[truncated from 5000 chars\]$/)
    expect(message.split('truncated from')).toHaveLength(2)
    expect(message.length).toBeLessThan(300) // cut further than maxStringLength did
  })

  it('trimming message and err.message to fit keeps one cut marker, with the original length', () => {
    const lines = _captureLines()
    const logger = createLogger({
      service: 's'.repeat(400),
      limits: { maxStringLength: 500, maxRecordBytes: 1024 },
    })
    logger.error(new Error('e'.repeat(5000)), 'm'.repeat(5000))
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    const line = JSON.parse(lines[0])
    expect(line.logError).toMatch(/only the Protected Fields/)
    for (const text of [line.message, line.err.message]) {
      expect(text).toMatch(/^[me]*…\[truncated from 5000 chars\]$/)
      expect(text.split('truncated from')).toHaveLength(2)
    }
  })

  it('a string that only ends like a cut marker is cut with its own length', () => {
    const lines = _captureLines()
    const text = 'x'.repeat(5000) + '…[truncated from 9 chars]'
    createLogger({ service: 's', limits: { maxRecordBytes: 1024 } }).info({ a: text }, 'm')
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    const cut: string = JSON.parse(lines[0]).a
    expect(cut.startsWith('xxx')).toBe(true)
    expect(cut.endsWith(`…[truncated from ${text.length} chars]`)).toBe(true)
  })

  it('a cut marker is found however many digits it holds, and only at the end', () => {
    const lines = _captureLines()
    const logger = createLogger({ service: 's', limits: { maxRecordBytes: 1024 } })
    const many = `${'x'.repeat(5000)}…[truncated from ${'9'.repeat(60)} chars]`
    const twice = `${'y'.repeat(5000)}…[truncated from 9000 chars]…[truncated from 7000 chars]`
    logger.info({ a: many }, 'm')
    logger.info({ b: twice }, 'm')
    expect(JSON.parse(lines[0]).a).toMatch(/^x+…\[truncated from 1e\+60 chars\]$/)
    expect(JSON.parse(lines[1]).b).toMatch(/^y+…\[truncated from 7000 chars\]$/)
  })

  it('works with maxStringLength and omitErrorKeys together', () => {
    const lines = _captureLines()
    const logger = createLogger({
      service: 'svc',
      serializeError: omitErrorKeys(['responseBody']),
      limits: { maxStringLength: 100, maxRecordBytes: 1024 },
    })
    logger.error(
      Object.assign(new Error('x'), { responseBody: 'secret', detail: 'd'.repeat(500) }),
      'm',
      { rows: Array.from({ length: 100 }, (_, i) => i) },
    )
    const line = JSON.parse(lines[0])
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    expect(line.err).toMatchObject({ omitted: ['responseBody'] })
    expect(lines[0]).not.toContain('secret')
  })

  it('rejects a value that is not an integer >= 1024', () => {
    for (const bad of [0, 1023, 2048.5, NaN])
      expect(() => createLogger({ service: 's', limits: { maxRecordBytes: bad } })).toThrow(
        `invalid limits.maxRecordBytes ${bad}`,
      )
  })

  it('fitLine never throws, even on a line it cannot read back', () => {
    const record = { time: '2026-01-01T00:00:00.000Z', level: 'INFO' }
    const line = fitLine(`{"time":"x","broken":${'['.repeat(5000)}`, record, 1024)
    expect(JSON.parse(line)).toEqual({ ...record, logError: 'line over maxRecordBytes (1024)' })
  })

  it('fitLine keeps the trace IDs and the cut service even from a line it cannot read back', () => {
    const record = {
      time: '2026-01-01T00:00:00.000Z',
      level: 'INFO',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      service: 's'.repeat(5000),
    }
    const line = fitLine(`{"time":"x","broken":${'['.repeat(5000)}`, record, 1024)
    expect(bytes(line)).toBeLessThanOrEqual(1024)
    expect(JSON.parse(line)).toEqual({
      time: record.time,
      level: 'INFO',
      traceId: record.traceId,
      spanId: record.spanId,
      service: expect.stringMatching(/^s+…\[truncated from 5000 chars\]$/),
      logError: 'line over maxRecordBytes (1024)',
    })
  })
})

/**
 * `value` as the walk of `output.ts` copies it: each object without a prototype.
 *
 * @param {unknown} value - A JSON-ready value.
 * @returns {unknown} The copy.
 */
function walkCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walkCopy)
  if (typeof value !== 'object' || value === null) return value
  const out = Object.create(null) as Record<string, unknown>
  for (const [key, item] of Object.entries(value)) out[key] = walkCopy(item)
  return out
}

/** Records of every shape the trimming takes a path for, each built fresh: trimming mutates a copy. */
const SHAPES: [string, () => Record<string, unknown>][] = [
  ['many small fields', () => flatFields(5_000)],
  ['nested small objects', () => nestedFields(3_000)],
  [
    'large, medium and small values',
    () => ({
      small: 'keep me',
      medium: 'm'.repeat(1500),
      big: { rows: Array.from({ length: 500 }, (_, i) => ({ i, name: `row ${i}` })) },
      text: 't'.repeat(30_000),
      again: 't'.repeat(30_000),
    }),
  ],
  ['a wide array of small items', () => ({ list: Array.from({ length: 20_000 }, (_, i) => i) })],
  [
    'a wide array of large and small items',
    () => ({
      list: Array.from({ length: 2_000 }, (_, i) => (i % 7 === 0 ? 'L'.repeat(300 + i) : i)),
    }),
  ],
  [
    'a wide object of large and small values',
    () =>
      Object.fromEntries(
        Array.from({ length: 2_000 }, (_, i) => [`k${i}`, i % 5 === 0 ? 'v'.repeat(200) : i]),
      ),
  ],
  [
    'an err with many fields',
    () => ({
      err: {
        type: 'Error',
        message: 'boom',
        stack: 's'.repeat(8000),
        ...Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`p${i}`, sixtyBytes(i)])),
      },
    }),
  ],
  [
    'multi-byte text, escapes and emoji',
    () => ({
      cjk: '漢字'.repeat(3000),
      emoji: '😀'.repeat(2000),
      escapes: '"\\\n\t\u0001'.repeat(1000),
      lone: '\ud800x'.repeat(1000),
      ...Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`ключ${i}😀`, `значение ${i}`])),
    }),
  ],
  [
    'cut markers, real and not',
    () => ({
      cut: `${'c'.repeat(9000)}…[truncated from 20000 chars]`,
      fake: `${'f'.repeat(9000)}…[truncated from 5 chars]`,
    }),
  ],
  [
    'keys like the marker, and integer keys',
    () => ({
      '[Trimmed]': 'mine',
      '[Trimmed]_': 'mine too',
      ...Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [String(i), sixtyBytes(i)])),
    }),
  ],
  [
    'numbers of every length: integers up to 1e21 and past it, fractions, negatives',
    () => ({
      list: Array.from({ length: 3_000 }, (_, i) => {
        const n = [10 ** (i % 23), 10 ** (i % 23) - 1, 1.5 * 10 ** (i % 30), 2 ** (i % 70), 5e-324]
        return (i % 2 ? -1 : 1) * n[i % 5]
      }),
    }),
  ],
  [
    'numbers JSON writes as null, and -0',
    () => ({
      list: Array.from({ length: 3_000 }, (_, i) => [NaN, Infinity, -Infinity, -0, i / 7][i % 5]),
    }),
  ],
  ['a message too large on its own', () => ({ message: 'm'.repeat(50_000) })],
  [
    'Protected Fields too large on their own',
    () => ({
      service: 's'.repeat(20_000),
      version: 'v'.repeat(20_000),
      message: 'm'.repeat(20_000),
      err: { type: 'T'.repeat(20_000), message: 'e'.repeat(20_000) },
    }),
  ],
]

/**
 * A record of `fields`, after Protected Fields: `time`, `level`, `message`, the trace IDs and `service`.
 *
 * @param {Record<string, unknown>} fields - The fields.
 * @returns {Record<string, unknown>} The record.
 */
const record = (fields: Record<string, unknown>): Record<string, unknown> => ({
  time: '2026-01-01T00:00:00.000Z',
  level: 'INFO',
  message: 'm',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  service: 'svc',
  ...fields,
})

/** An object written twice on a line: a repeat, which the fast path hands to the walk. */
const SHARED = { shared: true }

/** Lines that take each path of `stringifyRecord()`, and whether their loggers redact. */
const PATHS: [string, () => Record<string, unknown>, boolean][] = [
  ['the fast path', () => ({ rows: nestedFields(500) }), false],
  ['the walk, for a repeat', () => ({ a: nestedFields(500), b: 'x', c: SHARED, d: SHARED }), false],
  ['the walk, for an Error', () => ({ ctx: new Error('inner'), rows: nestedFields(500) }), false],
  ['the walk, for its size', () => ({ s: 'x'.repeat(1_200_000), rows: nestedFields(200) }), false],
  // At 16,384 bytes written before it is measured: what the walk counted is under the limit.
  ['the walk, with a redactor', () => ({ password: 'p', rows: nestedFields(500) }), true],
  // Measured before it is written: it holds more items than the limit has bytes for.
  [
    'the walk, with a redactor, many short values',
    () => ({ password: 'p', list: Array.from({ length: 20_000 }, (_, i) => i) }),
    true,
  ],
  [
    'the walk, for an Error, many short strings',
    () => ({ ctx: new Error('inner'), list: Array.from({ length: 20_000 }, (_, i) => `s${i}`) }),
    false,
  ],
  // Measured before it is written: its long strings alone are over the limit.
  [
    'the walk, with a redactor, for a long string',
    () => ({ password: 'p', s: 'x'.repeat(30_000), more: 'y'.repeat(2_000) }),
    true,
  ],
  [
    'the walk, for a repeat and a long string',
    () => ({ c: SHARED, d: SHARED, s: 'x'.repeat(30_000) }),
    false,
  ],
  [
    'the walk, with a redactor, multi-byte',
    () => ({ password: 'p', cjk: '漢'.repeat(6000) }),
    true,
  ],
]

/**
 * One line of `fields` from a logger with `limits`, and the same line from one without.
 *
 * @param {Record<string, unknown>} fields - The fields.
 * @param {LineLimits} limits - The limits.
 * @param {boolean} redact - Whether the loggers redact `password`.
 * @returns {[string, string]} The line with limits, and the line without.
 */
function both(
  fields: Record<string, unknown>,
  limits: LineLimits,
  redact: boolean,
): [string, string] {
  const lines = _captureLines()
  for (const options of [{ limits }, {}]) {
    const logger = createLogger(
      { service: 'svc', ...options, redact: redact && redactKeys(['password']) },
      { region: 'eu' },
    )
    runWithLogger({ logger, traceparent: TRACEPARENT }, () => getLogger().info(fields, 'm'))
  }
  return [lines[0], lines[1]]
}

describe("limits.maxRecordBytes on the walk's copy", () => {
  beforeEach(() => _reset())

  it.each(SHAPES)('trims the copy to the line fitLine gives its line read back: %s', (_, shape) => {
    for (const max of [1024, 4096, 16_384, 100_000]) {
      const line = JSON.stringify(record(shape()))
      const expected = fitLine(line, record(shape()), max)
      const copy = () => walkCopy(record(shape())) as Record<string, unknown>
      expect({ max, line: fitValue(copy(), record(shape()), max) }).toEqual({ max, line: expected })
      expect({ max, line: fitValue(copy(), record(shape()), max, line) }).toEqual({
        max,
        line: expected,
      })
      expect(bytes(expected)).toBeLessThanOrEqual(max)
    }
  })

  it('the same line at every limit, when a wide container loses a large value and then its tail', () => {
    // At some limits the large value's marker saves a few bytes too few, and the tail goes too.
    const shapes = [
      () => ({ list: [...Array.from({ length: 300 }, (_, i) => i), { s: 'x'.repeat(2000) }] }),
      () => ({ ...flatFields(300), last: { s: 'x'.repeat(2000) } }),
    ]
    for (const shape of shapes)
      for (let max = 1024; max <= 4096; max++) {
        const expected = fitLine(JSON.stringify(record(shape())), {}, max)
        expect(fitValue(walkCopy(record(shape())) as Record<string, unknown>, {}, max)).toBe(
          expected,
        )
        // The tail is measured as it is now, marker included: so it fits without falling back.
        expect(expected).not.toContain('logError')
        expect(bytes(expected)).toBeLessThanOrEqual(max)
      }
  })

  it('a dropped tail is measured to the byte: its marker holds what the dropped items took', () => {
    const items = Array.from(
      { length: 3_000 },
      (_, i) => [i, -i * 1001, 10 ** (i % 22), i / 3, `s${i}`, -0, NaN][i % 7],
    )
    for (let max = 1024; max <= 8192; max += 97) {
      const line = fitValue({ list: [...items] }, {}, max)
      const list = (JSON.parse(line) as { list: unknown[] }).list
      const kept = list.length - 1
      const dropped = items.slice(kept)
      const taken = dropped.reduce((sum: number, item) => sum + JSON.stringify(item).length, 0)
      expect(list.at(-1)).toBe(`[Trimmed: ${dropped.length} items, ${taken} bytes]`)
      expect(bytes(line)).toBeLessThanOrEqual(max)
      // As many leading items as fit: one more, and the line would be over.
      const more = `${JSON.stringify(items[kept])},`
      expect(bytes(line) + bytes(more)).toBeGreaterThan(max)
    }
  })

  it.each(SHAPES)('writes a copy that fits as JSON.stringify does: %s', (_, shape) => {
    const line = JSON.stringify(record(shape()))
    const max = Math.max(1024, bytes(line))
    expect(fitValue(walkCopy(record(shape())) as Record<string, unknown>, {}, max)).toBe(line)
  })

  it.each(PATHS)(
    'a line under the limit is byte for byte the line without limits: %s',
    (_, fields, redact) => {
      const [withLimits, without] = both(fields(), { maxRecordBytes: 50_000_000 }, redact)
      expect(strip(withLimits)).toBe(strip(without))
    },
  )

  it.each(PATHS)(
    'a line over the limit is what fitLine makes of the line without limits: %s',
    (_, fields, redact) => {
      for (const max of [1024, 16_384]) {
        const [withLimits, without] = both(fields(), { maxRecordBytes: max }, redact)
        expect({ max, line: strip(withLimits) }).toEqual({
          max,
          line: strip(fitLine(without, {}, max)),
        })
      }
    },
  )
})

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

  // Written whole and read back, these took 1.3x to 3.3x as long; now 0.9x to 1.2x. Under load a
  // run can go over, so a failing one is measured again: a real regression stays over.
  it.each(
    MULTI_MB.flatMap(([name, fields]) => [
      [name, fields, false],
      [`${name}, redacted`, fields, true],
    ]) as [string, () => Record<string, unknown>, boolean][],
  )(
    'an oversized multi-MB line costs at most about 1.2x what writing it whole does: %s',
    { timeout: 60_000, retry: 2 },
    (_, fields, redact) => {
      expect(trimRatio(fields(), redact)).toBeLessThan(1.25)
    },
  )
})
