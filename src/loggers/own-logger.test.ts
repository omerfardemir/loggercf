// Your own Root Logger: the `logger` option of the Workers helpers, and loggercf's own
// lines (Request Lines, span.end, failure lines) written through a hand-written Logger.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The `env` that `import { env } from 'cloudflare:workers'` returns; tests set its vars.
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

import { WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers'
import { Hono } from 'hono'
import {
  TracedEntrypoint,
  TracedSession,
  tracedWorker,
  withLogging,
  withQueueMessage,
  withScheduled,
  withWorkflow,
} from '../workers'
import { useLogger } from '../hono/middleware'
import { redactKeys } from '../output/redact'
import {
  _captureEntries,
  _getDefaultLogger,
  _reset,
  getLogger,
  getTraceContext,
  withSpan,
} from '../core/logger'
import { recordingLogger, type RecordedCall } from '../testing/helpers'
import type { Logger } from '../core/types'

const ENV = { NAME: 'jobs', ENVIRONMENT: 'staging' }
const CTX = {} as ExecutionContext

/** The calls whose message (the first string argument) starts with `prefix`. */
const callsOf = (calls: RecordedCall[], prefix: string) =>
  calls.filter((c) => {
    const message = c.args.find((a) => typeof a === 'string')
    return typeof message === 'string' && message.startsWith(prefix)
  })

const controller = () => ({ cron: '* * * * *', scheduledTime: 1, noRetry: vi.fn() })

describe('your own Root Logger', () => {
  let entries: Record<string, unknown>[]
  beforeEach(() => {
    _reset()
    entries = _captureEntries()
    for (const key of Object.keys(workersEnv)) delete workersEnv[key]
    Object.assign(workersEnv, ENV)
  })

  describe('useLogger', () => {
    it('writes the Request Lines through it, with nothing written by loggercf itself', async () => {
      const { logger, calls } = recordingLogger()
      const app = new Hono()
      app.use(useLogger(logger))
      app.get('/users/:id', (c) => {
        getLogger().info({ id: c.req.param('id') }, 'handler')
        return c.text('ok')
      })
      await app.request('/users/1')

      expect(callsOf(calls, 'handler')).toHaveLength(1)
      const end = callsOf(calls, 'request.end')
      expect(end).toHaveLength(1)
      expect(end[0]!.level).toBe('info')
      expect(end[0]!.args[0]).toMatchObject({ statusCode: 200, route: '/users/:id' })
      expect(entries).toEqual([])
    })
  })

  describe('withScheduled', () => {
    it('opens the Logging Context over it: your lines and the scheduled Span go through it', async () => {
      const { logger, calls } = recordingLogger()
      await withScheduled(
        () => {
          getLogger().info('nightly')
        },
        { logger },
      )(controller(), ENV, CTX)

      expect(callsOf(calls, 'nightly')).toHaveLength(1)
      expect(callsOf(calls, 'span.end')).toHaveLength(1)
      expect(entries).toEqual([])
    })

    it('registers it as the Default Logger', async () => {
      const { logger, calls } = recordingLogger()
      await withScheduled(() => {}, { logger })(controller(), ENV, CTX)
      getLogger().info('outside')
      expect(callsOf(calls, 'outside')).toHaveLength(1)
    })

    it('takes a function of env, called once per env', async () => {
      const { logger, calls } = recordingLogger()
      const make = vi.fn((_env: typeof ENV) => logger)
      const handler = withScheduled(() => getLogger().info('run'), { logger: make })
      await handler(controller(), ENV, CTX)
      await handler(controller(), ENV, CTX)

      expect(make).toHaveBeenCalledTimes(1)
      expect(make).toHaveBeenCalledWith(ENV)
      expect(callsOf(calls, 'run')).toHaveLength(2)
    })

    it('throws when it is given with env, serializeError or redact', () => {
      const { logger } = recordingLogger()
      for (const extra of [
        { env: { service: 'NAME' } },
        { serializeError: (e: Error) => ({ message: e.message }) },
        { redact: redactKeys(['token']) },
      ]) {
        expect(() => withScheduled(() => {}, { logger, ...extra } as never)).toThrow(TypeError)
      }
    })

    it('accepts redact: false with it, which is no redactor', () => {
      const { logger } = recordingLogger()
      expect(() => withScheduled(() => {}, { logger, redact: false })).not.toThrow()
    })

    it('throws for something that is not a Logger, naming what is missing', () => {
      const consolaLike = { info: () => {}, warn: () => {}, error: () => {} }
      expect(() => withScheduled(() => {}, { logger: consolaLike as never })).toThrow(
        /logger must be a Logger/,
      )
    })

    it('throws when a function of env returns something that is not a Logger', () => {
      const handler = withScheduled(() => {}, { logger: () => ({}) as Logger })
      expect(() => handler(controller(), ENV, CTX)).toThrow(
        /^withScheduled\(\): logger must be a Logger/,
      )
    })
  })

  describe('withQueueMessage', () => {
    it('opens the Logging Context over it', async () => {
      const { logger, calls } = recordingLogger()
      const message = { id: 'm-1', attempts: 1, body: {} }
      await withQueueMessage({ queue: 'orders' }, message, () => getLogger().info('msg'), {
        logger,
      })
      expect(callsOf(calls, 'msg')).toHaveLength(1)
      expect(entries).toEqual([])
    })
  })

  describe('withWorkflow', () => {
    it('opens the Logging Context over it', async () => {
      const { logger, calls } = recordingLogger()
      class Report extends WorkflowEntrypoint<typeof ENV> {
        async run(_event: unknown, _step: unknown) {
          getLogger().info('running')
        }
      }
      const Logged = withWorkflow(Report, { logger })
      await new Logged(CTX, ENV).run(
        { payload: {}, timestamp: new Date(0), instanceId: 'i-1' } as never,
        {} as never,
      )
      expect(callsOf(calls, 'running')).toHaveLength(1)
      expect(entries).toEqual([])
    })
  })

  describe('withLogging', () => {
    class Search extends WorkerEntrypoint<typeof ENV> {
      find() {
        getLogger().info('finding')
        return getTraceContext()
      }
      fail(): never {
        throw new Error('nope')
      }
    }

    it('opens each call’s Logging Context over it, failure lines included', () => {
      const { logger, calls } = recordingLogger()
      const Logged = withLogging(Search, { logger })
      const instance = new Logged(CTX, ENV)
      expect(instance.find()).not.toBeNull()
      expect(() => instance.fail()).toThrow('nope')

      expect(callsOf(calls, 'finding')).toHaveLength(1)
      const failed = callsOf(calls, 'Search.fail failed')
      expect(failed).toHaveLength(0) // the message is a printf template: '%s failed'
      const errors = calls.filter((c) => c.level === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0]!.args.slice(1)).toEqual(['%s failed', 'Search.fail'])
      expect(entries).toEqual([])
    })

    it('the same logger is the same options; another logger is not', () => {
      const { logger } = recordingLogger()
      class Other extends WorkerEntrypoint<typeof ENV> {}
      const Logged = withLogging(Other, { logger })
      expect(withLogging(Logged, { logger })).toBe(Logged)
      expect(() => withLogging(Logged, { logger: recordingLogger().logger })).toThrow(
        /already wrapped with other options/,
      )
    })

    it('throws for a TracedEntrypoint, whose Root Logger hook supplies its logger', () => {
      class Traced extends TracedEntrypoint<typeof ENV> {}
      expect(() => withLogging(Traced, { logger: recordingLogger().logger })).toThrow(
        /override its \[TracedEntrypoint.rootLogger\] getter instead of passing logger/,
      )
    })
  })

  describe('tracedWorker', () => {
    it("opens each Traced Session's Logging Context over it", () => {
      const { logger, calls } = recordingLogger()
      class Session extends TracedSession<typeof ENV> {
        add(a: number, b: number) {
          return this.traced(() => {
            getLogger().info('adding')
            return withSpan('inner', () => a + b)
          }, 'bind.add')
        }
      }
      const Worker = tracedWorker(Session, { logger })
      const instance = new Worker(CTX, ENV)
      expect(instance.session({}).add(1, 2)).toBe(3)

      expect(callsOf(calls, 'adding')).toHaveLength(1)
      expect(callsOf(calls, 'span.end')).toHaveLength(2)
      expect(_getDefaultLogger()).toBe(logger)
      expect(entries).toEqual([])
    })

    it('throws when it is given with env', () => {
      class Session extends TracedSession<typeof ENV> {}
      expect(() =>
        tracedWorker(Session, { logger: recordingLogger().logger, env: { service: 'NAME' } }),
      ).toThrow(TypeError)
    })
  })
})
