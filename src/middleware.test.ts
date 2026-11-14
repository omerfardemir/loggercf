import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createLogger, _captureEntries, _captureLines, _reset, _setSink } from './logger'
import type { LogFields, Logger } from './types'
import { useLogger, type UseLoggerOptions } from './middleware'

function setup() {
  const entries = _captureEntries()
  const logger = createLogger({ service: 'test-mw' })
  const app = new Hono()
  app.use(useLogger(logger))
  return { entries, app }
}

function messageStartsWith(prefix: string) {
  return (entry: Record<string, unknown>) =>
    typeof entry.message === 'string' && entry.message.startsWith(prefix)
}

describe('useLogger lifecycle logging', () => {
  beforeEach(() => _reset())

  it('emits request.start and request.end on success', async () => {
    const { entries, app } = setup()
    app.get('/hello', (c) => c.text('ok'))

    const res = await app.request('/hello')
    expect(res.status).toBe(200)

    const start = entries.find(messageStartsWith('request.start'))
    expect(start).toBeDefined()
    expect(start!.method).toBe('GET')
    expect(start!.path).toBe('/hello')
    expect(start!.requestId).toBeDefined()
    expect(start!.traceId).toBeDefined()

    const end = entries.find(messageStartsWith('request.end'))
    expect(end).toBeDefined()
    expect(end!.method).toBe('GET')
    expect(end!.path).toBe('/hello')
    expect(end!.statusCode).toBe(200)
    expect(typeof end!.duration).toBe('number')
    expect(end!.duration).toBeGreaterThanOrEqual(0)
  })

  it('emits request.end even when handler throws', async () => {
    const { entries, app } = setup()
    app.get('/boom', () => {
      throw new Error('kaboom')
    })

    const res = await app.request('/boom')
    expect(res.status).toBe(500)

    const end = entries.find(messageStartsWith('request.end'))
    expect(end).toBeDefined()
    expect(end!.statusCode).toBe(500)
    expect(typeof end!.duration).toBe('number')
  })

  it('lets app-level Hono error handling own thrown route errors', async () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'test-mw' })
    const app = new Hono()
    app.onError((err, c) => c.text(`handled: ${err.message}`, 418))
    app.use(useLogger(logger))
    app.get('/boom', () => {
      throw new Error('boom')
    })

    const res = await app.request('/boom')
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('handled: boom')
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        message: 'request.end GET /boom',
        statusCode: 418,
        err: expect.objectContaining({ message: 'boom' }),
      }),
    )
    expect(entries.filter(messageStartsWith('request.error'))).toEqual([])
  })

  it('logs HTTPException status when Hono turns it into a response', async () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'test-mw' })
    const app = new Hono()
    app.onError((err, c) => {
      if (err instanceof HTTPException) {
        return err.getResponse()
      }
      return c.text('handled', 500)
    })
    app.use(useLogger(logger))
    app.get('/bad-request', () => {
      throw new HTTPException(400, { message: 'bad request' })
    })

    const res = await app.request('/bad-request')
    expect(res.status).toBe(400)
    // c.error is set, so the default level is ERROR even though the status is 4xx.
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        message: 'request.end GET /bad-request',
        statusCode: 400,
        err: expect.objectContaining({ message: 'bad request' }),
      }),
    )
    expect(entries.filter(messageStartsWith('request.error'))).toEqual([])
  })

  it('includes correct method and path in lifecycle logs', async () => {
    const { entries, app } = setup()
    app.post('/users', (c) => c.json({ id: 1 }, 201))

    const res = await app.request('/users', { method: 'POST' })
    expect(res.status).toBe(201)

    const start = entries.find(messageStartsWith('request.start'))
    expect(start!.method).toBe('POST')
    expect(start!.path).toBe('/users')

    const end = entries.find(messageStartsWith('request.end'))
    expect(end!.statusCode).toBe(201)
  })

  it('sets response headers', async () => {
    const { app } = setup()
    app.get('/h', (c) => c.text('ok'))

    const res = await app.request('/h')
    expect(res.headers.get('X-Request-Id')).toBeDefined()
    expect(res.headers.get('X-Trace-Id')).toBeDefined()
    expect(res.headers.get('traceparent')).toBeDefined()
  })

  it('sets response headers even on error', async () => {
    const { app } = setup()
    app.get('/fail', () => {
      throw new Error('fail')
    })

    const res = await app.request('/fail')
    expect(res.status).toBe(500)
    expect(res.headers.get('X-Request-Id')).toBeDefined()
    expect(res.headers.get('X-Trace-Id')).toBeDefined()
    expect(res.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-\d{2}$/)
  })

  it('measures duration accurately', async () => {
    const { entries, app } = setup()
    app.get('/slow', async (c) => {
      await new Promise((r) => setTimeout(r, 50))
      return c.text('done')
    })

    await app.request('/slow')

    const end = entries.find(messageStartsWith('request.end'))
    expect(end!.duration).toBeGreaterThanOrEqual(40)
  })

  it('exposes a per-request logger whose lines carry requestId', async () => {
    const { entries, app } = setup()
    let capturedLogger: unknown

    app.get('/child', (c) => {
      capturedLogger = c.get('logger' as never)
      ;(capturedLogger as any).info({}, 'from handler')
      return c.text('ok')
    })

    await app.request('/child')

    const handlerLog = entries.find((e) => e.message === 'from handler')
    expect(handlerLog).toBeDefined()
    expect(handlerLog!.requestId).toBeDefined()
  })

  it('writes requestId exactly once per log line', async () => {
    const lines = _captureLines()
    const app = new Hono()
    app.use(useLogger(createLogger({ service: 'test-mw' })))
    app.get('/once', (c) => {
      ;(c.get('logger' as never) as Logger).info('from handler')
      return c.text('ok')
    })

    await app.request('/once', { headers: { 'X-Request-Id': 'req-once' } })

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.match(/"requestId":/g)).toHaveLength(1)
    }
  })

  it('gives different logger instances to concurrent requests', async () => {
    const { app } = setup()
    const loggers: unknown[] = []

    app.get('/concurrent', (c) => {
      loggers.push(c.get('logger' as never))
      return c.text('ok')
    })

    await Promise.all([app.request('/concurrent'), app.request('/concurrent')])

    expect(loggers).toHaveLength(2)
    expect(loggers[0]).not.toBe(loggers[1])
  })

  it('round-trips tracestate header', async () => {
    const { app } = setup()
    app.get('/ts', (c) => c.text('ok'))

    const res = await app.request('/ts', {
      headers: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        tracestate: 'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7',
      },
    })

    expect(res.headers.get('tracestate')).toBe('congo=t61rcWkgMzE,rojo=00f067aa0ba902b7')
  })

  it('does not set tracestate header when not present on request', async () => {
    const { app } = setup()
    app.get('/no-ts', (c) => c.text('ok'))

    const res = await app.request('/no-ts')
    expect(res.headers.get('tracestate')).toBeNull()
  })
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CF_RAY = '8f1e2d3c4b5a6978-SJC'

function requestIdApp(options?: UseLoggerOptions, before?: MiddlewareHandler) {
  const entries = _captureEntries()
  const app = new Hono()
  if (before) app.use(before)
  app.use(useLogger(createLogger({ service: 'test-mw' }), options))
  app.get('/', (c) => c.text(String(c.get('requestId' as never))))
  return { entries, app }
}

/** Sends one request and returns the request ID, checking line, header and c.var agree. */
async function requestIdOf(
  { app, entries }: ReturnType<typeof requestIdApp>,
  headers: Record<string, string> = {},
  path = '/',
) {
  const res = await app.request(path, { headers })
  const end = entries.find(messageStartsWith('request.end'))!
  expect(res.headers.get('X-Request-Id')).toBe(end.requestId)
  expect(await res.text()).toBe(end.requestId)
  return end.requestId as string
}

const setRequestIdVar =
  (id: string): MiddlewareHandler =>
  async (c, next) => {
    c.set('requestId' as never, id as never)
    await next()
  }

function cfRayApp(options?: UseLoggerOptions) {
  const lines = _captureLines()
  const app = new Hono()
  app.use(useLogger(createLogger({ service: 'test-mw' }), options))
  app.get('/', (c) => {
    ;(c.get('logger' as never) as Logger).info('from handler')
    return c.text('ok')
  })
  return {
    lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    app,
  }
}

describe('useLogger request ID', () => {
  beforeEach(() => _reset())

  it('reuses a valid incoming X-Request-Id', async () => {
    expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': 'req-e2e-local' })).toBe(
      'req-e2e-local',
    )
  })

  it('accepts UUIDs, cf-ray values and IDs with = : .', async () => {
    for (const id of [crypto.randomUUID(), CF_RAY, 'a.b:c=d_e-f']) {
      expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': id })).toBe(id)
    }
  })

  it('generates an ID when there is no incoming one', async () => {
    expect(await requestIdOf(requestIdApp())).toMatch(UUID_RE)
  })

  it('replaces an oversized incoming ID with a generated one', async () => {
    expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': 'a'.repeat(129) })).toMatch(UUID_RE)
  })

  it('accepts an incoming ID of exactly 128 characters', async () => {
    const id = 'a'.repeat(128)
    expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': id })).toBe(id)
  })

  it('replaces an incoming ID with disallowed characters with a generated one', async () => {
    for (const id of ['abc def', 'abc"def', 'abc,requestId=x', '{"a":1}', 'a/b', 'caf%C3%A9']) {
      expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': id })).toMatch(UUID_RE)
    }
  })

  it('falls back to c.var.requestId from an earlier middleware', async () => {
    expect(await requestIdOf(requestIdApp(undefined, setRequestIdVar('from-earlier')))).toBe(
      'from-earlier',
    )
  })

  it('prefers the X-Request-Id header over c.var.requestId by default', async () => {
    const id = await requestIdOf(requestIdApp(undefined, setRequestIdVar('from-earlier')), {
      'X-Request-Id': 'from-header',
    })
    expect(id).toBe('from-header')
  })

  it('falls through an invalid header to c.var.requestId', async () => {
    const id = await requestIdOf(requestIdApp(undefined, setRequestIdVar('from-earlier')), {
      'X-Request-Id': 'bad id',
    })
    expect(id).toBe('from-earlier')
  })

  it('validates c.var.requestId too', async () => {
    expect(await requestIdOf(requestIdApp(undefined, setRequestIdVar('x'.repeat(200))))).toMatch(
      UUID_RE,
    )
  })

  it('respects the from order, with cf-ray as the primary source', async () => {
    const id = await requestIdOf(
      requestIdApp({ requestId: { from: ['cf-ray', 'x-request-id'] } }),
      {
        'cf-ray': CF_RAY,
        'X-Request-Id': 'from-client',
      },
    )
    expect(id).toBe(CF_RAY)
  })

  it('moves to the next source in from when one is missing or invalid', async () => {
    const options: UseLoggerOptions = { requestId: { from: ['cf-ray', 'x-request-id'] } }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toBe(
      'from-client',
    )
    expect(
      await requestIdOf(requestIdApp(options), {
        'cf-ray': 'not valid',
        'X-Request-Id': 'from-client',
      }),
    ).toBe('from-client')
  })

  it('reads only the sources listed in from, then c.var.requestId', async () => {
    const options: UseLoggerOptions = { requestId: { from: ['cf-ray'] } }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toMatch(
      UUID_RE,
    )
    expect(
      await requestIdOf(requestIdApp(options, setRequestIdVar('from-earlier')), {
        'X-Request-Id': 'from-client',
      }),
    ).toBe('from-earlier')
  })

  it('reads nothing but c.var.requestId with an empty from', async () => {
    const options: UseLoggerOptions = { requestId: { from: [] } }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toMatch(
      UUID_RE,
    )
  })

  it('accepts a function as a source', async () => {
    const options: UseLoggerOptions = {
      requestId: { from: [(c) => c.req.query('rid'), 'x-request-id'] },
    }
    expect(
      await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' }, '/?rid=q-1'),
    ).toBe('q-1')
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toBe(
      'from-client',
    )
  })

  it('throws when useLogger is built with an invalid header name in from', () => {
    for (const name of ['', 'x request id', 'x-request-id\n']) {
      expect(() =>
        useLogger(createLogger({ service: 'test-mw' }), { requestId: { from: [name] } }),
      ).toThrow(TypeError)
    }
  })

  it('validates values returned by a function source', async () => {
    expect(await requestIdOf(requestIdApp({ requestId: { from: [() => 'bad id'] } }))).toMatch(
      UUID_RE,
    )
  })

  it('trustIncoming: false ignores client headers', async () => {
    const id = await requestIdOf(requestIdApp({ requestId: { trustIncoming: false } }), {
      'X-Request-Id': 'from-client',
    })
    expect(id).toMatch(UUID_RE)
  })

  it('trustIncoming: false ignores every source in from', async () => {
    const options: UseLoggerOptions = {
      requestId: { trustIncoming: false, from: ['cf-ray', () => 'from-function'] },
    }
    expect(await requestIdOf(requestIdApp(options), { 'cf-ray': CF_RAY })).toMatch(UUID_RE)
  })

  it('trustIncoming: false ignores c.var.requestId from an earlier middleware too', async () => {
    const options: UseLoggerOptions = { requestId: { trustIncoming: false } }
    const id = await requestIdOf(requestIdApp(options, setRequestIdVar('from-app')), {
      'X-Request-Id': 'from-client',
    })
    expect(id).toMatch(UUID_RE)
  })

  it('trustIncoming: false still rejects an invalid header name in from at setup', () => {
    expect(() =>
      useLogger(createLogger({ service: 'test-mw' }), {
        requestId: { trustIncoming: false, from: ['x request id'] },
      }),
    ).toThrow(TypeError)
  })

  it('marks every line with requestIdRejected when an incoming ID is rejected', async () => {
    const ctx = requestIdApp()
    const id = await requestIdOf(ctx, { 'X-Request-Id': 'bad id' })
    expect(id).toMatch(UUID_RE)
    expect(ctx.entries.length).toBeGreaterThan(0)
    for (const entry of ctx.entries) {
      expect(entry.requestIdRejected).toBe(true)
      expect(JSON.stringify(entry)).not.toContain('bad id')
    }
  })

  it('marks requestIdRejected when an earlier source fails but a later one is used', async () => {
    const ctx = requestIdApp({ requestId: { from: ['cf-ray', 'x-request-id'] } })
    expect(await requestIdOf(ctx, { 'cf-ray': 'not valid!', 'X-Request-Id': 'r-2' })).toBe('r-2')
    expect(ctx.entries.find(messageStartsWith('request.end'))!.requestIdRejected).toBe(true)
  })

  it('does not mark requestIdRejected when no incoming ID was sent or it was accepted', async () => {
    const cases: Record<string, string>[] = [{}, { 'X-Request-Id': 'r-ok' }]
    for (const headers of cases) {
      const ctx = requestIdApp()
      await requestIdOf(ctx, headers)
      for (const entry of ctx.entries) expect(entry).not.toHaveProperty('requestIdRejected')
    }
  })

  it('rejects a value a custom validate accepts when it is not a safe header value', async () => {
    for (const unsafe of ['a\r\nSet-Cookie: x=1', ' padded ', 'ümlaut']) {
      const ctx = requestIdApp({ requestId: { from: [() => unsafe], validate: () => true } })
      const res = await ctx.app.request('/')
      expect(res.status).toBe(200)
      const end = ctx.entries.find(messageStartsWith('request.end'))!
      expect(end.requestId).toMatch(UUID_RE)
      expect(end.requestIdRejected).toBe(true)
      expect(res.headers.get('X-Request-Id')).toBe(end.requestId)
    }
  })

  it('replaces a generated ID that is not a safe header value, with one WARN per useLogger()', async () => {
    for (const bad of ['', 'line\nbreak']) {
      const ctx = requestIdApp({ requestId: { generate: () => bad } })
      expect(await requestIdOf(ctx)).toMatch(UUID_RE)
      await ctx.app.request('/')
      expect(ctx.entries.filter((e) => e.level === 'WARN')).toHaveLength(1)
    }
  })

  it('a first useLogger whose level hides the WARN does not use up the WARN of another', async () => {
    const entries = _captureEntries()
    const quiet = new Hono()
    quiet.use(
      useLogger(createLogger({ service: 'quiet', level: 'error' }), {
        requestId: { generate: () => 'x\ny' },
      }),
    )
    quiet.get('/', (c) => c.text('ok'))
    await quiet.request('/')
    const loud = new Hono()
    loud.use(
      useLogger(createLogger({ service: 'loud' }), { requestId: { generate: () => 'x\ny' } }),
    )
    loud.get('/', (c) => c.text('ok'))
    await loud.request('/')
    expect(entries.filter((e) => e.level === 'WARN').map((e) => e.service)).toEqual(['loud'])
  })

  it("writes the unsafe generated ID WARN the first time, through the app's Root Logger", async () => {
    const ctx = requestIdApp({ requestId: { generate: () => 'x\ny' } })
    await requestIdOf(ctx)
    const warns = ctx.entries.filter((e) => e.level === 'WARN')
    expect(warns).toHaveLength(1)
    expect(String(warns[0]!.message)).toContain('requestId.generate')
    expect(warns[0]!.service).toBe('test-mw')
  })

  it('falls back to a UUID with a WARN when generate throws, and still logs the request', async () => {
    const ctx = requestIdApp({
      requestId: {
        generate: () => {
          throw new Error('boom')
        },
      },
    })
    expect(await requestIdOf(ctx)).toMatch(UUID_RE)
    expect(ctx.entries.filter((e) => e.level === 'WARN')).toHaveLength(1)
    expect(ctx.entries.some(messageStartsWith('request.start'))).toBe(true)
  })

  it('rejects a value when validate returns a truthy non-boolean such as a Promise', async () => {
    const ctx = requestIdApp({
      requestId: { validate: (() => Promise.resolve(false)) as unknown as () => boolean },
    })
    expect(await requestIdOf(ctx, { 'X-Request-Id': 'r-1' })).toMatch(UUID_RE)
    expect(ctx.entries.find(messageStartsWith('request.end'))!.requestIdRejected).toBe(true)
  })

  it('writes one WARN when a from source throws, without the error message', async () => {
    const ctx = requestIdApp({
      requestId: {
        from: [
          () => {
            throw new Error('secret-id-in-message')
          },
        ],
      },
    })
    await requestIdOf(ctx)
    await ctx.app.request('/')
    const warns = ctx.entries.filter((e) => e.level === 'WARN')
    expect(warns).toHaveLength(1)
    expect(JSON.stringify(warns[0])).not.toContain('secret-id-in-message')
  })

  it('does not log a cf-ray rejected as the request ID as cfRay', async () => {
    const ray = '8f1c2a3b4d5e6f70-AMS'
    const ctx = requestIdApp({ requestId: { from: ['cf-ray'], validate: /^r-/ } })
    expect(await requestIdOf(ctx, { 'cf-ray': ray })).toMatch(UUID_RE)
    for (const entry of ctx.entries) {
      expect(entry).not.toHaveProperty('cfRay')
      expect(JSON.stringify(entry)).not.toContain(ray)
    }
  })

  it('treats a validate that throws as a rejection, with one WARN without the message', async () => {
    const ctx = requestIdApp({
      requestId: {
        validate: () => {
          throw new Error('secret-id')
        },
      },
    })
    expect(await requestIdOf(ctx, { 'X-Request-Id': 'r-1' })).toMatch(UUID_RE)
    await ctx.app.request('/', { headers: { 'X-Request-Id': 'r-2' } })
    expect(ctx.entries.find(messageStartsWith('request.end'))!.requestIdRejected).toBe(true)
    const warns = ctx.entries.filter((e) => e.level === 'WARN')
    expect(warns).toHaveLength(1)
    expect(JSON.stringify(warns[0])).not.toContain('secret-id')
  })

  it('keeps a genuine cfRay when a client sends the same value in X-Request-Id and it is rejected', async () => {
    const ray = '8f1c2a3b4d5e6f70-AMS'
    const ctx = requestIdApp({ requestId: { validate: /^req_/ } })
    expect(await requestIdOf(ctx, { 'cf-ray': ray, 'X-Request-Id': ray })).toMatch(UUID_RE)
    const end = ctx.entries.find(messageStartsWith('request.end'))!
    expect(end.requestIdRejected).toBe(true)
    expect(end.cfRay).toBe(ray)
  })

  it('treats a from function that throws or returns a non-string as no value, not a rejection', async () => {
    const sources = [
      () => {
        throw new Error('boom')
      },
      () => 42 as unknown as string,
    ]
    const ctx = requestIdApp({ requestId: { from: sources } })
    expect(await requestIdOf(ctx)).toMatch(UUID_RE)
    for (const entry of ctx.entries) expect(entry).not.toHaveProperty('requestIdRejected')
  })

  it('does not mark an empty X-Request-Id as rejected', async () => {
    const ctx = requestIdApp()
    expect(await requestIdOf(ctx, { 'X-Request-Id': '' })).toMatch(UUID_RE)
    for (const entry of ctx.entries) expect(entry).not.toHaveProperty('requestIdRejected')
  })

  it('marks an app-set c.var.requestId that fails validation as rejected', async () => {
    const ctx = requestIdApp(undefined, setRequestIdVar('bad id'))
    expect(await requestIdOf(ctx)).toMatch(UUID_RE)
    expect(ctx.entries.find(messageStartsWith('request.end'))!.requestIdRejected).toBe(true)
  })

  it('trustIncoming: false never marks requestIdRejected, even for a bad header', async () => {
    const ctx = requestIdApp({ requestId: { trustIncoming: false } })
    expect(await requestIdOf(ctx, { 'X-Request-Id': 'bad id' })).toMatch(UUID_RE)
    for (const entry of ctx.entries) expect(entry).not.toHaveProperty('requestIdRejected')
  })

  it('uses a custom generate function, called once with the Hono context', async () => {
    let calls = 0
    const options: UseLoggerOptions = {
      requestId: {
        generate: (c) => {
          calls++
          return `gen-${c.req.method}`
        },
      },
    }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'bad id' })).toBe('gen-GET')
    expect(calls).toBe(1)
  })

  it('does not call generate when an incoming ID is used', async () => {
    let calls = 0
    const options: UseLoggerOptions = {
      requestId: {
        generate: () => {
          calls++
          return 'generated'
        },
      },
    }
    await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })
    expect(calls).toBe(0)
  })

  it('uses a custom validate regex in place of the default', async () => {
    const options: UseLoggerOptions = { requestId: { validate: /^[0-9a-f-]{36}$/ } }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'req-e2e-local' })).toMatch(
      UUID_RE,
    )
    const uuid = crypto.randomUUID()
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': uuid })).toBe(uuid)
  })

  it('gives the same answer every time for a global validate regex', async () => {
    const options: UseLoggerOptions = { requestId: { validate: /^[a-z-]+$/g } }
    for (let i = 0; i < 3; i++) {
      expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toBe(
        'from-client',
      )
    }
  })

  it('uses a custom validate function', async () => {
    const seen: string[] = []
    const options: UseLoggerOptions = {
      requestId: {
        validate: (id) => {
          seen.push(id)
          return id.startsWith('ok-')
        },
      },
    }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'nope' })).toMatch(UUID_RE)
    expect(seen).toEqual(['nope'])
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'ok-1' })).toBe('ok-1')
  })

  it('does not validate the generated ID', async () => {
    const options: UseLoggerOptions = {
      requestId: { validate: () => false, generate: () => 'generated id with spaces' },
    }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toBe(
      'generated id with spaces',
    )
  })
})

describe('useLogger cfRay', () => {
  beforeEach(() => _reset())

  it('records cfRay on every line when the cf-ray header is present', async () => {
    const { entries, app } = cfRayApp()
    await app.request('/', { headers: { 'cf-ray': CF_RAY, 'X-Request-Id': 'r-1' } })
    expect(entries().length).toBeGreaterThanOrEqual(3)
    for (const entry of entries()) {
      expect(entry.cfRay).toBe(CF_RAY)
      expect(entry.requestId).toBe('r-1')
    }
  })

  it('records cfRay when it is also the request ID, exactly once per line', async () => {
    const { entries, lines, app } = cfRayApp({ requestId: { from: ['cf-ray'] } })
    await app.request('/', { headers: { 'cf-ray': CF_RAY } })
    const end = entries().find(messageStartsWith('request.end'))!
    expect(end.cfRay).toBe(CF_RAY)
    expect(end.requestId).toBe(CF_RAY)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.match(/"cfRay":/g)).toHaveLength(1)
  })

  it('does not record cfRay with trustIncoming: false', async () => {
    const { entries, app } = cfRayApp({ requestId: { trustIncoming: false } })
    const res = await app.request('/', { headers: { 'cf-ray': CF_RAY } })
    const end = entries().find(messageStartsWith('request.end'))!
    expect(end.requestId).toMatch(UUID_RE)
    expect(res.headers.get('X-Request-Id')).toBe(end.requestId)
    for (const entry of entries()) expect(entry).not.toHaveProperty('cfRay')
  })

  it('omits cfRay when the header is absent', async () => {
    const { entries, app } = cfRayApp()
    await app.request('/')
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) expect(entry).not.toHaveProperty('cfRay')
  })

  it('omits a cf-ray header that fails the default format check', async () => {
    const { entries, app } = cfRayApp()
    await app.request('/', { headers: { 'cf-ray': 'x'.repeat(500) } })
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) expect(entry).not.toHaveProperty('cfRay')
  })
})

class DbError extends Error {
  code = 'E_DB'
}

/** Strip what differs between runs: time, the new span ID, duration, stacks, a generated request ID. */
const normalizeRequestLine = (line: string) =>
  line
    .replace(/"time":"[^"]+"/g, '"time":"<t>"')
    .replace(/"spanId":"[0-9a-f]+"/g, '"spanId":"<span>"')
    .replace(/"duration":\d+/g, '"duration":0')
    .replace(/"stack":"(?:\\.|[^"\\])*"/g, '"stack":"<stack>"')
    .replace(/"requestId":"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"/g, '"requestId":"<uuid>"')

/**
 * The request lines written for the scenario below by the pino-based logger
 * (main at 7c22732 with #27's request lines, pino 10), captured by running the same
 * requests against that build. Key order included: the internal core must match.
 */
const BASELINE_REQUEST_LINES = [
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","cfRay":"8f1c2d3e4a5b6c7d-AMS","service":"gold","environment":"test","version":"1.0.0","method":"GET","path":"/ok","route":"/ok","message":"request.start GET /ok","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","cfRay":"8f1c2d3e4a5b6c7d-AMS","service":"gold","environment":"test","version":"1.0.0","method":"GET","path":"/ok","route":"/ok","statusCode":200,"duration":0,"message":"request.end GET /ok","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"<uuid>","requestIdRejected":true,"service":"gold","environment":"test","version":"1.0.0","method":"POST","path":"/boom","route":"/boom","message":"request.start POST /boom","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"ERROR","requestId":"<uuid>","requestIdRejected":true,"service":"gold","environment":"test","version":"1.0.0","method":"POST","path":"/boom","route":"/boom","statusCode":500,"duration":0,"err":{"type":"DbError","message":"kaboom","stack":"<stack>","code":"E_DB","cause":{"type":"Error","message":"socket closed","stack":"<stack>"}},"message":"request.end POST /boom","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
]

describe('useLogger lines are the same as with the pino-based logger', () => {
  beforeEach(() => _reset())

  it('writes byte-identical request.start and request.end lines, including a failed request', async () => {
    const lines = _captureLines()
    const app = new Hono()
    const logger = createLogger({ service: 'gold', environment: 'test', version: '1.0.0' })
    app.use(useLogger(logger, { requestId: { from: ['x-request-id'] } }))
    app.get('/ok', (c) => c.text('ok'))
    app.post('/boom', () => {
      throw new DbError('kaboom', { cause: new Error('socket closed') })
    })
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

    await app.request('/ok?x=1', {
      headers: { traceparent, 'X-Request-Id': 'req-1', 'cf-ray': '8f1c2d3e4a5b6c7d-AMS' },
    })
    await app.request('/boom', {
      method: 'POST',
      headers: { traceparent, 'X-Request-Id': 'bad id!' },
    })

    expect(lines.map(normalizeRequestLine)).toEqual(BASELINE_REQUEST_LINES)
  })
})

function optionsApp(options?: UseLoggerOptions) {
  const lines = _captureLines()
  const app = new Hono()
  app.use(useLogger(createLogger({ service: 'test-mw', level: 'trace' }), options))
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  const ends = () => entries().filter(messageStartsWith('request.end'))
  const end = () => {
    expect(ends()).toHaveLength(1)
    return ends()[0]
  }
  const starts = () => entries().filter(messageStartsWith('request.start'))
  const start = () => starts()[0]
  const warnings = () => entries().filter((e) => e.level === 'WARN' && e.hook !== undefined)
  return { lines, entries, ends, end, starts, start, warnings, app }
}

describe('useLogger request.end level', () => {
  beforeEach(() => _reset())

  it('writes one request.end at ERROR with err, statusCode, duration, route and path for a thrown 500', async () => {
    const { entries, end, app } = optionsApp()
    app.get('/users/:id', () => {
      throw new Error('kaboom')
    })

    expect((await app.request('/users/42')).status).toBe(500)

    expect(end()).toMatchObject({
      level: 'ERROR',
      message: 'request.end GET /users/42',
      err: expect.objectContaining({ message: 'kaboom' }),
      statusCode: 500,
      duration: expect.any(Number),
      route: '/users/:id',
      path: '/users/42',
    })
    expect(entries().filter(messageStartsWith('request.error'))).toEqual([])
  })

  it('writes ERROR for a returned 5xx, without err', async () => {
    const { end, app } = optionsApp()
    app.get('/down', (c) => c.text('down', 503))
    await app.request('/down')
    expect(end()).toMatchObject({ level: 'ERROR', statusCode: 503 })
    expect(end()).not.toHaveProperty('err')
  })

  it('writes WARN for a 404 on an unmatched path', async () => {
    const { end, app } = optionsApp()
    app.get('/known', (c) => c.text('ok'))
    expect((await app.request('/unknown')).status).toBe(404)
    expect(end()).toMatchObject({ level: 'WARN', statusCode: 404, path: '/unknown' })
  })

  it('writes WARN for a returned 4xx and INFO for 2xx and 3xx', async () => {
    for (const [status, level] of [
      [401, 'WARN'],
      [499, 'WARN'],
      [200, 'INFO'],
      [204, 'INFO'],
      [302, 'INFO'],
    ] as const) {
      const { end, app } = optionsApp()
      app.get('/', () => new Response(null, { status }))
      await app.request('/')
      expect(end()).toMatchObject({ level, statusCode: status })
    }
  })

  it('uses the level option, called with the status, the error and the Hono context', async () => {
    const calls: unknown[][] = []
    const { end, app } = optionsApp({
      level: (status, err, c) => {
        calls.push([status, err?.message, c.req.method])
        return 'fatal'
      },
    })
    app.get('/', () => {
      throw new Error('x')
    })
    await app.request('/')
    expect(end()).toMatchObject({ level: 'FATAL' })
    expect(calls).toEqual([[500, 'x', 'GET']])
  })
})

/** A cache-style middleware: answers itself on a hit (`?hit=1`), calls the handler otherwise. */
const cache: MiddlewareHandler = async (c, next) => {
  if (c.req.query('hit')) return c.text('cached')
  await next()
}

describe('useLogger route', () => {
  beforeEach(() => _reset())

  it('logs the matched pattern on request.start and request.end, not the concrete path', async () => {
    const { start, end, app } = optionsApp()
    app.get('/users/:id/items/:item', (c) => c.text('ok'))
    await app.request('/users/8f3a/items/42')
    const expected = { route: '/users/:id/items/:item', path: '/users/8f3a/items/42' }
    expect(start()).toMatchObject(expected)
    expect(end()).toMatchObject(expected)
  })

  it('includes the base path of a mounted sub-app', async () => {
    const { end, app } = optionsApp()
    const api = new Hono()
    api.get('/items/:n', (c) => c.text('ok'))
    app.route('/api', api)
    await app.request('/api/items/3')
    expect(end().route).toBe('/api/items/:n')
  })

  it("keeps the handler's pattern when a middleware answers before the handler runs", async () => {
    const { end, app } = optionsApp()
    app.use('/admin/*', async (c) => c.text('denied', 401))
    app.get('/admin/users/:id', (c) => c.text('ok'))
    expect((await app.request('/admin/users/7')).status).toBe(401)
    expect(end()).toMatchObject({ statusCode: 401, route: '/admin/users/:id' })
  })

  it('ignores a catch-all handler registered after the one that answered', async () => {
    const { start, end, app } = optionsApp()
    app.get('/users/:id', (c) => c.text('ok'))
    app.get('*', (c) => c.text('fallback'))
    await app.request('/users/1')
    expect(start().route).toBe('/users/:id')
    expect(end().route).toBe('/users/:id')
  })

  it('logs the handler on request.end when a middleware registered with app.get runs first', async () => {
    const { start, end, app } = optionsApp()
    app.get('/api/*', async (_c, next) => {
      await next()
    })
    app.get('/api/users/:id', (c) => c.text('ok'))
    await app.request('/api/users/1')
    // request.start is written before the handlers run, so it can only expect the first one.
    expect(start().route).toBe('/api/*')
    expect(end().route).toBe('/api/users/:id')
  })

  it("logs a method-registered cache's pattern on a hit and the handler's on a miss; app.use keeps the handler's", async () => {
    for (const register of ['get', 'use'] as const) {
      const { ends, app } = optionsApp()
      if (register === 'get') app.get('*', cache)
      else app.use('*', cache)
      app.get('/items/:id', (c) => c.text('fresh'))
      await app.request('/items/1?hit=1')
      await app.request('/items/1')
      expect(ends().map((e) => e.route)).toEqual(
        register === 'get' ? ['/*', '/items/:id'] : ['/items/:id', '/items/:id'],
      )
    }
  })

  it('uses the wildcard pattern when only a wildcard handler matches', async () => {
    const { end, app } = optionsApp()
    app.get('/users/:id', (c) => c.text('ok'))
    app.get('/files/*', (c) => c.text('fallback'))
    await app.request('/files/a/b')
    expect(end().route).toBe('/files/*')
  })

  it('logs the pattern of an app.all handler', async () => {
    const { end, app } = optionsApp()
    app.all('/any/:x', (c) => c.text('ok'))
    await app.request('/any/1', { method: 'DELETE' })
    expect(end().route).toBe('/any/:x')
  })

  it("uses the last matching middleware's pattern when no handler matches", async () => {
    const { end, app } = optionsApp()
    app.get('/known', (c) => c.text('ok'))
    await app.request('/unknown')
    expect(end().route).toBe('/*')
  })
})

describe('useLogger requestStart', () => {
  beforeEach(() => _reset())

  it('writes request.start by default', async () => {
    const { start, app } = optionsApp()
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(start()).toMatchObject({ level: 'INFO', method: 'GET', path: '/', route: '/' })
  })

  it('requestStart: false writes no request.start, and still writes request.end', async () => {
    const { starts, end, app } = optionsApp({ requestStart: false })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(starts()).toEqual([])
    expect(end()).toMatchObject({ statusCode: 200 })
  })
})

function forgedDetails() {
  return { userAgent: 'forged', cf: { colo: 'forged' } }
}

describe('useLogger fields and endFields', () => {
  beforeEach(() => _reset())

  it('adds fields to every line of the request, as Context Fields', async () => {
    const { entries, app } = optionsApp({
      fields: (c) => ({ tenant: c.req.header('x-tenant') }),
    })
    app.get('/', (c) => {
      ;(c.get('logger' as never) as Logger).info('from handler')
      return c.text('ok')
    })
    await app.request('/', { headers: { 'x-tenant': 't-1' } })
    expect(entries()).toHaveLength(3)
    for (const entry of entries()) expect(entry.tenant).toBe('t-1')
  })

  it('does not let fields replace requestId or cfRay', async () => {
    const { entries, app } = optionsApp({
      fields: () => ({ requestId: 'forged', cfRay: 'forged' }),
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/', { headers: { 'X-Request-Id': 'r-1', 'cf-ray': CF_RAY } })
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) expect(entry).toMatchObject({ requestId: 'r-1', cfRay: CF_RAY })
  })

  it('does not let fields or endFields set requestIdRejected', async () => {
    const { entries, app } = optionsApp({
      fields: () => ({ requestIdRejected: true }),
      endFields: () => ({ requestIdRejected: true }),
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/', { headers: { 'X-Request-Id': 'r-1' } })
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) expect(entry).not.toHaveProperty('requestIdRejected')
  })

  it('adds endFields to request.end only, computed after the handler ran', async () => {
    const { entries, start, end, app } = optionsApp({
      endFields: (c) => ({ userId: c.get('userId' as never) }),
    })
    app.get('/', (c) => {
      c.set('userId' as never, 'u-42' as never)
      ;(c.get('logger' as never) as Logger).info('from handler')
      return c.text('ok')
    })
    await app.request('/')
    expect(end().userId).toBe('u-42')
    expect(start()).not.toHaveProperty('userId')
    expect(entries().find((e) => e.message === 'from handler')).not.toHaveProperty('userId')
  })

  it('does not let endFields replace the request.end fields, requestId or cfRay', async () => {
    const { end, app } = optionsApp({
      endFields: () => ({
        statusCode: 1,
        route: 'forged',
        path: 'forged',
        duration: -1,
        requestId: 'forged',
        cfRay: 'forged',
      }),
    })
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x', { headers: { 'X-Request-Id': 'r-1', 'cf-ray': CF_RAY } })
    expect(end()).toMatchObject({
      statusCode: 200,
      route: '/x',
      path: '/x',
      requestId: 'r-1',
      cfRay: CF_RAY,
    })
    expect(end().duration).toBeGreaterThanOrEqual(0)
  })

  it('does not add a cfRay to request.end when the request has none', async () => {
    const { end, app } = optionsApp({ endFields: () => ({ cfRay: 'forged' }) })
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(end()).not.toHaveProperty('cfRay')
  })

  it('does not let fields set cfRay, err or the request.end fields when the request has none of them', async () => {
    const { entries, start, end, app } = optionsApp({
      fields: () => ({
        tenant: 't-1',
        cfRay: 'forged',
        err: 'forged',
        method: 'forged',
        path: 'forged',
        route: 'forged',
        statusCode: 1,
        duration: -1,
      }),
    })
    app.get('/x', (c) => {
      ;(c.get('logger' as never) as Logger).info('from handler')
      return c.text('ok')
    })
    await app.request('/x')
    // request.start, the handler line, the WARN naming the dropped keys, request.end
    expect(entries()).toHaveLength(4)
    expect(entries().filter((e) => e.droppedKeys !== undefined)).toHaveLength(1)
    for (const entry of entries()) {
      expect(entry.tenant).toBe('t-1')
      expect(entry).not.toHaveProperty('cfRay')
      expect(entry).not.toHaveProperty('err')
    }
    const fromHandler = entries().find((e) => e.message === 'from handler')!
    for (const key of ['method', 'path', 'route', 'statusCode', 'duration']) {
      expect(fromHandler).not.toHaveProperty(key)
    }
    expect(start()).not.toHaveProperty('statusCode')
    expect(end()).toMatchObject({ method: 'GET', path: '/x', route: '/x', statusCode: 200 })
  })

  it('never lets endFields write err, even on a successful request', async () => {
    const { end, app } = optionsApp({ endFields: () => ({ err: 'forged', userId: 'u-1' }) })
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(end()).toMatchObject({ level: 'INFO', userId: 'u-1' })
    expect(end()).not.toHaveProperty('err')
  })

  it('does not let a hook set userAgent or cf when include turns them on, even if the request has neither', async () => {
    const { entries, app } = optionsApp({
      include: { userAgent: true, cf: true },
      fields: forgedDetails,
      endFields: forgedDetails,
    })
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) {
      expect(entry).not.toHaveProperty('userAgent')
      expect(entry).not.toHaveProperty('cf')
    }
  })

  it('lets a hook set userAgent and cf when include leaves them off', async () => {
    const { end, app } = optionsApp({ endFields: () => ({ userAgent: 'mine', cf: 'mine' }) })
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(end()).toMatchObject({ userAgent: 'mine', cf: 'mine' })
  })
})

describe('useLogger owned keys a hook returns', () => {
  beforeEach(() => _reset())

  it('warns once per hook, naming the dropped keys but never their values', async () => {
    const { lines, entries, ends, app } = optionsApp({
      fields: () => ({ tenant: 't-1', requestId: 'forged-secret-1' }),
      endFields: () => ({ userId: 'u-1', statusCode: 'forged-secret-2', route: 'forged-secret-3' }),
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    await app.request('/')
    expect(ends()).toHaveLength(2)
    const dropped = entries().filter((e) => e.droppedKeys !== undefined)
    expect(dropped).toHaveLength(2)
    expect(dropped[0]).toMatchObject({ level: 'WARN', hook: 'fields', droppedKeys: ['requestId'] })
    expect(dropped[1]).toMatchObject({
      level: 'WARN',
      hook: 'endFields',
      droppedKeys: ['route', 'statusCode'],
    })
    for (const line of lines) expect(line).not.toContain('forged-secret')
  })

  it('writes no dropped-keys WARN when a hook returns none of the owned keys', async () => {
    const { entries, app } = optionsApp({
      fields: () => ({ tenant: 't-1' }),
      endFields: () => ({ userId: 'u-1' }),
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(entries().filter((e) => e.level === 'WARN')).toEqual([])
  })

  it('names userAgent and cf only when include turns them on', async () => {
    const { entries, app } = optionsApp({
      include: { userAgent: true },
      endFields: () => ({ userAgent: 'mine', cf: 'mine' }),
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    const dropped = entries().filter((e) => e.droppedKeys !== undefined)
    expect(dropped).toHaveLength(1)
    expect(dropped[0].droppedKeys).toEqual(['userAgent'])
  })
})

/** A hook that returns a Proxy whose `traps` throw an Error with `message`. */
function proxyThrowingIn(traps: (keyof ProxyHandler<object>)[], message: string): () => LogFields {
  const trap = () => {
    throw new Error(message)
  }
  const handler: ProxyHandler<LogFields> = Object.fromEntries(traps.map((name) => [name, trap]))
  return () => new Proxy({}, handler)
}

function throwingHook(): never {
  throw new Error('broke')
}

describe('useLogger hook errors', () => {
  beforeEach(() => _reset())

  it('a throwing fields hook leaves the response alone, keeps both request lines, and warns once', async () => {
    const { starts, ends, warnings, app } = optionsApp({
      fields: () => {
        throw new Error('fields broke')
      },
    })
    app.get('/', (c) => c.text('handled'))

    for (let i = 0; i < 2; i++) {
      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('handled')
    }

    expect(starts()).toHaveLength(2)
    expect(ends()).toHaveLength(2)
    for (const e of ends()) expect(e).toMatchObject({ level: 'INFO', statusCode: 200, route: '/' })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      hook: 'fields',
      err: expect.objectContaining({ message: 'fields broke' }),
      requestId: expect.any(String),
      traceId: expect.any(String),
    })
  })

  it('a throwing endFields hook keeps request.end without its fields, and warns once', async () => {
    const { ends, warnings, app } = optionsApp({
      endFields: () => {
        throw new Error('endFields broke')
      },
    })
    app.get('/', (c) => c.text('handled'))

    for (let i = 0; i < 2; i++) expect(await (await app.request('/')).text()).toBe('handled')

    expect(ends()).toHaveLength(2)
    for (const e of ends()) expect(e).toMatchObject({ level: 'INFO', statusCode: 200, route: '/' })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      hook: 'endFields',
      err: expect.objectContaining({ message: 'endFields broke' }),
    })
  })

  it('a throwing level hook falls back to the default level, and warns once', async () => {
    const { ends, warnings, app } = optionsApp({
      level: () => {
        throw new Error('level broke')
      },
    })
    app.get('/', (c) => c.text('nope', 404))

    for (let i = 0; i < 2; i++) expect((await app.request('/')).status).toBe(404)

    expect(ends()).toHaveLength(2)
    for (const e of ends()) expect(e).toMatchObject({ level: 'WARN', statusCode: 404 })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      hook: 'level',
      err: expect.objectContaining({ message: 'level broke' }),
    })
  })

  it('a level hook that returns an unknown level falls back to the default level, and warns', async () => {
    const { end, warnings, app } = optionsApp({ level: () => 'warning' as never })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(end()).toMatchObject({ level: 'INFO' })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({ hook: 'level', returned: 'string' })
  })

  it('treats an async fields or endFields hook as a failure: no fields, one WARN each', async () => {
    const { entries, ends, warnings, app } = optionsApp({
      fields: (async () => ({ tenant: 't-1' })) as never,
      endFields: (async () => ({ userId: 'u-1' })) as never,
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    for (const entry of entries()) {
      expect(entry).not.toHaveProperty('tenant')
      expect(entry).not.toHaveProperty('userId')
    }
    expect(ends()).toHaveLength(1)
    expect(warnings().map((w) => [w.hook, w.returned])).toEqual([
      ['fields', 'Promise'],
      ['endFields', 'Promise'],
    ])
  })

  it('handles a rejecting async hook, so there is no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const { ends, warnings, app } = optionsApp({
        fields: (() => Promise.reject(new Error('fields rejected'))) as never,
        endFields: (async () => {
          throw new Error('endFields rejected')
        }) as never,
        level: (() => Promise.reject(new Error('level rejected'))) as never,
      })
      app.get('/', (c) => c.text('ok'))
      const res = await app.request('/')
      expect(res.status).toBe(200)
      // Unhandled rejections are reported after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
      expect(ends()).toHaveLength(1)
      expect(ends()[0]).toMatchObject({ level: 'INFO', statusCode: 200 })
      expect(warnings().map((w) => [w.hook, w.returned])).toEqual([
        ['fields', 'Promise'],
        ['endFields', 'Promise'],
        ['level', 'Promise'],
      ])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('treats a fields hook that returns a string or an array as a failure', async () => {
    for (const value of ['abc', ['a']]) {
      const { entries, warnings, app } = optionsApp({ fields: () => value as never })
      app.get('/', (c) => c.text('ok'))
      await app.request('/')
      for (const entry of entries()) expect(entry).not.toHaveProperty('0')
      expect(warnings()).toHaveLength(1)
      expect(warnings()[0].hook).toBe('fields')
    }
  })

  it('accepts a fields or endFields hook that returns undefined, without a WARN', async () => {
    const { ends, warnings, app } = optionsApp({
      fields: () => undefined,
      endFields: () => undefined,
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(ends()).toHaveLength(1)
    expect(warnings()).toEqual([])
  })

  it('treats a fields result with a throwing getter as a failure: same response, no fields, one WARN', async () => {
    const { starts, ends, warnings, app } = optionsApp({
      fields: () => ({
        tenant: 't-1',
        get broken(): string {
          throw new Error('getter broke')
        },
      }),
    })
    app.get('/', (c) => c.text('handled'))
    for (let i = 0; i < 2; i++) {
      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('handled')
    }
    expect(starts()).toHaveLength(2)
    expect(ends()).toHaveLength(2)
    for (const e of [...starts(), ...ends()]) expect(e).not.toHaveProperty('tenant')
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      hook: 'fields',
      err: expect.objectContaining({ message: 'getter broke' }),
    })
  })

  it('treats an endFields result with a throwing getter as a failure: request.end is still written', async () => {
    const { ends, warnings, app } = optionsApp({
      endFields: () => ({
        userId: 'u-1',
        get broken(): string {
          throw new Error('getter broke')
        },
      }),
    })
    app.get('/', (c) => c.text('handled'))
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('handled')
    expect(ends()).toHaveLength(1)
    expect(ends()[0]).toMatchObject({ level: 'INFO', statusCode: 200 })
    expect(ends()[0]).not.toHaveProperty('userId')
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      hook: 'endFields',
      err: expect.objectContaining({ message: 'getter broke' }),
    })
  })

  it('treats a Proxy result whose traps throw as a failure, for fields and endFields', async () => {
    const hostile = proxyThrowingIn(['ownKeys', 'get', 'has'], 'trap broke')
    const { starts, ends, warnings, app } = optionsApp({ fields: hostile, endFields: hostile })
    app.get('/', (c) => c.text('handled'))
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('handled')
    expect(starts()).toHaveLength(1)
    expect(ends()).toHaveLength(1)
    expect(warnings().map((w) => w.hook)).toEqual(['fields', 'endFields'])
    for (const w of warnings()) {
      expect(w).toMatchObject({ err: expect.objectContaining({ message: 'trap broke' }) })
    }
  })

  it('treats a Proxy result whose ownKeys trap alone throws as a failure', async () => {
    const hostile = proxyThrowingIn(['ownKeys'], 'ownKeys broke')
    const { ends, warnings, app } = optionsApp({ endFields: hostile })
    app.get('/', (c) => c.text('handled'))
    expect((await app.request('/')).status).toBe(200)
    expect(ends()).toHaveLength(1)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      hook: 'endFields',
      err: expect.objectContaining({ message: 'ownKeys broke' }),
    })
  })

  it('warns once per useLogger instance', async () => {
    const lines = _captureLines()
    for (let i = 0; i < 2; i++) {
      const app = new Hono()
      app.use(useLogger(createLogger({ service: 'test-mw' }), { endFields: throwingHook }))
      app.get('/', (c) => c.text('ok'))
      await app.request('/')
      await app.request('/')
    }
    const warns = lines.map((l) => JSON.parse(l)).filter((e) => e.hook === 'endFields')
    expect(warns).toHaveLength(2)
  })
})

function forgedEscapeKeys() {
  return { statusCodeAssumed: 'forged', originalErr: 'forged' }
}

describe('useLogger throws that escape Hono', () => {
  beforeEach(() => _reset())

  it('writes request.end at ERROR for a non-Error throw, then rethrows the same value', async () => {
    const { end, app } = optionsApp({
      endFields: () => ({ userId: 'u-1' }),
      level: () => 'info',
    })
    app.get('/x', () => {
      throw 'boom'
    })
    await expect(app.request('/x')).rejects.toBe('boom')
    expect(end()).toMatchObject({
      level: 'ERROR',
      statusCode: 500,
      route: '/x',
      path: '/x',
      userId: 'u-1',
      err: { type: 'string', message: 'boom' },
    })
    expect(typeof end().duration).toBe('number')
  })

  it('writes request.end when onError throws, then rethrows its error', async () => {
    const { end, app } = optionsApp()
    app.onError(() => {
      throw new Error('onError broke')
    })
    app.get('/x', () => {
      throw new Error('handler broke')
    })
    await expect(app.request('/x')).rejects.toThrow('onError broke')
    expect(end()).toMatchObject({
      level: 'ERROR',
      statusCode: 500,
      err: expect.objectContaining({ type: 'Error', message: 'onError broke' }),
    })
  })

  it('leaves the thrown value and the response to an outer middleware, unchanged', async () => {
    const lines = _captureLines()
    const thrown = { code: 42 }
    let caught: unknown
    const app = new Hono()
    app.use(async (c, next) => {
      try {
        await next()
      } catch (value) {
        caught = value
        c.res = new Response('outer', { status: 503 })
      }
    })
    app.use(useLogger(createLogger({ service: 'test-mw' })))
    app.get('/x', () => {
      throw thrown
    })
    const res = await app.request('/x')
    expect(caught).toBe(thrown)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('outer')
    expect(res.headers.get('X-Request-Id')).toBeNull()
    const ends = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(messageStartsWith('request.end'))
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({
      level: 'ERROR',
      statusCode: 500,
      statusCodeAssumed: true,
      err: { type: 'object', message: '{"code":42}' },
    })
    expect(ends[0]).not.toHaveProperty('originalErr')
  })

  it('assumes 500 when onError throws, though Hono may answer with another status', async () => {
    // Hono catches onError's throw at useLogger's own level and calls onError again with it,
    // so the response is whatever onError returns for the second error: here, a 502.
    const { end, app } = optionsApp({ level: () => 'info' })
    app.onError((err) => {
      if (err instanceof HTTPException) return err.getResponse()
      throw new HTTPException(502, { message: 'bad gateway' })
    })
    app.get('/x', () => {
      throw new Error('handler broke')
    })
    const res = await app.request('/x')
    expect(res.status).toBe(502)
    expect(end()).toMatchObject({
      level: 'ERROR',
      statusCode: 500,
      statusCodeAssumed: true,
      err: expect.objectContaining({ type: 'HTTPException', message: 'bad gateway' }),
      originalErr: expect.objectContaining({ type: 'Error', message: 'handler broke' }),
    })
  })

  it('logs ERROR 500 for a throw an outer middleware turns into a 200, marked as assumed', async () => {
    const lines = _captureLines()
    const app = new Hono()
    app.use(async (c, next) => {
      try {
        await next()
      } catch {
        c.res = new Response('recovered', { status: 200 })
      }
    })
    app.use(useLogger(createLogger({ service: 'test-mw' })))
    app.get('/x', () => {
      throw 'x'
    })
    const res = await app.request('/x')
    expect(res.status).toBe(200)
    const end = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(messageStartsWith('request.end'))
    expect(end).toMatchObject({ level: 'ERROR', statusCode: 500, statusCodeAssumed: true })
  })

  it('does not mark a status Hono answered with as assumed', async () => {
    const { ends, app } = optionsApp()
    app.get('/ok', (c) => c.text('ok'))
    app.get('/boom', () => {
      throw new Error('kaboom')
    })
    await app.request('/ok')
    await app.request('/boom')
    expect(ends()).toHaveLength(2)
    for (const e of ends()) {
      expect(e).not.toHaveProperty('statusCodeAssumed')
      expect(e).not.toHaveProperty('originalErr')
    }
  })

  it('does not let a hook set statusCodeAssumed or originalErr', async () => {
    const { entries, app } = optionsApp({ fields: forgedEscapeKeys, endFields: forgedEscapeKeys })
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) {
      expect(entry).not.toHaveProperty('statusCodeAssumed')
      expect(entry).not.toHaveProperty('originalErr')
    }
  })
})

/** A value no sink can write: JSON.stringify throws on it. */
function unwritable(): object {
  return {
    toJSON() {
      throw new Error('cannot write this')
    },
  }
}

/** A value whose `instanceof` check throws. */
function prototypeTrapProxy(): object {
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('getPrototypeOf broke')
      },
    },
  )
}

/** An Error that no sink can write, because one of its own properties is unwritable. */
function unwritableError(message: string): Error {
  return Object.assign(new Error(message), { detail: unwritable() })
}

/** Swaps in a sink that throws on every write, for the length of `run`. */
async function withThrowingSink(run: () => Promise<void>): Promise<void> {
  const previous = _setSink({
    write() {
      throw new Error('sink broke')
    },
  })
  try {
    await run()
  } finally {
    _setSink(previous)
  }
}

const UNUSUAL_THROWN_VALUES: [string, () => unknown][] = [
  ['an object whose toJSON throws', unwritable],
  ['a Proxy whose getPrototypeOf trap throws', prototypeTrapProxy],
  ['an Error with an unwritable property', () => unwritableError('hook broke')],
]

describe('useLogger diagnostics that cannot be written', () => {
  beforeEach(() => _reset())

  for (const [name, value] of UNUSUAL_THROWN_VALUES) {
    it(`a fields hook that throws ${name} leaves the response and both request lines alone`, async () => {
      const { starts, ends, app } = optionsApp({
        fields: () => {
          throw value()
        },
      })
      app.get('/', (c) => c.text('handled'))
      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('handled')
      expect(starts()).toHaveLength(1)
      expect(ends()).toHaveLength(1)
    })

    it(`an endFields hook that throws ${name} leaves the response and request.end alone`, async () => {
      const { ends, app } = optionsApp({
        endFields: () => {
          throw value()
        },
      })
      app.get('/', (c) => c.text('handled'))
      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('handled')
      expect(ends()).toHaveLength(1)
      expect(ends()[0]).toMatchObject({ level: 'INFO', statusCode: 200 })
    })

    it(`a level hook that throws ${name} falls back to the default level`, async () => {
      const { ends, app } = optionsApp({
        level: () => {
          throw value()
        },
      })
      app.get('/', (c) => c.text('handled'))
      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(ends()).toHaveLength(1)
      expect(ends()[0]).toMatchObject({ level: 'INFO', statusCode: 200 })
    })
  }

  it('reports a thrown non-Error value as { type, message } in the hook WARN', async () => {
    const { warnings, app } = optionsApp({
      fields: () => {
        throw unwritable()
      },
      endFields: () => {
        throw prototypeTrapProxy()
      },
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(warnings().map((w) => [w.hook, w.err])).toEqual([
      ['fields', { type: 'object', message: '[object Object]' }],
      ['endFields', { type: 'object', message: '{}' }],
    ])
  })

  it('never changes the response when the sink throws on every write', async () => {
    await withThrowingSink(async () => {
      const app = new Hono()
      app.use(
        useLogger(createLogger({ service: 'test-mw' }), {
          requestId: { from: [throwingHook], generate: () => 'not a safe value\n' },
          fields: () => ({ requestId: 'forged' }),
          endFields: throwingHook,
          level: throwingHook,
        }),
      )
      app.get('/', (c) => c.text('handled'))
      app.get('/boom', () => {
        throw new Error('kaboom')
      })
      for (let i = 0; i < 2; i++) {
        const res = await app.request('/')
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('handled')
        expect(res.headers.get('X-Request-Id')).toMatch(UUID_RE)
        expect((await app.request('/boom')).status).toBe(500)
      }
    })
  })

  it('rethrows an escaped value unchanged when the sink throws on every write', async () => {
    await withThrowingSink(async () => {
      const app = new Hono()
      app.use(useLogger(createLogger({ service: 'test-mw' })))
      app.get('/x', () => {
        throw 'boom'
      })
      await expect(app.request('/x')).rejects.toBe('boom')
    })
  })

  it('rethrows what onError threw even when request.end cannot be written', async () => {
    // Hono hands an Error that escapes useLogger to onError again, one level up. That second
    // call must get what onError threw, not the error of the request.end that failed.
    const { app } = optionsApp()
    const thrown = unwritableError('onError broke')
    const seen: unknown[] = []
    app.onError((err, c) => {
      seen.push(err)
      if (seen.length === 1) throw thrown
      return c.text('answered', 503)
    })
    app.get('/x', () => {
      throw new Error('handler broke')
    })
    const res = await app.request('/x')
    expect(res.status).toBe(503)
    expect(seen).toHaveLength(2)
    expect(seen[1] === thrown).toBe(true)
  })

  it('keeps the response, its headers and the request lines when a Context Field cannot be written', async () => {
    const { lines, app } = optionsApp({ fields: () => ({ broken: unwritable() as never }) })
    app.get('/', (c) => c.text('handled'))
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('handled')
    expect(res.headers.get('X-Request-Id')).toMatch(UUID_RE)
    // The core replaces only the value it cannot write, so neither request line is lost.
    const written = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(written.map((e) => e.message)).toEqual(['request.start GET /', 'request.end GET /'])
    for (const e of written) expect(e.broken).toMatch(/^\[Unserializable: /)
  })

  it('keeps the response and its headers when only request.end cannot be written', async () => {
    const { starts, app } = optionsApp({ endFields: () => ({ broken: unwritable() as never }) })
    app.get('/', (c) => c.text('handled'))
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('handled')
    expect(res.headers.get('X-Request-Id')).toMatch(UUID_RE)
    expect(starts()).toHaveLength(1)
  })
})

describe('useLogger returned values in the hook WARN', () => {
  beforeEach(() => _reset())

  it('logs only the type of a string a fields or endFields hook returned, never the string', async () => {
    const { lines, warnings, app } = optionsApp({
      fields: () => 'secret-token-abc' as never,
      endFields: () => 'secret-token-def' as never,
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(warnings().map((w) => [w.hook, w.returned])).toEqual([
      ['fields', 'string'],
      ['endFields', 'string'],
    ])
    for (const line of lines) expect(line).not.toMatch(/secret-token/)
  })

  it('logs the string a level hook returned as is', async () => {
    const { warnings, app } = optionsApp({ level: () => 'WARN' as never })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({ hook: 'level', returned: 'WARN' })
  })

  it('never logs a string a level hook returned that is not a level name', async () => {
    const { warnings, app } = optionsApp({
      level: (_s, _e, c) => c.req.header('authorization') as never,
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/', { headers: { authorization: 'Bearer secret-token' } })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({ hook: 'level', returned: 'string' })
    expect(JSON.stringify(warnings())).not.toContain('secret-token')
  })
})

describe('useLogger thenables', () => {
  beforeEach(() => _reset())

  it('never calls then on a thenable that is not a Promise, and treats it as a failure', async () => {
    const then = vi.fn()
    // A lazy query builder returned by mistake: a thenable whose then must never run.
    // oxlint-disable-next-line unicorn/no-thenable
    const thenable = () => ({ then }) as never
    const { ends, warnings, app } = optionsApp({
      requestId: { from: [thenable], validate: thenable },
      fields: thenable,
      endFields: thenable,
      level: thenable,
    })
    app.get('/', (c) => c.text('ok'))
    const res = await app.request('/', { headers: { 'x-request-id': 'abc' } })
    expect(res.status).toBe(200)
    expect(then).not.toHaveBeenCalled()
    expect(ends()).toHaveLength(1)
    expect(warnings().map((w) => [w.hook, w.returned])).toEqual([
      ['fields', 'thenable'],
      ['endFields', 'thenable'],
      ['level', 'thenable'],
    ])
  })
})

describe('useLogger query string', () => {
  beforeEach(() => _reset())

  it('never logs the query string, with include, fields, endFields and level on', async () => {
    const { lines, end, app } = optionsApp({
      include: { userAgent: true, cf: true },
      fields: () => ({ tenant: 't-1' }),
      endFields: () => ({ userId: 'u-1' }),
      level: () => 'info',
    })
    app.get('/search', (c) => c.text('ok'))
    await app.request(
      cfRequest('/search?token=s3cr3t&q=private', CF, { 'user-agent': 'test-agent/1.0' }),
    )
    expect(end()).toMatchObject({
      path: '/search',
      route: '/search',
      message: 'request.end GET /search',
      tenant: 't-1',
      userId: 'u-1',
      userAgent: 'test-agent/1.0',
      cf: CF_BASICS,
    })
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toContain('s3cr3t')
      expect(line).not.toContain('private')
      expect(line).not.toContain('?')
    }
  })
})

function cfRequest(path: string, cf?: Record<string, unknown>, headers: HeadersInit = {}) {
  const req = new Request(`http://localhost${path}`, { headers })
  if (cf) Object.defineProperty(req, 'cf', { value: cf })
  return req
}

const CF = { colo: 'SJC', country: 'US', asn: 13335, city: 'San Jose', tlsVersion: 'TLSv1.3' }
const CF_BASICS = { colo: 'SJC', country: 'US', asn: 13335 }

describe('useLogger include', () => {
  beforeEach(() => _reset())

  it('adds no userAgent or cf by default', async () => {
    const { entries, app } = optionsApp()
    app.get('/', (c) => c.text('ok'))
    await app.request(cfRequest('/', CF, { 'user-agent': 'curl/8' }))
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) {
      expect(entry).not.toHaveProperty('userAgent')
      expect(entry).not.toHaveProperty('cf')
    }
  })

  it('adds userAgent and cf colo, country and asn to request.start and request.end only', async () => {
    const { entries, start, end, app } = optionsApp({ include: { userAgent: true, cf: true } })
    app.get('/', (c) => {
      ;(c.get('logger' as never) as Logger).info('from handler')
      return c.text('ok')
    })
    await app.request(cfRequest('/', CF, { 'user-agent': 'curl/8' }))
    for (const line of [start(), end()]) {
      expect(line.userAgent).toBe('curl/8')
      expect(line.cf).toEqual(CF_BASICS)
    }
    const handlerLine = entries().find((e) => e.message === 'from handler')
    expect(handlerLine).not.toHaveProperty('userAgent')
    expect(handlerLine).not.toHaveProperty('cf')
  })

  it('includes only what was asked for', async () => {
    const { end, app } = optionsApp({ include: { cf: true } })
    app.get('/', (c) => c.text('ok'))
    await app.request(cfRequest('/', CF, { 'user-agent': 'curl/8' }))
    expect(end()).not.toHaveProperty('userAgent')
    expect(end().cf).toEqual(CF_BASICS)
  })

  it('omits userAgent and cf when the request has neither, as on Node.js', async () => {
    const { end, app } = optionsApp({ include: { userAgent: true, cf: true } })
    app.get('/', (c) => c.text('ok'))
    await app.request(cfRequest('/'))
    expect(end()).not.toHaveProperty('userAgent')
    expect(end()).not.toHaveProperty('cf')
  })

  it('leaves out cf values of the wrong type', async () => {
    const { end, app } = optionsApp({ include: { cf: true } })
    app.get('/', (c) => c.text('ok'))
    await app.request(cfRequest('/', { colo: 'SJC', country: { x: 1 }, asn: '13335' }))
    expect(end().cf).toEqual({ colo: 'SJC' })
  })
})
