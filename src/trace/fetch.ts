import { getContextField, getTraceCarrier, setLoggerContext, withSpan } from '../core/logger'
import { injectCarrier } from './trace'
import { REQUEST_ID_HEADER, SAFE_HEADER_VALUE } from './headers'

/**
 * Options for `tracedFetch` and `tracedFetcher`. Every option is off by default.
 */
export interface TracedFetchOptions {
  /**
   * Record each call as a Span (`span.end fetch`), with `method`, `host`, `path` (the pathname
   * only: the query string can carry tokens) and the response `statusCode`. A call that throws
   * or rejects (a network failure) is logged at `ERROR` and the same error is rethrown. The
   * error is logged as it is: if its message quotes the URL (e.g. `Failed to parse URL from
   * /x?token=abc`), so does the line. Any response, 5xx included, is a completed call: the
   * Span's status is `OK` and `statusCode` says what came back. Written only inside a Logging
   * Context: `span.end fetch` when the trace is sampled; for an unsampled trace only a
   * failure is written, as one `fetch failed` line at `ERROR`.
   */
  spans?: boolean
  /**
   * Send the current Request ID (the `requestId` Context Field) as `X-Request-Id`, so the
   * receiver's `useLogger` can reuse it (subject to its own validation). It replaces any
   * `X-Request-Id` already on the call, in `init` or on the `Request`, so a gateway forwarding
   * the client's Request sends its own ID, not the client's. With no `requestId`, the headers
   * are left alone. On `tracedFetch` the ID goes to whatever host you call.
   */
  forwardRequestId?: boolean
}

/** The shape `tracedFetcher` needs: anything with a `fetch` like a service binding's. */
type FetchLike = (...args: any[]) => Promise<unknown>

/** One outgoing call, as `fetch` reads its arguments. */
interface Call {
  /** The arguments exactly as the caller passed them. */
  args: unknown[]
  input: unknown
  init: RequestInit | undefined
  /** `input`, when it is a `Request`. */
  request: Request | undefined
}

/** The Span operation name for an outgoing call. */
const SPAN_OPERATION = 'fetch'

/**
 * The `RequestInit` members `fetch(url, request)` reads from a `Request` used as `init`
 * (besides `headers`, which are rebuilt). A member the runtime's `Request` does not have is
 * `undefined` there and is left out, as `fetch` itself would.
 *
 * `fetcher` is workerd's: a Request built with a `fetcher` is sent through it by the global
 * `fetch`, so `tracedFetch(url, request)` keeps it to reach the same destination. Through a
 * binding it makes no difference: the binding is used either way.
 */
const REQUEST_INIT_KEYS = [
  'method',
  'body',
  'redirect',
  'signal',
  'cf',
  'integrity',
  'keepalive',
  'cache',
  'credentials',
  'mode',
  'priority',
  'referrer',
  'referrerPolicy',
  'duplex',
  'fetcher',
] as const

/**
 * The methods `fetch` uppercases (case-insensitively). Any other method is sent as given.
 */
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'])

/**
 * @param {unknown} value - Any value.
 * @returns {boolean} Whether `value` is a `Request`.
 */
function isRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request
}

/**
 * @param {unknown[]} args - The arguments the caller passed to `fetch`.
 * @returns {Call} The arguments as `fetch` reads them.
 */
function readCall(args: unknown[]): Call {
  const [input, init] = args as [unknown, RequestInit | undefined]
  return { args, input, init, request: isRequest(input) ? input : undefined }
}

/**
 * A plain `RequestInit` with the fields `fetch(url, request)` reads from `request`, and
 * `headers` in place of its own. Unlike `new Request(request, { headers })`, building it does
 * not take the Request's body, so the body is untouched until the binding reads it.
 *
 * @param {Request} request - A `Request` the caller passed as `init`.
 * @param {Headers} headers - The headers to send instead of the Request's.
 * @returns {RequestInit} The init to pass on.
 */
function initFromRequest(request: Request, headers: Headers): RequestInit {
  const source = request as unknown as Record<string, unknown>
  const init: Record<string, unknown> = {}
  for (const key of REQUEST_INIT_KEYS) {
    const value = source[key]
    // workerd's Request has `fetcher: null` when it has none, which is the same as no fetcher.
    if (value === undefined || (key === 'fetcher' && value === null)) continue
    init[key] = value
  }
  // Node requires `duplex` with a stream body, and a Request's body is always a stream.
  if (init.body != null && init.duplex === undefined) init.duplex = 'half'
  init.headers = headers
  return init as RequestInit
}

/**
 * The arguments to call `fetch` with, carrying the current Trace Carrier (and the Request ID,
 * when asked) in a new `Headers`. Nothing the caller passed is changed: `init` is copied with
 * new headers, and a `Request` passed as `input` is passed on as it is, so its body (streaming
 * or not) is neither read nor teed and its `method`, `redirect`, `signal` and `cf` still apply.
 *
 * The headers start from what `fetch` itself would send: `init.headers` when given, otherwise
 * the `Request`'s. A `tracestate` already there is dropped, because it belongs to another
 * `traceparent`. When the headers cannot be read (invalid caller headers), the caller's
 * arguments are returned unchanged, so the binding rejects them with its own error.
 *
 * @param {Call} call - The outgoing call.
 * @param {TracedFetchOptions} options - The options the wrapper was given.
 * @returns {unknown[]} The arguments to call `fetch` with.
 */
function withCarrier({ args, input, init, request }: Call, options: TracedFetchOptions): unknown[] {
  let headers: Headers
  try {
    headers = new Headers(init?.headers !== undefined ? init.headers : request?.headers)
  } catch {
    return args
  }

  const carrier = getTraceCarrier()
  if (carrier.traceparent) headers.delete('tracestate')
  injectCarrier(carrier, (name, value) => {
    if (SAFE_HEADER_VALUE.test(value)) headers.set(name, value)
  })
  if (options.forwardRequestId) {
    const requestId = getContextField('requestId')
    if (typeof requestId === 'string' && SAFE_HEADER_VALUE.test(requestId)) {
      headers.set(REQUEST_ID_HEADER, requestId)
    }
  }

  // `fetch(url, request)`: a Request's fields are getters a spread would drop.
  if (isRequest(init)) return [input, initFromRequest(init, headers)]
  return [input, { ...init, headers }]
}

/**
 * @param {string} method - The method the caller gave.
 * @returns {string} The method as `fetch` sends it: one of `NORMALIZED_METHODS` uppercased
 *   (ASCII only, as `fetch` does), any other as given (`patch` stays `patch`).
 */
function wireMethod(method: string): string {
  const upper = method.replace(/[a-z]+/g, (letters) => letters.toUpperCase())
  return NORMALIZED_METHODS.has(upper) ? upper : method
}

/**
 * The Span fields for a call. All four are always set, `undefined` when unknown (a URL that
 * cannot be parsed, no response yet), so the caller's own Context Fields of the same names
 * never show on the Span's line.
 *
 * @param {Call} call - The outgoing call.
 * @returns The Span's `method`, `host`, `path` and `statusCode`.
 */
function spanFields({ input, init, request }: Call): {
  method: string
  host: string | undefined
  path: string | undefined
  statusCode: number | undefined
} {
  let method = 'GET'
  try {
    method = wireMethod(String(init?.method ?? request?.method ?? 'GET'))
  } catch {
    // a method whose toString throws: fetch will reject it
  }
  let url: URL | undefined
  try {
    url = new URL(request ? request.url : String(input))
  } catch {
    // relative or invalid: fetch will reject it
  }
  return { method, host: url?.host, path: url?.pathname, statusCode: undefined }
}

/**
 * Call `doFetch` with the current Trace Carrier in the headers, optionally as a Span.
 * Outside a Logging Context, calls it with exactly `args` and returns its result.
 * Never retries and never handles an error: what `doFetch` returns or throws is what the
 * caller gets.
 *
 * @param {(...args: unknown[]) => Promise<R>} doFetch - The `fetch` to call.
 * @param {unknown[]} args - The arguments the caller passed.
 * @param {TracedFetchOptions} options - The options the wrapper was given.
 * @returns {Promise<R>} What `doFetch` returns.
 */
function tracedCall<R>(
  doFetch: (...args: unknown[]) => Promise<R>,
  args: unknown[],
  options: TracedFetchOptions,
): Promise<R> {
  if (!getTraceCarrier().traceparent) return doFetch(...args)
  const call = readCall(args)
  if (!options.spans) return doFetch(...withCarrier(call, options))

  const fields = spanFields(call)
  return withSpan(SPAN_OPERATION, () => {
    // Context Fields set inside a Span stay on that Span's lines (its `span.end`).
    setLoggerContext(fields)
    // Inside the Span, so the downstream work's parent is this Span.
    return doFetch(...withCarrier(call, options)).then((response) => {
      const status = (response as { status?: unknown } | null)?.status
      if (typeof status === 'number') setLoggerContext({ statusCode: status })
      return response
    })
  })
}

/**
 * A `fetch` wrapper that sends the current Trace Carrier as `traceparent` / `tracestate`
 * headers. Takes the same arguments as `fetch`, plus optional `options` (Spans, Request ID
 * forwarding). Never mutates `input` or `init`.
 *
 * Outside a Logging Context, behaves like regular `fetch()`.
 *
 * @param {RequestInfo | URL} input - The fetch URL or Request.
 * @param {RequestInit} [init] - Optional fetch init options. Never mutated.
 * @param {TracedFetchOptions} [options] - `spans`, `forwardRequestId`. All off by default.
 *   `forwardRequestId` sends the Request ID to whatever host you call.
 * @returns {Promise<Response>} The fetch response, or the rejection `fetch` gave.
 *
 * @example
 * ```ts
 * const res = await tracedFetch('https://api.example.com/items', undefined, { spans: true })
 * ```
 */
export function tracedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: TracedFetchOptions = {},
): Promise<Response> {
  const args = init === undefined ? [input] : [input, init]
  return tracedCall((...a) => fetch(...(a as [RequestInfo | URL, RequestInit?])), args, options)
}

/**
 * Wrap a service binding (a `Fetcher`) so its `fetch` sends the current Trace Carrier as
 * `traceparent` / `tracestate` headers, both as `fetch(input, init)` and `fetch(request)`.
 * The receiver's `useLogger` continues the trace. Nothing the caller passes is mutated.
 *
 * The result has the binding's type: `connect()` and every other member (RPC methods
 * included) pass through to the binding unchanged. Outside a Logging Context, `fetch` calls
 * the binding with exactly the same arguments. Wrap once and reuse it; pass the original
 * binding (not the wrapper) when handing it on to another Worker.
 *
 * With `forwardRequestId`, the current Request ID replaces any `X-Request-Id` on the call, so
 * forwarding `c.req.raw` sends this Worker's ID, not the client's.
 *
 * @template T - The binding type (e.g. `Fetcher`, or `Service<MyEntrypoint>`).
 * @param {T} binding - The service binding.
 * @param {TracedFetchOptions} [options] - `spans`, `forwardRequestId`. All off by default.
 * @returns {T} The wrapped binding.
 *
 * @example
 * ```ts
 * const svc = tracedFetcher(c.env.SVC, { forwardRequestId: true, spans: true })
 * const res = await svc.fetch(c.req.raw) // traceparent, tracestate and X-Request-Id sent
 * ```
 */
export function tracedFetcher<T extends { fetch: FetchLike }>(
  binding: T,
  options: TracedFetchOptions = {},
): T {
  const opts = { ...options }
  const fetch = (...args: unknown[]) => tracedCall((...a) => binding.fetch(...a), args, opts)
  // Methods of the binding, called on the binding itself (a platform object rejects any
  // other `this`). Wrapped in a Proxy so properties on them, like RPC pipelining, still work.
  const methods = new WeakMap<object, unknown>()
  const read = (prop: string | symbol): unknown => {
    if (prop === 'fetch') return fetch
    const value: unknown = Reflect.get(binding, prop)
    if (typeof value !== 'function') return value
    let method = methods.get(value)
    if (!method) {
      method = new Proxy(value, {
        apply: (fn, _this, args) => Reflect.apply(fn, binding, args),
      })
      methods.set(value, method)
    }
    return method
  }

  // Service bindings are extensible platform objects, so they are proxied directly.
  if (Object.isExtensible(binding)) {
    return new Proxy(binding, { get: (_target, prop) => read(prop) })
  }

  // A Proxy must return a frozen (non-configurable, read-only) property's own value, so a
  // frozen or sealed binding is proxied through an empty, extensible shell that inherits from
  // it. Its own keys are the binding's. Proxy invariants forbid reporting a property the shell
  // lacks as non-configurable, so each is reported as configurable (with the value `get`
  // gives), and `Object.isFrozen(wrapper)` is false.
  return new Proxy(Object.create(binding) as T, {
    get: (_target, prop) => read(prop),
    ownKeys: () => Reflect.ownKeys(binding),
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
        binding,
        prop,
      )
      if (!descriptor) return undefined
      if ('value' in descriptor) descriptor.value = read(prop)
      return { ...descriptor, configurable: true }
    },
  })
}
