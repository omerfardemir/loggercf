// `loggercf/winston` with a real winston logger: fromWinston(), the contextFields() format
// and contextMeta(), and loggercf's own lines written through winston.
import { describe, it, expect, vi, beforeEach, expectTypeOf } from 'vitest'
import { Writable } from 'node:stream'
import winston from 'winston'

// The `env` that `import { env } from 'cloudflare:workers'` returns.
const workersEnv = vi.hoisted((): Record<string, unknown> => ({}))

// cloudflare:workers is not available in Node/vitest.
vi.mock('cloudflare:workers', () => ({
  env: workersEnv,
  RpcTarget: class RpcTarget {},
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown
    constructor(_ctx?: unknown, env?: unknown) {
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

import { WorkerEntrypoint } from 'cloudflare:workers'
import { Hono } from 'hono'
import {
  contextFields,
  contextMeta,
  fromWinston,
  type WinstonFormat,
  type WinstonInfo,
  type WinstonLike,
} from './winston'
import {
  _captureEntries,
  _reset,
  getLogger,
  runWithLogger,
  setLoggerContext,
  withSpan,
} from './logger'
import { useLogger } from './middleware'
import { withLogging, withScheduled } from './workers'
import type { Logger } from './types'

type Line = Record<string, unknown>

/** The base class of winston's transports: `winston.Transport` at runtime, `winston.transport` in its types. */
const Transport = (winston as unknown as { Transport: new () => winston.transport }).Transport

/**
 * A winston logger writing to memory through a Stream transport, as JSON, with the
 * `contextFields()` format. `options` replace the defaults.
 */
function memoryWinston(options: winston.LoggerOptions = {}) {
  const out: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      out.push(String(chunk))
      done()
    },
  })
  const w = winston.createLogger({
    level: 'silly',
    format: winston.format.combine(contextFields(), winston.format.json()),
    transports: [new winston.transports.Stream({ stream })],
    ...options,
  })
  return { w, lines: (): Line[] => out.map((line) => JSON.parse(line) as Line) }
}

/**
 * A transport that finishes each write a tick later, as a file or HTTP transport
 * does: behind it, winston buffers a burst of lines and formats them later.
 */
function slowTransport() {
  const infos: WinstonInfo[] = []
  class Slow extends Transport {
    override log(info: WinstonInfo, next: () => void) {
      infos.push(info)
      setTimeout(next, 0)
    }
  }
  return { transport: new Slow(), infos }
}

/** Wait for every timer queued so far (and the writes they release) to run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const ENV = { NAME: 'jobs' }
const CTX = {} as ExecutionContext
const controller = () => ({ cron: '* * * * *', scheduledTime: 1, noRetry: vi.fn() })

describe('loggercf/winston', () => {
  beforeEach(() => {
    _reset()
    _captureEntries()
    for (const key of Object.keys(workersEnv)) delete workersEnv[key]
    Object.assign(workersEnv, ENV)
  })

  describe('types', () => {
    it('fromWinston takes a winston logger as it is and is a Logger', () => {
      const { w } = memoryWinston()
      expectTypeOf(w).toExtend<WinstonLike>()
      expectTypeOf(fromWinston(w)).toEqualTypeOf<Logger>()
      expectTypeOf(fromWinston(w.child({ module: 'db' }))).toEqualTypeOf<Logger>()
    })

    it('contextFields() is a winston Format, and contextMeta() a defaultMeta', () => {
      expectTypeOf(contextFields()).toExtend<winston.Logform.Format>()
      expectTypeOf(winston.format.combine).toBeCallableWith(contextFields(), winston.format.json())
      expectTypeOf(contextMeta()).toExtend<winston.LoggerOptions['defaultMeta']>()
    })
  })

  describe('fromWinston', () => {
    describe('levels', () => {
      it("maps loggercf's levels onto npm levels: trace is silly, fatal is error", () => {
        const { w, lines } = memoryWinston()
        const logger = fromWinston(w)
        for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
          logger[level](level)
        }
        expect(lines().map((l) => [l.message, l.level])).toEqual([
          ['trace', 'silly'],
          ['debug', 'debug'],
          ['info', 'info'],
          ['warn', 'warn'],
          ['error', 'error'],
          ['fatal', 'error'],
        ])
      })

      it("uses the winston logger's own trace and fatal when its levels have them", () => {
        const levels = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 }
        const { w, lines } = memoryWinston({ levels, level: 'trace' })
        const logger = fromWinston(w)
        logger.trace('t')
        logger.fatal('f')
        expect(lines().map((l) => l.level)).toEqual(['trace', 'fatal'])
      })

      it('maps onto syslog levels: warn is warning, fatal is crit, trace is debug', () => {
        const { w, lines } = memoryWinston({ levels: winston.config.syslog.levels, level: 'debug' })
        const logger = fromWinston(w)
        logger.trace('t')
        logger.warn('w')
        logger.fatal('f')
        expect(lines().map((l) => l.level)).toEqual(['debug', 'warning', 'crit'])
      })

      it('takes your own mapping for any level', () => {
        const { w, lines } = memoryWinston()
        const logger = fromWinston(w, { levels: { trace: 'verbose', info: 'http' } })
        logger.trace('t')
        logger.info('i')
        logger.debug('d')
        expect(lines().map((l) => l.level)).toEqual(['verbose', 'http', 'debug'])
      })

      it('throws a TypeError when a level has no winston level, naming it', () => {
        const { w } = memoryWinston({ levels: { loud: 0, quiet: 1 }, level: 'quiet' })
        expect(() => fromWinston(w)).toThrow(TypeError)
        expect(() => fromWinston(w)).toThrow(/'trace'/)
        expect(() => fromWinston(w, { levels: { trace: 'quiet', debug: 'quiet' } })).toThrow(
          /'info'/,
        )
      })

      it("throws a TypeError when your mapping names a level the logger doesn't have", () => {
        const { w } = memoryWinston()
        expect(() => fromWinston(w, { levels: { trace: 'nope' } })).toThrow(
          /levels.trace: 'nope' is not one of the winston logger's levels/,
        )
      })

      it("leaves filtering to winston: a line below the logger's level is not written", () => {
        const { w, lines } = memoryWinston({ level: 'info' })
        const logger = fromWinston(w)
        logger.debug('hidden')
        logger.trace('hidden')
        logger.info('shown')
        expect(lines().map((l) => l.message)).toEqual(['shown'])
      })

      it("doesn't build a line winston would not write: its Errors are not serialized", () => {
        const { w } = memoryWinston({ level: 'info' })
        const writeError = vi.fn((err: Error) => err.message)
        fromWinston(w, { writeError }).debug(new Error('hidden'))
        expect(writeError).not.toHaveBeenCalled()
      })
    })

    describe('calls', () => {
      it('writes a structured call: fields, then a printf message', () => {
        const { w, lines } = memoryWinston()
        fromWinston(w).info({ userId: 42 }, 'user %s signed in', 'ada')
        expect(lines()).toEqual([{ level: 'info', message: 'user ada signed in', userId: 42 }])
      })

      it('writes a console-style call: the message, then fields', () => {
        const { w, lines } = memoryWinston()
        fromWinston(w).warn('slow', { ms: 900 })
        expect(lines()).toEqual([{ level: 'warn', message: 'slow', ms: 900 }])
      })

      it('writes an empty message when the call gives none, as winston does', () => {
        const { w, lines } = memoryWinston()
        fromWinston(w).info({ a: 1 })
        expect(lines()).toEqual([{ level: 'info', message: '', a: 1 }])
      })

      it('writes the values with no better place under args, as loggercf does', () => {
        const { w, lines } = memoryWinston()
        fromWinston(w).info('batch', [1, 2])
        expect(lines()).toEqual([{ level: 'info', message: 'batch', args: [[1, 2]] }])
      })

      it("keeps a % in the formatted message from winston's splat format", () => {
        const { w, lines } = memoryWinston({
          format: winston.format.combine(winston.format.splat(), winston.format.json()),
        })
        const logger = fromWinston(w)
        logger.info('%s', 'progress %d%%')
        logger.info({ splat: ['x'] }, 'rate %s', '50%s')
        expect(lines()).toEqual([
          { level: 'info', message: 'progress %d%%' },
          { level: 'info', message: 'rate 50%s', splat: ['x'] },
        ])
      })

      it("puts winston's defaultMeta under the line's fields", () => {
        const { w, lines } = memoryWinston({ defaultMeta: { service: 'api', region: 'eu' } })
        fromWinston(w).info({ region: 'us' }, 'm')
        expect(lines()).toEqual([{ level: 'info', message: 'm', service: 'api', region: 'us' }])
      })
    })

    describe('errors', () => {
      it("writes an Error first as err, with type, message and stack, and its message as the line's", () => {
        const { w, lines } = memoryWinston()
        fromWinston(w).error(new TypeError('boom'))
        const [line] = lines()
        expect(line).toMatchObject({
          level: 'error',
          message: 'boom',
          err: { type: 'TypeError', message: 'boom', stack: expect.stringContaining('boom') },
        })
      })

      it('writes the Errors after the first under errors, each with its cause', () => {
        const { w, lines } = memoryWinston()
        const second = new Error('two', { cause: new RangeError('root') })
        fromWinston(w).error('failed', new Error('one'), second)
        expect(lines()[0]).toMatchObject({
          message: 'failed',
          err: { type: 'Error', message: 'one' },
          errors: [
            { type: 'Error', message: 'two', cause: { type: 'RangeError', message: 'root' } },
          ],
        })
      })

      it("writes an Error inside a field's objects and arrays, leaving your objects unchanged", () => {
        const { w, lines } = memoryWinston()
        const result = { ok: false, failures: [new Error('a')], detail: { err: new Error('b') } }
        fromWinston(w).warn({ result }, 'partial')
        expect(lines()[0]).toMatchObject({
          result: {
            ok: false,
            failures: [{ type: 'Error', message: 'a' }],
            detail: { err: { type: 'Error', message: 'b' } },
          },
        })
        expect(result.failures[0]).toBeInstanceOf(Error)
      })

      it('writes an object that holds itself as [Circular] there', () => {
        const { w, lines } = memoryWinston()
        const loop: Record<string, unknown> = { err: new Error('x') }
        loop.self = loop
        fromWinston(w).info({ loop }, 'm')
        expect(lines()[0]).toMatchObject({
          loop: { err: { message: 'x' }, self: '[Circular]' },
        })
      })

      it('writes each Error with your writeError, given the default shape too', () => {
        const { w, lines } = memoryWinston()
        const logger = fromWinston(w, {
          writeError: (err, defaultSerialize) => {
            const { stack: _stack, ...rest } = defaultSerialize(err)
            return { ...rest, code: 'E1' }
          },
        })
        logger.error(new Error('boom'))
        expect(lines()[0]!.err).toEqual({ type: 'Error', message: 'boom', code: 'E1' })
      })

      it('hands winston the Error itself when your writeError returns it', () => {
        const infos: WinstonInfo[] = []
        const err = new Error('raw')
        const target: WinstonLike = { write: (info) => void infos.push(info) }
        fromWinston(target, { writeError: (e) => e }).error(err)
        expect(infos[0]!.err).toBe(err)
      })

      it('writes the default shape with serializeErrorFailed when your writeError throws', () => {
        const { w, lines } = memoryWinston()
        const logger = fromWinston(w, {
          writeError: () => {
            throw new RangeError('bad serializer')
          },
        })
        logger.error(new Error('boom'))
        expect(lines()[0]!.err).toMatchObject({
          type: 'Error',
          message: 'boom',
          serializeErrorFailed: 'RangeError: bad serializer',
        })
      })
    })

    describe('child', () => {
      it('writes the bindings on each line, the nearest winning, the call fields over them', () => {
        const { w, lines } = memoryWinston()
        const child = fromWinston(w).child({ module: 'db', a: 1 }).child({ a: 2, b: 1 })
        child.info({ b: 2 }, 'query')
        expect(lines()).toEqual([{ level: 'info', message: 'query', module: 'db', a: 2, b: 2 }])
      })

      it('leaves the parent unchanged', () => {
        const { w, lines } = memoryWinston()
        const parent = fromWinston(w)
        parent.child({ module: 'db' })
        parent.info('m')
        expect(lines()).toEqual([{ level: 'info', message: 'm' }])
      })

      it("writes a winston child's metadata, when you adapt a child", () => {
        const { w, lines } = memoryWinston()
        fromWinston(w.child({ module: 'db' })).info('m')
        expect(lines()).toEqual([{ level: 'info', message: 'm', module: 'db' }])
      })

      it('moves a binding named level or message to args, so it changes nothing', () => {
        const { w, lines } = memoryWinston()
        fromWinston(w).child({ level: 'fatal', message: 'x' }).info('m')
        expect(lines()).toEqual([
          { level: 'info', message: 'm', args: [{ level: 'fatal', message: 'x' }] },
        ])
      })
    })

    describe('Context Fields', () => {
      it('writes the Context Fields and trace IDs on its lines, without the format', () => {
        const { w, lines } = memoryWinston({ format: winston.format.json() })
        const logger = fromWinston(w)
        runWithLogger({ logger, fields: { requestId: 'r-1' } }, () => {
          setLoggerContext({ userId: 7 })
          getLogger().info({ a: 1 }, 'inside')
        })
        expect(lines()[0]).toEqual({
          level: 'info',
          message: 'inside',
          requestId: 'r-1',
          userId: 7,
          a: 1,
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
          spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        })
      })

      it('puts the call fields, the bindings and defaultMeta over the Context Fields, and the trace IDs over all', () => {
        const { w, lines } = memoryWinston({ defaultMeta: { fromMeta: 'meta', shared: 'meta' } })
        const logger = fromWinston(w)
        runWithLogger(
          {
            logger,
            traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
            fields: { fromMeta: 'ctx', fromBinding: 'ctx', fromCall: 'ctx', shared: 'ctx' },
          },
          () => {
            getLogger()
              .child({ fromBinding: 'binding', shared: 'binding', traceId: 'binding' })
              .info({ fromCall: 'call', shared: 'call' }, 'm')
          },
        )
        expect(lines()[0]).toMatchObject({
          fromMeta: 'meta',
          fromBinding: 'binding',
          fromCall: 'call',
          shared: 'call',
          traceId: '0af7651916cd43dd8448eb211c80319c',
          parentSpanId: 'b7ad6b7169203331',
        })
      })

      it('writes no parentSpanId on a root trace, whatever the bindings say', () => {
        const { w, lines } = memoryWinston()
        const logger = fromWinston(w)
        runWithLogger({ logger }, () => getLogger().child({ parentSpanId: 'binding' }).info('m'))
        expect(lines()[0]).not.toHaveProperty('parentSpanId')
        expect(lines()[0]!.traceId).toMatch(/^[0-9a-f]{32}$/)
      })

      it('moves a Context Field named level or message to args', () => {
        const { w, lines } = memoryWinston()
        const logger = fromWinston(w)
        runWithLogger({ logger, fields: { level: 'fatal' } }, () => getLogger().info('m'))
        expect(lines()[0]).toMatchObject({
          level: 'info',
          message: 'm',
          args: [{ level: 'fatal' }],
        })
      })
    })

    describe('a log call never throws', () => {
      it('when a format throws, and the next line is still written', () => {
        let broken = true
        const flaky = winston.format((info) => {
          if (broken) throw new Error('format broke')
          return info
        })
        const { w, lines } = memoryWinston({
          format: winston.format.combine(flaky(), winston.format.json()),
        })
        const logger = fromWinston(w)
        expect(() => logger.info('lost')).not.toThrow()
        broken = false
        logger.info('kept')
        expect(lines().map((l) => l.message)).toEqual(['kept'])
      })

      it('when a transport throws', () => {
        class Broken extends Transport {
          override log(): void {
            throw new Error('transport broke')
          }
        }
        const w = winston.createLogger({ transports: [new Broken()] })
        w.on('error', () => {})
        expect(() => fromWinston(w).error(new Error('boom'))).not.toThrow()
      })
    })
  })

  describe('contextFields()', () => {
    it("adds the Context Fields and trace IDs to winston's own calls inside a Logging Context", () => {
      const { w, lines } = memoryWinston()
      runWithLogger({ logger: fromWinston(w), fields: { requestId: 'r-1' } }, () => {
        w.info('direct', { a: 1 })
      })
      expect(lines()[0]).toEqual({
        level: 'info',
        message: 'direct',
        a: 1,
        requestId: 'r-1',
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
      })
    })

    it('adds nothing outside a Logging Context', () => {
      const { w, lines } = memoryWinston()
      w.info('outside', { a: 1 })
      expect(lines()).toEqual([{ level: 'info', message: 'outside', a: 1 }])
    })

    it("adds the Span's own spanId inside a Span, with the outer one as parentSpanId", () => {
      const { w, lines } = memoryWinston()
      let outer = ''
      runWithLogger({ logger: fromWinston(w) }, () => {
        w.info('before')
        withSpan('db.query', () => w.info('in span'))
      })
      const [before, inSpan] = lines()
      outer = before!.spanId as string
      expect(inSpan).toMatchObject({ traceId: before!.traceId, parentSpanId: outer })
      expect(inSpan!.spanId).not.toBe(outer)
    })

    it("keeps the line's own value for a key it already has", () => {
      const { w, lines } = memoryWinston()
      runWithLogger({ logger: fromWinston(w), fields: { requestId: 'r-1', userId: 7 } }, () => {
        w.info('direct', { userId: 8 })
      })
      expect(lines()[0]).toMatchObject({ requestId: 'r-1', userId: 8 })
    })

    it('composes with the other formats in format.combine', () => {
      const { w, lines } = memoryWinston({
        format: winston.format.combine(
          winston.format.timestamp(),
          contextFields(),
          winston.format.label({ label: 'api' }),
          winston.format.json(),
        ),
      })
      runWithLogger({ logger: fromWinston(w), fields: { requestId: 'r-1' } }, () => w.info('m'))
      expect(lines()[0]).toMatchObject({
        message: 'm',
        label: 'api',
        requestId: 'r-1',
        timestamp: expect.any(String),
      })
    })

    it('adds nothing to a line fromWinston wrote, even when winston formats it later, elsewhere', async () => {
      const { transport, infos } = slowTransport()
      const w = winston.createLogger({
        format: winston.format.combine(contextFields(), winston.format.json()),
        transports: [transport],
      })
      const logger = fromWinston(w)
      runWithLogger({ logger, fields: { requestId: 'r-1' } }, () => getLogger().info('first'))
      for (let i = 0; i < 40; i++) logger.info({ i }, 'outside')
      await settle()

      expect(infos).toHaveLength(41)
      expect(infos.slice(1).filter((info) => 'requestId' in info)).toEqual([])
    })
  })

  describe('contextMeta()', () => {
    it("adds the Context Fields and trace IDs to winston's own calls, at the call", () => {
      const { w, lines } = memoryWinston({
        defaultMeta: contextMeta(),
        format: winston.format.json(),
      })
      runWithLogger({ logger: fromWinston(w), fields: { requestId: 'r-1' } }, () => {
        w.info('direct', { a: 1 })
      })
      w.info('outside')
      expect(lines()).toEqual([
        {
          level: 'info',
          message: 'direct',
          requestId: 'r-1',
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
          spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
          a: 1,
        },
        { level: 'info', message: 'outside' },
      ])
    })

    it('writes each line with its own Logging Context, even behind a slow transport', async () => {
      const { transport, infos } = slowTransport()
      const w = winston.createLogger({ defaultMeta: contextMeta(), transports: [transport] })
      const logger = fromWinston(w)
      for (let i = 0; i < 40; i++) {
        runWithLogger({ logger, fields: { requestId: `r-${i}` } }, () => w.info('line', { i }))
      }
      await settle()

      expect(infos).toHaveLength(40)
      expect(infos.filter((info) => info.requestId !== `r-${String(info.i)}`)).toEqual([])
    })

    it('keeps its own fields, over the Context Fields, with the trace IDs over both', () => {
      const { w, lines } = memoryWinston({
        defaultMeta: contextMeta({ service: 'api', region: 'eu', traceId: 'fixed' }),
        format: winston.format.json(),
      })
      runWithLogger({ logger: fromWinston(w), fields: { region: 'ctx', requestId: 'r-1' } }, () =>
        w.info('m'),
      )
      w.info('outside')
      const [inside, outside] = lines()
      expect(inside).toMatchObject({ service: 'api', region: 'eu', requestId: 'r-1' })
      expect(inside!.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(outside).toEqual({
        level: 'info',
        message: 'outside',
        service: 'api',
        region: 'eu',
        traceId: 'fixed',
      })
    })

    it('reads its own fields once, when it is made', () => {
      const base = { service: 'api' }
      const meta = contextMeta(base)
      base.service = 'changed'
      expect({ ...meta }).toEqual({ service: 'api' })
    })
  })

  describe("loggercf's own lines through winston", () => {
    it('writes the Request Lines of useLogger(fromWinston(w))', async () => {
      const { w, lines } = memoryWinston()
      const app = new Hono()
      app.use(useLogger(fromWinston(w)))
      app.get('/users/:id', (c) => {
        getLogger().info({ id: c.req.param('id') }, 'handler')
        return c.text('ok')
      })
      await app.request('/users/1', { headers: { 'x-request-id': 'req-1' } })

      const [start, handler, end] = lines()
      expect(start).toMatchObject({ level: 'info', message: 'request.start GET /users/1' })
      expect(handler).toMatchObject({
        level: 'info',
        message: 'handler',
        id: '1',
        requestId: 'req-1',
      })
      expect(end).toMatchObject({
        level: 'info',
        message: 'request.end GET /users/1',
        statusCode: 200,
        route: '/users/:id',
        requestId: 'req-1',
        traceId: handler!.traceId,
      })
    })

    it("writes a Span's span.end, with its message's placeholder filled", () => {
      const { w, lines } = memoryWinston()
      runWithLogger({ logger: fromWinston(w) }, () => {
        withSpan('db.query', () => 1, { fields: { table: 'users' } })
      })
      expect(lines()[0]).toMatchObject({
        level: 'info',
        message: 'span.end db.query',
        span: { operation: 'db.query', status: 'OK' },
        table: 'users',
      })
    })

    it("writes a failed Span's span.end at error, with err's type, message and stack", () => {
      const { w, lines } = memoryWinston()
      runWithLogger({ logger: fromWinston(w) }, () => {
        expect(() =>
          withSpan('db.query', () => {
            throw new TypeError('down')
          }),
        ).toThrow('down')
      })
      expect(lines()[0]).toMatchObject({
        level: 'error',
        message: 'span.end db.query',
        err: { type: 'TypeError', message: 'down', stack: expect.stringContaining('down') },
      })
    })

    it("writes withLogging's failure line, its '%s failed' filled, with err", () => {
      const { w, lines } = memoryWinston()
      class Search extends WorkerEntrypoint<typeof ENV> {
        fail(): never {
          throw new Error('nope')
        }
      }
      const Logged = withLogging(Search, { logger: fromWinston(w) })
      expect(() => new Logged(CTX, ENV).fail()).toThrow('nope')
      const failed = lines().filter((l) => l.level === 'error')
      expect(failed).toEqual([
        expect.objectContaining({
          message: 'Search.fail failed',
          err: expect.objectContaining({ type: 'Error', message: 'nope' }),
          traceId: expect.any(String),
        }),
      ])
    })

    it("writes a Workers helper's lines when it is the helper's logger option", async () => {
      const { w, lines } = memoryWinston()
      await withScheduled(() => getLogger().info('nightly'), { logger: fromWinston(w) })(
        controller(),
        ENV,
        CTX,
      )
      expect(lines().map((l) => l.message)).toEqual(['nightly', 'span.end scheduled'])
      expect(lines()[0]!.traceId).toBe(lines()[1]!.traceId)
    })

    it('becomes the Default Logger, so getLogger() outside every Logging Context writes through winston', async () => {
      const { w, lines } = memoryWinston()
      await withScheduled(() => {}, { logger: fromWinston(w) })(controller(), ENV, CTX)
      getLogger().info('outside')
      expect(lines().at(-1)).toEqual({ level: 'info', message: 'outside' })
    })

    it("takes a function of env as the helper's logger option", async () => {
      const { w, lines } = memoryWinston()
      const make = vi.fn((env: typeof ENV) => fromWinston(w.child({ service: env.NAME })))
      await withScheduled(() => getLogger().info('run'), { logger: make })(controller(), ENV, CTX)
      expect(make).toHaveBeenCalledWith(ENV)
      expect(lines()[0]).toMatchObject({ message: 'run', service: 'jobs' })
    })

    it('a raw winston logger is not a Logger: the helpers throw for it', () => {
      const { w } = memoryWinston()
      expect(() => withScheduled(() => {}, { logger: w as unknown as Logger })).toThrow(
        /logger must be a Logger/,
      )
    })
  })

  it('fromWinston works over any object with write, levels being npm when it has none', () => {
    const infos: WinstonInfo[] = []
    const logger = fromWinston({ write: (info) => void infos.push(info) })
    logger.fatal('f')
    logger.trace('t')
    expect(infos.map((i) => [i.level, i.message])).toEqual([
      ['error', 'f'],
      ['silly', 't'],
    ])
  })

  it('a format is just a transform', () => {
    const format: WinstonFormat = contextFields()
    const info: WinstonInfo = { level: 'info', message: 'm' }
    expect(format.transform(info)).toBe(info)
  })
})
