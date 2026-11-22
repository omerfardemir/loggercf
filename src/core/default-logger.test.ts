import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import {
  createLogger,
  getLogger,
  runWithLogger,
  setDefaultLogger,
  setLoggerContext,
  _captureEntries,
  _reset,
} from './logger'
import { useLogger } from '../hono/middleware'
import * as core from '../index'

/** The `service` a line written with `getLogger()` outside a Logging Context carries. */
function outsideService(entries: Record<string, unknown>[]): unknown {
  getLogger().info('probe')
  return entries.at(-1)?.service
}

describe('Default Logger', () => {
  beforeEach(() => _reset())

  it('without one, getLogger() outside a Logging Context is unchanged', () => {
    const entries = _captureEntries()
    getLogger().info('standalone')

    expect(entries[0]).toMatchObject({ service: 'unknown', message: 'standalone' })
    expect(entries[0]).not.toHaveProperty('environment')
    expect(entries[0]).not.toHaveProperty('version')
  })

  it('getLogger() outside a Logging Context logs through the registered default', () => {
    const entries = _captureEntries()
    const root = createLogger({
      service: 'orders',
      environment: 'production',
      version: '1.2.0',
    })
    setDefaultLogger(root)

    getLogger().info('module scope')

    expect(entries[0]).toMatchObject({
      service: 'orders',
      environment: 'production',
      version: '1.2.0',
      message: 'module scope',
    })
  })

  it('getLogger(service) with an explicit name keeps its standalone logger', () => {
    const entries = _captureEntries()
    setDefaultLogger(createLogger({ service: 'orders', environment: 'production' }))

    getLogger('cron').info('named')

    expect(entries[0]).toMatchObject({ service: 'cron', message: 'named' })
    expect(entries[0]).not.toHaveProperty('environment')
  })

  it('inside a Logging Context, getLogger() still returns the context logger', () => {
    const entries = _captureEntries()
    setDefaultLogger(createLogger({ service: 'default-svc' }))

    runWithLogger(
      { logger: createLogger({ service: 'ctx-svc' }), fields: { requestId: 'r1' } },
      () => getLogger().info('inside'),
    )

    expect(entries[0]).toMatchObject({ service: 'ctx-svc', requestId: 'r1' })
    expect(entries[0].traceId).toBeDefined()
  })

  it('a later setDefaultLogger() replaces the default', () => {
    const entries = _captureEntries()
    setDefaultLogger(createLogger({ service: 'first' }))
    setDefaultLogger(createLogger({ service: 'second' }))

    expect(outsideService(entries)).toBe('second')
  })

  it('carries no Context Fields or trace IDs, even when registered inside a Logging Context', async () => {
    const entries = _captureEntries()
    const root = createLogger({ service: 'orders' })

    await runWithLogger({ logger: root, fields: { requestId: 'req-1' } }, async () => {
      setLoggerContext({ userId: 'u-1' })
      setDefaultLogger(getLogger()) // the context's logger, not a Root Logger
    })
    getLogger().info('after the request')

    const line = entries.find((e) => e.message === 'after the request')!
    expect(line).toMatchObject({ service: 'orders' })
    expect(line).not.toHaveProperty('requestId')
    expect(line).not.toHaveProperty('userId')
    expect(line).not.toHaveProperty('traceId')
    expect(line).not.toHaveProperty('spanId')
  })

  it('setLoggerContext outside a context warns through the default', () => {
    const entries = _captureEntries()
    setDefaultLogger(createLogger({ service: 'orders' }))

    setLoggerContext({ userId: 'u-1' })

    expect(entries[0]).toMatchObject({ level: 'WARN', service: 'orders' })
  })

  it('_reset() clears the default', () => {
    setDefaultLogger(createLogger({ service: 'orders' }))
    _reset()
    const entries = _captureEntries()
    getLogger().info('after reset')

    expect(entries[0]).toMatchObject({ service: 'unknown' })
  })

  it('is exported from the core entry', () => {
    expect(core.setDefaultLogger).toBe(setDefaultLogger)
  })

  it('a getLogger() kept at module scope before registration logs through the later default', () => {
    const entries = _captureEntries()
    const early = getLogger() // e.g. a shared package's top level, evaluated before the app's
    early.info('before')
    setDefaultLogger(createLogger({ service: 'orders', version: '1.2.0' }))
    early.info('after')

    expect(entries.find((e) => e.message === 'before')).toMatchObject({ service: 'unknown' })
    expect(entries.find((e) => e.message === 'after')).toMatchObject({
      service: 'orders',
      version: '1.2.0',
    })
  })

  it('a getLogger() kept at module scope still gets the Logging Context on each line', () => {
    const entries = _captureEntries()
    const early = getLogger()
    setDefaultLogger(createLogger({ service: 'orders' }))
    runWithLogger({ logger: createLogger({ service: 'ctx' }), fields: { requestId: 'r1' } }, () =>
      early.info('inside'),
    )

    expect(entries[0]).toMatchObject({ service: 'orders', requestId: 'r1' })
    expect(entries[0]!.traceId).toBeDefined()
  })

  it('getLogger().child() kept at module scope follows a default registered later', () => {
    const entries = _captureEntries()
    const early = getLogger().child({ component: 'billing' })
    early.info('before')
    setDefaultLogger(createLogger({ service: 'orders' }))
    early.info('after')
    early.child({ step: 'charge' }).info('nested')

    expect(entries[0]).toMatchObject({ service: 'unknown', component: 'billing' })
    expect(entries[1]).toMatchObject({ service: 'orders', component: 'billing' })
    expect(entries[2]).toMatchObject({ service: 'orders', component: 'billing', step: 'charge' })
  })

  it('setDefaultLogger(getLogger()) outside a context is a no-op, not a self-loop', () => {
    const entries = _captureEntries()
    setDefaultLogger(getLogger())
    getLogger().info('unknown')
    setDefaultLogger(createLogger({ service: 'orders' }))
    setDefaultLogger(getLogger())
    getLogger().info('still orders')

    expect(entries.map((e) => e.service)).toEqual(['unknown', 'orders'])
  })

  it('useLogger(getLogger()) at module scope does not register a self-loop', async () => {
    const entries = _captureEntries()
    const app = new Hono()
    app.use(useLogger(getLogger()))
    app.get('/', (c) => c.text('ok'))
    const res = await app.request('/')
    getLogger().info('outside')

    expect(res.status).toBe(200)
    expect(entries.find((e) => e.message === 'outside')).toMatchObject({ service: 'unknown' })
  })

  it.each([
    ['a .child() of it', () => setDefaultLogger(getLogger().child({ component: 'pkg' }))],
    [
      'the logger inside runWithLogger({ logger: getLogger() })',
      () => runWithLogger({ logger: getLogger() }, () => setDefaultLogger(getLogger())),
    ],
  ])(
    'a logger from getLogger() outside a context (%s) set before any default is ignored',
    (_name, register) => {
      const entries = _captureEntries()
      register()
      useLogger(createLogger({ service: 'orders' }))

      expect(outsideService(entries)).toBe('orders')
    },
  )

  it('a registered logger that writes back through getLogger() does not recurse', () => {
    const entries = _captureEntries()
    setDefaultLogger({ ...getLogger() })

    expect(() => getLogger().info('x')).not.toThrow()
    expect(entries.at(-1)).toMatchObject({ service: 'unknown', message: 'x' })
  })

  it('registering a module-scope child of getLogger() registers a concrete child', () => {
    const entries = _captureEntries()
    setDefaultLogger(createLogger({ service: 'orders' }))
    setDefaultLogger(getLogger().child({ region: 'eu' }))
    getLogger().info('x')

    expect(entries[0]).toMatchObject({ service: 'orders', region: 'eu' })
  })
})

describe('useLogger registers its Root Logger as the Default Logger', () => {
  beforeEach(() => _reset())

  it('registers the Root Logger, so lines outside a request carry its service', async () => {
    const entries = _captureEntries()
    const root = createLogger({ service: 'api', environment: 'staging', version: '2.0.0' })
    const app = new Hono()
    app.use(useLogger(root))
    app.get('/', (c) => c.text('ok'))

    expect(outsideService(entries)).toBe('api')

    await app.request('/', { headers: { 'X-Request-Id': 'req-abc' } })
    getLogger().info('outside the request')

    const line = entries.find((e) => e.message === 'outside the request')!
    expect(line).toMatchObject({ service: 'api', environment: 'staging', version: '2.0.0' })
    expect(line).not.toHaveProperty('requestId')
    expect(line).not.toHaveProperty('traceId')
  })

  it('first seen wins', () => {
    const entries = _captureEntries()
    new Hono().use(useLogger(createLogger({ service: 'first' })))
    new Hono().use(useLogger(createLogger({ service: 'second' })))

    expect(outsideService(entries)).toBe('first')
  })

  it('does not replace a default set with setDefaultLogger()', () => {
    const entries = _captureEntries()
    setDefaultLogger(createLogger({ service: 'explicit' }))
    new Hono().use(useLogger(createLogger({ service: 'api' })))

    expect(outsideService(entries)).toBe('explicit')
  })

  it('an explicit setDefaultLogger() replaces the registered one', () => {
    const entries = _captureEntries()
    new Hono().use(useLogger(createLogger({ service: 'api' })))
    setDefaultLogger(createLogger({ service: 'explicit' }))

    expect(outsideService(entries)).toBe('explicit')
  })

  it('does not register a logger returned by a factory', async () => {
    const entries = _captureEntries()
    const root = createLogger({ service: 'api' })
    const app = new Hono()
    app.use(useLogger(() => root))
    app.get('/', (c) => c.text('ok'))

    await app.request('/')
    getLogger().info('outside the request')

    expect(entries.find((e) => e.message === 'outside the request')).toMatchObject({
      service: 'unknown',
    })
  })
})
