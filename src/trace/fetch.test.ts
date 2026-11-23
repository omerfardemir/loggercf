import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import {
  createLogger,
  getLogger,
  getTraceContext,
  runWithLogger,
  setLoggerContext,
  _captureEntries,
  _reset,
} from '../core/logger'
import { useLogger } from '../hono/middleware'
import { tracedFetch, tracedFetcher } from './fetch'
import { parseTraceparent } from './trace'

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const CALLER_SPAN = 'b7ad6b7169203331'
const TRACEPARENT = `00-${TRACE_ID}-${CALLER_SPAN}-01`

const rootLogger = () => createLogger({ service: 'fetch-svc' })

/**
 * A `fetch` that does what a real one does with its arguments: builds `new Request(...args)`
 * (rejecting when that throws), and records it. `sent` holds what would go on the wire.
 */
function recordingFetch(respond: (request: Request) => Promise<Response>) {
  const sent: Request[] = []
  const fetch = vi.fn((...args: unknown[]): Promise<Response> => {
    let request: Request
    try {
      request = new Request(...(args as [RequestInfo | URL, RequestInit?]))
    } catch (err) {
      return Promise.reject(err)
    }
    sent.push(request)
    return respond(request)
  })
  return { fetch, sent }
}

/** A Fetcher-shaped mock: a recording `fetch`, plus a `connect` that returns its `this`. */
function mockBinding(
  respond: (request: Request) => Promise<Response> = async () => new Response('ok'),
) {
  const connect = vi.fn(function (this: unknown) {
    return this
  })
  return { ...recordingFetch(respond), connect }
}

function inContext<R>(fn: () => R, fields?: Record<string, string>): R {
  return runWithLogger({ logger: rootLogger(), traceparent: TRACEPARENT, fields }, fn)
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** A gateway that never trusts the client's X-Request-Id and forwards `c.req.raw` to API. */
function gateway(binding: ReturnType<typeof mockBinding>, forwardRequestId: boolean) {
  const app = new Hono<{ Bindings: { API: typeof binding } }>()
  app.use(useLogger(rootLogger(), { requestId: { trustIncoming: false } }))
  app.all('*', (c) => tracedFetcher(c.env.API, { forwardRequestId }).fetch(c.req.raw))
  return app
}

describe('tracedFetcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it("sends a traceparent carrying the caller's trace ID and span", async () => {
    const binding = mockBinding()
    let spanId: string | undefined
    await inContext(async () => {
      spanId = getTraceContext()!.spanId
      await tracedFetcher(binding).fetch('https://svc/api')
    })

    const parsed = parseTraceparent(binding.sent[0].headers.get('traceparent')!)
    expect(parsed?.traceId).toBe(TRACE_ID)
    expect(parsed?.spanId).toBe(spanId)
  })

  it('sends tracestate when the trace has one', async () => {
    const binding = mockBinding()
    await runWithLogger(
      { logger: rootLogger(), traceparent: TRACEPARENT, tracestate: 'congo=t61rcWkgMzE' },
      () => tracedFetcher(binding).fetch('https://svc/api'),
    )
    expect(binding.sent[0].headers.get('tracestate')).toBe('congo=t61rcWkgMzE')
  })

  it("drops the caller's own tracestate when the trace has none: it belongs to another traceparent", async () => {
    const binding = mockBinding()
    const forwarded = new Request('https://svc/api', {
      headers: { traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`, tracestate: 'old=1' },
    })
    await inContext(async () => {
      await tracedFetcher(binding).fetch(forwarded)
      await tracedFetcher(binding).fetch('https://svc/api', { headers: { tracestate: 'old=2' } })
    })
    for (const request of binding.sent) {
      expect(request.headers.get('traceparent')).toMatch(new RegExp(`^00-${TRACE_ID}-`))
      expect(request.headers.has('tracestate')).toBe(false)
    }
    expect(forwarded.headers.get('tracestate')).toBe('old=1')
  })

  it('fetch(input, init): keeps init and its headers, without mutating init or its Headers', async () => {
    const binding = mockBinding()
    const callerHeaders = new Headers({ Authorization: 'Bearer abc' })
    const signal = new AbortController().signal
    const init: RequestInit = {
      method: 'POST',
      body: '{"a":1}',
      headers: callerHeaders,
      redirect: 'manual',
      signal,
    }
    const before = { ...init }

    await inContext(() => tracedFetcher(binding).fetch('https://svc/api', init))

    expect(init).toEqual(before)
    expect(init.headers).toBe(callerHeaders)
    expect([...callerHeaders]).toEqual([['authorization', 'Bearer abc']])

    const [input, passed] = binding.fetch.mock.calls[0] as [string, RequestInit]
    expect(input).toBe('https://svc/api')
    expect(passed).not.toBe(init)
    const [sent] = binding.sent
    expect(sent.method).toBe('POST')
    expect(sent.redirect).toBe('manual')
    expect(await sent.text()).toBe('{"a":1}')
    expect(sent.headers.get('authorization')).toBe('Bearer abc')
    expect(sent.headers.get('traceparent')).toMatch(new RegExp(`^00-${TRACE_ID}-`))
  })

  it('fetch(request): keeps the request and its streaming body, without mutating it', async () => {
    const recorded: unknown[][] = []
    const binding = {
      fetch: vi.fn(async (...args: unknown[]) => {
        recorded.push(args)
        return new Response('ok')
      }),
    }
    const request = new Request('https://svc/upload', {
      method: 'PUT',
      body: streamOf('streamed'),
      headers: { 'X-Custom': 'v' },
      redirect: 'manual',
      duplex: 'half',
    } as RequestInit)

    await inContext(() => tracedFetcher(binding).fetch(request))

    // The caller's Request is untouched: same headers, body not read.
    expect([...request.headers]).toEqual([['x-custom', 'v']])
    expect(request.bodyUsed).toBe(false)

    const [input, init] = recorded[0] as [Request, RequestInit]
    expect(input).toBe(request)
    // Only headers are overridden; method, body, redirect, signal (and cf) come from the Request.
    expect(Object.keys(init)).toEqual(['headers'])

    // What a fetch builds from these arguments keeps the body, method and headers.
    const sent = new Request(input, init)
    expect(sent.method).toBe('PUT')
    expect(sent.redirect).toBe('manual')
    expect(sent.headers.get('x-custom')).toBe('v')
    expect(sent.headers.get('traceparent')).toMatch(new RegExp(`^00-${TRACE_ID}-`))
    expect(await sent.text()).toBe('streamed')
  })

  it('fetch(request, init): init headers win over the Request headers, as in fetch()', async () => {
    const binding = mockBinding()
    const request = new Request('https://svc/api', { headers: { 'X-From': 'request' } })
    await inContext(() => tracedFetcher(binding).fetch(request, { headers: { 'X-From': 'init' } }))
    const [sent] = binding.sent
    expect(sent.headers.get('x-from')).toBe('init')
    expect(sent.headers.get('traceparent')).toBeTruthy()
  })

  it('fetch(url, request): uses a Request passed as init without mutating it or taking its body', async () => {
    const forwarded = new Request('https://old/api', {
      method: 'POST',
      body: 'payload',
      headers: { 'X-Custom': 'v' },
      redirect: 'manual',
    })
    let bodyUsedWhenCalled: boolean | undefined
    let args: unknown[] = []
    const binding = {
      fetch: vi.fn(async (...a: unknown[]) => {
        bodyUsedWhenCalled = forwarded.bodyUsed
        args = a
        return new Response('ok')
      }),
    }

    await inContext(() => tracedFetcher(binding).fetch('https://svc/api', forwarded))

    // The binding gets the body untouched, as with plain fetch(url, request).
    expect(bodyUsedWhenCalled).toBe(false)
    expect(forwarded.bodyUsed).toBe(false)
    expect([...forwarded.headers]).toEqual([
      ['content-type', 'text/plain;charset=UTF-8'],
      ['x-custom', 'v'],
    ])

    // What the binding builds matches what plain fetch(url, request) would send.
    const plainSource = new Request('https://old/api', {
      method: 'POST',
      body: 'payload',
      headers: { 'X-Custom': 'v' },
      redirect: 'manual',
    })
    const plain = new Request('https://svc/api', plainSource)
    const sent = new Request(...(args as [string, RequestInit]))
    expect(args[0]).toBe('https://svc/api')
    expect(sent.url).toBe(plain.url)
    expect(sent.method).toBe(plain.method)
    expect(sent.redirect).toBe(plain.redirect)
    expect(sent.headers.get('x-custom')).toBe('v')
    expect(sent.headers.get('content-type')).toBe(plain.headers.get('content-type'))
    expect(sent.headers.get('traceparent')).toBeTruthy()
    expect(await sent.text()).toBe(await plain.text())
    // Reading it takes the caller's body, as plain fetch does.
    expect(forwarded.bodyUsed).toBe(plainSource.bodyUsed)
  })

  it("fetch(url, request): keeps workerd's fetcher, so the global fetch reaches the same destination", async () => {
    const via = { fetch: async () => new Response('via') }
    const routed = Object.defineProperty(new Request('https://old/api'), 'fetcher', { value: via })
    const unrouted = Object.defineProperty(new Request('https://old/api'), 'fetcher', {
      value: null,
    })
    const calls: unknown[][] = []
    const binding = {
      fetch: vi.fn(async (...a: unknown[]) => {
        calls.push(a)
        return new Response('ok')
      }),
    }

    await inContext(async () => {
      await tracedFetcher(binding).fetch('https://svc/api', routed)
      await tracedFetcher(binding).fetch('https://svc/api', unrouted)
    })

    expect((calls[0][1] as { fetcher?: unknown }).fetcher).toBe(via)
    // `fetcher: null` means no fetcher: it is left out, like any member that is not set.
    expect(calls[1][1]).not.toHaveProperty('fetcher')
  })

  it('outside a Logging Context, passes the same arguments through and returns the same promise', async () => {
    const response = new Response('ok')
    const promise = Promise.resolve(response)
    const binding = { fetch: vi.fn((..._args: unknown[]) => promise) }
    const request = new Request('https://svc/api')
    const init = { headers: { 'X-Custom': 'v' } }

    const svc = tracedFetcher(binding, { spans: true, forwardRequestId: true })
    expect(svc.fetch(request)).toBe(promise)
    expect(svc.fetch('https://svc/api', init)).toBe(promise)

    expect(binding.fetch.mock.calls[0]).toEqual([request])
    expect(binding.fetch.mock.calls[0][0]).toBe(request)
    expect(binding.fetch.mock.calls[1][1]).toBe(init)
    expect(init).toEqual({ headers: { 'X-Custom': 'v' } })
  })

  it('returns what the binding returns and rejects with the same error', async () => {
    const response = new Response('hi', { status: 503 })
    const ok = mockBinding(async () => response)
    await inContext(async () => {
      expect(await tracedFetcher(ok).fetch('https://svc/api')).toBe(response)
    })

    const error = new TypeError('network down')
    const failing = mockBinding(() => Promise.reject(error))
    await inContext(async () => {
      await expect(tracedFetcher(failing).fetch('https://svc/api')).rejects.toBe(error)
    })
    expect(failing.fetch).toHaveBeenCalledOnce() // no retry
  })

  it('a header value it cannot send never fails the call: it is left out', async () => {
    const binding = mockBinding()
    await runWithLogger(
      { logger: rootLogger(), traceparent: TRACEPARENT, tracestate: 'bad\nvalue' },
      () => tracedFetcher(binding).fetch('https://svc/api'),
    )
    const [sent] = binding.sent
    expect(sent.headers.get('traceparent')).toBeTruthy()
    expect(sent.headers.has('tracestate')).toBe(false)
  })

  it('invalid caller headers reach the binding unchanged, so it throws its own error', async () => {
    const binding = mockBinding()
    const init = { headers: [['bad header', 'v']] } as unknown as RequestInit
    await inContext(async () => {
      await expect(tracedFetcher(binding).fetch('https://svc/api', init)).rejects.toThrow(TypeError)
    })
    expect(binding.fetch.mock.calls[0]).toEqual(['https://svc/api', init])
    expect(binding.fetch.mock.calls[0][1]).toBe(init)
  })

  describe('forwardRequestId', () => {
    it('is off by default', async () => {
      const binding = mockBinding()
      await inContext(() => tracedFetcher(binding).fetch('https://svc/api'), { requestId: 'r-1' })
      expect(binding.sent[0].headers.has('x-request-id')).toBe(false)
    })

    it('sends the requestId Context Field as X-Request-Id', async () => {
      const binding = mockBinding()
      const svc = tracedFetcher(binding, { forwardRequestId: true })
      await inContext(() => svc.fetch('https://svc/api'), { requestId: 'r-1' })
      await inContext(() => svc.fetch(new Request('https://svc/api')), { requestId: 'r-2' })
      expect(binding.sent[0].headers.get('x-request-id')).toBe('r-1')
      expect(binding.sent[1].headers.get('x-request-id')).toBe('r-2')
    })

    it('reads requestId when the call is made, after setLoggerContext', async () => {
      const binding = mockBinding()
      await inContext(() => {
        setLoggerContext({ requestId: 'set-later' })
        return tracedFetcher(binding, { forwardRequestId: true }).fetch('https://svc/api')
      })
      expect(binding.sent[0].headers.get('x-request-id')).toBe('set-later')
    })

    it('replaces an X-Request-Id already on the call, in init or on the Request', async () => {
      const binding = mockBinding()
      const svc = tracedFetcher(binding, { forwardRequestId: true })
      const request = new Request('https://svc/api', { headers: { 'X-Request-Id': 'mine-2' } })
      const init = { headers: { 'x-request-id': 'mine' } }
      await inContext(
        async () => {
          await svc.fetch('https://svc/api', init)
          await svc.fetch(request)
        },
        { requestId: 'context-id' },
      )
      expect(binding.sent[0].headers.get('x-request-id')).toBe('context-id')
      expect(binding.sent[1].headers.get('x-request-id')).toBe('context-id')
      // ...without changing what the caller passed.
      expect(init).toEqual({ headers: { 'x-request-id': 'mine' } })
      expect(request.headers.get('x-request-id')).toBe('mine-2')
    })

    it('leaves the headers alone when there is no requestId, or it is not a safe header value', async () => {
      const binding = mockBinding()
      const svc = tracedFetcher(binding, { forwardRequestId: true })
      const headers = { 'X-Request-Id': 'caller-id' }
      await inContext(() => svc.fetch('https://svc/api'))
      await inContext(() => svc.fetch('https://svc/api'), { requestId: 'a\r\nb' })
      await inContext(() => svc.fetch('https://svc/api', { headers }))
      expect(binding.sent[0].headers.has('x-request-id')).toBe(false)
      expect(binding.sent[1].headers.has('x-request-id')).toBe(false)
      expect(binding.sent[2].headers.get('x-request-id')).toBe('caller-id')
    })

    describe('a gateway forwarding c.req.raw', () => {
      it("sends the gateway's Request ID, not the client's X-Request-Id", async () => {
        const binding = mockBinding()
        const res = await gateway(binding, true).request(
          '/api',
          { headers: { 'X-Request-Id': 'client-id' } },
          { API: binding },
        )
        const gatewayId = res.headers.get('X-Request-Id')
        expect(gatewayId).toBeTruthy()
        expect(gatewayId).not.toBe('client-id')
        expect(binding.sent[0].headers.get('x-request-id')).toBe(gatewayId)
      })

      it("without the option, the client's X-Request-Id passes through unchanged", async () => {
        const binding = mockBinding()
        await gateway(binding, false).request(
          '/api',
          { headers: { 'X-Request-Id': 'client-id' } },
          { API: binding },
        )
        expect(binding.sent[0].headers.get('x-request-id')).toBe('client-id')
      })
    })
  })

  describe('spans', () => {
    it('writes no span by default', async () => {
      const entries = _captureEntries()
      await inContext(() => tracedFetcher(mockBinding()).fetch('https://svc/api'))
      expect(entries).toEqual([])
    })

    it('writes one span.end per call with method, host, path (no query) and statusCode', async () => {
      const entries = _captureEntries()
      const binding = mockBinding(async () => new Response(null, { status: 201 }))
      const svc = tracedFetcher(binding, { spans: true })
      await inContext(async () => {
        await svc.fetch('https://svc.internal:8443/users/42?token=secret#frag', { method: 'post' })
        await svc.fetch(new Request('https://svc.internal/health'))
      })

      expect(entries).toHaveLength(2)
      const [first, second] = entries
      expect(first).toMatchObject({
        level: 'INFO',
        message: 'span.end fetch',
        method: 'POST',
        host: 'svc.internal:8443',
        path: '/users/42',
        statusCode: 201,
        span: { operation: 'fetch', status: 'OK' },
      })
      expect(JSON.stringify(first)).not.toContain('secret')
      expect(second).toMatchObject({ method: 'GET', host: 'svc.internal', path: '/health' })
    })

    it('logs the method as it goes on the wire: only the methods fetch normalises are uppercased', async () => {
      const entries = _captureEntries()
      const binding = mockBinding()
      const svc = tracedFetcher(binding, { spans: true })
      await inContext(async () => {
        await svc.fetch('https://svc/a', { method: 'dElEtE' })
        await svc.fetch('https://svc/a', { method: 'Options' })
        await svc.fetch('https://svc/a', { method: 'propfind' })
      })
      expect(binding.sent.map((request) => request.method)).toEqual([
        'DELETE',
        'OPTIONS',
        'propfind',
      ])
      expect(entries.map((entry) => entry.method)).toEqual(['DELETE', 'OPTIONS', 'propfind'])

      // `patch` is sent as `patch` (Node's Request warns about it, so this binding builds none).
      const raw = { fetch: vi.fn(async (..._args: unknown[]) => new Response('ok')) }
      await inContext(() =>
        tracedFetcher(raw, { spans: true }).fetch('https://svc/a', { method: 'patch' }),
      )
      expect(raw.fetch.mock.calls[0][1]).toMatchObject({ method: 'patch' })
      expect(entries[3]).toMatchObject({ message: 'span.end fetch', method: 'patch' })
    })

    it('the span is the parent of the downstream work: traceparent carries its span ID', async () => {
      const entries = _captureEntries()
      const binding = mockBinding()
      await inContext(() => tracedFetcher(binding, { spans: true }).fetch('https://svc/api'))

      const sent = parseTraceparent(binding.sent[0].headers.get('traceparent')!)
      expect(entries[0].traceId).toBe(TRACE_ID)
      expect(entries[0].spanId).toBe(sent?.spanId)
      expect(entries[0].parentSpanId).not.toBe(sent?.spanId)
    })

    it('a 5xx response is a successful call: OK status, statusCode recorded, no throw', async () => {
      const entries = _captureEntries()
      const response = new Response(null, { status: 502 })
      const svc = tracedFetcher(
        mockBinding(async () => response),
        { spans: true },
      )
      const res = await inContext(() => svc.fetch('https://svc/api'))
      expect(res).toBe(response)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ level: 'INFO', statusCode: 502, span: { status: 'OK' } })
    })

    it('logs ERROR on a network failure and rethrows the same error', async () => {
      const entries = _captureEntries()
      const error = new TypeError('Network connection lost.')
      const binding = mockBinding(() => Promise.reject(error))
      const svc = tracedFetcher(binding, { spans: true })

      await inContext(async () => {
        await expect(svc.fetch('https://svc/api?key=1')).rejects.toBe(error)
      })

      expect(binding.fetch).toHaveBeenCalledOnce()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        level: 'ERROR',
        message: 'span.end fetch',
        method: 'GET',
        host: 'svc',
        path: '/api',
        span: { status: 'ERROR', error: 'Network connection lost.' },
      })
      expect(entries[0].statusCode).toBeUndefined()
    })

    it("never shows the caller's host, path or statusCode Context Fields on its span", async () => {
      const entries = _captureEntries()
      const binding = mockBinding()
      const outer = { method: 'PATCH', host: 'gateway', path: '/outer', statusCode: '418' }
      await runWithLogger(
        { logger: rootLogger(), traceparent: TRACEPARENT, fields: outer },
        async () => {
          // A relative URL can't be parsed: the binding rejects it.
          await expect(
            tracedFetcher(binding, { spans: true }).fetch('/relative?token=abc'),
          ).rejects.toThrow(TypeError)
        },
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ level: 'ERROR', method: 'GET' })
      for (const key of ['host', 'path', 'statusCode']) expect(entries[0]).not.toHaveProperty(key)
    })

    it('a binding that throws synchronously still throws synchronously, after an ERROR span', () => {
      const entries = _captureEntries()
      const error = new Error('sync')
      const binding = {
        fetch: (_input: string): Promise<Response> => {
          throw error
        },
      }
      inContext(() => {
        expect(() => tracedFetcher(binding, { spans: true }).fetch('https://svc/api')).toThrow(
          error,
        )
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ level: 'ERROR', span: { status: 'ERROR' } })
    })

    it('span fields stay on the span.end line, not in the caller context', async () => {
      const entries = _captureEntries()
      await inContext(async () => {
        await tracedFetcher(mockBinding(), { spans: true }).fetch('https://svc/api')
        getLogger().info('after')
      })
      expect(entries[1].message).toBe('after')
      expect(entries[1].path).toBeUndefined()
      expect(entries[1].statusCode).toBeUndefined()
    })

    it('outside a Logging Context, writes no span', async () => {
      const entries = _captureEntries()
      await tracedFetcher(mockBinding(), { spans: true }).fetch('https://svc/api')
      expect(entries).toEqual([])
    })
  })

  describe('Fetcher shape', () => {
    it('passes other members through, called on the binding itself', () => {
      const binding = mockBinding()
      const svc = tracedFetcher(binding)
      expect(svc.connect()).toBe(binding)
      expect(binding.connect).toHaveBeenCalledOnce()
    })

    it('passes non-function members and RPC-style methods through', async () => {
      const binding = {
        fetch: async () => new Response('ok'),
        name: 'svc',
        add: vi.fn(async (a: number, b: number) => a + b),
      }
      const svc = tracedFetcher(binding)
      expect(svc.name).toBe('svc')
      expect(await svc.add(2, 3)).toBe(5)
      expect('add' in svc).toBe(true)
    })

    it('does not change the binding', async () => {
      const binding = mockBinding()
      const original = binding.fetch
      tracedFetcher(binding, { spans: true })
      expect(binding.fetch).toBe(original)
    })

    it('wraps a frozen binding too', async () => {
      const recorded = recordingFetch(async () => new Response('ok'))
      const connect = vi.fn(function (this: unknown) {
        return this
      })
      const binding = Object.freeze({ fetch: recorded.fetch, connect, name: 'svc' })
      const svc = tracedFetcher(binding)

      await inContext(() => svc.fetch('https://svc/api'))
      expect(recorded.sent[0].headers.get('traceparent')).toMatch(new RegExp(`^00-${TRACE_ID}-`))
      expect(svc.connect()).toBe(binding)
      expect(svc.name).toBe('svc')
      expect('connect' in svc).toBe(true)
      expect(Object.isFrozen(binding)).toBe(true)
    })

    it("a frozen binding's own keys and descriptors show through the wrapper", () => {
      const tag = Symbol('tag')
      const binding = Object.freeze({
        fetch: async () => new Response('ok'),
        name: 'svc',
        [tag]: 1,
      })
      const svc = tracedFetcher(binding)

      expect(Object.keys(svc)).toEqual(['fetch', 'name'])
      expect(Reflect.ownKeys(svc)).toEqual(['fetch', 'name', tag])
      expect(Object.hasOwn(svc, 'name')).toBe(true)
      expect(Object.getOwnPropertyDescriptor(svc, 'name')).toEqual({
        value: 'svc',
        writable: false,
        enumerable: true,
        configurable: true,
      })
      // The descriptor's value is what reading the property gives: the wrapper's fetch.
      expect(Object.getOwnPropertyDescriptor(svc, 'fetch')?.value).toBe(svc.fetch)
      expect(svc.fetch).not.toBe(binding.fetch)
      expect({ ...svc }).toEqual({ fetch: svc.fetch, name: 'svc', [tag]: 1 })
      expect(Object.getOwnPropertyDescriptor(svc, 'missing')).toBeUndefined()
    })
  })
})

describe('tracedFetch options', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    _reset()
  })

  it('records a span with spans: true', async () => {
    const entries = _captureEntries()
    const mock = recordingFetch(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', mock.fetch)

    await inContext(() =>
      tracedFetch('https://api.example.com/v1/items?page=2', undefined, { spans: true }),
    )

    expect(mock.fetch).toHaveBeenCalledOnce()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      message: 'span.end fetch',
      method: 'GET',
      host: 'api.example.com',
      path: '/v1/items',
      statusCode: 404,
    })
  })

  it('logs ERROR on a network failure and rethrows the same error', async () => {
    const entries = _captureEntries()
    const error = new TypeError('fetch failed')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(error)),
    )

    await inContext(async () => {
      await expect(tracedFetch('https://api.example.com/', {}, { spans: true })).rejects.toBe(error)
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'ERROR', span: { status: 'ERROR' } })
  })

  it('keeps the headers of a Request passed on its own', async () => {
    const mock = recordingFetch(async () => new Response('ok'))
    vi.stubGlobal('fetch', mock.fetch)
    const request = new Request('https://api.example.com/', { headers: { Authorization: 'x' } })

    await inContext(() => tracedFetch(request))

    const [sent] = mock.sent
    expect(sent.headers.get('authorization')).toBe('x')
    expect(sent.headers.get('traceparent')).toBeTruthy()
    expect([...request.headers]).toEqual([['authorization', 'x']])
  })
})
