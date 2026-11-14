import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The `env` that `import { env } from 'cloudflare:workers'` returns; tests set its vars.
const workersEnv = vi.hoisted((): Record<string, unknown> => ({}))

// Mock cloudflare:workers not available in Node/vitest
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
  WorkflowEntrypoint: class WorkflowEntrypoint {},
}))

import {
  TracedSession,
  tracedSession,
  withTrace,
  TracedEntrypoint,
  tracedWorker,
  loggerOptionsFromEnv,
  defaultLoggerFromEnv,
  withLogging,
} from './workers'
import { DurableObject, RpcTarget, WorkerEntrypoint } from 'cloudflare:workers'
import type { EnvMapping, SessionInit, TracedServiceBinding } from './workers'
import type { Logger, LoggerOptions } from './types'
import { brokenLogger } from './test-helpers'
import { omitErrorKeys } from './omit'
import {
  runWithLogger,
  getTraceContext,
  getLogger,
  withSpan,
  _reset,
  createLogger,
  setDefaultLogger,
  _captureEntries,
  _getDefaultLogger,
} from './logger'
import { resolveTrace, buildTraceparent } from './trace'
import { useLogger } from './middleware'
import { Hono } from 'hono'

describe('Session Factory trace propagation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('tracedSession() sends one SessionInit: Trace Carrier plus fields', () => {
    let received: SessionInit | undefined
    const binding: TracedServiceBinding<object> = {
      session(init) {
        received = init
        return {}
      },
    }
    const context = {
      logger: createLogger({ service: 'caller' }),
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      tracestate: 'vendor=value',
    }

    let callerSpanId: string | undefined
    runWithLogger(context, () => {
      callerSpanId = getTraceContext()!.spanId
      tracedSession(binding, { requestId: 'req-1' })
    })

    expect(received).toEqual({
      traceparent: `00-11111111111111111111111111111111-${callerSpanId}-01`,
      tracestate: 'vendor=value',
      fields: { requestId: 'req-1' },
    })
  })

  it('Traced Session continues the carrier and its fields', () => {
    const entries = _captureEntries()

    class TestSession extends TracedSession {
      work() {
        return this.traced(() => {
          this.logger.info('working')
          return getTraceContext()
        })
      }
    }

    const session = new TestSession(
      {
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        tracestate: 'vendor=value',
        fields: { requestId: 'req-1' },
      },
      createLogger({ service: 'receiver' }),
      {},
    )
    const trace = session.work()

    expect(trace).toMatchObject({
      traceId: '11111111111111111111111111111111',
      parentSpanId: '2222222222222222',
      tracestate: 'vendor=value',
    })
    expect(entries.find((e) => e.message === 'working')).toMatchObject({ requestId: 'req-1' })
  })

  it('TracedSession.traced() sets up ALS with correct trace context', () => {
    _captureEntries()

    const callerTrace = resolveTrace()
    const traceparent = buildTraceparent(callerTrace)

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
    const receivedTrace = session.getTrace()

    expect(receivedTrace).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
    expect(receivedTrace!.parentSpanId).toBe(callerTrace.spanId)
    expect(receivedTrace!.spanId).not.toBe(callerTrace.spanId)
  })

  it('tracedSession() extracts traceparent from current ALS context', () => {
    _captureEntries()

    const callerTrace = resolveTrace()
    const callerLogger = createLogger({ service: 'caller' })

    let receivedTraceparent: string | undefined
    const mockBinding = {
      session(init: SessionInit) {
        receivedTraceparent = init.traceparent
        return {}
      },
    }

    let callerContextTrace: ReturnType<typeof getTraceContext>
    runWithLogger({ logger: callerLogger, traceparent: buildTraceparent(callerTrace) }, () => {
      callerContextTrace = getTraceContext()
      tracedSession(mockBinding)
    })

    expect(receivedTraceparent).toBe(buildTraceparent(callerContextTrace!))
    expect(callerContextTrace!.traceId).toBe(callerTrace.traceId)
  })

  it('tracedSession() passes an empty carrier outside a Logging Context', () => {
    let receivedTraceparent: string | undefined
    const mockBinding = {
      session(init: SessionInit) {
        receivedTraceparent = init.traceparent
        return {}
      },
    }

    tracedSession(mockBinding)
    expect(receivedTraceparent).toBeUndefined()
  })

  it('propagates traceId end-to-end through session factory', () => {
    _captureEntries()

    const callerTrace = resolveTrace()
    const callerLogger = createLogger({ service: 'caller' })

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const mockBinding = {
      session(init: SessionInit) {
        return new TestSession(init, createLogger({ service: 'receiver' }), {})
      },
    }

    let receivedTrace: ReturnType<typeof getTraceContext>
    let callerContextTrace: ReturnType<typeof getTraceContext>

    runWithLogger({ logger: callerLogger, traceparent: buildTraceparent(callerTrace) }, () => {
      callerContextTrace = getTraceContext()
      const session = tracedSession(mockBinding)
      receivedTrace = session.getTrace()
    })

    expect(receivedTrace!).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
    expect(receivedTrace!.parentSpanId).toBe(callerContextTrace!.spanId)
    expect(receivedTrace!.spanId).not.toBe(callerContextTrace!.spanId)
  })

  it('isolates traces across concurrent sessions', async () => {
    _captureEntries()

    const traceA = resolveTrace()
    const traceB = resolveTrace()
    expect(traceA.traceId).not.toBe(traceB.traceId)

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const mockBinding = {
      session(init: SessionInit) {
        return new TestSession(init, createLogger({ service: 'receiver' }), {})
      },
    }

    const callerLogger = createLogger({ service: 'caller' })

    const [resultA, resultB] = await Promise.all([
      new Promise<ReturnType<typeof getTraceContext>>((resolve) => {
        runWithLogger({ logger: callerLogger, traceparent: buildTraceparent(traceA) }, () => {
          const session = tracedSession(mockBinding)
          resolve(session.getTrace())
        })
      }),
      new Promise<ReturnType<typeof getTraceContext>>((resolve) => {
        runWithLogger({ logger: callerLogger, traceparent: buildTraceparent(traceB) }, () => {
          const session = tracedSession(mockBinding)
          resolve(session.getTrace())
        })
      }),
    ])

    expect(resultA!.traceId).toBe(traceA.traceId)
    expect(resultB!.traceId).toBe(traceB.traceId)
    expect(resultA!.traceId).not.toBe(resultB!.traceId)
  })

  it('traced() logs include correct traceId', () => {
    const entries = _captureEntries()

    const callerTrace = resolveTrace()
    const traceparent = buildTraceparent(callerTrace)

    class TestSession extends TracedSession {
      doWork() {
        return this.traced(() => {
          getLogger('test-svc').info({ action: 'test' }, 'doing work')
        })
      }
    }

    const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
    session.doWork()

    const entry = entries.find((e) => e.message === 'doing work')
    expect(entry).toBeDefined()
    expect(entry!.traceId).toBe(callerTrace.traceId)
  })

  it('round-trips through W3C traceparent format', () => {
    const original = resolveTrace()
    const traceparent = buildTraceparent(original)
    const continued = resolveTrace(traceparent)

    expect(continued.traceId).toBe(original.traceId)
    expect(continued.parentSpanId).toBe(original.spanId)
    expect(continued.spanId).not.toBe(original.spanId)
  })

  describe('traced() span support', () => {
    it('does not emit span log when no operation name is provided', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => 42)
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      const result = session.doWork()

      expect(result).toBe(42)
      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))
      expect(spanEntry).toBeUndefined()
    })

    it('emits span log with OK status for sync operations', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => 42, 'test.doWork')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      const result = session.doWork()

      expect(result).toBe(42)
      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const span = spanEntry.span as Record<string, unknown>
      expect(span.operation).toBe('test.doWork')
      expect(span.status).toBe('OK')
      expect(span.duration).toBeGreaterThanOrEqual(0)
      expect(span.startTime as number).toBeLessThanOrEqual(span.endTime as number)
      expect(span.error).toBeUndefined()
      // trace IDs are on the log line itself, not duplicated in span
      expect(span.traceId).toBeUndefined()
      expect(spanEntry.traceId).toBe(callerTrace.traceId)
    })

    it('emits span log with ERROR status when sync operation throws', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => {
            throw new Error('boom')
          }, 'test.fail')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      expect(() => session.doWork()).toThrow('boom')

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const span = spanEntry.span as Record<string, unknown>
      expect(span.operation).toBe('test.fail')
      expect(span.status).toBe('ERROR')
      expect(span.error).toBe('boom')
    })

    it('sync error span includes stack trace in err field', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => {
            throw new Error('stack test')
          }, 'test.stackSync')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      expect(() => session.doWork()).toThrow('stack test')

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const err = spanEntry.err as Record<string, unknown>
      expect(err).toBeDefined()
      expect(err.message).toBe('stack test')
      expect(err.type).toBe('Error')
      expect(typeof err.stack).toBe('string')
      expect((err.stack as string).length).toBeGreaterThan(0)
    })

    it('emits span log with OK status for async operations', async () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        async doWork() {
          return this.traced(async () => {
            return 99
          }, 'test.async')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      const result = await session.doWork()

      expect(result).toBe(99)
      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const span = spanEntry.span as Record<string, unknown>
      expect(span.operation).toBe('test.async')
      expect(span.status).toBe('OK')
      // trace IDs are on the log line itself, not duplicated in span
      expect(span.traceId).toBeUndefined()
      expect(spanEntry.traceId).toBe(callerTrace.traceId)
    })

    it('emits span log with ERROR status when async operation rejects', async () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        async doWork() {
          return this.traced(async () => {
            throw new Error('async boom')
          }, 'test.asyncFail')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      await expect(session.doWork()).rejects.toThrow('async boom')

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const span = spanEntry.span as Record<string, unknown>
      expect(span.operation).toBe('test.asyncFail')
      expect(span.status).toBe('ERROR')
      expect(span.error).toBe('async boom')
    })

    it('async error span includes stack trace in err field', async () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        async doWork() {
          return this.traced(async () => {
            throw new Error('async stack test')
          }, 'test.stackAsync')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      await expect(session.doWork()).rejects.toThrow('async stack test')

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      const err = spanEntry.err as Record<string, unknown>
      expect(err).toBeDefined()
      expect(err.message).toBe('async stack test')
      expect(err.type).toBe('Error')
      expect(typeof err.stack).toBe('string')
      expect((err.stack as string).length).toBeGreaterThan(0)
    })

    it('span does not duplicate trace IDs (they are on the log line)', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => 'ok', 'test.parent')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      session.doWork()

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      const span = spanEntry.span as Record<string, unknown>
      // trace IDs should be on the log line, not in the span object
      expect(span.traceId).toBeUndefined()
      expect(span.spanId).toBeUndefined()
      expect(span.parentSpanId).toBeUndefined()
      expect(spanEntry.traceId).toBe(callerTrace.traceId)
      expect(spanEntry.parentSpanId).toBe(callerTrace.spanId)
    })
  })

  it('withTrace() creates session and runs callback as one-liner', async () => {
    _captureEntries()

    const callerTrace = resolveTrace()
    const callerLogger = createLogger({ service: 'caller' })

    class TestSession extends TracedSession {
      async add(a: number, b: number) {
        return this.traced(() => {
          const trace = getTraceContext()
          expect(trace!.traceId).toBe(callerTrace.traceId)
          return a + b
        })
      }
    }

    const mockBinding = {
      session(init: SessionInit) {
        return new TestSession(init, createLogger({ service: 'receiver' }), {})
      },
    }

    const result = await runWithLogger(
      { logger: callerLogger, traceparent: buildTraceparent(callerTrace) },
      () => withTrace(mockBinding, (s) => s.add(5, 7)),
    )

    expect(result).toBe(12)
  })
})

describe('TracedEntrypoint', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('the Logger Options hook reads NAME, LOG_LEVEL, ENVIRONMENT and VERSION from env by default', () => {
    const entrypoint = new TracedEntrypoint({} as any, {
      NAME: 'my-svc',
      LOG_LEVEL: 'warn',
      ENVIRONMENT: 'staging',
      VERSION: '1.2.3',
    })

    const opts = (entrypoint as any)[TracedEntrypoint.loggerOptions]
    expect(opts).toEqual({
      service: 'my-svc',
      level: 'warn',
      environment: 'staging',
      version: '1.2.3',
    })
  })

  it('the Logger Options hook defaults when env vars missing', () => {
    const entrypoint = new TracedEntrypoint({} as any, {})

    expect((entrypoint as any)[TracedEntrypoint.loggerOptions]).toStrictEqual({
      service: 'unknown',
      level: 'info',
    })
  })

  it('re-exports loggerOptionsFromEnv', () => {
    expect(loggerOptionsFromEnv({ NAME: 'api' })).toStrictEqual({ service: 'api', level: 'info' })
  })

  it('an Env Mapping hook override maps fields by name and by function', () => {
    interface Env {
      SERVICE: string
      RELEASE: string
      CF_VERSION_METADATA: { id: string }
    }

    class Entrypoint extends TracedEntrypoint<Env> {
      protected override get [TracedEntrypoint.envMapping](): EnvMapping<Env> {
        return { service: 'SERVICE', version: (e) => e.CF_VERSION_METADATA.id }
      }
    }

    const entrypoint = new Entrypoint({} as any, {
      SERVICE: 'mapped-svc',
      RELEASE: 'unused',
      CF_VERSION_METADATA: { id: 'version-id' },
    })

    expect((entrypoint as any)[TracedEntrypoint.loggerOptions]).toStrictEqual({
      service: 'mapped-svc',
      level: 'info',
      version: 'version-id',
    })
  })

  it('a Logger Options hook override still wins over the Env Mapping hook', () => {
    class Entrypoint extends TracedEntrypoint {
      protected override get [TracedEntrypoint.envMapping](): EnvMapping {
        return { service: 'SERVICE' }
      }
      protected override get [TracedEntrypoint.loggerOptions]() {
        return { service: 'custom', level: 'debug' as const }
      }
    }

    const entrypoint = new Entrypoint({} as any, { SERVICE: 'mapped' })
    expect((entrypoint as any)[TracedEntrypoint.rootLogger]).toBeDefined()
    expect((entrypoint as any)[TracedEntrypoint.loggerOptions]).toStrictEqual({
      service: 'custom',
      level: 'debug',
    })
  })

  it('shares one Root Logger per isolate for the same Logger Options', () => {
    const env = { NAME: 'root-svc', LOG_LEVEL: 'info' }
    const a = new TracedEntrypoint({} as any, env)
    const b = new TracedEntrypoint({} as any, { ...env })
    const other = new TracedEntrypoint({} as any, { NAME: 'other-svc', LOG_LEVEL: 'info' })

    expect((a as any)[TracedEntrypoint.rootLogger]).toBe((b as any)[TracedEntrypoint.rootLogger])
    expect((a as any)[TracedEntrypoint.rootLogger]).not.toBe(
      (other as any)[TracedEntrypoint.rootLogger],
    )
  })

  it('Root Logger carries per-process fields from env', () => {
    const entries = _captureEntries()
    const entrypoint = new TracedEntrypoint({} as any, {
      NAME: 'env-svc',
      LOG_LEVEL: 'info',
      ENVIRONMENT: 'staging',
      VERSION: '2.0.0',
    })

    ;(entrypoint as any)[TracedEntrypoint.rootLogger].info('hello')

    expect(entries[0]).toMatchObject({
      service: 'env-svc',
      environment: 'staging',
      version: '2.0.0',
    })
  })
})

describe('tracedWorker', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('creates entrypoint with session() that returns the session class', () => {
    _captureEntries()

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const Worker = tracedWorker(TestSession)
    const instance = new Worker(undefined, { NAME: 'test-svc', LOG_LEVEL: 'debug' })

    const callerTrace = resolveTrace()
    const session = instance.session({ traceparent: buildTraceparent(callerTrace) })
    const receivedTrace = session.getTrace()

    expect(receivedTrace).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
  })

  it('end-to-end: tracedSession + tracedWorker', async () => {
    _captureEntries()

    class TestSession extends TracedSession {
      async add(a: number, b: number) {
        return this.traced(() => {
          expect(getTraceContext()!.traceId).toBe(callerTrace.traceId)
          return a + b
        })
      }
    }

    const Worker = tracedWorker(TestSession)
    const binding = new Worker(undefined, { NAME: 'test-svc', LOG_LEVEL: 'debug' })

    const callerTrace = resolveTrace()
    const callerLogger = createLogger({ service: 'caller' })

    const result = await runWithLogger(
      { logger: callerLogger, traceparent: buildTraceparent(callerTrace) },
      () => withTrace(binding, (s) => s.add(3, 4)),
    )

    expect(result).toBe(7)
  })

  it('tracedWorker(SessionClass, { env }) maps fields by name and by function', () => {
    const entries = _captureEntries()

    interface Env {
      NAME: string
      RELEASE: string
      CF_VERSION_METADATA: { id: string; tag: string }
    }

    class TestSession extends TracedSession<Env> {
      hello() {
        return this.traced(() => this.logger.info('hello'))
      }
    }

    const Worker = tracedWorker(TestSession, {
      env: { environment: 'RELEASE', version: (e) => e.CF_VERSION_METADATA.tag },
    })
    const instance = new Worker(undefined, {
      NAME: 'mapped-worker',
      RELEASE: 'canary',
      VERSION: 'ignored',
      CF_VERSION_METADATA: { id: 'id-1', tag: 'tag-1' },
    })
    instance.session({}).hello()

    expect(entries[0]).toMatchObject({
      service: 'mapped-worker',
      environment: 'canary',
      version: 'tag-1',
    })
  })

  it('the documented version_metadata recipe falls back to id when tag is empty, and tolerates a missing binding', () => {
    const entries = _captureEntries()

    interface Env {
      CF_VERSION_METADATA?: { id: string; tag: string }
    }

    class TestSession extends TracedSession<Env> {
      hello() {
        return this.traced(() => this.logger.info('hello'))
      }
    }

    const Worker = tracedWorker(TestSession, {
      env: { version: (e) => e.CF_VERSION_METADATA?.tag || e.CF_VERSION_METADATA?.id },
    })
    new Worker(undefined, { NAME: 'w', CF_VERSION_METADATA: { id: 'id-1', tag: '' } })
      .session({})
      .hello()
    // Without the binding the recipe must not throw; version is just left off.
    new Worker(undefined, { NAME: 'w2' }).session({}).hello()

    expect(entries[0]).toMatchObject({ service: 'w', version: 'id-1' })
    expect(entries[1]).toMatchObject({ service: 'w2' })
    expect(entries[1]).not.toHaveProperty('version')
  })

  it('an invalid LOG_LEVEL warns once per isolate across repeated session() calls', () => {
    const entries = _captureEntries()

    class TestSession extends TracedSession {
      hello() {
        return this.traced(() => this.logger.info('hello'))
      }
    }

    const instance = new (tracedWorker(TestSession))(undefined, {
      NAME: 'bad-level',
      LOG_LEVEL: 'verbose',
    })
    instance.session({}).hello()
    instance.session({}).hello()

    const warns = entries.filter((e) => e.level === 'WARN')
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ invalidLevel: 'verbose', service: 'bad-level' })
    expect(entries.filter((e) => e.message === 'hello')).toHaveLength(2)
  })

  it('tracedWorker() without options reads the default vars', () => {
    const entries = _captureEntries()

    class TestSession extends TracedSession {
      hello() {
        return this.traced(() => this.logger.info('hello'))
      }
    }

    const instance = new (tracedWorker(TestSession))(undefined, { NAME: 'plain', VERSION: '3.0.0' })
    instance.session({}).hello()

    expect(entries[0]).toMatchObject({ service: 'plain', version: '3.0.0' })
    expect(entries[0]).not.toHaveProperty('environment')
  })

  it('session receives env and can access it for multi-hop RPC', () => {
    _captureEntries()

    interface TestEnv {
      OTHER_SERVICE: { session(init: SessionInit): unknown }
    }

    class TestSession extends TracedSession<TestEnv> {
      hasBinding() {
        return this.traced(() => {
          return this.env.OTHER_SERVICE !== undefined
        })
      }
    }

    const fakeEnv: TestEnv = { OTHER_SERVICE: { session: () => ({}) } }
    const Worker = tracedWorker(TestSession)
    const instance = new Worker(undefined, { NAME: 'svc', LOG_LEVEL: 'info', ...fakeEnv })

    const session = instance.session({ traceparent: buildTraceparent(resolveTrace()) })
    expect(session.hasBinding()).toBe(true)
  })
})

describe('traceFlags sampling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('skips span logs when traceFlags sampled bit is 0', () => {
    const entries = _captureEntries()

    const callerTrace = resolveTrace()
    // Build unsampled traceparent (flags = 00)
    const unsampledTp = `00-${callerTrace.traceId}-${callerTrace.spanId}-00`

    class TestSession extends TracedSession {
      doWork() {
        return this.traced(() => {
          getLogger().info({}, 'inside traced')
          return 42
        }, 'test.operation')
      }
    }

    const session = new TestSession(
      { traceparent: unsampledTp },
      createLogger({ service: 'test-svc' }),
      {},
    )
    const result = session.doWork()
    expect(result).toBe(42)

    // Should have the business log but NO span.end log
    const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))
    expect(spanEntry).toBeUndefined()
    const businessLog = entries.find((e) => e.message === 'inside traced')
    expect(businessLog).toBeDefined()
  })

  it('emits span logs when traceFlags sampled bit is 1', () => {
    const entries = _captureEntries()

    const callerTrace = resolveTrace()
    // Build sampled traceparent (flags = 01)
    const sampledTp = `00-${callerTrace.traceId}-${callerTrace.spanId}-01`

    class TestSession extends TracedSession {
      doWork() {
        return this.traced(() => 42, 'test.operation')
      }
    }

    const session = new TestSession(
      { traceparent: sampledTp },
      createLogger({ service: 'test-svc' }),
      {},
    )
    const result = session.doWork()
    expect(result).toBe(42)

    const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))
    expect(spanEntry).toBeDefined()
  })
})

describe('Default Logger from the Workers helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
    for (const key of Object.keys(workersEnv)) delete workersEnv[key]
  })

  it('a TracedEntrypoint whose Root Logger hook returns getLogger() does not loop', () => {
    const entries = _captureEntries()
    class Forwarding extends TracedEntrypoint {
      protected override get [TracedEntrypoint.rootLogger]() {
        return getLogger()
      }
    }

    expect(() => new Forwarding({} as any, {})).not.toThrow()
    expect(_getDefaultLogger()).toBeUndefined()
    getLogger().info('x')
    expect(entries.at(-1)).toMatchObject({ service: 'unknown', message: 'x' })
  })

  it('a TracedEntrypoint whose Root Logger hook is a child of getLogger() does not lock in unknown', () => {
    const entries = _captureEntries()
    class ForwardingChild extends TracedEntrypoint {
      protected override get [TracedEntrypoint.rootLogger]() {
        return getLogger().child({ component: 'pkg' })
      }
    }

    expect(() => new ForwardingChild({} as any, {})).not.toThrow()
    expect(_getDefaultLogger()).toBeUndefined()
    workersEnv.NAME = 'orders'
    defaultLoggerFromEnv()
    getLogger().info('x')
    expect(entries.at(-1)).toMatchObject({ service: 'orders', message: 'x' })
  })

  it('defaultLoggerFromEnv() builds the Root Logger from env and registers it', () => {
    const entries = _captureEntries()
    Object.assign(workersEnv, {
      NAME: 'cron-worker',
      LOG_LEVEL: 'debug',
      ENVIRONMENT: 'production',
      VERSION: '4.0.0',
    })

    const logger = defaultLoggerFromEnv()
    expect(_getDefaultLogger()).toBe(logger)

    getLogger().debug('outside any Logging Context')
    expect(entries[0]).toMatchObject({
      level: 'DEBUG',
      service: 'cron-worker',
      environment: 'production',
      version: '4.0.0',
    })
    expect(entries[0]).not.toHaveProperty('traceId')
  })

  it('defaultLoggerFromEnv(mapping) reads vars through an Env Mapping', () => {
    const entries = _captureEntries()
    Object.assign(workersEnv, {
      SERVICE_NAME: 'mapped',
      CF_VERSION_METADATA: { id: 'v-id' },
    })

    defaultLoggerFromEnv<{ CF_VERSION_METADATA: { id: string } }>({
      service: 'SERVICE_NAME',
      version: (e) => e.CF_VERSION_METADATA.id,
    })
    getLogger().info('hello')

    expect(entries[0]).toMatchObject({ service: 'mapped', version: 'v-id' })
  })

  it('defaultLoggerFromEnv() returns the same Root Logger as TracedEntrypoint for the same env', () => {
    Object.assign(workersEnv, { NAME: 'shared' })
    const entrypoint = new TracedEntrypoint({} as any, { NAME: 'shared' })

    expect(defaultLoggerFromEnv()).toBe(defaultLoggerFromEnv())
    expect(defaultLoggerFromEnv()).toBe((entrypoint as any)[TracedEntrypoint.rootLogger])
  })

  it('defaultLoggerFromEnv() does not replace a default set with setDefaultLogger()', () => {
    Object.assign(workersEnv, { NAME: 'from-env' })
    const explicit = createLogger({ service: 'explicit' })
    setDefaultLogger(explicit)

    const logger = defaultLoggerFromEnv()

    expect(logger).not.toBe(explicit)
    expect(_getDefaultLogger()).toBe(explicit)
  })

  it('TracedEntrypoint registers its Root Logger when constructed', () => {
    const entries = _captureEntries()

    class Entrypoint extends TracedEntrypoint {
      scheduled() {
        getLogger().info('scheduled, outside a Logging Context')
      }
    }

    const entrypoint = new Entrypoint({} as any, {
      NAME: 'rpc-worker',
      ENVIRONMENT: 'staging',
      VERSION: '1.0.0',
    })
    entrypoint.scheduled()

    expect(_getDefaultLogger()).toBe((entrypoint as any)[TracedEntrypoint.rootLogger])
    expect(entries[0]).toMatchObject({
      service: 'rpc-worker',
      environment: 'staging',
      version: '1.0.0',
    })
    expect(entries[0]).not.toHaveProperty('traceId')
  })

  it('TracedEntrypoint registers an overridden Root Logger hook', () => {
    const custom = createLogger({ service: 'custom-root' })

    class Entrypoint extends TracedEntrypoint {
      protected override get [TracedEntrypoint.rootLogger]() {
        return custom
      }
    }

    const entrypoint = new Entrypoint({} as any, { NAME: 'ignored' })
    expect(_getDefaultLogger()).toBe((entrypoint as any)[TracedEntrypoint.rootLogger])
    expect(_getDefaultLogger()).toBe(custom)
  })

  it('tracedWorker() registers its Root Logger; Context Fields never reach the default', () => {
    const entries = _captureEntries()

    class TestSession extends TracedSession {
      hello() {
        return this.traced(() => this.logger.info('inside'))
      }
    }

    const instance = new (tracedWorker(TestSession))(undefined, { NAME: 'bind' })
    instance.session({ fields: { requestId: 'req-1' } }).hello()
    getLogger().info('outside')

    expect(entries.find((e) => e.message === 'inside')).toMatchObject({ requestId: 'req-1' })
    const outside = entries.find((e) => e.message === 'outside')!
    expect(outside).toMatchObject({ service: 'bind' })
    expect(outside).not.toHaveProperty('requestId')
    expect(outside).not.toHaveProperty('traceId')
  })

  it('first seen wins, and setDefaultLogger() overrides a registered default', () => {
    const a = new TracedEntrypoint({} as any, { NAME: 'first' })
    const b = new TracedEntrypoint({} as any, { NAME: 'second' })
    const first = (a as any)[TracedEntrypoint.rootLogger]
    expect((b as any)[TracedEntrypoint.rootLogger]).not.toBe(first)

    expect(_getDefaultLogger()).toBe(first)

    const explicit = createLogger({ service: 'explicit' })
    setDefaultLogger(explicit)
    const again = new TracedEntrypoint({} as any, { NAME: 'first' })
    expect((again as any)[TracedEntrypoint.rootLogger]).toBe(first)

    expect(_getDefaultLogger()).toBe(explicit)
  })
})

const ownNames = (o: object) => new Set(Object.getOwnPropertyNames(o))
/**
 * What JSRPC can reach on an `RpcTarget` (or, with `base`, a `WorkerEntrypoint`): the
 * string-keyed members of its prototype chain (methods and accessors, own and inherited)
 * above `base`, without `constructor`. workerd does not expose the instance's own
 * properties, `#private` members, symbol keys, or `Object.prototype`.
 */
const rpcSurface = (target: object, base: object = RpcTarget.prototype) => {
  const names = new Set<string>()
  for (
    let proto = Object.getPrototypeOf(target);
    proto && proto !== base && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor') names.add(name)
    }
  }
  return names
}
/** Lines whose message is `message`. */
const linesOf = (entries: Record<string, unknown>[], message: string) =>
  entries.filter((e) => e.message === message)
/** A Durable Object's `ctx`, with an ID that has `name` when given. */
const state = (name?: string) =>
  ({
    id: { toString: () => 'a'.repeat(64), ...(name ? { name } : {}) },
  }) as unknown as DurableObjectState
const spanEnds = (entries: Record<string, unknown>[]) =>
  entries.filter((e) => String(e.message).startsWith('span.end '))

describe('withLogging', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  const ENV = { NAME: 'search', ENVIRONMENT: 'staging', VERSION: '1.2.3' }
  const CALLER_TRACEPARENT_BASE = '00-11111111111111111111111111111111-2222222222222222'
  const CALLER_TRACEPARENT = `${CALLER_TRACEPARENT_BASE}-01`
  const RPC_METHODS = new Set([
    'constructor',
    'search',
    'searchAsync',
    'fail',
    'failAsync',
    'nested',
    'target',
    'stub',
  ])
  const failure = new Error('search failed')
  const returnedTarget = new (class Counter extends RpcTarget {})()
  // An RPC stub answers every property, `then` included, so nothing may inspect it.
  const returnedStub = new Proxy(() => {}, { get: () => () => {} })

  class SearchWorker extends WorkerEntrypoint<typeof ENV> {
    search(q: string) {
      getLogger().info({ q }, 'searching')
      return { q, trace: getTraceContext() }
    }

    async searchAsync(q: string) {
      await Promise.resolve()
      getLogger().info({ q }, 'searching async')
      return getTraceContext()
    }

    fail(): never {
      throw failure
    }

    async failAsync(): Promise<never> {
      await Promise.resolve()
      throw failure
    }

    nested() {
      const outer = getTraceContext()
      const inner = this.search('inner').trace
      return { outer, inner, after: getTraceContext() }
    }

    target() {
      return returnedTarget
    }

    stub() {
      return returnedStub
    }

    scheduled() {
      getLogger().info('scheduled')
    }

    queue() {}

    tail() {}

    get computed() {
      return 'getter'
    }
  }

  it('opens a Logging Context per call: service, traceId, spanId, rpcMethod, entrypoint', () => {
    const entries = _captureEntries()
    const worker = new (withLogging(SearchWorker))({} as any, ENV)

    const first = worker.search('cats').trace!
    const second = worker.search('dogs').trace!

    const lines = entries.filter((e) => e.message === 'searching')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      service: 'search',
      environment: 'staging',
      version: '1.2.3',
      traceId: first.traceId,
      spanId: first.spanId,
      rpcMethod: 'search',
      entrypoint: 'SearchWorker',
      q: 'cats',
    })
    expect(lines[0]!.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(lines[0]!.spanId).toMatch(/^[0-9a-f]{16}$/)
    // No carrier: each call is a new root trace.
    expect(second.traceId).not.toBe(first.traceId)
    expect(first.parentSpanId).toBeUndefined()
    expect(lines[1]).not.toHaveProperty('parentSpanId')
  })

  it('keeps the Logging Context across awaits in an async method', async () => {
    const entries = _captureEntries()
    const worker = new (withLogging(SearchWorker))({} as any, ENV)

    const trace = await worker.searchAsync('cats')

    expect(entries.find((e) => e.message === 'searching async')).toMatchObject({
      traceId: trace!.traceId,
      rpcMethod: 'searchAsync',
    })
  })

  it('passes arguments, return values and thrown values through unchanged; sync stays sync', async () => {
    _captureEntries()
    const worker = new (withLogging(SearchWorker, { spans: true }))({} as any, ENV)

    const result = worker.search('cats')
    expect(result).not.toBeInstanceOf(Promise)
    expect(result.q).toBe('cats')
    expect(worker.target()).toBe(returnedTarget)
    expect(worker.stub()).toBe(returnedStub)

    let thrown: unknown
    try {
      worker.fail()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBe(failure)
    await expect(worker.failAsync()).rejects.toBe(failure)
  })

  it('spans: true writes one span.end per call, at ERROR on throw', async () => {
    const entries = _captureEntries()
    const worker = new (withLogging(SearchWorker, { spans: true }))({} as any, ENV)

    const trace = worker.search('cats').trace!
    expect(() => worker.fail()).toThrow(failure)
    await expect(worker.failAsync()).rejects.toBe(failure)

    const spans = spanEnds(entries)
    expect(spans).toHaveLength(3)
    expect(spans[0]).toMatchObject({
      level: 'INFO',
      message: 'span.end SearchWorker.search',
      traceId: trace.traceId,
      spanId: trace.spanId,
      rpcMethod: 'search',
      span: { operation: 'SearchWorker.search', status: 'OK' },
    })
    expect((spans[0]!.span as { duration: number }).duration).toBeGreaterThanOrEqual(0)
    for (const [i, method] of [
      [1, 'fail'],
      [2, 'failAsync'],
    ] as const) {
      expect(spans[i]).toMatchObject({
        level: 'ERROR',
        message: `span.end SearchWorker.${method}`,
        rpcMethod: method,
        span: { status: 'ERROR', error: 'search failed' },
        err: { message: 'search failed' },
      })
    }
  })

  it('a thrown value that String() and instanceof cannot handle is rethrown as is, spans or not', async () => {
    const odd = Object.create(null) as unknown
    class Odd extends WorkerEntrypoint<typeof ENV> {
      fail(): never {
        throw odd
      }
      async failAsync(): Promise<never> {
        await Promise.resolve()
        throw odd
      }
    }
    for (const spans of [true, false]) {
      const entries = _captureEntries()
      const worker = new (withLogging(Odd, { spans }))({} as any, ENV)
      let thrown: unknown
      try {
        worker.fail()
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBe(odd)
      await expect(worker.failAsync()).rejects.toBe(odd)
      expect(entries.filter((e) => e.level === 'ERROR')).toHaveLength(2)
    }
  })

  it("a hand-written Logger that throws: the method's own value is still rethrown, spans or not", async () => {
    class Broken extends TracedEntrypoint<typeof ENV> {
      protected override get [TracedEntrypoint.rootLogger]() {
        return brokenLogger
      }
      fail(): never {
        throw failure
      }
      async failAsync(): Promise<never> {
        await Promise.resolve()
        throw failure
      }
      ok() {
        return 1
      }
    }
    const entries = _captureEntries()
    /** The calls one path makes, each rethrowing or returning the method's own value. */
    const expectOwnValues = async (target: Pick<Broken, 'fail' | 'failAsync' | 'ok'>) => {
      let thrown: unknown
      try {
        target.fail()
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBe(failure)
      await expect(target.failAsync()).rejects.toBe(failure)
      expect(target.ok()).toBe(1) // with spans and a sampled trace, `span.end` at INFO throws too
    }
    for (const spans of [true, false]) {
      await expectOwnValues(new (withLogging(Broken, { spans }))({} as any, ENV))
    }
    // A Traced Session continuing a sampled and an unsampled caller trace.
    const Worker = withLogging(Broken, { spans: true, session: true })
    for (const traceparent of [CALLER_TRACEPARENT, `${CALLER_TRACEPARENT_BASE}-00`]) {
      await expectOwnValues(new Worker({} as any, ENV).session({ traceparent }))
      // Joining a Logging Context that is already active, whose logger throws.
      await runWithLogger({ logger: brokenLogger, traceparent }, () =>
        expectOwnValues(new Worker({} as any, ENV)),
      )
    }
    expect(entries).toHaveLength(0) // every line went to the Logger that throws
  })

  it('writes no span.end without spans: true', () => {
    const entries = _captureEntries()
    const worker = new (withLogging(SearchWorker))({} as any, ENV)

    worker.search('cats')
    expect(() => worker.fail()).toThrow(failure)

    expect(spanEnds(entries)).toHaveLength(0)
  })

  it('without spans, a throw writes one ERROR line with err and rpcMethod, then is rethrown', async () => {
    const entries = _captureEntries()
    const thrown = new Error('fetch failed')
    class WithFetch extends SearchWorker {
      fetch(_request: Request): Response {
        throw thrown
      }
    }
    const worker = new (withLogging(WithFetch))({} as any, ENV)

    expect(() => worker.fail()).toThrow(failure)
    await expect(worker.failAsync()).rejects.toBe(failure)
    expect(() => worker.fetch(new Request('https://svc/x'))).toThrow(thrown)
    worker.search('cats')

    expect(entries.filter((e) => e.level === 'ERROR')).toEqual([
      expect.objectContaining({
        message: 'WithFetch.fail failed',
        span: expect.objectContaining({ operation: 'WithFetch.fail', status: 'ERROR' }),
        rpcMethod: 'fail',
        entrypoint: 'WithFetch',
        service: 'search',
        err: expect.objectContaining({ message: 'search failed' }),
      }),
      expect.objectContaining({ message: 'WithFetch.failAsync failed', rpcMethod: 'failAsync' }),
      expect.objectContaining({
        message: 'WithFetch.fetch failed',
        rpcMethod: 'fetch',
        err: expect.objectContaining({ message: 'fetch failed' }),
      }),
    ])
    expect(spanEnds(entries)).toHaveLength(0)
  })

  it('without spans, a throw through a nested call or a session is logged once', async () => {
    const entries = _captureEntries()
    class Nesting extends SearchWorker {
      outer() {
        return this.fail()
      }
    }
    const worker = new (withLogging(Nesting, { session: true }))({} as any, ENV)

    expect(() => worker.outer()).toThrow(failure)
    expect(() => tracedSession(worker).fail()).toThrow(failure)

    expect(entries.filter((e) => e.level === 'ERROR')).toEqual([
      expect.objectContaining({ message: 'Nesting.outer failed', rpcMethod: 'outer' }),
      expect.objectContaining({ message: 'Nesting.fail failed', rpcMethod: 'fail' }),
    ])
  })

  it('with spans, a throw writes only the span.end at ERROR; unsampled, one failed line', async () => {
    const entries = _captureEntries()
    class WithFetch extends WorkerEntrypoint<typeof ENV> {
      fetch(_request: Request): Response {
        throw failure
      }
    }
    const worker = new (withLogging(WithFetch, { spans: true }))({} as any, ENV)
    const sampled = new Request('https://svc/x', { headers: { traceparent: CALLER_TRACEPARENT } })
    const unsampled = new Request('https://svc/x', {
      headers: { traceparent: `${CALLER_TRACEPARENT_BASE}-00` },
    })

    expect(() => worker.fetch(sampled)).toThrow(failure)
    expect(entries.filter((e) => e.level === 'ERROR').map((e) => e.message)).toEqual([
      'span.end WithFetch.fetch',
    ])

    entries.length = 0
    expect(() => worker.fetch(unsampled)).toThrow(failure)
    expect(entries).toEqual([
      expect.objectContaining({
        level: 'ERROR',
        message: 'WithFetch.fetch failed',
        span: expect.objectContaining({ operation: 'WithFetch.fetch', status: 'ERROR' }),
        rpcMethod: 'fetch',
        traceId: '11111111111111111111111111111111',
      }),
    ])
  })

  it('a public method called from another one stays in the same trace', () => {
    const entries = _captureEntries()
    const worker = new (withLogging(SearchWorker, { spans: true }))({} as any, ENV)

    const { outer, inner, after } = worker.nested()

    expect(inner!.traceId).toBe(outer!.traceId)
    expect(inner!.parentSpanId).toBe(outer!.spanId)
    expect(after).toEqual(outer)
    expect(spanEnds(entries).map((e) => e.message)).toEqual([
      'span.end SearchWorker.search',
      'span.end SearchWorker.nested',
    ])
  })

  it('reads the Root Logger from env through the Env Mapping and shares the cached instance', () => {
    const entries = _captureEntries()
    interface Env {
      SERVICE: string
      CF_VERSION_METADATA: { id: string }
    }
    class Mapped extends WorkerEntrypoint<Env> {
      hello() {
        getLogger().info('hello')
      }
    }
    const Worker = withLogging(Mapped, {
      env: { service: 'SERVICE', version: (e) => e.CF_VERSION_METADATA.id },
    })

    new Worker({} as any, { SERVICE: 'mapped', CF_VERSION_METADATA: { id: 'v-1' } }).hello()

    expect(entries[0]).toMatchObject({ service: 'mapped', version: 'v-1', message: 'hello' })
    const sameOptions = new TracedEntrypoint({} as any, { NAME: 'mapped', VERSION: 'v-1' })
    expect(_getDefaultLogger()).toBe((sameOptions as any)[TracedEntrypoint.rootLogger])
  })

  it('registers the Root Logger as the Default Logger, first seen wins', () => {
    const entries = _captureEntries()
    const worker = new (withLogging(SearchWorker))({} as any, ENV)
    const second = new (withLogging(SearchWorker))({} as any, { ...ENV, NAME: 'second' })

    worker.scheduled()
    second.scheduled()

    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry).toMatchObject({ service: 'search', message: 'scheduled' })
      expect(entry).not.toHaveProperty('traceId')
    }

    const explicit = createLogger({ service: 'explicit' })
    setDefaultLogger(explicit)
    new (withLogging(SearchWorker))({} as any, ENV).scheduled()
    expect(_getDefaultLogger()).toBe(explicit)
    expect(entries.at(-1)).toMatchObject({ service: 'explicit' })
  })

  it('adds no RPC methods: the prototype has the same method names, handlers untouched', () => {
    const Worker = withLogging(SearchWorker, { spans: true })

    expect(Object.getPrototypeOf(Worker)).toBe(SearchWorker)
    expect(Worker.name).toBe('SearchWorker')
    expect(ownNames(Worker.prototype)).toEqual(RPC_METHODS)
    for (const name of Object.getOwnPropertyNames(Worker.prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, name)!
      expect(descriptor.enumerable).toBe(false)
      expect(typeof descriptor.value).toBe('function')
    }
    expect(Worker.prototype.search.name).toBe('search')
    // Handlers and accessors are inherited unchanged, not wrapped.
    expect(Worker.prototype.scheduled).toBe(SearchWorker.prototype.scheduled)
    expect(Worker.prototype.queue).toBe(SearchWorker.prototype.queue)
    expect(Worker.prototype.tail).toBe(SearchWorker.prototype.tail)
    const worker = new Worker({} as any, ENV)
    expect(worker.computed).toBe('getter')
    // Only the fields WorkerEntrypoint itself sets; no instance methods.
    expect(Object.getOwnPropertyNames(worker)).toEqual(['env'])
    expect('session' in Worker.prototype).toBe(false)
  })

  it('wraps public methods inherited from a base class, keeping this.env', () => {
    const entries = _captureEntries()
    class Base extends WorkerEntrypoint<typeof ENV> {
      whoami() {
        getLogger().info('base')
        return this.env.NAME
      }
    }
    class Derived extends Base {}
    const Worker = withLogging(Derived)

    expect(new Worker({} as any, ENV).whoami()).toBe('search')
    expect(ownNames(Worker.prototype)).toEqual(new Set(['constructor', 'whoami']))
    expect(entries[0]).toMatchObject({ rpcMethod: 'whoami', entrypoint: 'Derived' })
    expect(entries[0]).toHaveProperty('traceId')
  })

  it('session: true adds session(init), which continues the caller trace', async () => {
    const entries = _captureEntries()
    const Worker = withLogging(SearchWorker, { spans: true, session: true })
    const binding = new Worker({} as any, ENV)

    let callerSpanId: string | undefined
    const trace = await runWithLogger(
      { logger: createLogger({ service: 'caller' }), traceparent: CALLER_TRACEPARENT },
      () => {
        callerSpanId = getTraceContext()!.spanId
        return withTrace(binding, (s) => s.search('cats').trace, { requestId: 'req-1' })
      },
    )

    expect(trace).toMatchObject({
      traceId: '11111111111111111111111111111111',
      parentSpanId: callerSpanId,
    })
    expect(entries.find((e) => e.message === 'searching')).toMatchObject({
      service: 'search',
      traceId: '11111111111111111111111111111111',
      spanId: trace!.spanId,
      parentSpanId: callerSpanId,
      requestId: 'req-1',
      rpcMethod: 'search',
      entrypoint: 'SearchWorker',
    })
    expect(spanEnds(entries)).toHaveLength(1)
    expect(spanEnds(entries)[0]).toMatchObject({
      message: 'span.end SearchWorker.search',
      parentSpanId: callerSpanId,
      rpcMethod: 'search',
    })
  })

  it('a session() Traced Session rethrows unchanged and has only the RPC methods', async () => {
    const entries = _captureEntries()
    const Worker = withLogging(SearchWorker, { spans: true, session: true })
    const session = tracedSession(new Worker({} as any, ENV))

    expect(session).toBeInstanceOf(TracedSession)
    expect(() => session.fail()).toThrow(failure)
    await expect(session.failAsync()).rejects.toBe(failure)
    expect(session.target()).toBe(returnedTarget)
    expect(spanEnds(entries).map((e) => e.level)).toEqual(['ERROR', 'ERROR', 'INFO'])

    expect(ownNames(Object.getPrototypeOf(session))).toEqual(RPC_METHODS)
    expect(ownNames(Worker.prototype)).toEqual(new Set([...RPC_METHODS, 'session']))
    // `traced` and `logger` are instance properties, which JSRPC never exposes.
    expect(rpcSurface(session)).toEqual(
      new Set([...RPC_METHODS].filter((n) => n !== 'constructor')),
    )
    expect(ownNames(session)).toEqual(new Set(['env', 'traced', 'logger']))
  })

  it('session: true rejects a class that already defines session()', () => {
    class HasSession extends WorkerEntrypoint {
      session() {
        return {}
      }
    }
    expect(() => withLogging(HasSession, { session: true })).toThrow(/already defines session/)
  })

  it('fetch gets a Logging Context that continues an incoming traceparent', async () => {
    const entries = _captureEntries()
    const response = new Response('ok')
    class WithFetch extends WorkerEntrypoint<typeof ENV> {
      fetch(request: Request) {
        getLogger().info({ path: new URL(request.url).pathname }, 'fetch')
        return response
      }
    }
    const worker = new (withLogging(WithFetch, { spans: true }))({} as any, ENV)

    const result = await worker.fetch(
      new Request('https://svc/ping', { headers: { traceparent: CALLER_TRACEPARENT } }),
    )
    await worker.fetch(new Request('https://svc/fresh'))

    expect(result).toBe(response)
    expect(entries[0]).toMatchObject({
      message: 'fetch',
      path: '/ping',
      service: 'search',
      traceId: '11111111111111111111111111111111',
      parentSpanId: '2222222222222222',
      rpcMethod: 'fetch',
      entrypoint: 'WithFetch',
    })
    expect(entries[1]).toMatchObject({ message: 'span.end WithFetch.fetch' })
    expect(entries[2]).toMatchObject({ message: 'fetch', path: '/fresh' })
    expect(entries[2]!.traceId).not.toBe('11111111111111111111111111111111')
  })

  it('a nested call keeps the caller rpcMethod; only the child Span names the callee', () => {
    const entries = _captureEntries()
    const worker = new (withLogging(SearchWorker, { spans: true }))({} as any, ENV)

    worker.nested()

    expect(entries.find((e) => e.message === 'searching')).toMatchObject({ rpcMethod: 'nested' })
    expect(spanEnds(entries)).toMatchObject([
      { message: 'span.end SearchWorker.search', rpcMethod: 'nested' },
      { message: 'span.end SearchWorker.nested', rpcMethod: 'nested' },
    ])
  })

  it('user methods named traced and logger work on the entrypoint and on the session', () => {
    const entries = _captureEntries()
    class Shadowing extends WorkerEntrypoint<typeof ENV> {
      traced(n: number) {
        getLogger().info('in traced')
        return n * 2
      }

      logger() {
        return 'mine'
      }
    }
    const worker = new (withLogging(Shadowing, { spans: true, session: true }))({} as any, ENV)

    expect(worker.traced(2)).toBe(4)
    expect(worker.logger()).toBe('mine')
    const session = tracedSession(worker) as unknown as Shadowing
    expect(session.traced(3)).toBe(6)
    expect(session.logger()).toBe('mine')

    expect(entries.filter((e) => e.message === 'in traced')).toMatchObject([
      { rpcMethod: 'traced', entrypoint: 'Shadowing' },
      { rpcMethod: 'traced', entrypoint: 'Shadowing' },
    ])
    expect(spanEnds(entries).map((e) => e.message)).toEqual([
      'span.end Shadowing.traced',
      'span.end Shadowing.logger',
      'span.end Shadowing.traced',
      'span.end Shadowing.logger',
    ])
  })

  it('wrapping a TracedEntrypoint subclass uses its Root Logger hook (its Env Mapping hook)', () => {
    const entries = _captureEntries()
    interface Env {
      NAME: string
      SERVICE: string
    }
    class Mapped extends TracedEntrypoint<Env> {
      protected override get [TracedEntrypoint.envMapping](): EnvMapping<Env> {
        return { service: 'SERVICE' }
      }

      hello() {
        getLogger().info('hello')
      }
    }
    const env = { NAME: 'wrong', SERVICE: 'mapped' }
    const worker = new (withLogging(Mapped, { session: true }))({} as any, env)

    worker.hello()
    ;(tracedSession(worker) as unknown as Mapped).hello()

    expect(entries.map((e) => e.service)).toEqual(['mapped', 'mapped'])
    expect(_getDefaultLogger()).toBe((worker as any)[TracedEntrypoint.rootLogger])
    expect(() => withLogging(Mapped, { env: { service: 'NAME' } })).toThrow(
      /TracedEntrypoint.*envMapping/,
    )
  })

  it('session: true rejects a session getter, own or inherited', () => {
    class Getter extends WorkerEntrypoint {
      get session() {
        return 1
      }
    }
    class Inherits extends Getter {}
    expect(() => withLogging(Getter, { session: true })).toThrow(/already defines session/)
    expect(() => withLogging(Inherits, { session: true })).toThrow(/already defines session/)
  })

  it('wrapping a wrapped class returns it with the same options and throws with others', () => {
    const entries = _captureEntries()
    const mapping = { service: 'NAME' } as const
    const Once = withLogging(SearchWorker, { spans: true, session: true, env: mapping })

    const Twice = withLogging(Once, { spans: true, session: true, env: { service: 'NAME' } })
    expect(Twice).toBe(Once)
    new Twice({} as any, ENV).search('cats')
    expect(spanEnds(entries)).toHaveLength(1)

    expect(() => withLogging(Once, { session: true, env: mapping })).toThrow(
      /already wrapped with other options/,
    )
    expect(() => withLogging(Once, { spans: true, env: mapping })).toThrow(
      /already wrapped with other options/,
    )
    expect(() => withLogging(Once, { spans: true, session: true })).toThrow(
      /already wrapped with other options/,
    )
    const Plain = withLogging(SearchWorker)
    expect(withLogging(Plain)).toBe(Plain)
    expect(withLogging(Plain, { spans: false, session: false, env: {} })).toBe(Plain)

    class Sub extends Plain {}
    expect(() => withLogging(Sub)).toThrow(/extends a class already wrapped/)
    // The marker is not a visible property.
    expect(Reflect.ownKeys(Once)).toEqual(Reflect.ownKeys(withLogging(SearchWorker)))
  })

  it('fetch: false leaves fetch inherited unchanged, with no Logging Context of its own', async () => {
    const entries = _captureEntries()
    class WithFetch extends WorkerEntrypoint<typeof ENV> {
      fetch() {
        getLogger().info('fetch')
        return new Response(String(!!getTraceContext()))
      }
      search() {
        getLogger().info('searching')
      }
    }
    const Worker = withLogging(WithFetch, { spans: true, fetch: false })

    expect(Object.hasOwn(Worker.prototype, 'fetch')).toBe(false)
    expect(Worker.prototype.fetch).toBe(WithFetch.prototype.fetch)
    const worker = new Worker({} as any, ENV)
    expect(await worker.fetch().text()).toBe('false')
    worker.search()

    expect(entries[0]).toMatchObject({ message: 'fetch', service: 'search' })
    expect(entries[0]).not.toHaveProperty('traceId')
    expect(entries[0]).not.toHaveProperty('rpcMethod')
    // The RPC methods are still wrapped.
    expect(entries[1]).toMatchObject({ message: 'searching', rpcMethod: 'search' })
    expect(spanEnds(entries)).toMatchObject([{ message: 'span.end WithFetch.search' }])
  })

  /**
   * Send one request through a `withLogging` entrypoint whose `fetch` hands off to a
   * Hono app with `useLogger`, and return the lines logged.
   */
  const fetchThroughApp = async (options: { fetch?: boolean }, headers?: HeadersInit) => {
    const entries = _captureEntries()
    const app = new Hono()
    app.use(useLogger(createLogger({ service: 'search' })))
    app.get('/ping', (c) => {
      getLogger().info('handler')
      return c.text('ok')
    })
    class AppWorker extends WorkerEntrypoint<typeof ENV> {
      fetch(request: Request) {
        getLogger().info('handing off')
        return app.fetch(request, this.env)
      }
    }
    const worker = new (withLogging(AppWorker, { spans: true, ...options }))({} as any, ENV)
    const response = await worker.fetch(new Request('https://svc/ping', { headers }))
    expect(await response.text()).toBe('ok')
    return entries
  }

  it('fetch: false lets a Hono app with useLogger own the request: one trace', async () => {
    const unwrapped = await fetchThroughApp({ fetch: false })
    const traced = unwrapped.filter((e) => 'traceId' in e)
    expect(traced.map((e) => e.message)).toEqual([
      'request.start GET /ping',
      'handler',
      'request.end GET /ping',
    ])
    expect(new Set(traced.map((e) => e.traceId)).size).toBe(1)

    const continued = await fetchThroughApp({ fetch: false }, { traceparent: CALLER_TRACEPARENT })
    const continuedTraced = continued.filter((e) => 'traceId' in e)
    expect(continuedTraced).toHaveLength(3)
    for (const entry of continuedTraced) {
      expect(entry).toMatchObject({
        traceId: '11111111111111111111111111111111',
        parentSpanId: '2222222222222222',
      })
    }

    // The default wraps fetch as well, which splits the request into two root traces.
    const wrapped = await fetchThroughApp({})
    expect(new Set(wrapped.map((e) => e.traceId)).size).toBe(2)
  })

  it('methods added or overridden in a subclass of the wrapped class run outside any Logging Context', () => {
    const entries = _captureEntries()
    class Ext extends withLogging(SearchWorker) {
      extra() {
        getLogger().info('extra')
      }
      override search(q: string) {
        getLogger().info({ q }, 'overridden')
        return { q, trace: getTraceContext() }
      }
    }
    const worker = new Ext({} as any, ENV)

    worker.extra()
    expect(worker.search('cats').trace).toBeNull()

    expect(entries[0]).toMatchObject({ message: 'extra', service: 'search' })
    expect(entries[1]).toMatchObject({ message: 'overridden', service: 'search' })
    for (const entry of entries.slice(0, 2)) {
      expect(entry).not.toHaveProperty('traceId')
      expect(entry).not.toHaveProperty('rpcMethod')
    }
  })

  it('throws for a class that does not extend WorkerEntrypoint', () => {
    class Room {
      constructor(
        readonly ctx: unknown,
        readonly env: unknown,
      ) {}
      alarm() {}
      webSocketMessage() {}
    }
    expect(() => withLogging(Room as any)).toThrow(
      /withLogging\(Room\): Room does not extend WorkerEntrypoint/,
    )
    expect(() => withLogging(WorkerEntrypoint as any)).toThrow(/does not extend WorkerEntrypoint/)
    expect(() => withLogging(class {} as any)).toThrow(/the class does not extend WorkerEntrypoint/)
  })

  it('an anonymous class gets no entrypoint field and a bare span name', () => {
    const entries = _captureEntries()
    const Anonymous = (() =>
      class extends WorkerEntrypoint<typeof ENV> {
        search() {
          getLogger().info('searching')
        }
      })()
    expect(Anonymous.name).toBe('')

    new (withLogging(Anonymous, { spans: true }))({} as any, ENV).search()

    expect(entries[0]).toMatchObject({ message: 'searching', rpcMethod: 'search' })
    expect(entries[0]).not.toHaveProperty('entrypoint')
    expect(spanEnds(entries)).toMatchObject([{ message: 'span.end search' }])
  })

  it('the double-wrap guard compares fetch too (default true)', () => {
    const Plain = withLogging(SearchWorker)
    expect(withLogging(Plain, { fetch: true })).toBe(Plain)
    expect(() => withLogging(Plain, { fetch: false })).toThrow(/already wrapped with other options/)
    const NoFetch = withLogging(SearchWorker, { fetch: false })
    expect(withLogging(NoFetch, { fetch: false })).toBe(NoFetch)
    expect(() => withLogging(NoFetch)).toThrow(/already wrapped with other options/)
  })
})

describe('the JSRPC surface of a Traced Session', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  const ENV = { NAME: 'receiver' }
  const CALLER_TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01'

  class UserSession extends TracedSession<typeof ENV> {
    add(a: number, b: number) {
      return this.traced(() => {
        this.logger.info({ a, b }, 'adding')
        return { sum: a + b, trace: getTraceContext() }
      }, 'user.add')
    }
  }

  class DerivedSession extends UserSession {
    double(n: number) {
      return this.traced(() => n * 2)
    }
  }

  it('a TracedSession subclass exposes only its own methods, not traced or logger', () => {
    const entries = _captureEntries()
    const session = new DerivedSession(
      { traceparent: CALLER_TRACEPARENT },
      createLogger({ service: 'receiver' }),
      ENV,
    )

    expect(rpcSurface(session)).toEqual(new Set(['add', 'double']))
    expect(rpcSurface(new TracedSession({}, createLogger({ service: 'x' }), ENV))).toEqual(
      new Set(),
    )
    // Instance properties, which JSRPC never exposes, and not enumerable.
    expect(Object.keys(session)).toEqual(['env'])
    expect(ownNames(session)).toEqual(new Set(['env', 'traced', 'logger']))

    // The subclass API is unchanged.
    expect(session.add(2, 3).sum).toBe(5)
    expect(session.add(2, 3).trace!.traceId).toBe('11111111111111111111111111111111')
    expect(session.double(4)).toBe(8)
    expect(entries.find((e) => e.message === 'adding')).toMatchObject({
      service: 'receiver',
      traceId: '11111111111111111111111111111111',
      parentSpanId: '2222222222222222',
    })
    expect(spanEnds(entries)[0]).toMatchObject({ message: 'span.end user.add' })
  })

  it("tracedWorker's sessions expose only the session class's methods", () => {
    const Worker = tracedWorker(UserSession)
    const session = new Worker(undefined, ENV).session({ traceparent: CALLER_TRACEPARENT })

    expect(session).toBeInstanceOf(UserSession)
    expect(rpcSurface(session)).toEqual(new Set(['add']))
    expect(session.add(1, 1).trace!.traceId).toBe('11111111111111111111111111111111')
  })

  it("withLogging({ session: true })'s sessions expose only the entrypoint's RPC methods", () => {
    class Plain extends WorkerEntrypoint<typeof ENV> {
      hello(name: string) {
        getLogger().info({ name }, 'hello')
        return getTraceContext()
      }

      bye() {
        return 'bye'
      }

      fetch() {
        return new Response('ok')
      }
    }
    const Worker = withLogging(Plain, { session: true })
    const worker = new Worker({} as any, ENV)
    const session = worker.session({ traceparent: CALLER_TRACEPARENT })

    expect(rpcSurface(session)).toEqual(new Set(['hello', 'bye']))
    expect(session.hello('ada')!.traceId).toBe('11111111111111111111111111111111')
  })
})

describe('the JSRPC surface of a TracedEntrypoint', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  interface Env {
    NAME: string
    SERVICE: string
    RELEASE: string
    SECRET: string
  }
  const ENV: Env = { NAME: 'wrong', SERVICE: 'billing', RELEASE: 'r-7', SECRET: 'hunter2' }
  const CALLER_TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01'
  const HOOKS = ['envMapping', 'loggerOptions', 'rootLogger']

  class BillingSession extends TracedSession<Env> {
    total(n: number) {
      return this.traced(() => {
        this.logger.debug({ n }, 'totalling')
        return n
      }, 'billing.total')
    }
  }

  it('a TracedEntrypoint subclass exposes only its own methods, not its hooks', () => {
    class Billing extends TracedEntrypoint<Env> {
      protected override get [TracedEntrypoint.envMapping](): EnvMapping<Env> {
        return { version: (env) => `v-${env.SECRET}` }
      }

      session(init: SessionInit) {
        return new BillingSession(init, this[TracedEntrypoint.rootLogger], this.env)
      }

      scheduled() {}
    }
    const entrypoint = new Billing({} as any, ENV)

    expect(rpcSurface(entrypoint, WorkerEntrypoint.prototype)).toEqual(
      new Set(['session', 'scheduled']),
    )
    expect(rpcSurface(new TracedEntrypoint({} as any, ENV), WorkerEntrypoint.prototype)).toEqual(
      new Set(),
    )
    for (const name of HOOKS) expect(name in entrypoint).toBe(false)
    // The hooks are symbol-keyed, which JSRPC never exposes.
    expect(Object.getOwnPropertySymbols(TracedEntrypoint.prototype)).toEqual([
      TracedEntrypoint.envMapping,
      TracedEntrypoint.loggerOptions,
      TracedEntrypoint.rootLogger,
    ])
    expect((entrypoint as any)[TracedEntrypoint.loggerOptions].version).toBe('v-hunter2')
  })

  it('a tracedWorker entrypoint exposes only session and fetch, and keeps its env mapping', () => {
    const entries = _captureEntries()
    const Worker = tracedWorker(BillingSession, {
      env: { service: 'SERVICE', version: (env) => `v-${env.SECRET}`, level: () => 'debug' },
    })
    const worker = new Worker(undefined, ENV)

    expect(rpcSurface(worker, WorkerEntrypoint.prototype)).toEqual(new Set(['session', 'fetch']))
    for (const name of HOOKS) expect(name in worker).toBe(false)

    expect(worker.session({ traceparent: CALLER_TRACEPARENT }).total(3)).toBe(3)
    expect(entries.find((e) => e.message === 'totalling')).toMatchObject({
      service: 'billing',
      version: 'v-hunter2',
      traceId: '11111111111111111111111111111111',
    })
  })

  it('a subclass customizes the env mapping, the Logger Options and the Root Logger', () => {
    const entries = _captureEntries()
    let custom: Logger | undefined

    class Billing extends TracedEntrypoint<Env> {
      protected override get [TracedEntrypoint.envMapping](): EnvMapping<Env> {
        return { service: 'SERVICE', version: (env) => env.RELEASE }
      }

      protected override get [TracedEntrypoint.loggerOptions](): LoggerOptions {
        // Built on the mapped options, from this.env.
        return { ...super[TracedEntrypoint.loggerOptions], level: 'debug' }
      }

      protected override get [TracedEntrypoint.rootLogger](): Logger {
        return (custom ??= createLogger(this[TracedEntrypoint.loggerOptions]))
      }

      session(init: SessionInit) {
        return new BillingSession(init, this[TracedEntrypoint.rootLogger], this.env)
      }
    }
    const entrypoint = new Billing({} as any, ENV)

    expect((entrypoint as any)[TracedEntrypoint.loggerOptions]).toStrictEqual({
      service: 'billing',
      level: 'debug',
      version: 'r-7',
    })
    // The constructor registered the overridden Root Logger.
    expect(_getDefaultLogger()).toBe(custom)
    expect((entrypoint as any)[TracedEntrypoint.rootLogger]).toBe(custom)

    expect(entrypoint.session({ traceparent: CALLER_TRACEPARENT }).total(5)).toBe(5)
    expect(entries.find((e) => e.message === 'totalling')).toMatchObject({
      level: 'DEBUG',
      service: 'billing',
      version: 'r-7',
      traceId: '11111111111111111111111111111111',
      parentSpanId: '2222222222222222',
    })
  })
})

describe('withLogging(DurableObject)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  const ENV = { NAME: 'jobs', ENVIRONMENT: 'staging', VERSION: '2.0.0' }
  const CALLER_TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01'
  const failure = new Error('room failed')

  class Room extends DurableObject<typeof ENV> {
    async join(user: string) {
      getLogger().info({ user }, 'joined')
      return { user, trace: getTraceContext() }
    }

    async fail(): Promise<never> {
      throw failure
    }

    fetch(request: Request) {
      getLogger().info('room fetch')
      return new Response(String(getTraceContext()?.traceId ?? ''), {
        headers: { path: new URL(request.url).pathname },
      })
    }

    alarm() {
      getLogger().info('alarm')
    }

    webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
      getLogger().info({ message: String(message) }, 'ws message')
    }

    webSocketClose(_ws: WebSocket, code: number) {
      getLogger().info({ code }, 'ws close')
    }

    webSocketError(_ws: WebSocket, error: unknown) {
      getLogger().info({ error: String(error) }, 'ws error')
    }

    connect() {
      getLogger().info('connect')
    }
  }

  it('fetch, RPC methods, alarm and webSocket* each run in a Logging Context', async () => {
    const entries = _captureEntries()
    const Logged = withLogging(Room)
    const room = new Logged(state('lobby'), ENV)

    const { trace } = await room.join('ada')
    await room.fetch(new Request('https://room/x'))
    await room.alarm()
    await room.webSocketMessage({} as WebSocket, 'hi')
    await room.webSocketClose({} as WebSocket, 1000)
    await room.webSocketError({} as WebSocket, 'boom')

    const common = {
      service: 'jobs',
      environment: 'staging',
      durableObject: 'Room',
      objectId: 'a'.repeat(64),
      objectName: 'lobby',
    }
    expect(linesOf(entries, 'joined')[0]).toMatchObject({
      ...common,
      rpcMethod: 'join',
      traceId: trace!.traceId,
    })
    for (const [message, rpcMethod] of [
      ['room fetch', 'fetch'],
      ['alarm', 'alarm'],
      ['ws message', 'webSocketMessage'],
      ['ws close', 'webSocketClose'],
      ['ws error', 'webSocketError'],
    ]) {
      const line = linesOf(entries, message)[0]
      expect(line).toMatchObject({ ...common, rpcMethod })
      expect(line!.traceId).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('has objectId alone when the id has no name', async () => {
    const entries = _captureEntries()
    const room = new (withLogging(Room))(state(), ENV)
    await room.join('bob')
    const line = linesOf(entries, 'joined')[0]
    expect(line).toMatchObject({ durableObject: 'Room', objectId: 'a'.repeat(64) })
    expect(line).not.toHaveProperty('objectName')
  })

  it('fetch continues a traceparent header; fetch: false leaves it unwrapped', async () => {
    const room = new (withLogging(Room))(state('lobby'), ENV)
    const res = await room.fetch(
      new Request('https://room/x', { headers: { traceparent: CALLER_TRACEPARENT } }),
    )
    expect(await res.text()).toBe('11111111111111111111111111111111')

    const Unwrapped = withLogging(class Plain extends Room {}, { fetch: false })
    const plain = new Unwrapped(state('lobby'), ENV)
    expect(await (await plain.fetch(new Request('https://room/x'))).text()).toBe('')
  })

  it('values pass through; a throw is logged in a Span at ERROR and rethrown unchanged', async () => {
    const entries = _captureEntries()
    const room = new (withLogging(Room, { spans: true }))(state('lobby'), ENV)

    expect((await room.join('ada')).user).toBe('ada')
    await expect(room.fail()).rejects.toBe(failure)

    expect(linesOf(entries, 'span.end Room.join')[0]).toMatchObject({
      level: 'INFO',
      durableObject: 'Room',
      objectName: 'lobby',
    })
    expect(linesOf(entries, 'span.end Room.fail')[0]).toMatchObject({
      level: 'ERROR',
      rpcMethod: 'fail',
      span: { status: 'ERROR', error: 'room failed' },
      err: { message: 'room failed' },
    })
  })

  it('without spans, a throw in alarm, fetch or an RPC method writes one ERROR line', async () => {
    const entries = _captureEntries()
    const alarmFailure = new Error('alarm failed')
    class Failing extends Room {
      override alarm() {
        throw alarmFailure
      }

      override fetch(_request: Request): Response {
        throw failure
      }
    }
    const room = new (withLogging(Failing))(state('lobby'), ENV)

    expect(() => room.alarm()).toThrow(alarmFailure)
    expect(() => room.fetch(new Request('https://room/x'))).toThrow(failure)
    await expect(room.fail()).rejects.toBe(failure)

    const common = { level: 'ERROR', durableObject: 'Failing', objectId: 'a'.repeat(64) }
    expect(entries).toEqual([
      expect.objectContaining({
        ...common,
        message: 'Failing.alarm failed',
        rpcMethod: 'alarm',
        err: expect.objectContaining({ message: 'alarm failed' }),
      }),
      expect.objectContaining({ ...common, message: 'Failing.fetch failed', rpcMethod: 'fetch' }),
      expect.objectContaining({
        ...common,
        message: 'Failing.fail failed',
        rpcMethod: 'fail',
        err: expect.objectContaining({ message: 'room failed' }),
      }),
    ])
  })

  it('adds no RPC methods, leaves connect unwrapped, and rejects session', () => {
    const Logged = withLogging(Room)
    expect(ownNames(Logged.prototype)).toEqual(
      new Set([
        'alarm',
        'constructor',
        'fail',
        'fetch',
        'join',
        'webSocketClose',
        'webSocketError',
        'webSocketMessage',
      ]),
    )
    expect(() => withLogging(class Other extends Room {}, { session: true } as any)).toThrow(
      /session/,
    )
  })

  it('honours the Env Mapping and registers the Default Logger in the constructor', async () => {
    const entries = _captureEntries()
    const Logged = withLogging(class Mapped extends Room {}, { env: { service: 'NAME' } })
    expect(new Logged(state('lobby'), { NAME: 'rooms' } as typeof ENV)).toBeInstanceOf(Logged)

    getLogger().info('outside')
    expect(linesOf(entries, 'outside')[0]).toMatchObject({ service: 'rooms' })
  })

  it('still throws for a class that is neither a WorkerEntrypoint nor a DurableObject', () => {
    class Plain {
      method() {}
    }
    expect(() => withLogging(Plain as any)).toThrow(/WorkerEntrypoint or DurableObject/)
  })
})

const SPAN_SAMPLED = '00-11111111111111111111111111111111-2222222222222222-01'
const SPAN_UNSAMPLED = '00-11111111111111111111111111111111-2222222222222222-00'
const elapse = (ms: number) => vi.setSystemTime(Date.now() + ms)

class SpanSession extends TracedSession {
  fast() {
    return this.traced(
      (span) => {
        span.set({ rows: 3 })
        this.logger.info('inside')
        return 'fast'
      },
      'db.fast',
      { level: 'debug', slowMs: 100, fields: { table: 'users' } },
    )
  }

  slow() {
    return this.traced(() => (elapse(150), 'slow'), 'db.slow', { level: 'debug', slowMs: 100 })
  }

  fail() {
    return this.traced(
      (span) => {
        span.set({ rows: 0 })
        throw new Error('db down')
      },
      'db.fail',
      { level: 'debug', fields: { table: 'users' } },
    )
  }

  plain() {
    return this.traced((span) => (span.set({ ignored: true }), 'plain'))
  }

  defaults() {
    return this.traced(() => elapse(10), 'db.defaults')
  }
}

/** A TracedEntrypoint whose Logger Options hook sets `spans`. */
const withSpans = (spans: LoggerOptions['spans']) =>
  class extends TracedEntrypoint {
    protected override get [TracedEntrypoint.loggerOptions](): LoggerOptions {
      return { service: 'svc', level: 'trace', spans }
    }
    session(init: SessionInit) {
      return new SpanSession(init, this[TracedEntrypoint.rootLogger], this.env)
    }
  }

describe('Span options and Span Defaults in the Workers helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
    _reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('traced(fn, operation, options): level, slowMs and Span Fields as for withSpan', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc', level: 'trace' })
    const session = new SpanSession({ traceparent: SPAN_SAMPLED }, logger, {})

    expect(session.fast()).toBe('fast')
    expect(session.slow()).toBe('slow')
    expect(() => session.fail()).toThrow('db down')
    expect(session.plain()).toBe('plain')

    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ['INFO', 'inside'],
      ['DEBUG', 'span.end db.fast'],
      ['WARN', 'span.end db.slow'],
      ['ERROR', 'span.end db.fail'],
    ])
    expect(entries[0]).not.toHaveProperty('table')
    expect(entries[0]).not.toHaveProperty('rows')
    expect(entries[1]).toMatchObject({ table: 'users', rows: 3 })
    expect(entries[3]).toMatchObject({ table: 'users', rows: 0, err: { message: 'db down' } })
  })

  it('traced() on an unsampled trace: OK writes nothing, a throw writes <op> failed without Span Fields', () => {
    const entries = _captureEntries()
    const session = new SpanSession(
      { traceparent: SPAN_UNSAMPLED },
      createLogger({ service: 'svc' }),
      {},
    )

    session.slow()
    expect(() => session.fail()).toThrow('db down')

    expect(entries.map((e) => [e.level, e.message])).toEqual([['ERROR', 'db.fail failed']])
    expect(entries[0]).not.toHaveProperty('table')
  })

  it("tracedWorker: the Root Logger's Span Defaults come from LOG_SPAN_LEVEL and LOG_SPAN_SLOW_MS", () => {
    const entries = _captureEntries()
    const Worker = tracedWorker(SpanSession)
    const env = { NAME: 'svc', LOG_LEVEL: 'debug', LOG_SPAN_LEVEL: 'debug', LOG_SPAN_SLOW_MS: '5' }
    const session = new Worker(undefined, env).session({ traceparent: SPAN_SAMPLED })

    session.defaults()
    expect(entries.map((e) => [e.level, e.message])).toEqual([['WARN', 'span.end db.defaults']])
  })

  it('withLogging: method Spans and withSpan inside them use the env Span Defaults', () => {
    const entries = _captureEntries()
    class Worker extends WorkerEntrypoint {
      search() {
        elapse(10)
        return withSpan('db.query', () => elapse(1))
      }
    }
    const env = { NAME: 'svc', LOG_LEVEL: 'debug', LOG_SPAN_LEVEL: 'debug', LOG_SPAN_SLOW_MS: '10' }
    new (withLogging(Worker, { spans: true }))({} as any, env).search()

    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ['DEBUG', 'span.end db.query'],
      ['WARN', 'span.end Worker.search'],
    ])
  })

  it('withLogging without spans: no span.end however slow, and a throw is still <Class>.<method> failed', () => {
    const entries = _captureEntries()
    class Worker extends WorkerEntrypoint {
      slow() {
        elapse(1000)
      }
      fail() {
        throw new Error('nope')
      }
    }
    const env = { NAME: 'svc', LOG_SPAN_SLOW_MS: '0' }
    const worker = new (withLogging(Worker))({} as any, env)
    worker.slow()
    expect(() => worker.fail()).toThrow('nope')

    expect(entries.map((e) => [e.level, e.message])).toEqual([['ERROR', 'Worker.fail failed']])
  })

  it('TracedEntrypoint: the Logger Options hook can set spans; each spans config gets its own Root Logger', () => {
    const entries = _captureEntries()
    const Debug = withSpans({ level: 'debug' })
    const Warn = withSpans({ level: 'warn' })

    new Debug({} as any, {}).session({ traceparent: SPAN_SAMPLED }).defaults()
    new Warn({} as any, {}).session({ traceparent: SPAN_SAMPLED }).defaults()
    new (withSpans(undefined))({} as any, {}).session({ traceparent: SPAN_SAMPLED }).defaults()

    expect(entries.map((e) => e.level)).toEqual(['DEBUG', 'WARN', 'INFO'])
  })
})

/** An Error with a key the application leaves out. */
const errorWithBody = () => Object.assign(new Error('failed'), { body: 'secret' })

describe('serializeError and limits in the Workers helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
    for (const key of Object.keys(workersEnv)) delete workersEnv[key]
  })

  const serializeError = omitErrorKeys(['body'])

  class FailSession extends TracedSession {
    fail() {
      return this.traced(() => {
        throw errorWithBody()
      }, 'op.fail')
    }
  }

  it('tracedWorker: serializeError from the options, limits from env', () => {
    const entries = _captureEntries()
    const Worker = tracedWorker(FailSession, { serializeError })
    const env = { NAME: 'svc', LOG_MAX_STRING_LENGTH: '4' }
    expect(() => new Worker(undefined, env).session({ traceparent: SPAN_SAMPLED }).fail()).toThrow(
      'failed',
    )
    expect(entries[0]!.err).toMatchObject({
      message: 'fail…[truncated from 6 chars]',
      omitted: ['body'],
    })
  })

  it('withLogging: serializeError from the options; it is part of "the same options"', () => {
    const entries = _captureEntries()
    class Worker extends WorkerEntrypoint {
      fail() {
        throw errorWithBody()
      }
    }
    const Logged = withLogging(Worker, { serializeError })
    expect(withLogging(Logged, { serializeError })).toBe(Logged)
    expect(() => withLogging(Logged)).toThrow('already wrapped with other options')
    expect(() => new Logged({} as any, { NAME: 'svc' }).fail()).toThrow('failed')
    expect(entries[0]!.err).toMatchObject({ omitted: ['body'] })
    expect(JSON.stringify(entries)).not.toContain('secret')
  })

  it('withLogging(TracedEntrypoint) with serializeError throws: use its Logger Options hook', () => {
    class Entry extends TracedEntrypoint {}
    expect(() => withLogging(Entry, { serializeError })).toThrow(
      '[TracedEntrypoint.loggerOptions] getter instead of passing serializeError',
    )
  })

  it('TracedEntrypoint: the Logger Options hook sets serializeError and limits', () => {
    const entries = _captureEntries()
    class Entry extends TracedEntrypoint {
      protected override get [TracedEntrypoint.loggerOptions](): LoggerOptions {
        return {
          ...super[TracedEntrypoint.loggerOptions],
          serializeError,
          limits: { maxStringLength: 4 },
        }
      }
      session(init: SessionInit) {
        return new FailSession(init, this[TracedEntrypoint.rootLogger], this.env)
      }
    }
    expect(() => new Entry({} as any, {}).session({ traceparent: SPAN_SAMPLED }).fail()).toThrow(
      'failed',
    )
    expect(entries[0]!.err).toMatchObject({
      message: 'fail…[truncated from 6 chars]',
      omitted: ['body'],
    })
  })

  it('TracedEntrypoint: an inline omitErrorKeys in the hook gives one Root Logger, not one per access', () => {
    class Entry extends TracedEntrypoint {
      protected override get [TracedEntrypoint.loggerOptions](): LoggerOptions {
        return { ...super[TracedEntrypoint.loggerOptions], serializeError: omitErrorKeys(['body']) }
      }
    }
    const roots = new Set<Logger>()
    for (let i = 0; i < 100; i++) {
      const entry = new Entry({} as any, { NAME: 'svc' }) as any
      roots.add(entry[TracedEntrypoint.rootLogger])
      roots.add(entry[TracedEntrypoint.rootLogger])
    }
    expect(roots.size).toBe(1)
  })

  it('defaultLoggerFromEnv: serializeError as its second argument; each serializer its own Root Logger', () => {
    Object.assign(workersEnv, { NAME: 'svc', LOG_MAX_RECORD_BYTES: '1024' })
    const entries = _captureEntries()
    const logger = defaultLoggerFromEnv(undefined, { serializeError })
    expect(defaultLoggerFromEnv(undefined, { serializeError })).toBe(logger)
    expect(defaultLoggerFromEnv()).not.toBe(logger)
    logger.error(errorWithBody(), 'm')
    expect(entries[0]!.err).toMatchObject({ omitted: ['body'] })
  })
})
