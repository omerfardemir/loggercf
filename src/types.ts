/**
 * Supported log severity levels.
 *
 * @example
 * ```ts
 * const level: LogLevel = 'info'
 * ```
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/**
 * Allowed types for log field values.
 *
 * Supports primitives, `Date`, nested objects, and arrays.
 */
export type LogValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | { [key: string]: LogValue }
  | LogValue[]

/**
 * Key-value map of structured log fields.
 *
 * Passed to `setLoggerContext()` or included as logger bindings.
 */
export type LogFields = {
  [key: string]: LogValue
}

/**
 * Parsed W3C Trace Context derived from a `traceparent` header.
 *
 * @see {@link https://www.w3.org/TR/trace-context/#traceparent-header} for the specification.
 *
 * @example
 * ```ts
 * const trace: TraceContext = {
 *   traceId: 'abcdef1234567890abcdef1234567890',
 *   spanId: 'abcdef1234567890',
 *   traceFlags: 0x01,
 * }
 * ```
 */
export interface TraceContext {
  /** 32 lowercase hex chars identifying the whole trace. */
  traceId: string
  /** 16 lowercase hex chars identifying the current span. */
  spanId: string
  /** 16 lowercase hex chars identifying the caller's span. */
  parentSpanId?: string
  /** 8-bit field (usually `0x00` or `0x01`). */
  traceFlags: number
  /** W3C tracestate header value for vendor-specific key-value pairs. */
  tracestate?: string
}

/**
 * The wire form of a Trace Context, as it travels in HTTP headers, an RPC
 * `session()` call, or a queue message.
 *
 * Get one with `getTraceCarrier()`; continue it with `runWithLogger({ logger, ...carrier })`.
 */
export interface TraceCarrier {
  /** W3C `traceparent` value. Absent outside a Logging Context. */
  traceparent?: string
  /** W3C `tracestate` value, when the trace has one. */
  tracestate?: string
}

/**
 * Structured span data logged on `span.end` by `withSpan()` and `TracedSession.traced()`.
 *
 * Trace IDs (`traceId`, `spanId`, `parentSpanId`) are already on every log line
 * from the Logging Context, so they are not duplicated inside the span object.
 */
export interface SpanContext {
  /** Human-readable operation name (e.g. `'bind.add'`). */
  operation: string
  /** Epoch milliseconds when the operation started. */
  startTime: number
  /** Epoch milliseconds when the operation ended. */
  endTime: number
  /** Duration in milliseconds (`endTime - startTime`). */
  duration: number
  /** `'OK'` on success, `'ERROR'` on failure. */
  status: 'OK' | 'ERROR'
  /** Error message when `status` is `'ERROR'`. */
  error?: string
}

/**
 * Shape of the `AsyncLocalStorage` store behind each Logging Context.
 *
 * Created internally by `runWithLogger()` and `withSpan()`; never exposed.
 *
 * @template T - The type of user-defined log fields.
 */
export interface ALSStore<T extends LogFields = LogFields> {
  /** Protected trace context not writable via `setLoggerContext()`. */
  trace: TraceContext
  /** Mutable user fields `setLoggerContext()` writes here. */
  fields: T
  /** The Logger wrapper bound to this request. */
  logger: Logger<T>
}

/**
 * Options for creating a Logger instance.
 *
 * @example
 * ```ts
 * const logger = createLogger({
 *   service: 'api-gateway',
 *   level: 'debug',
 *   environment: 'production',
 * })
 * ```
 */
export interface LoggerOptions {
  /** Service name included on every log line. */
  service: string
  /** Minimum log level. Defaults to `'info'`. */
  level?: LogLevel
  /** Deployment environment (e.g. `'production'`, `'development'`). */
  environment?: string
  /** Application version (e.g. `'1.2.0'`). */
  version?: string
}

/**
 * The known (non-index-signature) keys of `T`, all optional. Gives structured
 * calls autocomplete and type checks for the fields `T` declares.
 *
 * @template T - The type of user-defined log fields.
 */
type KnownFields<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]?: T[K]
}

/**
 * A single log-level method. Two call styles, which can be mixed:
 *
 * - **structured**: `logger.info({ userId }, 'user signed in')`, `logger.error(err, 'failed')`
 * - **console style**: `logger.info('user signed in', { userId })`, `logger.error('failed', err)`
 *
 * The message supports `printf` placeholders (`%s %d %i %f %j %o %O %%`).
 * No argument is ever dropped: arguments the placeholders don't take are
 * routed into the record (see the README's "Log Output").
 *
 * @template T - The type of user-defined log fields.
 */
export interface LogFn<T extends LogFields = LogFields> {
  /** Console style: a message, then placeholder values, fields, errors or extra words. */
  (msg: string, ...args: unknown[]): void
  /** An `Error`, kept under `err`. The message defaults to `err.message`. */
  (err: Error, msg?: string, ...args: unknown[]): void
  /** Structured: fields merged at the top level (`err` may be `unknown`), then the message. */
  <F extends object>(fields: F & KnownFields<T>, msg?: string, ...args: unknown[]): void
  /**
   * A message or an `Error` whose static type is a union (`string | Error`,
   * `Error | undefined`, `Error | null`). An unset `undefined` / `null`
   * followed by a string writes nothing, and the string is still the message:
   * `logger.error(maybeErr, 'failed %s', id)`. Alone, or before anything else,
   * it is a leading primitive: `String(value)` is the message, the value is in
   * `args`, and the arguments after it are routed as usual.
   */
  (value: string | Error | null | undefined, msg?: string, ...args: unknown[]): void
  /**
   * A value typed `unknown` or `any`, such as a `catch (e)` binding:
   * `logger.error(e)`, `logger.error(e, 'failed')`. Only `unknown` and `any`
   * match this overload, so a wrongly typed value is still rejected.
   */
  <E>(value: unknown extends E ? E : never, msg?: string, ...args: unknown[]): void
}

/**
 * Public logger interface.
 *
 * `T` provides autocomplete for `setLoggerContext()` while still
 * allowing arbitrary extra fields via the `LogFields` base.
 *
 * @template T - The type of user-defined log fields.
 *
 * @example
 * ```ts
 * const logger: Logger = getLogger()
 * logger.info({ userId: 42 }, 'user signed in')
 * ```
 */
export interface Logger<T extends LogFields = LogFields> {
  /** Most detailed, fine-grained logs. severity: 10 */
  trace: LogFn<T>
  /** Debug-level logs. severity: 20 */
  debug: LogFn<T>
  /** Informational logs. severity: 30 */
  info: LogFn<T>
  /** Warning logs. severity: 40 */
  warn: LogFn<T>
  /** Error logs. severity: 50 */
  error: LogFn<T>
  /** Critical errors causing service failure. severity: 60 */
  fatal: LogFn<T>

  /**
   * Create a scoped child logger with extra bindings baked in.
   *
   * Does NOT affect other loggers only this instance and its descendants.
   *
   * @param {Record<string, unknown>} bindings - Key-value pairs to include on every log line.
   * @returns {Logger<T>} A new child logger.
   */
  child(bindings: Record<string, unknown>): Logger<T>
}
