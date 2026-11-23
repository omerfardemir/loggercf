import type { TraceCarrier, TraceContext } from '../core/types'

/**
 * Generate a random 16-byte trace ID as a 32-character hex string.
 *
 * @returns {string} A new trace ID.
 *
 * @example
 * ```ts
 * const traceId = generateTraceId()
 * // => 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8'
 * ```
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Generate a new random span ID (16 hex chars).
 *
 * @returns {string} A new span ID.
 *
 * @example
 * ```ts
 * const spanId = generateSpanId()
 * // => 'a1b2c3d4e5f6a7b8'
 * ```
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Regular expression for W3C `traceparent` headers.
 */
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

const ALL_ZERO_TRACE = '0'.repeat(32)
const ALL_ZERO_SPAN = '0'.repeat(16)

/**
 * Parse a W3C `traceparent` header string into a `TraceContext`.
 *
 * Returns `null` if the header is invalid or contains all-zero IDs.
 *
 * @see {@link https://www.w3.org/TR/trace-context/#traceparent-header} for the specification.
 * @param {string} header - The value of the `traceparent` header to parse.
 * @returns {TraceContext | null} A `TraceContext` object, or `null` if parsing fails.
 *
 * @example
 * ```ts
 * const trace = parseTraceparent('00-abc...32chars...-def...16chars...-01')
 * if (trace) {
 *   console.log(trace.traceId, trace.spanId)
 * }
 * ```
 */
export function parseTraceparent(header: string): TraceContext | null {
  const match = header.match(TRACEPARENT_RE)
  if (!match) return null

  const [, traceId, spanId, flags] = match
  if (traceId === ALL_ZERO_TRACE || spanId === ALL_ZERO_SPAN) return null

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
  }
}

/**
 * Build a W3C `traceparent` header string from a `TraceContext`.
 *
 * @param {TraceContext} trace - The trace context to serialize.
 * @param {string} trace.traceId - The trace ID (32 hex chars).
 * @param {string} trace.spanId - The span ID (16 hex chars).
 * @param {number} trace.traceFlags - The trace flags (8-bit number).
 * @param {string} [trace.parentSpanId] - Optional parent span ID (16 hex chars).
 * @returns {string} A `traceparent` header value (e.g. `'00-{traceId}-{spanId}-{flags}'`).
 *
 * @example
 * ```ts
 * const header = buildTraceparent({ traceId: '...', spanId: '...', traceFlags: 1 })
 * c.header('traceparent', header)
 * ```
 */
export function buildTraceparent(trace: TraceContext): string {
  const flags = trace.traceFlags.toString(16).padStart(2, '0')
  return `00-${trace.traceId}-${trace.spanId}-${flags}`
}

/**
 * Resolve a `TraceContext` from an incoming `traceparent` header.
 *
 * Parses and continues the trace if valid, otherwise starts a new root trace.
 * Always generates a new `spanId` for the current service. `tracestate` is kept only
 * with a valid `traceparent` (W3C Trace Context), so a new root trace has none.
 *
 * @param {string | null} [traceparent] - The incoming `traceparent` header value, if any.
 * @param {string | null} [tracestate] - The incoming `tracestate` header value, if any.
 * @returns {TraceContext} A trace context representing the current span.
 *
 * @example
 * ```ts
 * const trace = resolveTrace(req.headers.get('traceparent'))
 * // trace.traceId is either inherited or freshly generated
 * ```
 */
export function resolveTrace(
  traceparent?: string | null,
  tracestate?: string | null,
): TraceContext {
  const parsed = traceparent ? parseTraceparent(traceparent) : null
  return {
    traceId: parsed?.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    ...(parsed?.spanId ? { parentSpanId: parsed.spanId } : {}),
    traceFlags: parsed?.traceFlags ?? 1,
    // W3C: a tracestate without a valid traceparent is ignored.
    ...(parsed && tracestate ? { tracestate } : {}),
  }
}

/**
 * Serialize a Trace Context into its Trace Carrier.
 *
 * @param {TraceContext} trace - The trace context to serialize.
 * @returns {TraceCarrier} `traceparent`, plus `tracestate` when present.
 */
export function toCarrier(trace: TraceContext): TraceCarrier {
  return {
    traceparent: buildTraceparent(trace),
    ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
  }
}

/**
 * Read a Trace Carrier from headers.
 *
 * Takes a getter so it works with `Headers#get`, Hono's `c.req.header`, etc.
 *
 * @param {(name: string) => string | null | undefined} get - Header getter.
 * @returns {TraceCarrier} The carrier, with absent headers omitted.
 */
export function extractCarrier(get: (name: string) => string | null | undefined): TraceCarrier {
  const traceparent = get('traceparent')
  const tracestate = get('tracestate')
  return {
    ...(traceparent ? { traceparent } : {}),
    ...(tracestate ? { tracestate } : {}),
  }
}

/**
 * Write a Trace Carrier to headers. Absent values are not written.
 *
 * Takes a setter so it works with `Headers#set`, Hono's `c.header`, etc.
 *
 * @param {TraceCarrier} carrier - The carrier to write.
 * @param {(name: string, value: string) => void} set - Header setter.
 */
export function injectCarrier(
  carrier: TraceCarrier,
  set: (name: string, value: string) => void,
): void {
  if (carrier.traceparent) set('traceparent', carrier.traceparent)
  if (carrier.tracestate) set('tracestate', carrier.tracestate)
}
