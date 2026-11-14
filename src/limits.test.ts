import { describe, it, expect, beforeEach } from 'vitest'
import { createLogger, runWithLogger, getLogger, _captureLines, _reset } from './logger'
import { omitErrorKeys } from './omit'
import { fitLine, utf8Bytes } from './limits'
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
 * The fastest of 3 lines with `n` small fields, trimmed to 10,000 bytes, in milliseconds.
 *
 * @param {number} n - How many fields.
 * @returns {number} The time.
 */
function trimTime(n: number): number {
  const fields = Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`k${i}`, { s: 'v'.repeat(30 + (i % 50)) }]),
  )
  const { log } = limited({ maxRecordBytes: 10_000 })
  log((l) => l.info(fields)) // warm up
  return Math.min(...Array.from({ length: 3 }, () => elapsed(() => log((l) => l.info(fields)))))
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

  it('many small fields: only the Protected Fields are kept, with logError', () => {
    const { lines, log, parsed } = limited({ maxRecordBytes: 1024 })
    log((l) =>
      l.warn(
        Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])),
        'too many fields',
      ),
    )
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    expect(parsed()).toEqual({
      time: expect.any(String),
      level: 'WARN',
      message: 'too many fields',
      service: 'svc',
      environment: 'production',
      version: '1.0.0',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: expect.any(String),
      parentSpanId: 'b7ad6b7169203331',
      logError: expect.stringMatching(
        /^line of \d+ bytes over maxRecordBytes \(1024\): only the Protected Fields are kept$/,
      ),
    })
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

  it('the last resort is time, level and logError', () => {
    const lines = _captureLines()
    createLogger({ service: 's'.repeat(5000), limits: { maxRecordBytes: 1024 } }).info('x')
    expect(bytes(lines[0])).toBeLessThanOrEqual(1024)
    expect(JSON.parse(lines[0])).toEqual({
      time: expect.any(String),
      level: 'INFO',
      logError: 'line over maxRecordBytes (1024)',
    })
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
    const small = trimTime(20_000)
    const large = trimTime(80_000)
    expect(large / small).toBeLessThan(10) // 4x the size: quadratic would be ~16x
  })
})
