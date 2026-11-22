import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createLogger,
  runWithLogger,
  withSpan,
  getLogger,
  getTraceContext,
  setLoggerContext,
  _reset,
  _captureEntries,
} from './logger'
import { brokenLogger } from '../testing/helpers'
import type { Logger, LogLevel, Span, SpanDefaults, SpanOptions } from './types'

const SAMPLED = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const UNSAMPLED = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00'
const DROPPED_WARNING = 'span fields set keys the span line owns; they were dropped'

type Entry = Record<string, unknown>

const isSpanEnd = (e: Entry) => (e.message as string)?.startsWith('span.end')

/** Let `ms` pass on the faked clock, as the Span's work taking that long. */
const elapse = (ms: number) => vi.setSystemTime(Date.now() + ms)

/** A Root Logger that writes every level, so a test sees exactly which level a Span chose. */
const allLevels = (spans?: SpanDefaults) => createLogger({ service: 'svc', level: 'trace', spans })

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
  _reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('withSpan levels', () => {
  // Every OK combination of `level`, `slowMs` and duration, sampled.
  it.each<[string, SpanOptions, number, string]>([
    ['no options: INFO, as before', {}, 50, 'INFO'],
    ['level alone sets the level, however long it takes', { level: 'debug' }, 10_000, 'DEBUG'],
    ['faster than slowMs: INFO', { slowMs: 100 }, 99, 'INFO'],
    ['exactly slowMs: WARN', { slowMs: 100 }, 100, 'WARN'],
    ['slower than slowMs: WARN', { slowMs: 100 }, 250, 'WARN'],
    ['level and slowMs, fast: level', { level: 'debug', slowMs: 100 }, 50, 'DEBUG'],
    ['level and slowMs, slow: WARN', { level: 'debug', slowMs: 100 }, 150, 'WARN'],
    ['trace and slowMs 0: always WARN', { level: 'trace', slowMs: 0 }, 0, 'WARN'],
    ['a level above WARN is kept when slow', { level: 'error', slowMs: 100 }, 150, 'ERROR'],
    ['slowMs Infinity is never slow', { slowMs: Infinity }, 1e9, 'INFO'],
  ])('%s', async (_name, options, duration, level) => {
    const entries = _captureEntries()
    await runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, async () => {
      expect(withSpan('sync', () => (elapse(duration), 1), options)).toBe(1)
      await expect(
        withSpan(
          'async',
          async () => {
            await Promise.resolve()
            elapse(duration)
            return 2
          },
          options,
        ),
      ).resolves.toBe(2)
    })

    expect(entries).toHaveLength(2)
    for (const [entry, operation] of [
      [entries[0], 'sync'],
      [entries[1], 'async'],
    ] as const) {
      expect(entry).toMatchObject({
        level,
        message: `span.end ${operation}`,
        span: { operation, status: 'OK', duration },
      })
      expect(entry).not.toHaveProperty('err')
    }
  })

  it.each<[string, SpanOptions, number]>([
    ['no options', {}, 5],
    ['level debug', { level: 'debug' }, 5],
    ['fast under slowMs', { level: 'debug', slowMs: 100 }, 5],
    ['slow over slowMs', { level: 'debug', slowMs: 100 }, 500],
    ['level trace, slowMs 0', { level: 'trace', slowMs: 0 }, 0],
  ])(
    'a throw is span.end at ERROR whatever the options (%s), and rethrown',
    async (_n, options, ms) => {
      const entries = _captureEntries()
      const failure = new Error('boom')
      await runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, async () => {
        expect(() =>
          withSpan(
            'sync',
            () => {
              elapse(ms)
              throw failure
            },
            options,
          ),
        ).toThrow(failure)
        await expect(
          withSpan(
            'async',
            async () => {
              elapse(ms)
              throw failure
            },
            options,
          ),
        ).rejects.toBe(failure)
      })

      expect(entries).toHaveLength(2)
      for (const entry of entries) {
        expect(entry).toMatchObject({
          level: 'ERROR',
          span: { status: 'ERROR', error: 'boom', duration: ms },
          err: { message: 'boom' },
        })
      }
    },
  )

  it.each<[string, SpanOptions]>([
    ['no options', {}],
    ['level warn', { level: 'warn' }],
    ['slowMs 0 (every Span is slow)', { slowMs: 0 }],
    ['level error and slowMs', { level: 'error', slowMs: 10 }],
  ])(
    'unsampled: OK writes nothing (%s); a throw is one <op> failed at ERROR',
    async (_n, options) => {
      const entries = _captureEntries()
      const failure = new Error('boom')
      await runWithLogger({ logger: allLevels(), traceparent: UNSAMPLED }, async () => {
        expect(withSpan('ok', () => (elapse(500), 1), options)).toBe(1)
        await expect(withSpan('ok.async', async () => (elapse(500), 2), options)).resolves.toBe(2)
        expect(() =>
          withSpan(
            'db.read',
            () => {
              throw failure
            },
            { ...options, fields: { table: 'users' } },
          ),
        ).toThrow(failure)
      })

      expect(entries).toEqual([
        expect.objectContaining({
          level: 'ERROR',
          message: 'db.read failed',
          span: { operation: 'db.read', status: 'ERROR', error: 'boom' },
          err: expect.objectContaining({ message: 'boom' }),
        }),
      ])
      // Span Fields go on `span.end` only, and an unsampled trace writes none.
      expect(entries[0]).not.toHaveProperty('table')
    },
  )

  it("fast Spans at level 'debug' are silenced by the logger's level, slow ones still write WARN", () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc', level: 'info' })
    runWithLogger({ logger, traceparent: SAMPLED }, () => {
      withSpan('fast', () => elapse(10), { level: 'debug', slowMs: 100 })
      withSpan('slow', () => elapse(200), { level: 'debug', slowMs: 100 })
    })

    expect(entries.map((e) => [e.level, e.message])).toEqual([['WARN', 'span.end slow']])
  })

  it('an invalid per-call level or slowMs is ignored, never thrown', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      const bad = { level: 'loud', slowMs: -1 } as unknown as SpanOptions
      expect(withSpan('bad', () => (elapse(5), 1), bad)).toBe(1)
      expect(withSpan('nan', () => (elapse(5), 1), { slowMs: NaN })).toBe(1)
      expect(withSpan('silent', () => 1, { level: 'silent' as LogLevel })).toBe(1)
    })
    expect(entries.map((e) => e.level)).toEqual(['INFO', 'INFO', 'INFO'])
  })

  it('options whose getters throw are ignored; the work still runs and its value is returned', () => {
    const entries = _captureEntries()
    const options = {
      get level(): LogLevel {
        throw new Error('level getter')
      },
      get fields(): never {
        throw new Error('fields getter')
      },
    }
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      expect(withSpan('odd', () => 7, options)).toBe(7)
    })
    expect(entries).toEqual([expect.objectContaining({ level: 'INFO', message: 'span.end odd' })])
  })
})

describe('Span Defaults (createLogger spans)', () => {
  it('apply to every Span, and per-call options override them', () => {
    const entries = _captureEntries()
    const logger = allLevels({ level: 'debug', slowMs: 100 })
    runWithLogger({ logger, traceparent: SAMPLED }, () => {
      withSpan('fast', () => elapse(10))
      withSpan('slow', () => elapse(100))
      withSpan('level.override', () => elapse(10), { level: 'info' })
      withSpan('level.override.slow', () => elapse(150), { level: 'info' })
      withSpan('slow.override', () => elapse(150), { slowMs: 200 })
      withSpan('slow.off', () => elapse(1e6), { slowMs: Infinity })
    })

    expect(entries.map((e) => [e.message, e.level])).toEqual([
      ['span.end fast', 'DEBUG'],
      ['span.end slow', 'WARN'],
      ['span.end level.override', 'INFO'],
      ['span.end level.override.slow', 'WARN'],
      ['span.end slow.override', 'DEBUG'],
      ['span.end slow.off', 'DEBUG'],
    ])
  })

  it('an invalid per-call value falls back to the Span Defaults', () => {
    const entries = _captureEntries()
    runWithLogger(
      { logger: allLevels({ level: 'debug', slowMs: 100 }), traceparent: SAMPLED },
      () => {
        withSpan('x', () => elapse(150), { level: 'nope' as LogLevel, slowMs: -5 })
      },
    )
    expect(entries[0]!.level).toBe('WARN')
  })

  it('are kept by .child() loggers, nested Spans, and Spans in a child context', () => {
    const entries = _captureEntries()
    const logger = allLevels({ level: 'debug', slowMs: 100 }).child({ region: 'eu' })
    runWithLogger({ logger, traceparent: SAMPLED }, () => {
      withSpan('outer', () => withSpan('inner', () => 1))
      withSpan('slow', () => elapse(100))
    })
    expect(entries.map((e) => [e.message, e.level, e.region])).toEqual([
      ['span.end inner', 'DEBUG', 'eu'],
      ['span.end outer', 'DEBUG', 'eu'],
      ['span.end slow', 'WARN', 'eu'],
    ])
  })

  it('a hand-written Logger has none: its Spans use the built-in defaults', () => {
    const calls: [string, unknown][] = []
    const record =
      (level: string) =>
      (...args: unknown[]) =>
        calls.push([level, args[1]])
    const handWritten: Logger = {
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      fatal: record('fatal'),
      child: () => handWritten,
    }
    runWithLogger({ logger: handWritten, traceparent: SAMPLED }, () => {
      withSpan('a', () => elapse(10))
      withSpan('b', () => elapse(10), { level: 'debug' })
      withSpan('c', () => elapse(10), { slowMs: 5 })
    })
    expect(calls.map(([level]) => level)).toEqual(['info', 'debug', 'warn'])
  })

  it.each<[string, SpanDefaults, string]>([
    ['an unknown level', { level: 'loud' as LogLevel }, 'unknown span level loud'],
    ["'silent'", { level: 'silent' as LogLevel }, 'unknown span level silent'],
    ['a negative slowMs', { slowMs: -1 }, 'invalid spans.slowMs -1'],
    ['a NaN slowMs', { slowMs: NaN }, 'invalid spans.slowMs NaN'],
    ['a string slowMs', { slowMs: '100' as unknown as number }, 'invalid spans.slowMs 100'],
  ])('createLogger throws for %s, as for an unknown level', (_n, spans, message) => {
    expect(() => createLogger({ service: 'svc', spans })).toThrow(message)
  })
})

describe('Span Fields', () => {
  it('fields and span.set() go on span.end only: not on inner, outer or later lines, nor into the context', async () => {
    const entries = _captureEntries()
    await runWithLogger(
      { logger: allLevels(), traceparent: SAMPLED, fields: { requestId: 'r-1' } },
      async () => {
        await withSpan(
          'cache.read',
          async (span) => {
            getLogger().info('before set')
            span.set({ hit: true, size: 3 })
            getLogger().info('after set')
            withSpan('nested', () => getLogger().info('in nested'))
            await Promise.resolve()
            return 'v'
          },
          { fields: { table: 'users' } },
        )
        getLogger().info('after span')
      },
    )

    const spanEnd = entries.find((e) => e.message === 'span.end cache.read')!
    expect(spanEnd).toMatchObject({ requestId: 'r-1', table: 'users', hit: true, size: 3 })
    for (const entry of entries.filter((e) => e !== spanEnd)) {
      expect(entry).not.toHaveProperty('table')
      expect(entry).not.toHaveProperty('hit')
      expect(entry).not.toHaveProperty('size')
    }
    // `span.end nested` is its own Span: the parent's fields never reach it.
    expect(entries.map((e) => e.message)).toEqual([
      'before set',
      'after set',
      'in nested',
      'span.end nested',
      'span.end cache.read',
      'after span',
    ])
  })

  it('concurrent sibling Spans do not see each other’s span.set() fields', async () => {
    const entries = _captureEntries()
    await runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () =>
      Promise.all(
        ['a', 'b'].map((op) =>
          withSpan(op, async (span) => {
            await Promise.resolve()
            span.set({ [op]: true })
            await Promise.resolve()
          }),
        ),
      ),
    )
    const byOp = Object.fromEntries(entries.map((e) => [e.message, e]))
    expect(byOp['span.end a']).toMatchObject({ a: true })
    expect(byOp['span.end a']).not.toHaveProperty('b')
    expect(byOp['span.end b']).toMatchObject({ b: true })
    expect(byOp['span.end b']).not.toHaveProperty('a')
  })

  it('a later span.set() wins over an earlier one, and over fields', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      withSpan(
        'op',
        (span) => {
          span.set({ a: 1, b: 1 })
          span.set({ b: 2, c: 2 })
        },
        { fields: { a: 0, d: 0 } },
      )
    })
    expect(entries[0]).toMatchObject({ a: 1, b: 2, c: 2, d: 0 })
  })

  it('are on the ERROR span.end too, with the real err', () => {
    const entries = _captureEntries()
    const failure = new Error('boom')
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      expect(() =>
        withSpan(
          'op',
          (span) => {
            span.set({ attempt: 2 })
            throw failure
          },
          { fields: { table: 'users' } },
        ),
      ).toThrow(failure)
    })
    expect(entries[0]).toMatchObject({
      level: 'ERROR',
      table: 'users',
      attempt: 2,
      err: { message: 'boom' },
    })
  })

  it('come after span on the line, and are not inside the span object', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      withSpan('op', (span) => span.set({ rows: 4 }))
    })
    const keys = Object.keys(entries[0]!)
    expect(keys.indexOf('rows')).toBeGreaterThan(keys.indexOf('span'))
    expect(entries[0]!.span).not.toHaveProperty('rows')
  })

  it('span.set() after the Span ended does nothing', async () => {
    const entries = _captureEntries()
    let kept: Span | undefined
    let keptAsync: Span | undefined
    await runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, async () => {
      withSpan('sync', (span) => {
        kept = span
      })
      kept!.set({ late: true })
      await withSpan('async', async (span) => {
        keptAsync = span
        await Promise.resolve()
      })
      keptAsync!.set({ late: true })
      getLogger().info('after')
    })
    expect(entries.map((e) => e.message)).toEqual(['span.end sync', 'span.end async', 'after'])
    for (const entry of entries) expect(entry).not.toHaveProperty('late')
  })

  it('span.set() does nothing for an unsampled trace and outside a Logging Context', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: UNSAMPLED }, () => {
      expect(withSpan('op', (span) => (span.set({ hit: true }), 1))).toBe(1)
    })
    expect(withSpan('outside', (span) => (span.set({ hit: true }), 2))).toBe(2)
    expect(entries).toEqual([])
  })

  it('a span.set() argument whose getter throws is [Unserializable], and the work goes on', () => {
    const entries = _captureEntries()
    const odd = {
      ok: 1,
      get bad(): number {
        throw new Error('getter broke')
      },
    }
    const keysThrow = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys')
        },
      },
    )
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      const result = withSpan(
        'op',
        (span) => {
          span.set(odd as never)
          span.set(keysThrow)
          span.set(null as never)
          span.set('words' as never)
          return 'value'
        },
        { fields: odd as never },
      )
      expect(result).toBe('value')
    })
    expect(entries[0]).toMatchObject({
      level: 'INFO',
      ok: 1,
      bad: '[Unserializable: Error: getter broke]',
      args: [{ args: '[Unserializable: Error: no keys]' }],
    })
  })

  it('go through the serializer as usual: values for the Moved Keys move to args', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      withSpan('op', (span) =>
        span.set({ message: 'mine', level: 'FATAL', traceId: 'x', service: 'other', ok: 1 }),
      )
    })
    expect(entries[0]).toMatchObject({
      level: 'INFO',
      message: 'span.end op',
      service: 'svc',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      ok: 1,
      args: [{ message: 'mine', level: 'FATAL', traceId: 'x', service: 'other' }],
    })
  })

  it('never change the Logging Context, and setLoggerContext inside the Span still works as before', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      withSpan('op', (span) => {
        span.set({ spanOnly: 1 })
        setLoggerContext({ contextField: 2 })
        getLogger().info('inside')
      })
    })
    expect(entries[0]).toMatchObject({ message: 'inside', contextField: 2 })
    expect(entries[0]).not.toHaveProperty('spanOnly')
    expect(entries[1]).toMatchObject({ message: 'span.end op', contextField: 2, spanOnly: 1 })
  })

  it('a Logger that throws: the work’s own value or error still wins, with Span Fields set', async () => {
    for (const traceparent of [SAMPLED, UNSAMPLED]) {
      const thrown = new Error('work failed')
      await runWithLogger({ logger: brokenLogger, traceparent }, async () => {
        expect(withSpan('ok', (span) => (span.set({ a: 1 }), 1), { slowMs: 0 })).toBe(1)
        await expect(
          withSpan('async', async (span) => {
            span.set({ a: 1 })
            throw thrown
          }),
        ).rejects.toBe(thrown)
        expect(withSpan('owned', (span) => (span.set({ span: 1 }), 3))).toBe(3)
      })
    }
  })

  it('a zero-argument function is still accepted, and the Span still nests', () => {
    let outer: ReturnType<typeof getTraceContext>
    let inner: ReturnType<typeof getTraceContext>
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      outer = getTraceContext()
      withSpan('op', () => {
        inner = getTraceContext()
      })
    })
    expect(inner!.parentSpanId).toBe(outer!.spanId)
  })
})

describe('Span Owned Keys', () => {
  it('fields and span.set() cannot set span or err: they are dropped, and one WARN names them', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      withSpan('op', (span) => span.set({ span: 'mine', ok: 1 }), { fields: { err: 'x' } })
    })

    expect(entries).toHaveLength(2)
    const [spanEnd, warning] = entries
    expect(spanEnd).toMatchObject({ level: 'INFO', span: { operation: 'op', status: 'OK' }, ok: 1 })
    expect(spanEnd).not.toHaveProperty('err')
    expect(spanEnd).not.toHaveProperty('args')
    expect(warning).toMatchObject({
      level: 'WARN',
      message: DROPPED_WARNING,
      operation: 'op',
      droppedKeys: ['span', 'err'],
    })
    // Key names only, never their values.
    expect(JSON.stringify(warning)).not.toContain('mine')
  })

  it('on an ERROR Span, err is the thrown value, never the field', () => {
    const entries = _captureEntries()
    const failure = new Error('boom')
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      expect(() =>
        withSpan('op', (span) => {
          span.set({ err: 'not the error' })
          throw failure
        }),
      ).toThrow(failure)
    })
    expect(entries[0]).toMatchObject({ level: 'ERROR', err: { message: 'boom' } })
    expect(JSON.stringify(entries[0])).not.toContain('not the error')
    expect(entries[1]).toMatchObject({ level: 'WARN', droppedKeys: ['err'] })
  })

  it('the WARN is written once per operation per isolate', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      for (let i = 0; i < 3; i++) withSpan('a', (span) => span.set({ span: i }))
      withSpan('b', (span) => span.set({ err: 1 }))
    })
    expect(entries.filter((e) => e.level === 'WARN').map((e) => e.operation)).toEqual(['a', 'b'])
    expect(entries.filter(isSpanEnd)).toHaveLength(4)
  })

  it('the WARN stops after 100 distinct operations, so dynamic names cannot flood the log', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: SAMPLED }, () => {
      for (let i = 0; i < 150; i++) withSpan(`op ${i}`, (span) => span.set({ span: i }))
    })
    expect(entries.filter((e) => e.level === 'WARN')).toHaveLength(100)
  })

  it('an unsampled trace writes no Span Fields, so no WARN', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: allLevels(), traceparent: UNSAMPLED }, () => {
      withSpan('op', (span) => span.set({ span: 1 }), { fields: { err: 1 } })
    })
    expect(entries).toEqual([])
  })
})
