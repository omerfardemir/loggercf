// loggercf/consola: a loggercf Logger over a consola instance, and the reporters that put
// the Context Fields on consola's own lines.
import { describe, it, expect, vi, beforeEach, afterEach, expectTypeOf } from 'vitest'

// The `env` that `import { env } from 'cloudflare:workers'` returns; tests set its vars.
const workersEnv = vi.hoisted((): Record<string, unknown> => ({}))

// cloudflare:workers is not available in Node/vitest.
vi.mock('cloudflare:workers', () => ({
  env: workersEnv,
  RpcTarget: class RpcTarget {},
  WorkerEntrypoint: class WorkerEntrypoint {
    ctx: unknown
    env: unknown
    constructor(ctx?: unknown, env?: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
  DurableObject: class DurableObject {},
  WorkflowEntrypoint: class WorkflowEntrypoint {},
}))

import { WorkerEntrypoint } from 'cloudflare:workers'
import consolaDefault, {
  createConsola,
  LogLevels,
  type ConsolaOptions,
  type ConsolaReporter,
  type LogObject,
} from 'consola'
import { createConsola as createBrowserConsola } from 'consola/browser'
import { createConsola as createBasicConsola } from 'consola/basic'
import { createConsola as createCoreConsola } from 'consola/core'
import { Hono } from 'hono'
import { fromConsola, jsonReporter, contextFieldsReporter, type ConsolaLike } from '../consola'
import {
  _captureEntries,
  _getDefaultLogger,
  _reset,
  getLogger,
  runWithLogger,
  setLoggerContext,
  withSpan,
} from '../core/logger'
import { useLogger } from '../hono/middleware'
import {
  TracedEntrypoint,
  TracedSession,
  tracedWorker,
  withLogging,
  withScheduled,
  type SessionInit,
} from '../workers'
import type { Logger } from '../core/types'

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const PARENT_SPAN_ID = 'b7ad6b7169203331'
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`
const ENV = { NAME: 'jobs' }
const CTX = {} as ExecutionContext

/**
 * A consola instance whose one reporter keeps every log object it is given.
 * `throttle: 0`, so identical lines in a row are all written.
 */
function recordingConsola(level: number = LogLevels.info) {
  const logs: LogObject[] = []
  const consola = createConsola({
    level,
    throttle: 0,
    reporters: [{ log: (logObj) => void logs.push(logObj) }],
  })
  return { consola, logs }
}

/** consola's own BasicReporter, writing its text lines to `out` instead of stdout/stderr. */
function basicConsola() {
  const out: string[] = []
  const stream = { write: (text: string) => out.push(text), columns: 0 }
  const consola = createBasicConsola({
    throttle: 0,
    stdout: stream as never,
    stderr: stream as never,
  })
  return { consola, out }
}

/** The log objects whose first argument (the message) starts with `prefix`. */
const linesOf = (logs: LogObject[], prefix: string) =>
  logs.filter((o) => typeof o.args[0] === 'string' && o.args[0].startsWith(prefix))

/** A root Logging Context over `logger`, continuing TRACEPARENT. */
const inContext = <R>(logger: Logger, fn: () => R, fields = { requestId: 'r-1' }) =>
  runWithLogger({ logger, traceparent: TRACEPARENT, fields }, fn)

/** A ScheduledController for a cron run. */
const controller = () => ({ cron: '* * * * *', scheduledTime: 1, noRetry: vi.fn() })

/** A consola instance with one wrapped reporter, and a plain one beside it. */
function wrappedConsola() {
  const wrapped: LogObject[] = []
  const plain: LogObject[] = []
  const consola = createConsola({
    level: LogLevels.info,
    throttle: 0,
    reporters: [
      contextFieldsReporter({ log: (logObj: LogObject) => void wrapped.push(logObj) }),
      { log: (logObj) => void plain.push(logObj) },
    ],
  })
  return { consola, wrapped, plain }
}

/** A consola instance writing through jsonReporter() alone. */
const jsonConsola = () =>
  createCoreConsola({ level: LogLevels.trace, throttle: 0, reporters: [jsonReporter()] })

describe('fromConsola', () => {
  let entries: Record<string, unknown>[]
  beforeEach(() => {
    _reset()
    entries = _captureEntries()
    for (const key of Object.keys(workersEnv)) delete workersEnv[key]
    Object.assign(workersEnv, ENV)
  })

  describe('types', () => {
    it('is a Logger', () => {
      expectTypeOf(fromConsola(recordingConsola().consola)).toEqualTypeOf<Logger>()
    })

    it('accepts consola’s default instance and every createConsola() without a cast', () => {
      expectTypeOf(fromConsola).toBeCallableWith(consolaDefault)
      expectTypeOf(fromConsola).toBeCallableWith(createConsola())
      expectTypeOf(fromConsola).toBeCallableWith(createBasicConsola())
      expectTypeOf(fromConsola).toBeCallableWith(createBrowserConsola())
      expectTypeOf(fromConsola).toBeCallableWith(createCoreConsola().withTag('api'))
      expectTypeOf(consolaDefault).toExtend<ConsolaLike>()
    })

    it('rejects an object without the six level methods', () => {
      const partial = { info: () => {}, warn: () => {}, error: () => {} }
      expectTypeOf(partial).not.toExtend<ConsolaLike>()
    })

    it('makes reporters that createConsola() accepts, from any consola reporter', () => {
      const own = { log: (_logObj: LogObject, _ctx: { options: ConsolaOptions }) => {} }
      createCoreConsola({ reporters: [jsonReporter(), contextFieldsReporter(own)] })
      expectTypeOf(contextFieldsReporter(own)).toExtend<ConsolaReporter>()
      expectTypeOf(jsonReporter()).toExtend<ConsolaReporter>()
    })
  })

  describe('levels', () => {
    it('writes each level through consola’s method of the same name', () => {
      const { consola, logs } = recordingConsola(LogLevels.trace)
      const logger = fromConsola(consola)
      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
        logger[level]('hello')
      }
      expect(logs.map((o) => [o.type, o.level])).toEqual([
        ['trace', 5],
        ['debug', 4],
        ['info', 3],
        ['warn', 1],
        ['error', 0],
        ['fatal', 0],
      ])
    })

    it('leaves the filtering to consola’s level', () => {
      const { consola, logs } = recordingConsola(LogLevels.info)
      const logger = fromConsola(consola)
      logger.trace('t')
      logger.debug('d')
      logger.info('i')
      consola.level = LogLevels.debug
      logger.debug('d2')
      consola.level = LogLevels.silent
      logger.fatal('f')
      expect(logs.map((o) => o.args[0])).toEqual(['i', 'd2'])
    })

    it('does not route a call consola would filter out', () => {
      const { consola } = recordingConsola(LogLevels.info)
      const getter = vi.fn(() => 1)
      fromConsola(consola).debug({
        get read() {
          return getter()
        },
      })
      expect(getter).not.toHaveBeenCalled()
    })
  })

  describe('how a line is handed to consola', () => {
    it('passes a structured call as the formatted message, then one object of fields', () => {
      const { consola, logs } = recordingConsola()
      fromConsola(consola).info({ userId: 42 }, 'user %s signed in', 'ada')
      expect(logs[0]!.args).toEqual(['user ada signed in', { userId: 42 }])
    })

    it('passes a console-style call the same way', () => {
      const { consola, logs } = recordingConsola()
      fromConsola(consola).warn('slow', { ms: 900 })
      expect(logs[0]!.args).toEqual(['slow', { ms: 900 }])
    })

    it('passes only the message when the line has no fields', () => {
      const { consola, logs } = recordingConsola()
      fromConsola(consola).info('hello %d%', 100)
      expect(logs[0]!.args).toEqual(['hello 100%'])
    })

    it('escapes % in the message when fields follow, so consola’s reporters print it as it is', () => {
      const { consola, out } = basicConsola()
      fromConsola(consola).info({ id: 1 }, 'saved %s', '50%off')
      expect(out).toEqual(['[info] saved 50%off { id: 1 }\n'])
    })

    it('shows the fields in consola’s BasicReporter', () => {
      const { consola, out } = basicConsola()
      fromConsola(consola).warn({ orderId: 7 }, 'payment slow')
      expect(out).toEqual(['[warn] payment slow { orderId: 7 }\n'])
    })

    it('passes an Error last, on its own, so consola’s reporters print its message and stack', () => {
      const { consola, logs } = recordingConsola()
      const err = new TypeError('boom')
      fromConsola(consola).error({ err, orderId: 7 }, 'payment failed')
      expect(logs[0]!.args).toEqual(['payment failed', { orderId: 7 }, err])
    })

    it('writes an Error-first call as its message and stack in consola’s BasicReporter', () => {
      const { consola, out } = basicConsola()
      fromConsola(consola).error(new TypeError('boom'))
      expect(out[0]).toMatch(/^\[error\] boom\n\s+at /)
    })

    it('keeps a second Error and the Overflow in the fields object', () => {
      const { consola, logs } = recordingConsola()
      const first = new Error('one')
      const second = new Error('two')
      fromConsola(consola).error('failed', first, second, [1, 2])
      expect(logs[0]!.args).toEqual(['failed', { errors: [second], args: [[1, 2]] }, first])
    })

    it('writes the bindings of child() in the fields, the call’s own winning', () => {
      const { consola, logs } = recordingConsola()
      const logger = fromConsola(consola).child({ service: 'api', region: 'eu' }).child({ job: 1 })
      logger.info({ region: 'us' }, 'run')
      expect(logs[0]!.args).toEqual(['run', { service: 'api', region: 'us', job: 1 }])
    })

    it('writes through a consola tag', () => {
      const { consola, logs } = recordingConsola()
      fromConsola(consola.withTag('billing')).info('charged')
      expect(logs[0]!.tag).toBe('billing')
    })

    it('never throws, even when a reporter does', () => {
      const consola = createConsola({
        level: LogLevels.info,
        reporters: [
          {
            log: () => {
              throw new Error('reporter broke')
            },
          },
        ],
      })
      expect(() => consola.info('direct')).toThrow('reporter broke')
      const logger = fromConsola(consola)
      expect(() => logger.info('through loggercf')).not.toThrow()
      expect(() => logger.child({ a: 1 }).error(new Error('x'))).not.toThrow()
    })
  })

  describe('Context Fields', () => {
    it('adds none outside a Logging Context', () => {
      const { consola, logs } = recordingConsola()
      fromConsola(consola).info({ a: 1 }, 'outside')
      expect(logs[0]!.args).toEqual(['outside', { a: 1 }])
    })

    it('adds the Context Fields and trace IDs inside one, before the line’s own fields', () => {
      const { consola, logs } = recordingConsola()
      const logger = fromConsola(consola)
      inContext(logger, () => {
        setLoggerContext({ userId: 42 })
        getLogger().info({ a: 1 }, 'inside')
      })
      expect(logs[0]!.args).toEqual([
        'inside',
        {
          requestId: 'r-1',
          userId: 42,
          a: 1,
          traceId: TRACE_ID,
          spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
          parentSpanId: PARENT_SPAN_ID,
        },
      ])
      expect(Object.keys(logs[0]!.args[1] as object)).toEqual([
        'requestId',
        'userId',
        'a',
        'traceId',
        'spanId',
        'parentSpanId',
      ])
    })

    it('lets the line’s own fields win over a Context Field, but never over the trace IDs', () => {
      const { consola, logs } = recordingConsola()
      const logger = fromConsola(consola)
      inContext(logger, () => {
        getLogger().child({ requestId: 'from-binding', spanId: 'binding' }).info('x')
      })
      const fields = logs[0]!.args[1] as Record<string, unknown>
      expect(fields.requestId).toBe('from-binding')
      expect(fields.spanId).toMatch(/^[0-9a-f]{16}$/)
    })

    it('writes a Span’s IDs on the lines inside the Span', () => {
      const { consola, logs } = recordingConsola()
      const logger = fromConsola(consola)
      let outerSpan: unknown
      inContext(logger, () => {
        getLogger().info('outer')
        outerSpan = (logs[0]!.args[1] as Record<string, unknown>).spanId
        withSpan('db.query', () => getLogger().info('inner'))
      })
      const inner = linesOf(logs, 'inner')[0]!.args[1] as Record<string, unknown>
      expect(inner.traceId).toBe(TRACE_ID)
      expect(inner.parentSpanId).toBe(outerSpan)
      expect(inner.spanId).not.toBe(outerSpan)
    })
  })

  describe('loggercf’s own lines', () => {
    it('writes the Request Lines of useLogger through consola, with the Context Fields', async () => {
      const { consola, logs } = recordingConsola()
      const app = new Hono()
      app.use(useLogger(fromConsola(consola)))
      app.get('/users/:id', (c) => c.text('ok'))
      await app.request('/users/1', { headers: { traceparent: TRACEPARENT } })

      const end = linesOf(logs, 'request.end')
      expect(end).toHaveLength(1)
      expect(end[0]!.type).toBe('info')
      expect(end[0]!.args[1]).toMatchObject({
        requestId: expect.any(String),
        method: 'GET',
        route: '/users/:id',
        statusCode: 200,
        duration: expect.any(Number),
        traceId: TRACE_ID,
      })
      expect(entries).toEqual([])
    })

    it('writes span.end with the operation in the message', () => {
      const { consola, logs } = recordingConsola()
      inContext(fromConsola(consola), () => withSpan('db.query', () => 1))
      const end = linesOf(logs, 'span.end')
      expect(end.map((o) => [o.type, o.args[0]])).toEqual([['info', 'span.end db.query']])
      expect(end[0]!.args[1]).toMatchObject({ span: { operation: 'db.query', status: 'OK' } })
    })

    it('writes a failing Span’s span.end at error, with the Error and its stack', () => {
      const { consola, out } = basicConsola()
      expect(() =>
        inContext(fromConsola(consola), () =>
          withSpan('db.query', () => {
            throw new Error('connection reset')
          }),
        ),
      ).toThrow('connection reset')
      const end = out.find((line) => line.startsWith('[error] span.end db.query'))
      expect(end).toMatch(/status: 'ERROR'.*connection reset\n\s+at /s)
    })

    it('writes the failure line of withLogging with the Error', () => {
      const { consola, logs } = recordingConsola()
      class Search extends WorkerEntrypoint<typeof ENV> {
        fail(): never {
          throw new Error('nope')
        }
      }
      const Logged = withLogging(Search, { logger: fromConsola(consola) })
      expect(() => new Logged(CTX, ENV).fail()).toThrow('nope')
      const failed = linesOf(logs, 'Search.fail failed')
      expect(failed).toHaveLength(1)
      expect(failed[0]!.type).toBe('error')
      expect(failed[0]!.args.at(-1)).toEqual(new Error('nope'))
    })
  })

  describe('the Workers helpers’ logger option', () => {
    it('opens the Logging Context over it and registers it as the Default Logger', async () => {
      const { consola, logs } = recordingConsola()
      const logger = fromConsola(consola)
      await withScheduled(() => getLogger().info('nightly'), { logger })(controller(), ENV, CTX)
      getLogger().info('outside')

      expect(linesOf(logs, 'nightly')[0]!.args[1]).toMatchObject({ traceId: expect.any(String) })
      expect(linesOf(logs, 'span.end')).toHaveLength(1)
      expect(linesOf(logs, 'outside')[0]!.args).toEqual(['outside'])
      expect(_getDefaultLogger()).toBe(logger)
      expect(entries).toEqual([])
    })

    it('takes a function of env', async () => {
      const { consola, logs } = recordingConsola()
      const handler = withScheduled(() => getLogger().info('run'), {
        logger: (env: typeof ENV) => fromConsola(consola).child({ service: env.NAME }),
      })
      await handler(controller(), ENV, CTX)
      expect(linesOf(logs, 'run')[0]!.args[1]).toMatchObject({ service: 'jobs' })
    })

    it('is the Root Logger a TracedEntrypoint’s hook returns', () => {
      const { consola, logs } = recordingConsola()
      class Session extends TracedSession<typeof ENV> {
        ping() {
          return this.traced(() => getLogger().info('pong'), 'ping')
        }
      }
      class Entry extends TracedEntrypoint<typeof ENV> {
        protected override get [TracedEntrypoint.rootLogger](): Logger {
          return fromConsola(consola).child({ service: this.env.NAME })
        }
        session(init: SessionInit) {
          return new Session(init, this[TracedEntrypoint.rootLogger], this.env)
        }
      }
      new Entry(CTX, ENV).session({ traceparent: TRACEPARENT }).ping()
      expect(linesOf(logs, 'pong')[0]!.args[1]).toMatchObject({
        service: 'jobs',
        traceId: TRACE_ID,
      })
      expect(linesOf(logs, 'span.end ping')).toHaveLength(1)
    })

    it('works with tracedWorker', () => {
      const { consola, logs } = recordingConsola()
      class Session extends TracedSession<typeof ENV> {
        add(a: number, b: number) {
          return this.traced(() => a + b, 'add')
        }
      }
      const Worker = tracedWorker(Session, { logger: fromConsola(consola) })
      expect(new Worker(CTX, ENV).session({}).add(1, 2)).toBe(3)
      expect(linesOf(logs, 'span.end add')).toHaveLength(1)
    })
  })
})

describe('contextFieldsReporter', () => {
  beforeEach(() => {
    _reset()
    _captureEntries()
  })

  it('adds the Context Fields, as a last argument, to consola’s own calls inside a Logging Context', () => {
    const { consola, wrapped } = wrappedConsola()
    inContext(fromConsola(consola), () => consola.info('direct %s', 'call', { a: 1 }))
    expect(wrapped[0]!.args).toEqual([
      'direct %s',
      'call',
      { a: 1 },
      {
        requestId: 'r-1',
        traceId: TRACE_ID,
        spanId: expect.any(String),
        parentSpanId: PARENT_SPAN_ID,
      },
    ])
  })

  it('adds nothing outside a Logging Context', () => {
    const { consola, wrapped } = wrappedConsola()
    consola.info('direct', { a: 1 })
    expect(wrapped[0]!.args).toEqual(['direct', { a: 1 }])
  })

  it('leaves a line from fromConsola as it is, which already has them', () => {
    const { consola, wrapped } = wrappedConsola()
    inContext(fromConsola(consola), () => getLogger().info('through loggercf'))
    expect(wrapped[0]!.args).toEqual([
      'through loggercf',
      {
        requestId: 'r-1',
        traceId: TRACE_ID,
        spanId: expect.any(String),
        parentSpanId: PARENT_SPAN_ID,
      },
    ])
  })

  it('does not change the log object the other reporters get', () => {
    const { consola, plain } = wrappedConsola()
    inContext(fromConsola(consola), () => consola.info('direct'))
    expect(plain[0]!.args).toEqual(['direct'])
  })
})

describe('jsonReporter', () => {
  let lines: { method: string; line: Record<string, unknown> }[]
  beforeEach(() => {
    _reset()
    _captureEntries()
    lines = []
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((text: unknown) => {
        lines.push({ method, line: JSON.parse(String(text)) })
      })
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a loggercf line as one JSON line, as loggercf writes its own', () => {
    const consola = jsonConsola()
    inContext(fromConsola(consola).child({ service: 'api' }), () =>
      getLogger().info({ orderId: 7 }, 'order %s placed', 'A-1'),
    )
    expect(lines).toEqual([
      {
        method: 'info',
        line: {
          time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          level: 'INFO',
          message: 'order A-1 placed',
          requestId: 'r-1',
          service: 'api',
          orderId: 7,
          traceId: TRACE_ID,
          spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
          parentSpanId: PARENT_SPAN_ID,
        },
      },
    ])
  })

  it('writes an Error with its type, message and stack', () => {
    const consola = jsonConsola()
    fromConsola(consola).error(new TypeError('boom'))
    expect(lines[0]!.line).toMatchObject({
      level: 'ERROR',
      message: 'boom',
      err: { type: 'TypeError', message: 'boom', stack: expect.stringContaining('at ') },
    })
  })

  it('writes a failing Span’s span.end with the Error', () => {
    const consola = jsonConsola()
    expect(() =>
      inContext(fromConsola(consola), () =>
        withSpan('db.query', () => {
          throw new Error('connection reset')
        }),
      ),
    ).toThrow('connection reset')
    const end = lines.find((l) => l.line.message === 'span.end db.query')!
    expect(end.method).toBe('error')
    expect(end.line).toMatchObject({
      level: 'ERROR',
      span: { operation: 'db.query', status: 'ERROR' },
      err: { type: 'Error', message: 'connection reset', stack: expect.any(String) },
    })
  })

  it('writes each level through the console method Workers Logs reads its severity from', () => {
    const consola = jsonConsola()
    const logger = fromConsola(consola)
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)
      logger[level]('x')
    expect(lines.map((l) => [l.method, l.line.level])).toEqual([
      ['debug', 'TRACE'],
      ['debug', 'DEBUG'],
      ['info', 'INFO'],
      ['warn', 'WARN'],
      ['error', 'ERROR'],
      ['error', 'FATAL'],
    ])
  })

  it('routes consola’s own calls as loggercf routes a log call, with the Context Fields', () => {
    const consola = jsonConsola()
    const err = new Error('declined')
    inContext(fromConsola(consola), () =>
      consola.warn('card %s declined', '4242', { amount: 5 }, err),
    )
    expect(lines[0]).toEqual({
      method: 'warn',
      line: {
        time: expect.any(String),
        level: 'WARN',
        message: 'card 4242 declined',
        requestId: 'r-1',
        amount: 5,
        err: expect.objectContaining({ type: 'Error', message: 'declined' }),
        traceId: TRACE_ID,
        spanId: expect.any(String),
        parentSpanId: PARENT_SPAN_ID,
      },
    })
  })

  it('maps consola’s other types to a level, and writes the type and tag', () => {
    const consola = jsonConsola().withTag('deploy')
    consola.success('done')
    consola.log('plain')
    expect(lines.map((l) => l.line)).toEqual([
      { time: expect.any(String), level: 'INFO', message: 'done', tag: 'deploy', type: 'success' },
      { time: expect.any(String), level: 'INFO', message: 'plain', tag: 'deploy' },
    ])
  })

  it('never throws', () => {
    const consola = jsonConsola()
    vi.mocked(console.info).mockImplementation(() => {
      throw new Error('console broke')
    })
    expect(() => consola.info('x')).not.toThrow()
  })
})

describe('consola’s throttle', () => {
  it('holds back identical lines in a row by default; throttle: 0 writes every one', () => {
    const held = createConsola({ level: LogLevels.info, reporters: [] })
    const kept: unknown[] = []
    held.setReporters([{ log: (o) => void kept.push(o) }])
    for (let i = 0; i < 10; i++) fromConsola(held).info('same')
    expect(kept.length).toBeLessThan(10)

    const { consola, logs } = recordingConsola()
    for (let i = 0; i < 10; i++) fromConsola(consola).info('same')
    expect(logs).toHaveLength(10)
  })
})
