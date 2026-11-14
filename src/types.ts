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
 * Supports primitives, `Date`, `Error` (written with its type, message and
 * stack, at any depth), nested objects, and arrays.
 */
export type LogValue =
  | string
  | number
  | boolean
  | Date
  | Error
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
 * The Span Defaults: how a Root Logger writes the `span.end` line of a Span that
 * succeeds, unless the Span's own `SpanOptions` say otherwise. A Span that throws
 * always writes at `ERROR`.
 *
 * @example
 * ```ts
 * const logger = createLogger({ service: 'api', spans: { level: 'debug', slowMs: 500 } })
 * ```
 */
export interface SpanDefaults {
  /** The level of an OK `span.end`. Defaults to `'info'`. */
  level?: LogLevel
  /**
   * The Slow Threshold, in milliseconds: an OK Span that takes this long or longer
   * writes its `span.end` at `WARN` (or at `level`, when that is more severe). Unset
   * by default: every OK Span writes at `level`. `Infinity` turns it off.
   */
  slowMs?: number
}

/**
 * Options for one Span (`withSpan()`, `TracedSession.traced()`). `level` and `slowMs`
 * override the Root Logger's Span Defaults; an invalid value is ignored.
 *
 * @example
 * ```ts
 * await withSpan('db.getUser', () => db.getUser(id), { level: 'debug', slowMs: 500, fields: { table: 'users' } })
 * ```
 */
export interface SpanOptions extends SpanDefaults {
  /**
   * Span Fields written on this Span's `span.end` line, and on no other line.
   * Read when the Span starts. `span.set()` adds more, and wins on a shared key.
   */
  fields?: LogFields
}

/**
 * The handle a Span passes to its work, to add Span Fields from inside it.
 *
 * @example
 * ```ts
 * const value = await withSpan('cache.read', async (span) => {
 *   const v = await cache.get(key)
 *   span.set({ hit: v !== null })
 *   return v
 * })
 * ```
 */
export interface Span {
  /**
   * Add Span Fields to this Span's `span.end` line, and to no other line. A later
   * call wins on a shared key. Read now: a getter that throws is written as
   * `[Unserializable: ...]`, never thrown. Does nothing once the Span has ended, and
   * for an unsampled trace (which writes no `span.end`).
   *
   * @param {LogFields} fields - The fields to add.
   */
  set(fields: LogFields): void
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
 * Writes one `Error` of a log line, in place of loggercf's default shape
 * (`{ type, message, stack, ...own enumerable props, errors?, cause? }`).
 * Called for every `Error` on the line, at any depth, once per `Error` and
 * line. What it returns is written like any value: an `Error` inside it is
 * written by this serializer too, where it loops it is `"[Circular]"`, and
 * the Re-write Budget and `limits` apply. A throw is never passed on: that
 * `Error` is written in the default shape, with `serializeErrorFailed`
 * describing the failure. So is a result that is not an object, or is a
 * Promise (`serializeError returned undefined`, `... a Promise`): it must
 * return an object, synchronously.
 *
 * A line logged while it runs (its own code logs), through any logger, writes
 * each `Error` as only `{ type, message, serializeErrorFailed: 'logged from
 * inside serializeError' }`, so a synchronous serializer can't call itself
 * again or write what it leaves out (an `Error` nested two or more levels deep
 * whose class has its own `toJSON` is still written by that `toJSON`).
 *
 * `defaultSerialize(e)` gives `e`'s default shape, with the values inside it
 * (`cause`, an `Error`-valued property, `errors`) kept as they are: loggercf
 * writes them afterwards, through this serializer.
 *
 * @example
 * ```ts
 * const serializeError: ErrorSerializer = (err, defaultSerialize) =>
 *   err instanceof HttpError ? { type: 'HttpError', message: err.message, status: err.status } : defaultSerialize(err)
 * ```
 */
export type ErrorSerializer = (
  err: Error,
  defaultSerialize: (err: Error) => Record<string, unknown>,
) => Record<string, unknown>

/**
 * Size limits on each log line. Off by default: without them, nothing is cut.
 *
 * @example
 * ```ts
 * const logger = createLogger({ service: 'api', limits: { maxStringLength: 8_192, maxRecordBytes: 200_000 } })
 * ```
 */
export interface LineLimits {
  /**
   * A string value longer than this many characters keeps its first
   * `maxStringLength` characters, followed by `…[truncated from <length> chars]`.
   * Applies at any depth, `message` and `err.message` included; `time`, `level`,
   * the trace IDs, `service`, `environment`, `version` and `err.type` are never cut.
   * An integer, 1 or more.
   */
  maxStringLength?: number
  /**
   * A line larger than this many UTF-8 bytes is trimmed to fit, its largest
   * values first. `time`, `level`, `message`, the trace IDs, `service`,
   * `environment`, `version` and `err`'s `type` and `message` are kept whole
   * unless they alone are too large. An integer, 1,024 or more.
   */
  maxRecordBytes?: number
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
  /** Minimum log level. Defaults to `'info'`. `'silent'` writes nothing. */
  level?: LogLevel | 'silent'
  /** Deployment environment (e.g. `'production'`, `'development'`). */
  environment?: string
  /** Application version (e.g. `'1.2.0'`). */
  version?: string
  /**
   * The Span Defaults for every Span in a Logging Context this Root Logger opens:
   * the level of an OK `span.end` and the Slow Threshold. Each Span's own options
   * override them.
   */
  spans?: SpanDefaults
  /**
   * Writes every `Error` on this logger's lines, at any depth, in place of the
   * default shape. See `omitErrorKeys()` for leaving out keys that hold user data.
   * Define it once, at module scope: the Workers helpers cache their Root Logger
   * by this function.
   */
  serializeError?: ErrorSerializer
  /** The Line Limits: size limits on each line. Off by default. */
  limits?: LineLimits
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
