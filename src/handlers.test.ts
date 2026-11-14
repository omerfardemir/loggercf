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

import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowStep } from 'cloudflare:workers'
import { withQueueMessage, withScheduled, withWorkflow, tracedStep } from './workers'
import { omitErrorKeys } from './omit'
import {
  _captureEntries,
  _getDefaultLogger,
  _reset,
  createLogger,
  getLogger,
  getTraceCarrier,
  getTraceContext,
  runWithLogger,
  setDefaultLogger,
} from './logger'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Runs a function in the async context of module scope: outside every Logging Context. */
const outsideEveryContext = AsyncLocalStorage.snapshot()

const PRODUCER_TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01'
const ENV = { NAME: 'jobs', ENVIRONMENT: 'staging', VERSION: '2.0.0' }

/** Lines whose message is `message`. */
const linesOf = (entries: Record<string, unknown>[], message: string) =>
  entries.filter((e) => e.message === message)

const controller = (cron = '*/5 * * * *') => ({
  cron,
  scheduledTime: 1_700_000_000_000,
  noRetry: vi.fn(),
})

/** A queue message with ack/retry spies. */
const queueMessage = (body: unknown, id = 'msg-1', attempts = 1) => ({
  id,
  body,
  attempts,
  timestamp: new Date(0),
  ack: vi.fn(),
  retry: vi.fn(),
})
const batch = (...messages: ReturnType<typeof queueMessage>[]) => ({
  queue: 'orders',
  messages,
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  ackAll: vi.fn(),
  retryAll: vi.fn(),
})

/**
 * A stand-in for the Workflows engine's `step`: runs each callback with a step
 * context, outside every Logging Context (as an RPC callback arrives), and
 * retries a throwing callback up to `limit` times. `step.count` counts the calls
 * per step name, as the engine does. `rollBack(i)` runs the `i`th call's rollback
 * handler, also outside every Logging Context.
 */
function fakeStep(limit = 1) {
  const calls: { name: string; args: unknown[]; ctx?: unknown; output?: unknown }[] = []
  const counts = new Map<string, number>()
  return {
    calls,
    async do(name: string, ...rest: unknown[]) {
      const call: (typeof calls)[number] = { name, args: rest }
      calls.push(call)
      const callback = (typeof rest[0] === 'function' ? rest[0] : rest[1]) as (
        ctx: unknown,
      ) => Promise<unknown>
      const count = (counts.get(name) ?? 0) + 1
      counts.set(name, count)
      for (let attempt = 1; ; attempt++) {
        call.ctx = { step: { name, count }, attempt, config: {} }
        try {
          call.output = await outsideEveryContext(() => callback(call.ctx))
          return call.output
        } catch (err) {
          if (attempt >= limit) throw err
        }
      }
    },
    rollBack(index: number, error = new Error('later step failed')) {
      const { name, args, ctx, output } = calls[index]!
      const options = (typeof args[0] === 'function' ? args[1] : args[2]) as {
        rollback: (input: unknown) => Promise<void>
      }
      return outsideEveryContext(() => options.rollback({ ctx, error, output, stepName: name }))
    },
  }
}

const event = (payload: unknown = {}, instanceId = 'inst-1') => ({
  payload,
  timestamp: new Date(0),
  instanceId,
  workflowName: 'report',
})

/** A step callback that logs nothing. */
const plainCallback = async () => 'plain'

/** A handler whose first parameter is optional: a wrapper that passes it an argument changes what it does. */
async function handle(dryRun = false) {
  return dryRun
}

beforeEach(() => {
  vi.restoreAllMocks()
  _reset()
  for (const key of Object.keys(workersEnv)) delete workersEnv[key]
})

describe('withScheduled', () => {
  it('runs the handler in a Logging Context with cron and scheduledTime, from env', async () => {
    const entries = _captureEntries()
    const handler = withScheduled(async (c: ScheduledController, env: typeof ENV) => {
      getLogger().info({ name: env.NAME, cron: c.cron }, 'tick')
    })

    await handler(controller(), ENV, {} as ExecutionContext)

    expect(linesOf(entries, 'tick')[0]).toMatchObject({
      service: 'jobs',
      environment: 'staging',
      version: '2.0.0',
      cron: '*/5 * * * *',
      scheduledTime: 1_700_000_000_000,
    })
  })

  it('starts a new root trace per run and writes one span.end scheduled', async () => {
    const entries = _captureEntries()
    const traces: ReturnType<typeof getTraceContext>[] = []
    const handler = withScheduled(() => {
      traces.push(getTraceContext())
    })

    // Even inside another Logging Context, a cron run is its own trace.
    await runWithLogger(
      { logger: createLogger({ service: 'x' }), traceparent: PRODUCER_TRACEPARENT },
      () => handler(controller(), ENV, {} as ExecutionContext),
    )
    await handler(controller(), ENV, {} as ExecutionContext)

    expect(traces[0]!.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(traces[0]!.traceId).not.toBe('11111111111111111111111111111111')
    expect(traces[0]!.parentSpanId).toBeUndefined()
    expect(traces[1]!.traceId).not.toBe(traces[0]!.traceId)

    const spans = linesOf(entries, 'span.end scheduled')
    expect(spans).toHaveLength(2)
    expect(spans[0]).toMatchObject({
      level: 'INFO',
      service: 'jobs',
      cron: '*/5 * * * *',
      scheduledTime: 1_700_000_000_000,
      traceId: traces[0]!.traceId,
      span: { operation: 'scheduled', status: 'OK' },
    })
  })

  it('the span.end scheduled level follows the env Span Defaults; a throw is still ERROR', async () => {
    const entries = _captureEntries()
    const env = { ...ENV, LOG_LEVEL: 'debug', LOG_SPAN_LEVEL: 'debug', LOG_SPAN_SLOW_MS: '60000' }
    await withScheduled(() => {})(controller(), env, {} as ExecutionContext)
    await expect(
      withScheduled(async () => {
        throw new Error('cron failed')
      })(controller(), env, {} as ExecutionContext),
    ).rejects.toThrow('cron failed')

    expect(linesOf(entries, 'span.end scheduled').map((e) => e.level)).toEqual(['DEBUG', 'ERROR'])
  })

  it('passes arguments and the return value through unchanged', async () => {
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext
    const c = controller()
    const result = { done: true }
    const inner = vi.fn((..._args: unknown[]) => result)
    const handler = withScheduled(inner)

    expect(handler(c, ENV, ctx)).toBe(result)
    expect(inner).toHaveBeenCalledWith(c, ENV, ctx)
    expect(c.noRetry).not.toHaveBeenCalled()
  })

  it('logs a throw at ERROR and rethrows the same error, sync or async', async () => {
    const entries = _captureEntries()
    const failure = new Error('cron failed')
    const c = controller()

    expect(() =>
      withScheduled(() => {
        throw failure
      })(c, ENV, {} as ExecutionContext),
    ).toThrow(failure)
    await expect(
      withScheduled(async () => {
        throw failure
      })(c, ENV, {} as ExecutionContext),
    ).rejects.toBe(failure)

    const spans = linesOf(entries, 'span.end scheduled')
    expect(spans).toHaveLength(2)
    for (const span of spans) {
      expect(span).toMatchObject({
        level: 'ERROR',
        cron: '*/5 * * * *',
        span: { status: 'ERROR', error: 'cron failed' },
        err: { message: 'cron failed' },
      })
    }
    expect(c.noRetry).not.toHaveBeenCalled()
  })

  it('honours the Env Mapping and registers the Default Logger, first seen wins', async () => {
    const entries = _captureEntries()
    const env = { SERVICE: 'mapped-cron' }
    const handler = withScheduled(() => getLogger().info('in cron'), {
      env: { service: 'SERVICE' },
    })

    await handler(controller(), env, {} as ExecutionContext)
    expect(linesOf(entries, 'in cron')[0]).toMatchObject({ service: 'mapped-cron' })

    getLogger().info('outside')
    expect(linesOf(entries, 'outside')[0]).toMatchObject({ service: 'mapped-cron' })

    // A Default Logger already set is kept.
    _reset()
    const mine = createLogger({ service: 'mine' })
    setDefaultLogger(mine)
    await handler(controller(), env, {} as ExecutionContext)
    expect(_getDefaultLogger()).toBe(mine)
  })

  it('works from a class entrypoint method that passes this.env', async () => {
    const entries = _captureEntries()
    const onCron = withScheduled((c: ScheduledController, env: typeof ENV) => {
      getLogger().info({ from: env.NAME }, 'class cron')
    })
    class Cron extends WorkerEntrypoint<typeof ENV> {
      scheduled(c: ScheduledController) {
        return onCron(c, this.env, this.ctx)
      }
    }

    await new Cron({} as ExecutionContext, ENV).scheduled(controller('0 * * * *'))

    expect(linesOf(entries, 'class cron')[0]).toMatchObject({
      service: 'jobs',
      cron: '0 * * * *',
      from: 'jobs',
    })
  })
})

describe('withQueueMessage', () => {
  beforeEach(() => {
    Object.assign(workersEnv, ENV)
  })

  it('calls fn with no arguments, as without the wrapper', async () => {
    const m = queueMessage({ n: 1 })
    await expect(withQueueMessage(batch(m), m, handle)).resolves.toBe(false)
  })

  it('opens one Logging Context per message with queue, messageId and attempts', async () => {
    const entries = _captureEntries()
    const b = batch(queueMessage({ n: 1 }, 'a', 1), queueMessage({ n: 2 }, 'b', 3))
    const traces: ReturnType<typeof getTraceContext>[] = []

    for (const m of b.messages) {
      await withQueueMessage(b, m, async () => {
        traces.push(getTraceContext())
        getLogger().info('processing')
      })
    }

    const lines = linesOf(entries, 'processing')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      service: 'jobs',
      environment: 'staging',
      queue: 'orders',
      messageId: 'a',
      attempts: 1,
    })
    expect(lines[1]).toMatchObject({ queue: 'orders', messageId: 'b', attempts: 3 })
    // No carrier in the body: each message is its own root trace.
    expect(traces[0]!.traceId).not.toBe(traces[1]!.traceId)
    expect(traces[0]!.parentSpanId).toBeUndefined()

    const spans = linesOf(entries, 'span.end queue.message')
    expect(spans).toHaveLength(2)
    expect(spans[1]).toMatchObject({
      level: 'INFO',
      messageId: 'b',
      span: { operation: 'queue.message', status: 'OK' },
    })
  })

  it("continues the producer's trace from the body's `trace` carrier", async () => {
    const entries = _captureEntries()
    let body: unknown
    await runWithLogger(
      {
        logger: createLogger({ service: 'producer' }),
        traceparent: PRODUCER_TRACEPARENT,
        tracestate: 'vendor=value',
      },
      () => {
        body = { orderId: 'o-1', trace: getTraceCarrier() }
      },
    )
    const producerSpanId = (body as { trace: { traceparent: string } }).trace.traceparent.split(
      '-',
    )[2]

    const m = queueMessage(body)
    const trace = await withQueueMessage(batch(m), m, () => getTraceContext())

    expect(trace).toMatchObject({
      traceId: '11111111111111111111111111111111',
      parentSpanId: producerSpanId,
      tracestate: 'vendor=value',
    })
    expect(trace!.spanId).not.toBe(producerSpanId)
    expect(linesOf(entries, 'span.end queue.message')[0]).toMatchObject({
      traceId: '11111111111111111111111111111111',
      parentSpanId: producerSpanId,
    })
    // The body is left as it is.
    expect((m.body as { trace: unknown }).trace).toEqual({
      traceparent: expect.any(String),
      tracestate: 'vendor=value',
    })
  })

  it('starts a new root trace for a body without a valid carrier', async () => {
    for (const body of [
      'plain text',
      null,
      new ArrayBuffer(4),
      { trace: 'nope' },
      { trace: { traceparent: 42 } },
      { trace: { traceparent: 'garbage' } },
    ]) {
      const m = queueMessage(body)
      const trace = await withQueueMessage(batch(m), m, () => getTraceContext())
      expect(trace!.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(trace!.parentSpanId).toBeUndefined()
    }
  })

  it("drops a carrier's tracestate when its traceparent is invalid", async () => {
    const m = queueMessage({
      trace: { traceparent: 'garbage', tracestate: 'v='.padEnd(4096, 'x') },
    })
    const carrier = await withQueueMessage(batch(m), m, () => getTraceCarrier())
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(carrier).not.toHaveProperty('tracestate')
  })

  it('never acks or retries: the app decides, and the value passes through', async () => {
    const m = queueMessage({ n: 1 })
    const b = batch(m)
    const result = { ok: true }

    expect(withQueueMessage(b, m, () => result)).toBe(result)
    expect(m.ack).not.toHaveBeenCalled()
    expect(m.retry).not.toHaveBeenCalled()
    expect(b.ackAll).not.toHaveBeenCalled()
    expect(b.retryAll).not.toHaveBeenCalled()

    await withQueueMessage(b, m, async () => m.ack())
    expect(m.ack).toHaveBeenCalledTimes(1)
    expect(m.retry).not.toHaveBeenCalled()
  })

  it('logs a throw at ERROR, rethrows the same error, and does not retry', async () => {
    const entries = _captureEntries()
    const failure = new Error('bad order')
    const m = queueMessage({ n: 1 }, 'x', 2)
    const b = batch(m)

    await expect(
      withQueueMessage(b, m, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(() =>
      withQueueMessage(b, m, () => {
        throw failure
      }),
    ).toThrow(failure)

    const spans = linesOf(entries, 'span.end queue.message')
    expect(spans).toHaveLength(2)
    for (const span of spans) {
      expect(span).toMatchObject({
        level: 'ERROR',
        queue: 'orders',
        messageId: 'x',
        attempts: 2,
        span: { status: 'ERROR', error: 'bad order' },
        err: { message: 'bad order' },
      })
    }
    expect(m.ack).not.toHaveBeenCalled()
    expect(m.retry).not.toHaveBeenCalled()
    expect(b.retryAll).not.toHaveBeenCalled()
  })

  it('for an unsampled carrier, a throw still writes one ERROR line; success writes none', async () => {
    const entries = _captureEntries()
    const failure = new Error('bad order')
    const unsampled = { trace: { traceparent: PRODUCER_TRACEPARENT.replace(/-01$/, '-00') } }
    const m = queueMessage(unsampled, 'x', 2)
    const b = batch(m)

    await expect(withQueueMessage(b, m, async () => 'ok')).resolves.toBe('ok')
    expect(entries).toHaveLength(0)
    await expect(
      withQueueMessage(b, m, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    expect(linesOf(entries, 'span.end queue.message')).toHaveLength(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'ERROR',
      message: 'queue.message failed',
      span: { operation: 'queue.message', status: 'ERROR' },
      queue: 'orders',
      messageId: 'x',
      attempts: 2,
      traceId: '11111111111111111111111111111111',
      err: { message: 'bad order' },
    })
  })

  it('reads env through cloudflare:workers with the Env Mapping, and registers the Default Logger', async () => {
    const entries = _captureEntries()
    workersEnv.QUEUE_SERVICE = 'consumer'
    const m = queueMessage({})

    await withQueueMessage(batch(m), m, () => getLogger().info('mapped'), {
      env: { service: 'QUEUE_SERVICE' },
    })

    expect(linesOf(entries, 'mapped')[0]).toMatchObject({ service: 'consumer' })
    getLogger().info('outside')
    expect(linesOf(entries, 'outside')[0]).toMatchObject({ service: 'consumer' })
  })
})

/**
 * Type-level checks for tracedStep's overloads, never called: a delay function
 * narrows the callback context as `step.do` does.
 */
function tracedStepTypes(s: WorkflowStep) {
  void tracedStep(
    s,
    'dynamic',
    { retries: { limit: 2, delay: () => '1 second' as const } },
    async (ctx) => {
      // @ts-expect-error a delay function leaves no resolved delay on the context
      void ctx.config.retries?.delay
      return 1
    },
  )
  void tracedStep(
    s,
    'static',
    { retries: { limit: 2, delay: '1 second' } },
    async (ctx) => ctx.config.retries?.delay ?? 0,
  )
}

describe('withWorkflow and tracedStep', () => {
  it('the fake step runs callbacks outside the Logging Context, as RPC callbacks arrive', async () => {
    const step = fakeStep()
    const seen = await runWithLogger({ logger: createLogger({ service: 'x' }) }, () =>
      step.do('probe', async () => getTraceContext()),
    )
    expect(seen).toBeNull()
  })

  it('runs run() in a Logging Context with workflowInstanceId, from env', async () => {
    const entries = _captureEntries()
    class Report extends WorkflowEntrypoint<typeof ENV> {
      async run(_event: unknown, _step: unknown) {
        getLogger().info('running')
        return 'done'
      }
    }
    const Logged = withWorkflow(Report)
    const result = await new Logged({} as ExecutionContext, ENV).run(
      event() as any,
      fakeStep() as any,
    )

    expect(result).toBe('done')
    expect(linesOf(entries, 'running')[0]).toMatchObject({
      service: 'jobs',
      environment: 'staging',
      workflowInstanceId: 'inst-1',
    })
    expect(getLogger()).toBeDefined()
    expect(_getDefaultLogger()).toBeDefined()
  })

  it("continues a trace carrier from the payload's `trace`, else starts a root trace", async () => {
    class Report extends WorkflowEntrypoint<typeof ENV, { trace?: unknown }> {
      async run(_event: unknown, _step: unknown) {
        return getTraceContext()
      }
    }
    const instance = new (withWorkflow(Report))({} as ExecutionContext, ENV)

    const continued = await instance.run(
      event({ trace: { traceparent: PRODUCER_TRACEPARENT } }) as any,
      fakeStep() as any,
    )
    expect(continued).toMatchObject({
      traceId: '11111111111111111111111111111111',
      parentSpanId: '2222222222222222',
    })

    const root = await instance.run(event({}) as any, fakeStep() as any)
    expect(root!.traceId).not.toBe('11111111111111111111111111111111')
    expect(root!.parentSpanId).toBeUndefined()
  })

  it('tracedStep writes one span per attempt with step and attempt, in the run context', async () => {
    const entries = _captureEntries()
    const failure = new Error('flaky')
    let calls = 0
    let runTrace: ReturnType<typeof getTraceContext> = null
    class Report extends WorkflowEntrypoint<typeof ENV> {
      async run(_event: unknown, step: any) {
        runTrace = getTraceContext()
        const rows = await tracedStep(step, 'fetch rows', async () => {
          calls++
          if (calls === 1) throw failure
          getLogger().info('fetched')
          return [1, 2, 3]
        })
        return rows
      }
    }
    const step = fakeStep(3)
    const rows = await new (withWorkflow(Report))({} as ExecutionContext, ENV).run(
      event() as any,
      step as any,
    )

    expect(rows).toEqual([1, 2, 3])
    // One step.do call: no extra steps, and the step name is unchanged.
    expect(step.calls).toHaveLength(1)
    expect(step.calls[0]!.name).toBe('fetch rows')

    const spans = linesOf(entries, 'span.end fetch rows')
    expect(spans).toHaveLength(2)
    expect(spans[0]).toMatchObject({
      level: 'ERROR',
      step: 'fetch rows',
      stepCount: 1,
      attempt: 1,
      workflowInstanceId: 'inst-1',
      traceId: runTrace!.traceId,
      parentSpanId: runTrace!.spanId,
      span: { operation: 'fetch rows', status: 'ERROR', error: 'flaky' },
      err: { message: 'flaky' },
    })
    expect(spans[1]).toMatchObject({
      level: 'INFO',
      step: 'fetch rows',
      attempt: 2,
      span: { status: 'OK' },
    })
    expect(linesOf(entries, 'fetched')[0]).toMatchObject({
      step: 'fetch rows',
      attempt: 2,
      workflowInstanceId: 'inst-1',
      traceId: runTrace!.traceId,
    })
  })

  it('tracedStep passes the config, rollback options and return value through unchanged', async () => {
    const config = {
      retries: { limit: 2, delay: '1 second' as const },
      timeout: '1 minute' as const,
    }
    const rollback = { rollback: async () => {} }
    const output = { id: 'r-1' }
    const step = fakeStep()
    let received: unknown
    class Report extends WorkflowEntrypoint<typeof ENV> {
      async run(_event: unknown, s: any) {
        return tracedStep(
          s,
          'save',
          config,
          async (ctx) => {
            received = ctx
            return output
          },
          rollback,
        )
      }
    }

    const result = await new (withWorkflow(Report))({} as ExecutionContext, ENV).run(
      event() as any,
      step as any,
    )

    expect(result).toBe(output)
    expect(step.calls[0]!.args[0]).toBe(config)
    // The rollback options are copied, with a handler that re-enters the Logging
    // Context; the object passed in is not changed.
    expect(step.calls[0]!.args[2]).toEqual({ rollback: expect.any(Function) })
    expect(step.calls[0]!.args[2]).not.toBe(rollback)
    expect(Object.keys(rollback)).toEqual(['rollback'])
    expect(received).toMatchObject({ step: { name: 'save', count: 1 }, attempt: 1 })
  })

  it('tracedStep records stepCount, so a step name repeated in a loop is told apart', async () => {
    const entries = _captureEntries()
    class Report extends WorkflowEntrypoint<typeof ENV> {
      async run(_event: unknown, s: any) {
        for (let i = 0; i < 2; i++) {
          await tracedStep(s, 'page', async () => {
            getLogger().info('paging')
            return i
          })
        }
      }
    }
    await new (withWorkflow(Report))({} as ExecutionContext, ENV).run(
      event() as any,
      fakeStep() as any,
    )

    expect(linesOf(entries, 'paging').map((e) => e.stepCount)).toEqual([1, 2])
    expect(linesOf(entries, 'span.end page').map((e) => e.stepCount)).toEqual([1, 2])
  })

  it('tracedStep for an unsampled trace still writes one ERROR line per failed attempt', async () => {
    const entries = _captureEntries()
    const failure = new Error('flaky')
    class Report extends WorkflowEntrypoint<typeof ENV> {
      async run(_event: unknown, s: any) {
        return tracedStep(s, 'charge', async () => {
          throw failure
        })
      }
    }
    const unsampled = { trace: { traceparent: PRODUCER_TRACEPARENT.replace(/-01$/, '-00') } }

    await expect(
      new (withWorkflow(Report))({} as ExecutionContext, ENV).run(
        event(unsampled) as any,
        fakeStep(2) as any,
      ),
    ).rejects.toBe(failure)

    expect(linesOf(entries, 'span.end charge')).toHaveLength(0)
    const failed = linesOf(entries, 'charge failed')
    expect(failed.map((e) => e.attempt)).toEqual([1, 2])
    expect(failed[0]).toMatchObject({
      level: 'ERROR',
      span: { operation: 'charge', status: 'ERROR' },
      step: 'charge',
      workflowInstanceId: 'inst-1',
      traceId: '11111111111111111111111111111111',
      err: { message: 'flaky' },
    })
  })

  it('tracedStep runs the rollback handler in the run context, as a Span', async () => {
    const entries = _captureEntries()
    const failure = new Error('undo failed')
    let received: unknown
    let runTrace: ReturnType<typeof getTraceContext> = null
    const rollbackConfig = { retries: { limit: 1, delay: 0 } }
    class Report extends WorkflowEntrypoint<typeof ENV> {
      async run(_event: unknown, s: any) {
        runTrace = getTraceContext()
        await tracedStep(s, 'reserve', async () => 'seat-1', {
          rollback: async (input) => {
            received = input
            getLogger().info('releasing')
          },
          rollbackConfig,
        })
        await tracedStep(s, 'refund', async () => 'r-1', {
          rollback: async () => {
            throw failure
          },
        })
      }
    }
    const step = fakeStep()
    await new (withWorkflow(Report))({} as ExecutionContext, ENV).run(event() as any, step as any)

    // The engine runs rollback handlers later, over RPC, outside every Logging Context.
    expect((step.calls[0]!.args[1] as { rollbackConfig: unknown }).rollbackConfig).toBe(
      rollbackConfig,
    )
    await step.rollBack(0)
    await expect(step.rollBack(1)).rejects.toBe(failure)

    expect(received).toMatchObject({ output: 'seat-1', stepName: 'reserve' })
    expect(linesOf(entries, 'releasing')[0]).toMatchObject({
      workflowInstanceId: 'inst-1',
      step: 'reserve',
      stepCount: 1,
      rollback: true,
      traceId: runTrace!.traceId,
    })
    expect(linesOf(entries, 'span.end rollback reserve')[0]).toMatchObject({
      level: 'INFO',
      parentSpanId: runTrace!.spanId,
      span: { status: 'OK' },
    })
    expect(linesOf(entries, 'span.end rollback refund')[0]).toMatchObject({
      level: 'ERROR',
      step: 'refund',
      rollback: true,
      err: { message: 'undo failed' },
    })
  })

  it('tracedStep narrows the callback context as step.do does for a delay function', () => {
    // The checks are in tracedStepTypes, which `pnpm typecheck` checks and nothing calls.
    expect(tracedStepTypes).toBeTypeOf('function')
  })

  it('tracedStep throws the error step.do throws, unchanged', async () => {
    const failure = new Error('gave up')
    class Report extends WorkflowEntrypoint<typeof ENV> {
      async run(_event: unknown, s: any) {
        return tracedStep(s, 'doomed', async () => {
          throw failure
        })
      }
    }
    await expect(
      new (withWorkflow(Report))({} as ExecutionContext, ENV).run(
        event() as any,
        fakeStep(2) as any,
      ),
    ).rejects.toBe(failure)
  })

  it('a run that throws outside every step is rethrown unchanged and writes no ERROR line', async () => {
    const entries = _captureEntries()
    const failure = new Error('bad input')
    class Report extends WorkflowEntrypoint<typeof ENV> {
      async run(_event: unknown, _step: unknown) {
        throw failure
      }
    }
    await expect(
      new (withWorkflow(Report))({} as ExecutionContext, ENV).run(
        event() as any,
        fakeStep() as any,
      ),
    ).rejects.toBe(failure)
    expect(entries.filter((e) => e.level === 'ERROR')).toHaveLength(0)
  })

  it('tracedStep outside a Logging Context calls step.do unchanged and logs nothing', async () => {
    const entries = _captureEntries()
    const step = fakeStep()
    const callback = plainCallback

    await expect(tracedStep(step as any, 'bare', callback)).resolves.toBe('plain')
    expect(step.calls[0]!.args[0]).toBe(callback)
    expect(entries).toHaveLength(0)
  })

  it('withWorkflow throws for a class that is not a WorkflowEntrypoint or has no run method', () => {
    class NotAWorkflow {
      async run(_event: unknown, _step: unknown) {}
    }
    expect(() => withWorkflow(NotAWorkflow as any)).toThrow(TypeError)

    class FieldRun extends WorkflowEntrypoint {
      run = async () => {}
    }
    expect(() => withWorkflow(FieldRun as any)).toThrow(/run/)
  })

  it('withWorkflow on its own result returns it; on a subclass of it throws', () => {
    class Report extends WorkflowEntrypoint {
      async run(_event: unknown, _step: unknown) {}
    }
    const Logged = withWorkflow(Report)
    expect(withWorkflow(Logged)).toBe(Logged)
    class Sub extends Logged {}
    expect(() => withWorkflow(Sub)).toThrow(TypeError)
  })

  it('honours the Env Mapping', async () => {
    const entries = _captureEntries()
    class Report extends WorkflowEntrypoint<{ WF_NAME: string }> {
      async run(_event: unknown, _step: unknown) {
        getLogger().info('mapped')
      }
    }
    const Logged = withWorkflow(Report, { env: { service: 'WF_NAME' } })
    await new Logged({} as ExecutionContext, { WF_NAME: 'reports' }).run(
      event() as any,
      fakeStep() as any,
    )
    expect(linesOf(entries, 'mapped')[0]).toMatchObject({ service: 'reports' })
  })
})

/** An Error with a key the application leaves out. */
const errorWithBody = () => Object.assign(new Error('failed'), { body: 'secret' })

describe('serializeError and limits in the handler helpers', () => {
  const serializeError = omitErrorKeys(['body'])

  it('withScheduled: serializeError from the options, limits from env', async () => {
    const entries = _captureEntries()
    const handler = withScheduled(
      () => {
        getLogger().info({ text: 'x'.repeat(50) }, 'tick')
        throw errorWithBody()
      },
      { serializeError },
    )
    await expect(
      Promise.resolve().then(() =>
        handler(controller(), { ...ENV, LOG_MAX_STRING_LENGTH: '20' }, {} as ExecutionContext),
      ),
    ).rejects.toThrow('failed')
    expect(linesOf(entries, 'tick')[0]!.text).toBe(`${'x'.repeat(20)}…[truncated from 50 chars]`)
    expect(linesOf(entries, 'span.end scheduled')[0]!.err).toMatchObject({ omitted: ['body'] })
    expect(JSON.stringify(entries)).not.toContain('secret')
  })

  it('withQueueMessage: serializeError from the options', async () => {
    const entries = _captureEntries()
    Object.assign(workersEnv, ENV)
    const message = queueMessage({})
    await expect(
      withQueueMessage(
        batch(message),
        message,
        async () => {
          throw errorWithBody()
        },
        { serializeError },
      ),
    ).rejects.toThrow('failed')
    expect(linesOf(entries, 'span.end queue.message')[0]!.err).toMatchObject({
      omitted: ['body'],
    })
  })

  it('withWorkflow: serializeError from the options; the same options give back the same class', async () => {
    const entries = _captureEntries()
    class Flow extends WorkflowEntrypoint {
      async run() {
        getLogger().error(errorWithBody(), 'in run')
      }
    }
    const Logged = withWorkflow(Flow, { serializeError })
    expect(withWorkflow(Logged, { serializeError })).toBe(Logged)
    expect(() => withWorkflow(Logged)).toThrow('already wrapped with other options')
    await (new Logged({} as any, ENV) as unknown as { run(...args: unknown[]): Promise<void> }).run(
      event(),
      {} as WorkflowStep,
    )
    expect(linesOf(entries, 'in run')[0]!.err).toMatchObject({ omitted: ['body'] })
  })

  it('without serializeError, the same env gives the same Root Logger as before', async () => {
    const loggers = new Set<unknown>()
    const record = withScheduled(() => {
      loggers.add(_getDefaultLogger())
    })
    await record(controller(), ENV, {} as ExecutionContext)
    await withScheduled(() => {}, { serializeError })(controller(), ENV, {} as ExecutionContext)
    expect(loggers.size).toBe(1)
  })
})
