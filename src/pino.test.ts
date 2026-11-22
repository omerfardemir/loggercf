// pino as Your Own Logger: a real pino logger, written to memory, as the Root Logger.
// It answers the Logger Port as it is: no adapter. These tests pin what its lines hold,
// loggercf's own lines (Request Lines, span.end, failure lines) included, and where
// pino and loggercf's built-in core differ.
import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest'

// The `env` that `import { env } from 'cloudflare:workers'` returns.
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
  DurableObject: class DurableObject {
    ctx: unknown
    env: unknown
    constructor(ctx?: unknown, env?: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
  WorkflowEntrypoint: class WorkflowEntrypoint {
    ctx: unknown
    env: unknown
    constructor(ctx?: unknown, env?: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

import pino from 'pino'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { Hono } from 'hono'
import {
  currentContextFields,
  getLogger,
  runWithLogger,
  setLoggerContext,
  withSpan,
  _captureEntries,
  _getDefaultLogger,
  _reset,
} from './logger'
import { useLogger } from './middleware'
import {
  TracedEntrypoint,
  TracedSession,
  tracedWorker,
  withLogging,
  withQueueMessage,
  withScheduled,
  type SessionInit,
} from './workers'
import type { Logger } from './types'

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const PARENT_SPAN_ID = 'b7ad6b7169203331'
const SAMPLED = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`
const UNSAMPLED = `00-${TRACE_ID}-${PARENT_SPAN_ID}-00`
const HEX16 = /^[0-9a-f]{16}$/
const HEX32 = /^[0-9a-f]{32}$/

const ENV = { NAME: 'jobs' }
const CTX = {} as ExecutionContext

type Line = Record<string, any>

/**
 * A real pino logger that writes to memory, synchronously: each line as pino wrote it
 * (`raw`) and parsed (`lines`). `mixin: currentContextFields` and `base: {}` (no `pid` or
 * `hostname`) unless `options` say otherwise.
 *
 * @param {pino.LoggerOptions} [options] - pino options, over the defaults above.
 * @returns {{ logger: pino.Logger, lines: Line[], raw: string[] }} The logger and what it wrote.
 */
function memoryPino(options: pino.LoggerOptions = {}): {
  logger: pino.Logger
  lines: Line[]
  raw: string[]
} {
  const raw: string[] = []
  const lines: Line[] = []
  const logger = pino(
    { base: {}, mixin: currentContextFields, ...options },
    {
      write(line: string) {
        raw.push(line)
        lines.push(JSON.parse(line) as Line)
      },
    },
  )
  return { logger, lines, raw }
}

/**
 * A Hono app logging through a pino logger, whose handler throws and whose `onError`
 * throws too: its `request.end` holds both Errors, `err` and `originalErr`.
 *
 * @param {pino.LoggerOptions} options - pino options.
 * @returns {{ app: Hono, lines: Line[] }} The app and the lines it wrote.
 */
function failingOnErrorApp(options: pino.LoggerOptions): { app: Hono; lines: Line[] } {
  const { logger, lines } = memoryPino(options)
  const app = new Hono()
  app.use(useLogger(logger, { requestStart: false }))
  app.get('/', () => {
    throw new Error('handler failed')
  })
  app.onError(() => {
    throw new Error('onError failed')
  })
  return { app, lines }
}

/** The lines whose message (`msg`, or `message` with `messageKey: 'message'`) starts with `prefix`. */
const linesOf = (lines: Line[], prefix: string) =>
  lines.filter((l) => String(l.msg ?? l.message ?? '').startsWith(prefix))

/** How many times `"key":` appears in one raw line. */
const keyCount = (raw: string, key: string) => raw.split(`"${key}":`).length - 1

describe('pino as your own logger', () => {
  let entries: Record<string, unknown>[]
  beforeEach(() => {
    _reset()
    entries = _captureEntries()
    for (const key of Object.keys(workersEnv)) delete workersEnv[key]
    Object.assign(workersEnv, ENV)
  })

  it('is a Logger as it is, with no adapter', () => {
    expectTypeOf<pino.Logger>().toExtend<Logger>()
    expectTypeOf(pino()).toExtend<Logger>()
  })

  describe('mixin: currentContextFields', () => {
    it('puts the Context Fields, traceId and spanId on your own lines inside a Logging Context', () => {
      const { logger, lines } = memoryPino()
      runWithLogger({ logger, fields: { requestId: 'req-1' } }, () => {
        getLogger().info({ step: 1 }, 'loading')
      })
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ requestId: 'req-1', step: 1, msg: 'loading' })
      expect(lines[0]!.traceId).toMatch(HEX32)
      expect(lines[0]!.spanId).toMatch(HEX16)
      expect(lines[0]).not.toHaveProperty('parentSpanId')
    })

    it('adds parentSpanId when the Logging Context continues a trace', () => {
      const { logger, lines } = memoryPino()
      runWithLogger({ logger, traceparent: SAMPLED }, () => getLogger().info('continued'))
      expect(lines[0]).toMatchObject({ traceId: TRACE_ID, parentSpanId: PARENT_SPAN_ID })
      expect(lines[0]!.spanId).not.toBe(PARENT_SPAN_ID)
    })

    it('writes Context Fields added later with setLoggerContext', () => {
      const { logger, lines } = memoryPino()
      runWithLogger({ logger }, () => {
        getLogger().info('before')
        setLoggerContext({ userId: 'u-42' })
        getLogger().info('after')
      })
      expect(lines[0]).not.toHaveProperty('userId')
      expect(lines[1]).toMatchObject({ userId: 'u-42' })
    })

    it("gives a Span's lines the Span's spanId, its parent being the enclosing span", () => {
      const { logger, lines } = memoryPino()
      runWithLogger({ logger }, () => {
        getLogger().info('outer')
        withSpan('inner', () => getLogger().info('in span'))
      })
      const [outer, inSpan] = lines
      expect(inSpan!.traceId).toBe(outer!.traceId)
      expect(inSpan!.parentSpanId).toBe(outer!.spanId)
      expect(inSpan!.spanId).not.toBe(outer!.spanId)
    })

    it('adds nothing outside a Logging Context', () => {
      const { logger, raw } = memoryPino()
      logger.info('outside')
      expect(JSON.parse(raw[0]!)).toEqual({ level: 30, time: expect.any(Number), msg: 'outside' })
    })

    it('without the mixin, your own lines carry no Context Fields or trace IDs', () => {
      const { logger, lines } = memoryPino({ mixin: undefined })
      runWithLogger({ logger, fields: { requestId: 'req-1' } }, () => getLogger().info('bare'))
      expect(lines[0]).not.toHaveProperty('requestId')
      expect(lines[0]).not.toHaveProperty('traceId')
    })
  })

  describe("loggercf's own lines", () => {
    it("useLogger writes the Request Lines through pino, and nothing through loggercf's core", async () => {
      const { logger, lines } = memoryPino()
      const app = new Hono()
      app.use(useLogger(logger))
      app.get('/users/:id', (c) => c.text('ok'))
      await app.request('/users/1', { headers: { traceparent: SAMPLED, 'x-request-id': 'req-1' } })

      const [start] = linesOf(lines, 'request.start')
      const [end] = linesOf(lines, 'request.end')
      expect(start).toMatchObject({ level: 30, msg: 'request.start GET /users/1' })
      expect(end).toMatchObject({
        level: 30,
        msg: 'request.end GET /users/1',
        method: 'GET',
        path: '/users/1',
        route: '/users/:id',
        statusCode: 200,
        duration: expect.any(Number),
        requestId: 'req-1',
        traceId: TRACE_ID,
        parentSpanId: PARENT_SPAN_ID,
      })
      expect(entries).toEqual([])
    })

    it('request.end holds requestId once, though both the call and the mixin give it', async () => {
      const { logger, raw } = memoryPino()
      const app = new Hono()
      app.use(useLogger(logger, { requestStart: false }))
      app.get('/', (c) => c.text('ok'))
      await app.request('/', { headers: { 'x-request-id': 'req-1' } })
      expect(raw).toHaveLength(1)
      expect(keyCount(raw[0]!, 'requestId')).toBe(1)
    })

    it('request.end for a 500 is at error, with the caught Error under err, serialized by pino', async () => {
      const { logger, lines } = memoryPino()
      const app = new Hono()
      app.use(useLogger(logger, { requestStart: false }))
      app.get('/boom', () => {
        throw new TypeError('kaput')
      })
      await app.request('/boom')
      expect(lines[0]).toMatchObject({
        level: 50,
        statusCode: 500,
        err: { type: 'TypeError', message: 'kaput', stack: expect.stringContaining('kaput') },
      })
    })

    it('withSpan writes span.end <operation>, with the %s filled in and the span object', () => {
      const { logger, lines } = memoryPino()
      runWithLogger({ logger }, () => withSpan('db.getUser', () => 42))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        level: 30,
        msg: 'span.end db.getUser',
        span: {
          operation: 'db.getUser',
          status: 'OK',
          duration: expect.any(Number),
          startTime: expect.any(Number),
          endTime: expect.any(Number),
        },
      })
    })

    it("writes a failing Span at error, with err serialized by pino's err serializer", () => {
      const { logger, lines } = memoryPino()
      expect(() =>
        runWithLogger({ logger }, () =>
          withSpan('db.write', () => {
            throw new RangeError('no row')
          }),
        ),
      ).toThrow('no row')
      expect(lines[0]).toMatchObject({
        level: 50,
        msg: 'span.end db.write',
        span: { operation: 'db.write', status: 'ERROR', error: 'no row' },
        err: { type: 'RangeError', message: 'no row', stack: expect.stringContaining('no row') },
      })
    })

    it('writes "<operation> failed" for a failing Span of an unsampled trace', () => {
      const { logger, lines } = memoryPino()
      expect(() =>
        runWithLogger({ logger, traceparent: UNSAMPLED }, () =>
          withSpan('db.write', () => {
            throw new Error('no row')
          }),
        ),
      ).toThrow('no row')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        level: 50,
        msg: 'db.write failed',
        err: { type: 'Error', message: 'no row' },
      })
    })

    it("applies a Span's own level, and pino's level filters it", () => {
      const { logger, lines } = memoryPino({ level: 'info' })
      runWithLogger({ logger }, () => {
        withSpan('cache.read', () => 1, { level: 'debug' })
        withSpan('cache.write', () => 1, { level: 'warn' })
      })
      expect(lines.map((l) => [l.level, l.msg])).toEqual([[40, 'span.end cache.write']])
    })

    it("applies a Span's own Slow Threshold and Span Fields", () => {
      const { logger, lines } = memoryPino()
      runWithLogger({ logger }, () =>
        withSpan('db.query', (span) => span.set({ rows: 3 }), {
          slowMs: 0,
          fields: { table: 'users' },
        }),
      )
      expect(lines[0]).toMatchObject({ level: 40, table: 'users', rows: 3 })
    })

    it("pino's level filters loggercf's own lines like any other", async () => {
      const { logger, lines } = memoryPino({ level: 'warn' })
      const app = new Hono()
      app.use(useLogger(logger))
      app.get('/', (c) => c.text('ok'))
      await app.request('/')
      expect(lines).toEqual([])
    })

    it('an Error under a key other than err, such as request.end’s originalErr, is {} without a serializer for it', async () => {
      const plain = failingOnErrorApp({})
      await expect(plain.app.request('/')).rejects.toThrow('onError failed')
      expect(plain.lines[0]!.err).toMatchObject({ message: 'onError failed' })
      expect(plain.lines[0]!.originalErr).toEqual({})

      const serialized = failingOnErrorApp({
        serializers: { originalErr: pino.stdSerializers.err },
      })
      await expect(serialized.app.request('/')).rejects.toThrow('onError failed')
      expect(serialized.lines[0]!.originalErr).toMatchObject({
        type: 'Error',
        message: 'handler failed',
      })
    })
  })

  describe('errors', () => {
    it("pino's err serializer folds an Error's cause into its message and stack; errWithCause nests it", () => {
      const err = new Error('outer', { cause: new TypeError('inner') })
      const folded = memoryPino()
      const nested = memoryPino({ serializers: { err: pino.stdSerializers.errWithCause } })
      folded.logger.error({ err }, 'x')
      nested.logger.error({ err }, 'x')

      expect(folded.lines[0]!.err.message).toBe('outer: inner')
      expect(folded.lines[0]!.err.stack).toContain('caused by: TypeError: inner')
      expect(folded.lines[0]!.err).not.toHaveProperty('cause')
      expect(nested.lines[0]!.err).toMatchObject({
        message: 'outer',
        cause: { type: 'TypeError', message: 'inner' },
      })
    })

    it('an Error in any field but err is {}', () => {
      const { logger, lines } = memoryPino()
      logger.error({ failure: new Error('lost'), nested: { e: new Error('lost too') } }, 'x')
      expect(lines[0]).toMatchObject({ failure: {}, nested: { e: {} } })
    })
  })

  describe('call styles', () => {
    it('an Error first: err is serialized, and its message is the message', () => {
      const { logger, lines } = memoryPino()
      logger.error(new TypeError('boom'))
      logger.error(new TypeError('boom'), 'charge failed')
      expect(lines[0]).toMatchObject({ msg: 'boom', err: { type: 'TypeError', message: 'boom' } })
      expect(lines[1]).toMatchObject({ msg: 'charge failed', err: { message: 'boom' } })
    })

    it('fields, then a printf message', () => {
      const { logger, lines } = memoryPino()
      logger.info({ userId: 42 }, 'user %s signed in after %d tries', 'ada', 3)
      expect(lines[0]).toMatchObject({ userId: 42, msg: 'user ada signed in after 3 tries' })
    })

    it('{ err } with no message: the message is err.message', () => {
      const { logger, lines } = memoryPino()
      logger.error({ err: new Error('boom'), orderId: 'o-1' })
      expect(lines[0]).toMatchObject({ msg: 'boom', orderId: 'o-1', err: { message: 'boom' } })
    })

    it("pino's own types reject a console-style call", () => {
      const { logger, lines } = memoryPino()
      // @ts-expect-error pino's types take nothing after a message without placeholders
      logger.info('user signed in', { userId: 'u-42' })
      // @ts-expect-error nor more arguments than the message's placeholders
      logger.info('user %s', 'ada', { plan: 'pro' })
      expect(lines.map((l) => l.msg)).toEqual(['user signed in', 'user ada'])
    })

    it("console style through loggercf's Logger type compiles, but pino keeps only the message and what its placeholders take", () => {
      const { logger, lines } = memoryPino()
      runWithLogger({ logger }, () => {
        const log = getLogger()
        log.info('user signed in', { userId: 'u-42' })
        log.error('charge failed', new Error('boom'))
        log.info('scope', 'more text')
        log.info('user %s', 'ada', { plan: 'pro' })
      })
      expect(lines.map((l) => [l.msg, l.userId, l.err, l.plan])).toEqual([
        ['user signed in', undefined, undefined, undefined],
        ['charge failed', undefined, undefined, undefined],
        ['scope', undefined, undefined, undefined],
        ['user ada', undefined, undefined, undefined],
      ])
    })

    it('a logMethod hook can route a console-style call the structured way', () => {
      const { logger, lines } = memoryPino({
        hooks: {
          logMethod(args, method) {
            const [message, value] = args as unknown[]
            if (
              args.length === 2 &&
              typeof message === 'string' &&
              !message.includes('%') &&
              typeof value === 'object' &&
              value !== null
            ) {
              return method.apply(this, [value, message] as never)
            }
            return method.apply(this, args)
          },
        },
      })
      const log: Logger = logger
      log.info('user signed in', { userId: 'u-42' })
      log.error('charge failed', new Error('boom'))
      log.info({ a: 1 }, 'structured %s', 'still')
      expect(lines[0]).toMatchObject({ msg: 'user signed in', userId: 'u-42' })
      expect(lines[1]).toMatchObject({ msg: 'charge failed', err: { message: 'boom' } })
      expect(lines[2]).toMatchObject({ msg: 'structured still', a: 1 })
    })

    it('writes all six levels, as pino level numbers', () => {
      const { logger, lines } = memoryPino({ level: 'trace' })
      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
        logger[level](level)
      }
      expect(lines.map((l) => [l.level, l.msg])).toEqual([
        [10, 'trace'],
        [20, 'debug'],
        [30, 'info'],
        [40, 'warn'],
        [50, 'error'],
        [60, 'fatal'],
      ])
    })

    it('writes the level as a label with formatters.level', () => {
      const { logger, lines } = memoryPino({
        formatters: { level: (label) => ({ level: label.toUpperCase() }) },
      })
      logger.warn('slow')
      expect(lines[0]!.level).toBe('WARN')
    })

    it("filters by pino's level", () => {
      const { logger, lines } = memoryPino({ level: 'warn' })
      logger.info('dropped')
      logger.warn('kept')
      expect(lines.map((l) => l.msg)).toEqual(['kept'])
    })

    it('writes child() bindings on every line of the child, and getLogger() inside a Logging Context is a child of your logger', () => {
      const { logger, lines } = memoryPino({ base: { service: 'api' } })
      const child = logger.child({ component: 'billing' })
      runWithLogger({ logger: child }, () => getLogger().child({ job: 'nightly' }).info('run'))
      expect(lines[0]).toMatchObject({ service: 'api', component: 'billing', job: 'nightly' })
    })
  })

  describe('key collisions', () => {
    it("writes the message as msg, or as message with messageKey: 'message'", () => {
      const asMsg = memoryPino()
      const asMessage = memoryPino({ messageKey: 'message' })
      asMsg.logger.info('hello')
      asMessage.logger.info('hello')
      expect(asMsg.lines[0]).toMatchObject({ msg: 'hello' })
      expect(asMessage.lines[0]).toMatchObject({ message: 'hello' })
      expect(asMessage.lines[0]).not.toHaveProperty('msg')
    })

    it("lets a call's fields win over the mixin by default, so a call can replace traceId", () => {
      const { logger, lines } = memoryPino()
      runWithLogger({ logger, traceparent: SAMPLED, fields: { requestId: 'req-1' } }, () =>
        getLogger().info({ traceId: 'mine', requestId: 'call' }, 'm'),
      )
      expect(lines[0]).toMatchObject({ traceId: 'mine', requestId: 'call' })
    })

    it("lets the mixin win with a mixinMergeStrategy, leaving the call's object unchanged", () => {
      const { logger, lines } = memoryPino({
        mixinMergeStrategy: (mergeObject, mixinObject) => ({ ...mergeObject, ...mixinObject }),
      })
      const fields = { traceId: 'mine', a: 1 }
      runWithLogger({ logger, traceparent: SAMPLED }, () => getLogger().info(fields, 'm'))
      expect(lines[0]).toMatchObject({ traceId: TRACE_ID, a: 1 })
      expect(fields).toEqual({ traceId: 'mine', a: 1 })
    })

    it('a Context Field named level, time or msg is written a second time, and wins when the line is parsed', () => {
      const { logger, lines, raw } = memoryPino()
      runWithLogger({ logger, fields: { level: 'custom', time: 'then', msg: 'ctx' } }, () =>
        getLogger().error('real message'),
      )
      expect(keyCount(raw[0]!, 'level')).toBe(2)
      expect(keyCount(raw[0]!, 'time')).toBe(2)
      expect(keyCount(raw[0]!, 'msg')).toBe(2)
      // The message pino writes is the last key, so it still wins; level and time do not.
      expect(lines[0]).toMatchObject({ level: 'custom', time: 'then', msg: 'real message' })
    })

    it('a child binding and a Context Field of the same name are both written; the Context Field wins when parsed', () => {
      const { logger, lines, raw } = memoryPino()
      runWithLogger(
        { logger: logger.child({ tenant: 'binding' }), fields: { tenant: 'ctx' } },
        () => getLogger().info('m'),
      )
      expect(keyCount(raw[0]!, 'tenant')).toBe(2)
      expect(lines[0]!.tenant).toBe('ctx')
    })

    it('a call field named message is a plain field by default, and written twice with messageKey: message', () => {
      const plain = memoryPino()
      const asMessage = memoryPino({ messageKey: 'message' })
      plain.logger.info({ message: 'field' }, 'real')
      asMessage.logger.info({ message: 'field' }, 'real')
      expect(plain.lines[0]).toMatchObject({ message: 'field', msg: 'real' })
      expect(keyCount(asMessage.raw[0]!, 'message')).toBe(2)
      expect(asMessage.lines[0]!.message).toBe('real')
    })

    it('base replaces pid and hostname', () => {
      const defaults: Line[] = []
      pino({}, { write: (line: string) => void defaults.push(JSON.parse(line)) }).info('m')
      expect(defaults[0]).toHaveProperty('pid')
      expect(defaults[0]).toHaveProperty('hostname')
      const { logger, lines } = memoryPino({ base: { service: 'api', environment: 'prod' } })
      logger.info('m')
      expect(lines[0]).toEqual({
        level: 30,
        time: expect.any(Number),
        service: 'api',
        environment: 'prod',
        msg: 'm',
      })
    })
  })

  describe('the Workers destination recipe', () => {
    it('a destination marked with pino.metadata gets each line’s level, to pick the console method', () => {
      const consoleDestination = {
        [Symbol.for('pino.metadata')]: true,
        lastLevel: 0,
        write(line: string) {
          if (this.lastLevel >= 50) console.error(line)
          else if (this.lastLevel >= 40) console.warn(line)
          else if (this.lastLevel >= 30) console.info(line)
          else console.debug(line)
        },
      }
      const spies = (['debug', 'info', 'warn', 'error'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => {}),
      )
      try {
        const logger = pino({ level: 'trace', base: {} }, consoleDestination)
        for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
          logger[level](level)
        }
        const messages = spies.map((spy) =>
          spy.mock.calls.map(([line]) => JSON.parse(line as string).msg),
        )
        expect(messages).toEqual([['trace', 'debug'], ['info'], ['warn'], ['error', 'fatal']])
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    })
  })

  describe('Workers helpers', () => {
    it('useLogger registers pino as the Default Logger', () => {
      const { logger, lines } = memoryPino()
      useLogger(logger)
      expect(_getDefaultLogger()).toBe(logger)
      getLogger().info('module scope')
      expect(lines[0]).toEqual({ level: 30, time: expect.any(Number), msg: 'module scope' })
    })

    it("withScheduled's logger option writes the run through pino, and makes it the Default Logger", async () => {
      const { logger, lines } = memoryPino()
      await withScheduled(() => getLogger().info('nightly'), { logger })(
        { cron: '0 3 * * *', scheduledTime: 1, noRetry: vi.fn() },
        ENV,
        CTX,
      )
      expect(linesOf(lines, 'nightly')[0]).toMatchObject({
        cron: '0 3 * * *',
        traceId: expect.stringMatching(HEX32),
      })
      expect(linesOf(lines, 'span.end scheduled')).toHaveLength(1)
      expect(_getDefaultLogger()).toBe(logger)
      expect(entries).toEqual([])
    })

    it("withScheduled's logger option takes a function of env, called once per env", async () => {
      const { logger, lines } = memoryPino()
      const make = vi.fn((env: typeof ENV) => logger.child({ service: env.NAME }))
      const handler = withScheduled(() => getLogger().info('run'), { logger: make })
      const controller = { cron: '* * * * *', scheduledTime: 1, noRetry: vi.fn() }
      await handler(controller, ENV, CTX)
      await handler(controller, ENV, CTX)
      expect(make).toHaveBeenCalledTimes(1)
      expect(linesOf(lines, 'run')).toHaveLength(2)
      expect(linesOf(lines, 'run')[0]).toMatchObject({ service: 'jobs' })
    })

    it("withQueueMessage continues the producer's trace through pino", async () => {
      const { logger, lines } = memoryPino()
      const message = { id: 'm-1', attempts: 1, body: { trace: { traceparent: SAMPLED } } }
      await withQueueMessage({ queue: 'orders' }, message, () => getLogger().info('msg'), {
        logger,
      })
      expect(linesOf(lines, 'msg')[0]).toMatchObject({
        queue: 'orders',
        messageId: 'm-1',
        traceId: TRACE_ID,
        parentSpanId: PARENT_SPAN_ID,
      })
    })

    it("withLogging writes a method's failure line through pino, at error, with err", () => {
      const { logger, lines } = memoryPino()
      class Search extends WorkerEntrypoint<typeof ENV> {
        fail(): never {
          throw new Error('nope')
        }
      }
      const Logged = withLogging(Search, { logger })
      expect(() => new Logged(CTX, ENV).fail()).toThrow('nope')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        level: 50,
        msg: 'Search.fail failed',
        err: { message: 'nope' },
        traceId: expect.stringMatching(HEX32),
      })
    })

    it("tracedWorker's logger option writes each Traced Session's lines through pino", () => {
      const { logger, lines } = memoryPino()
      class Session extends TracedSession<typeof ENV> {
        add(a: number, b: number) {
          return this.traced(() => {
            this.logger.info({ a, b }, 'adding')
            return a + b
          }, 'bind.add')
        }
      }
      const Worker = tracedWorker(Session, { logger })
      expect(new Worker(CTX, ENV).session({ traceparent: SAMPLED }).add(1, 2)).toBe(3)
      expect(linesOf(lines, 'adding')[0]).toMatchObject({ a: 1, b: 2, traceId: TRACE_ID })
      expect(linesOf(lines, 'span.end bind.add')).toHaveLength(1)
    })

    it('a TracedEntrypoint subclass supplies pino through its Root Logger hook', () => {
      const { logger, lines } = memoryPino()
      class Session extends TracedSession<typeof ENV> {
        ping() {
          return this.traced(() => getLogger().info('pong'), 'bind.ping')
        }
      }
      class Api extends TracedEntrypoint<typeof ENV> {
        protected override get [TracedEntrypoint.rootLogger](): Logger {
          return logger
        }
        session(init: SessionInit) {
          return new Session(init, this[TracedEntrypoint.rootLogger], this.env)
        }
      }
      new Api(CTX, ENV).session({ traceparent: SAMPLED }).ping()
      expect(linesOf(lines, 'pong')[0]).toMatchObject({ traceId: TRACE_ID })
      expect(linesOf(lines, 'span.end bind.ping')).toHaveLength(1)
      expect(_getDefaultLogger()).toBe(logger)
    })
  })
})
