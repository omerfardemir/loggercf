import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createLogger,
  runWithLogger,
  withSpan,
  getTraceContext,
  getTraceCarrier,
  getLogger,
  setLoggerContext,
  _reset,
  _captureEntries,
} from './logger'
import { tracedFetch } from '../trace/fetch'
import { buildTraceparent } from '../trace/trace'
import { brokenLogger } from '../testing/helpers'

describe('getLogger outside ALS context', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('returns a working logger without warnings', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entries = _captureEntries()

    const logger = getLogger()
    logger.info({ foo: 'bar' }, 'standalone log')

    // No warnings this is a valid use case
    expect(console.warn).not.toHaveBeenCalled()

    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].message).toBe('standalone log')
    expect(entries[0].foo).toBe('bar')
  })

  it('includes service field when name is provided', () => {
    const entries = _captureEntries()

    const logger = getLogger('auth-service')
    logger.info({}, 'with service')

    expect(entries[0].service).toBe('auth-service')
  })

  it('caches logger by service name', () => {
    _captureEntries()

    const a = getLogger('svc-a')
    const b = getLogger('svc-a')
    expect(a).toBe(b)

    const c = getLogger('svc-b')
    expect(c).not.toBe(a)
  })

  it('produces same JSON shape as ALS logger', () => {
    const entries = _captureEntries()

    // ALS logger
    const rootLogger = createLogger({ service: 'shape-svc' })
    runWithLogger({ logger: rootLogger }, () => {
      getLogger().info({ key: 'val' }, 'als log')
    })

    // Standalone logger
    _reset()
    getLogger('shape-svc').info({ key: 'val' }, 'standalone log')

    expect(entries.length).toBe(2)

    for (const k of ['level', 'time', 'message'] as const) {
      expect(entries[0][k]).toBeDefined()
      expect(entries[1][k]).toBeDefined()
    }
    expect(typeof entries[0].level).toBe(typeof entries[1].level)
  })
})

const WARNING = 'setLoggerContext called outside a Logging Context; fields ignored'

describe('setLoggerContext outside a Logging Context', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('ignores the fields, so they never reach later work in the isolate', () => {
    const entries = _captureEntries()
    getLogger('ctx-svc') // cached before the call, as in a long-lived isolate

    setLoggerContext({ userId: 'user-42' })
    getLogger('ctx-svc').info({}, 'standalone after')
    runWithLogger({ logger: createLogger({ service: 'ctx-svc' }) }, () => {
      getLogger().info({}, 'next request')
    })

    const later = entries.filter((e) => e.message !== WARNING)
    expect(later).toHaveLength(2)
    for (const entry of later) expect(entry.userId).toBeUndefined()
  })

  it('warns once per isolate, naming the ignored keys but not their values', () => {
    const entries = _captureEntries()

    setLoggerContext({ userId: 'user-42', tenant: 'acme' })
    setLoggerContext({ other: 'x' })

    const warnings = entries.filter((e) => e.message === WARNING)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ level: 'WARN', ignoredFields: ['userId', 'tenant'] })
    expect(JSON.stringify(warnings[0])).not.toContain('user-42')
  })
})

describe('setLoggerContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('makes fields visible on all log lines within the same request', () => {
    const entries = _captureEntries()

    const rootLogger = createLogger({ service: 'ctx-svc' })

    runWithLogger({ logger: rootLogger }, () => {
      const logger = getLogger()
      logger.info({}, 'before setLoggerContext')

      setLoggerContext({ userId: 'user-42' })
      logger.info({}, 'after setLoggerContext')

      // Even a child created BEFORE setLoggerContext sees the new field
      const child = logger.child({ component: 'db' })
      child.info({}, 'child after setLoggerContext')
    })

    expect(entries.length).toBe(3)
    expect(entries[0].userId).toBeUndefined()
    expect(entries[1].userId).toBe('user-42')
    expect(entries[2].userId).toBe('user-42')
    expect(entries[2].component).toBe('db')
  })
})

describe('ALS context isolation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('concurrent contexts do not leak fields between each other', async () => {
    const entries = _captureEntries()

    const rootLogger = createLogger({ service: 'iso-svc' })

    // Run two contexts concurrently
    await Promise.all([
      new Promise<void>((resolve) => {
        runWithLogger(
          { logger: rootLogger, traceparent: `00-${'aaaa'.repeat(8)}-${'bbbb'.repeat(4)}-00` },
          () => {
            setLoggerContext({ userId: 'user-A' })
            getLogger().info({}, 'from context A')
            resolve()
          },
        )
      }),
      new Promise<void>((resolve) => {
        runWithLogger(
          { logger: rootLogger, traceparent: `00-${'cccc'.repeat(8)}-${'dddd'.repeat(4)}-00` },
          () => {
            setLoggerContext({ userId: 'user-B' })
            getLogger().info({}, 'from context B')
            resolve()
          },
        )
      }),
    ])

    expect(entries.length).toBe(2)

    const entryA = entries.find((e) => e.message === 'from context A')!
    const entryB = entries.find((e) => e.message === 'from context B')!

    expect(entryA.userId).toBe('user-A')
    expect(entryA.traceId).toBe('aaaa'.repeat(8))

    expect(entryB.userId).toBe('user-B')
    expect(entryB.traceId).toBe('cccc'.repeat(8))
  })
})

describe('child logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('inherits ALS trace fields and adds its own bindings', () => {
    const entries = _captureEntries()

    const rootLogger = createLogger({ service: 'child-svc' })

    runWithLogger({ logger: rootLogger }, () => {
      const logger = getLogger()
      const child = logger.child({ component: 'cache' })

      child.info({}, 'child log')

      // Parent should NOT have the child's bindings
      logger.info({}, 'parent log')
    })

    expect(entries.length).toBe(2)
    expect(entries[0].component).toBe('cache')
    expect(entries[0].traceId).toBeDefined()
    expect(entries[0].service).toBe('child-svc')
    expect(entries[1].component).toBeUndefined()
    expect(entries[1].traceId).toBe(entries[0].traceId)
  })
})

describe('tracedFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('injects traceparent header inside ALS context', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    const rootLogger = createLogger({ service: 'fetch-svc' })
    let trace: ReturnType<typeof getTraceContext>

    await runWithLogger({ logger: rootLogger }, async () => {
      trace = getTraceContext()
      await tracedFetch('https://example.com/api')
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.com/api')
    const headers = new Headers(init.headers)
    expect(headers.get('traceparent')).toBe(buildTraceparent(trace!))
  })

  it('preserves existing headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    const rootLogger = createLogger({ service: 'fetch-svc' })

    await runWithLogger({ logger: rootLogger }, async () => {
      await tracedFetch('https://example.com/api', {
        headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
      })
    })

    const [, init] = mockFetch.mock.calls[0]
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer abc')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('traceparent')).toBeDefined()
  })

  it('falls back to regular fetch outside ALS', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    await tracedFetch('https://example.com/api')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.com/api')
    expect(init).toBeUndefined()
  })

  it('does not modify the original init object', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    const rootLogger = createLogger({ service: 'fetch-svc' })
    const originalInit = { headers: { 'X-Custom': 'value' } }

    await runWithLogger({ logger: rootLogger }, async () => {
      await tracedFetch('https://example.com/api', originalInit)
    })

    // Original should not have traceparent
    expect(originalInit.headers).toEqual({ 'X-Custom': 'value' })
  })

  it('includes tracestate header when present in ALS context', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)

    const rootLogger = createLogger({ service: 'fetch-svc' })
    const context = {
      logger: rootLogger,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      tracestate: 'congo=t61rcWkgMzE',
    }

    await runWithLogger(context, async () => {
      await tracedFetch('https://example.com/api')
    })

    const [, init] = mockFetch.mock.calls[0]
    const headers = new Headers(init.headers)
    expect(headers.get('tracestate')).toBe('congo=t61rcWkgMzE')
  })
})

describe('getTraceCarrier', () => {
  beforeEach(() => _reset())

  it('is empty outside a Logging Context', () => {
    expect(getTraceCarrier()).toEqual({})
  })

  it('round-trips over a queue-style transport into a continued trace', () => {
    const logger = createLogger({ service: 'svc' })
    let sent: ReturnType<typeof getTraceCarrier> = {}
    let producer: ReturnType<typeof getTraceContext>
    let consumer: ReturnType<typeof getTraceContext>

    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    runWithLogger({ logger, traceparent, tracestate: 'v=1' }, () => {
      producer = getTraceContext()
      sent = JSON.parse(JSON.stringify(getTraceCarrier())) // as a queue message body would
    })
    runWithLogger({ logger, ...sent }, () => {
      consumer = getTraceContext()
    })

    expect(consumer!.traceId).toBe(producer!.traceId)
    expect(consumer!.parentSpanId).toBe(producer!.spanId)
    expect(consumer!.tracestate).toBe('v=1')
  })
})

describe('runWithLogger', () => {
  const INCOMING = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('continues an incoming trace with a new span', () => {
    _captureEntries()
    let trace: ReturnType<typeof getTraceContext>

    runWithLogger({ logger: createLogger({ service: 'svc' }), traceparent: INCOMING }, () => {
      trace = getTraceContext()
    })

    expect(trace!.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(trace!.parentSpanId).toBe('b7ad6b7169203331')
    expect(trace!.spanId).not.toBe('b7ad6b7169203331')
  })

  it('starts a sampled root trace when no traceparent is given', () => {
    let trace: ReturnType<typeof getTraceContext>

    runWithLogger({ logger: createLogger({ service: 'svc' }) }, () => {
      trace = getTraceContext()
    })

    expect(trace!.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(trace!.parentSpanId).toBeUndefined()
    expect(trace!.traceFlags).toBe(1)
  })

  it('carries tracestate into the Trace Context', () => {
    let trace: ReturnType<typeof getTraceContext>
    const context = {
      logger: createLogger({ service: 'svc' }),
      traceparent: INCOMING,
      tracestate: 'congo=t61rcWkgMzE',
    }

    runWithLogger(context, () => {
      trace = getTraceContext()
    })

    expect(trace!.tracestate).toBe('congo=t61rcWkgMzE')
  })

  it('puts initial fields on every line and never mutates the caller object', () => {
    const entries = _captureEntries()
    const fields = { requestId: 'req-1' }

    runWithLogger({ logger: createLogger({ service: 'svc' }), fields }, () => {
      setLoggerContext({ userId: 'user-1' })
      getLogger().info('hello')
    })

    expect(entries[0]).toMatchObject({ requestId: 'req-1', userId: 'user-1' })
    expect(fields).toEqual({ requestId: 'req-1' })
  })
})

const isSpanEnd = (e: Record<string, unknown>) => (e.message as string)?.startsWith('span.end')

describe('withSpan', () => {
  const SAMPLED = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
  const UNSAMPLED = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00'

  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('outside a Logging Context, just runs fn', () => {
    const entries = _captureEntries()

    const result = withSpan('noop', () => 7)

    expect(result).toBe(7)
    expect(entries).toHaveLength(0)
  })

  it('nests a child span on the same trace and restores the outer span after', () => {
    const entries = _captureEntries()
    let outer: ReturnType<typeof getTraceContext>
    let inner: ReturnType<typeof getTraceContext>
    let after: ReturnType<typeof getTraceContext>

    runWithLogger({ logger: createLogger({ service: 'svc' }), traceparent: SAMPLED }, () => {
      outer = getTraceContext()
      withSpan('db.query', () => {
        inner = getTraceContext()
      })
      after = getTraceContext()
    })

    expect(inner!.traceId).toBe(outer!.traceId)
    expect(inner!.parentSpanId).toBe(outer!.spanId)
    expect(inner!.spanId).not.toBe(outer!.spanId)
    expect(after!).toEqual(outer!)

    const spanEnd = entries.find(isSpanEnd)!
    expect(spanEnd.message).toBe('span.end db.query')
    expect(spanEnd.spanId).toBe(inner!.spanId)
    expect(spanEnd.parentSpanId).toBe(outer!.spanId)
    expect((spanEnd.span as Record<string, unknown>).status).toBe('OK')
  })

  it('logs ERROR with err and rethrows when async fn rejects', async () => {
    const entries = _captureEntries()

    await runWithLogger(
      { logger: createLogger({ service: 'svc' }), traceparent: SAMPLED },
      async () => {
        await expect(
          withSpan('db.write', async () => {
            throw new Error('disk full')
          }),
        ).rejects.toThrow('disk full')
      },
    )

    const spanEnd = entries.find(isSpanEnd)!
    expect(spanEnd.level).toBe('ERROR')
    expect((spanEnd.span as Record<string, unknown>).status).toBe('ERROR')
    expect((spanEnd.span as Record<string, unknown>).error).toBe('disk full')
    expect((spanEnd.err as Record<string, unknown>).message).toBe('disk full')
  })

  it('keeps span.error for a falsy thrown value', () => {
    const entries = _captureEntries()

    runWithLogger({ logger: createLogger({ service: 'svc' }), traceparent: SAMPLED }, () => {
      for (const thrown of [0, '', undefined]) {
        let caught: unknown = 'not thrown'
        try {
          withSpan('falsy', () => {
            throw thrown
          })
        } catch (err) {
          caught = err
        }
        expect(caught).toBe(thrown)
      }
    })

    expect(entries.filter(isSpanEnd).map((e) => (e.span as { error?: string }).error)).toEqual([
      '0',
      '',
      'undefined',
    ])
  })

  it('does not log span.end when the trace is unsampled, but still nests', () => {
    const entries = _captureEntries()
    let outer: ReturnType<typeof getTraceContext>
    let inner: ReturnType<typeof getTraceContext>

    runWithLogger({ logger: createLogger({ service: 'svc' }), traceparent: UNSAMPLED }, () => {
      outer = getTraceContext()
      withSpan('db.query', () => {
        inner = getTraceContext()
      })
    })

    expect(entries.find(isSpanEnd)).toBeUndefined()
    expect(inner!.parentSpanId).toBe(outer!.spanId)
  })

  it('for an unsampled trace, a throw still writes one ERROR line with err, and is rethrown', async () => {
    const entries = _captureEntries()
    const failure = new Error('disk full')

    await runWithLogger(
      { logger: createLogger({ service: 'svc' }), traceparent: UNSAMPLED },
      async () => {
        expect(() =>
          withSpan('db.read', () => {
            throw failure
          }),
        ).toThrow(failure)
        await expect(
          withSpan('db.write', async () => {
            throw failure
          }),
        ).rejects.toBe(failure)
        await expect(withSpan('db.ok', async () => 1)).resolves.toBe(1)
      },
    )

    expect(entries.find(isSpanEnd)).toBeUndefined()
    expect(entries).toHaveLength(2)
    for (const [entry, operation] of [
      [entries[0], 'db.read'],
      [entries[1], 'db.write'],
    ] as const) {
      expect(entry).toMatchObject({
        level: 'ERROR',
        message: `${operation} failed`,
        span: { operation, status: 'ERROR', error: 'disk full' },
        err: { message: 'disk full' },
        traceId: '0af7651916cd43dd8448eb211c80319c',
      })
      // No timing on an unsampled trace: only the failure is recorded.
      expect(entry.span).not.toHaveProperty('duration')
    }
  })

  it.each([
    ['a null-prototype object', () => Object.create(null) as unknown],
    [
      'a revoked Proxy',
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {})
        revoke()
        return proxy as unknown
      },
    ],
  ])(
    'a thrown value String() and instanceof cannot handle (%s) is rethrown as is, sampled or not',
    async (_name, make) => {
      for (const traceparent of [SAMPLED, UNSAMPLED]) {
        const entries = _captureEntries()
        const thrown = make()
        await runWithLogger({ logger: createLogger({ service: 'svc' }), traceparent }, async () => {
          let caught: unknown
          try {
            withSpan('sync', () => {
              throw thrown
            })
          } catch (err) {
            caught = err
          }
          expect(caught).toBe(thrown)
          await expect(
            withSpan('async', async () => {
              throw thrown
            }),
          ).rejects.toBe(thrown)
        })
        expect(entries).toHaveLength(2)
        for (const entry of entries) {
          expect(entry.level).toBe('ERROR')
          expect((entry.span as { error: unknown }).error).toMatch(/^\[Unserializable: .*\]$/)
        }
      }
    },
  )

  it("a hand-written Logger that throws: the work's own value is still rethrown, sampled or not", async () => {
    for (const traceparent of [SAMPLED, UNSAMPLED]) {
      const thrown = new Error('work failed')
      await runWithLogger({ logger: brokenLogger, traceparent }, async () => {
        let caught: unknown
        try {
          withSpan('sync', () => {
            throw thrown
          })
        } catch (err) {
          caught = err
        }
        expect(caught).toBe(thrown)
        await expect(
          withSpan('async', async () => {
            throw thrown
          }),
        ).rejects.toBe(thrown)
        // Success writes `span.end` at INFO when sampled, which throws too.
        expect(withSpan('ok', () => 1)).toBe(1)
        await expect(withSpan('ok async', async () => 2)).resolves.toBe(2)
      })
    }
  })

  it('a returned revoked Proxy is returned as is', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    runWithLogger({ logger: createLogger({ service: 'svc' }), traceparent: SAMPLED }, () => {
      expect(withSpan('ret', () => proxy)).toBe(proxy)
    })
  })

  it('copies Context Fields in; fields set inside stay inside', () => {
    const entries = _captureEntries()
    const context = { logger: createLogger({ service: 'svc' }), fields: { requestId: 'req-1' } }

    runWithLogger(context, () => {
      withSpan('step', () => {
        setLoggerContext({ userId: 'user-1' })
        getLogger().info('inside')
      })
      getLogger().info('outside')
    })

    const inside = entries.find((e) => e.message === 'inside')!
    const outside = entries.find((e) => e.message === 'outside')!
    expect(inside).toMatchObject({ requestId: 'req-1', userId: 'user-1' })
    expect(outside.requestId).toBe('req-1')
    expect(outside.userId).toBeUndefined()
  })
})
