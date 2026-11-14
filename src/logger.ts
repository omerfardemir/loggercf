import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  LogFields,
  LogLevel,
  LogValue,
  LoggerOptions,
  Logger,
  TraceCarrier,
  TraceContext,
  ALSStore,
  SpanContext,
} from './types'
import { resolveTrace, generateSpanId, toCarrier } from './trace'
import {
  applyTrace,
  buildRecord,
  newBudget,
  copyBindings,
  describeFailure,
  nodeSink,
  stringifyRecord,
  takeRecordKeys,
  workersSink,
  type LogRecord,
  type Sink,
} from './output'
import { _resetEnvWarnings } from './env'
import { routeArgs } from './route'

const als = new AsyncLocalStorage<ALSStore>()

/**
 * Detect Cloudflare Workers runtime.
 *
 * @returns `true` when running inside a Cloudflare Worker.
 */
const IS_WORKERS = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'

/**
 * Where finished records go. Chosen by runtime; tests swap it via `_setSink()`.
 * Only the final write differs between runtimes: records are built identically.
 */
let sink: Sink = IS_WORKERS ? workersSink : nodeSink

/** Severity of each level, lowest first. A logger writes levels at or above its minimum. */
const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

const LEVELS = Object.keys(LEVEL_VALUES) as LogLevel[]

/**
 * The numeric minimum for a level name. `'silent'` (not a `LogLevel`, but
 * accepted by earlier loggercf versions) writes nothing, so existing configs keep working.
 *
 * @param {string} level - A level name.
 * @returns {number} Its severity.
 * @throws {Error} `unknown level <name>` for anything else.
 */
function levelValue(level: string): number {
  if (level === 'silent') return Infinity
  if (!Object.hasOwn(LEVEL_VALUES, level)) throw new Error(`unknown level ${level}`)
  return LEVEL_VALUES[level as LogLevel]
}

const noop = () => {}

/**
 * Build one log line: route the arguments, add time, level and bindings, then
 * hand it to `buildRecord()` and the current sink.
 *
 * Order of keys: `time`, `level`, Context Fields, bindings, call fields,
 * `message`, `errors`, `args`, trace IDs.
 *
 * @param {string} label - The upper-case level written as `level`.
 * @param {LogRecord} bindings - The logger's bindings (`createLogger` / `.child()`).
 * @param {unknown[]} input - The arguments the log method received.
 */
function write(label: string, bindings: LogRecord, input: unknown[]): void {
  const budget = newBudget() // one per line: the message's placeholders, then the record
  const entry = {
    time: new Date().toISOString(),
    level: label,
    bindings,
    budget,
    ...routeArgs(input, budget),
  }
  sink.write(buildRecord(entry, als.getStore()))
}

/**
 * `write()`, but a log call never throws. Routing and serialization already
 * replace a value that cannot be read or serialized with a stand-in, so this
 * is the last resort, for a failure no single value explains (the sink
 * throws, a value nested too deep for the stack): a minimal line is written
 * instead, with `time`, `level`, the trace IDs, bindings, the message
 * template as given, and `logError` describing the failure. As in
 * `buildRecord()`, bindings for the Record Keys move to `args`. If even
 * that fails, the line is written without bindings, then dropped.
 *
 * @param {string} label - The upper-case level written as `level`.
 * @param {LogRecord} bindings - The logger's bindings (`createLogger` / `.child()`).
 * @param {unknown[]} input - The arguments the log method received.
 */
function safeWrite(label: string, bindings: LogRecord, input: unknown[]): void {
  try {
    write(label, bindings, input)
  } catch (thrown) {
    const template = [input[0], input[1]].find((value) => typeof value === 'string')
    const trace = als.getStore()?.trace
    const head: LogRecord = { time: new Date().toISOString(), level: label }
    if (trace) applyTrace(head, trace)
    const tail: LogRecord = { logError: `log call failed: ${describeFailure(thrown)}` }
    if (template !== undefined) tail.message = template
    /**
     * The minimal line.
     *
     * @param {LogRecord} [extra] - Bindings to include, between `head` and `tail`.
     * @returns {LogRecord} `head`, `extra`, `tail`; then the trace IDs again, so `extra` cannot replace them.
     */
    const minimal = (extra?: LogRecord): LogRecord => {
      const line: LogRecord = { ...head, ...extra, ...tail }
      if (trace) applyTrace(line, trace)
      return line
    }
    try {
      // Like `buildRecord()`: bindings cannot set `time`, `level` or `message`.
      const moved: LogRecord[] = []
      const line = minimal(takeRecordKeys(bindings, moved))
      if (moved.length > 0) line.args = moved
      sink.write(line)
    } catch {
      try {
        sink.write(minimal())
      } catch {
        // Nowhere left to write: a log call must not throw.
      }
    }
  }
}

/**
 * Build a `Logger` that writes levels at or above `minimum`, with `bindings`
 * on every line. Immutable: `child()` returns a new logger with merged bindings.
 *
 * @template T - The type of user-defined log fields.
 * @param {number} minimum - The minimum severity written.
 * @param {LogRecord} bindings - Fixed fields on every line.
 * @returns {Logger<T>} The Logger.
 */
function makeLogger<T extends LogFields = LogFields>(
  minimum: number,
  bindings: LogRecord,
): Logger<T> {
  const logger = {
    child: (more: Record<string, unknown>) =>
      makeLogger<T>(minimum, { ...bindings, ...copyBindings(more) }),
  } as Logger<T>
  for (const level of LEVELS) {
    const label = level.toUpperCase()
    logger[level] =
      LEVEL_VALUES[level] < minimum
        ? noop
        : (...args: unknown[]) => safeWrite(label, bindings, args)
  }
  return logger
}

/**
 * Create a Root Logger.
 *
 * Build it once per process or isolate and share it. `service`, `environment`
 * and `version` appear on every line; `bindings` add more fixed fields. Keep
 * both to per-process data: per-unit-of-work data belongs in Context Fields.
 *
 * @template T - The type of user-defined log fields.
 * @param {LoggerOptions} options - Logger Options. `level` defaults to `'info'`.
 * @param {Partial<T>} [bindings] - Extra per-process fields included on every log line.
 * @returns {Logger<T>} The Root Logger.
 *
 * @example
 * ```ts
 * const logger = createLogger(
 *   { service: 'api-gateway', level: 'info', environment: 'production', version: '1.2.0' },
 * )
 * logger.info('server started')
 * ```
 */
export function createLogger<T extends LogFields = LogFields>(
  options: LoggerOptions,
  bindings?: Partial<T>,
): Logger<T> {
  const { service, level, environment, version } = options
  return makeLogger<T>(levelValue(level ?? 'info'), {
    service,
    ...(environment ? { environment } : {}),
    ...(version ? { version } : {}),
    ...copyBindings(bindings),
  })
}

/**
 * Cached standalone loggers keyed by service name, shared by the whole isolate.
 * Safe only because nothing mutates them after creation.
 */
const _cache = new Map<string, Logger>()

/** Whether the outside-a-Logging-Context warning has been written in this isolate. */
let warnedOutsideContext = false

const OUTSIDE_CONTEXT_WARNING = 'setLoggerContext called outside a Logging Context; fields ignored'

/** The standalone `service: 'unknown'` logger used outside a Logging Context while no default is set. */
let unknownLogger: Logger | undefined

/**
 * The isolate's Default Logger: what `getLogger()` writes through outside a Logging Context.
 * A Root Logger, so sharing it across concurrent work is safe.
 */
let defaultLogger: Logger | undefined

/**
 * Loggers returned by `getLogger()` outside a Logging Context (and their `.child()`ren),
 * mapped to how they resolve to a concrete logger when a line is written.
 */
const forwarders = new WeakMap<Logger, () => Logger>()

/** The logger `getLogger()` writes through outside a Logging Context, chosen at call time. */
function currentOutsideLogger(): Logger {
  return defaultLogger ?? fallbackLogger()
}

function fallbackLogger(): Logger {
  return (unknownLogger ??= createLogger({ service: 'unknown' }))
}

/**
 * True while a forwarder is writing a line. A registered default that writes back through
 * `getLogger()` (a hand-written logger wrapping it) would otherwise recurse until the stack
 * overflows; the nested line goes to the `'unknown'` logger instead.
 */
let forwarding = false

/**
 * A logger that resolves the logger to write through on every call. Its `.child()` is a
 * forwarder too, built again from the resolved logger whenever that logger changes.
 */
function forwardingLogger(resolve: () => Logger): Logger {
  const logger = {
    child: (more: Record<string, unknown>) => {
      // Read now, as `makeLogger` does: a log call never runs the getters.
      const bindings = copyBindings(more)
      let base: Logger | undefined
      let child: Logger | undefined
      return forwardingLogger(() => {
        const current = resolve()
        if (current !== base) {
          base = current
          try {
            child = current.child(bindings)
          } catch {
            // A hand-written default whose `.child()` throws: keep the line and its fields.
            child = fallbackLogger().child(bindings)
          }
        }
        return child!
      })
    },
  } as Logger
  for (const level of LEVELS) {
    logger[level] = (...args: unknown[]) => {
      const target = forwarding ? fallbackLogger() : resolve()
      const outer = forwarding
      forwarding = true
      try {
        ;(target[level] as (...a: unknown[]) => void)(...args)
      } finally {
        forwarding = outer
      }
    }
  }
  forwarders.set(logger, resolve)
  return logger
}

/**
 * What `getLogger()` returns outside a Logging Context: one stable logger that writes
 * through the Default Logger registered *when each line is logged*. So a shared package
 * that keeps `const log = getLogger()` (or `getLogger().child({ ... })`) at module scope,
 * which runs before the app registers its default, still logs with the app's `service`
 * once it is registered.
 */
const outsideContextLogger: Logger = forwardingLogger(currentOutsideLogger)

/**
 * The concrete logger to register for `logger`, or `undefined` when it must not be registered.
 *
 * Every forwarder resolves through `outsideContextLogger`. While no default is set, it would
 * resolve to the `'unknown'` logger (or a child of it), which would then win "first seen" and
 * keep the isolate at `service: 'unknown'`; and `outsideContextLogger` itself would make the
 * Default Logger write through itself. Once a default is set, a forwarder child resolves to a
 * concrete child of it.
 *
 * @param {Logger} logger - The logger passed to `setDefaultLogger` or a helper.
 * @returns {Logger | undefined} What to register, or `undefined` for a no-op.
 */
function resolveForRegistration(logger: Logger): Logger | undefined {
  const resolve = forwarders.get(logger)
  if (!resolve) return logger
  if (logger === outsideContextLogger || !defaultLogger) return undefined
  return resolve()
}

/**
 * Register a Root Logger as the isolate's Default Logger, the one `getLogger()` writes
 * through outside a Logging Context (module scope, plain RPC methods, `scheduled`,
 * shared packages). `getLogger(service)` with a name keeps its standalone logger.
 *
 * Pass the Root Logger itself, not a logger taken from inside a Logging Context.
 * It carries no Context Fields (those live in each Logging Context), so
 * per-request data cannot reach other work through it. A `.child()` of it is
 * accepted, but the fields passed to `.child()` appear on every line logged
 * outside a context, so they must be per-process data too.
 *
 * Replaces any default already set, including one `useLogger`, `TracedEntrypoint`,
 * `tracedWorker` or `defaultLoggerFromEnv` registered. The exception is a logger taken from
 * `getLogger()` outside a Logging Context: `setDefaultLogger(getLogger())` changes nothing,
 * and a `.child()` of it is ignored while no default is set (once one is, it registers a
 * child of that default).
 *
 * @template T - The type of user-defined log fields.
 * @param {Logger<T>} logger - The Root Logger.
 *
 * @example
 * ```ts
 * const logger = createLogger(loggerOptionsFromEnv(env))
 * setDefaultLogger(logger)
 * getLogger().info('outside a Logging Context') // service, environment, version from env
 * ```
 */
export function setDefaultLogger<T extends LogFields = LogFields>(logger: Logger<T>): void {
  const target = resolveForRegistration(logger as Logger)
  if (target) defaultLogger = target
}

/**
 * Register `logger` as the Default Logger unless one is already set: first seen wins.
 * Used by `useLogger` and the Workers helpers; `setDefaultLogger()` always overrides it.
 *
 * @internal Not exported from the package entry points.
 */
export function registerDefaultLogger(logger: Logger): void {
  if (defaultLogger) return
  defaultLogger = resolveForRegistration(logger)
}

/**
 * Whether a Default Logger is registered. Lets the Workers helpers skip working out
 * their Logger Options once one is set.
 *
 * @internal Not exported from the package entry points.
 */
export function hasDefaultLogger(): boolean {
  return defaultLogger !== undefined
}

/**
 * The registered Default Logger, or `undefined`.
 *
 * @internal Test helper, not exported from the package entry points.
 */
export function _getDefaultLogger(): Logger | undefined {
  return defaultLogger
}

/**
 * Get a logger for the current context.
 *
 * - **Inside a Logging Context** (`runWithLogger`, `useLogger`, Traced Sessions):
 *   returns the context's logger. `service` is ignored.
 * - **Outside a Logging Context**, with no `service`: returns a logger that writes
 *   through the Default Logger (see `setDefaultLogger`) registered when each line is
 *   logged, or through a standalone logger with `service: 'unknown'` while none is.
 *   Keeping it at module scope is fine, even before the default is registered.
 * - **Outside a Logging Context**, with `service`: returns a cached standalone
 *   logger (built with `createLogger`) tagged with `service`.
 *
 * @template T - The type of user-defined log fields.
 * @param {string} [service] - Service name for a standalone logger, used instead of the Default Logger.
 * @returns {Logger<T>} The logger for the current context.
 *
 * @example
 * ```ts
 * const logger = getLogger()
 * logger.info({ userId: 42 }, 'user signed in')
 * ```
 */
export function getLogger<T extends LogFields = LogFields>(service?: string): Logger<T> {
  const store = als.getStore()
  if (store) return store.logger as Logger<T>
  if (service === undefined) return outsideContextLogger as Logger<T>

  let logger = _cache.get(service)
  if (!logger) {
    logger = createLogger({ service })
    _cache.set(service, logger)
  }
  return logger as Logger<T>
}

/**
 * Add Context Fields to the current Logging Context.
 *
 * - **Inside a Logging Context**: fields appear on all subsequent log lines in
 *   this context and in Spans opened after this call (not in the outer context).
 * - **Outside a Logging Context**: the fields are ignored, and a single `WARN` line
 *   (naming the ignored keys, not their values) is written once per isolate.
 *   An isolate serves many requests at once, so there is nowhere safe to keep them.
 *
 * @template T - The type of user-defined log fields.
 * @param {Partial<T>} fields - Key-value pairs to merge into the logging context.
 *
 * @example
 * ```ts
 * setLoggerContext({ requestId: 'abc-123', tenantId: 'acme' })
 * ```
 */
export function setLoggerContext<T extends LogFields = LogFields>(fields: Partial<T>): void {
  const store = als.getStore()
  if (store) {
    Object.assign(store.fields, fields)
    return
  }

  if (!warnedOutsideContext) {
    warnedOutsideContext = true
    getLogger().warn({ ignoredFields: Object.keys(fields) }, OUTSIDE_CONTEXT_WARNING)
  }
}

/**
 * Run a function within a Logging Context.
 *
 * The single way to open a Logging Context, in any runtime (Hono, RPC sessions,
 * scheduled handlers, queue consumers, Node.js). It continues the trace from
 * `traceparent` / `tracestate` when they are valid, otherwise starts a new root
 * trace, and always gives this work its own span ID.
 *
 * `logger` is a Root Logger: create it once per process or isolate and pass the
 * same instance to every context. It must carry only per-process data; put
 * per-unit-of-work data (`requestId`, `userId`, ...) in `fields`.
 *
 * @template T - The type of user-defined log fields.
 * @template R - The return type of `fn`.
 * @param {object} options - Context options.
 * @param {Logger<T>} options.logger - The Root Logger this context logs through.
 * @param {string | null} [options.traceparent] - Incoming W3C `traceparent` value.
 * @param {string | null} [options.tracestate] - Incoming W3C `tracestate` value.
 * @param {Partial<T>} [options.fields] - Initial Context Fields. Copied, never mutated.
 * @param {() => R} fn - The function to execute inside the Logging Context.
 * @returns {R} The return value of `fn`.
 *
 * @example
 * ```ts
 * const logger = createLogger({ service: 'worker' })
 * runWithLogger({ logger, traceparent: req.headers.get('traceparent') }, () => {
 *   getLogger().info('inside the logging context')
 * })
 * ```
 */
export function runWithLogger<T extends LogFields = LogFields, R = unknown>(
  options: {
    logger: Logger<T>
    traceparent?: string | null
    tracestate?: string | null
    fields?: Partial<T> | LogFields
  },
  fn: () => R,
): R {
  const store: ALSStore = {
    trace: resolveTrace(options.traceparent, options.tracestate),
    fields: { ...options.fields } as LogFields,
    logger: options.logger.child({}),
  }
  return als.run(store, fn)
}

/**
 * Run `fn` as a named Span nested inside the current Logging Context.
 *
 * The Span gets a new span ID whose parent is the current span ID, on the same
 * trace. Context Fields are copied in: fields set inside the Span stay inside it.
 * When the trace is sampled, a `span.end` line with timing and status is logged
 * once `fn` settles (sync or async). Errors are logged and rethrown.
 *
 * Outside a Logging Context, `fn` simply runs: no Span, no error.
 *
 * @template R - The return type of `fn`.
 * @param {string} operation - Operation name (e.g. `'db.query'`).
 * @param {() => R} fn - The work to time.
 * @returns {R} The return value of `fn`.
 *
 * @example
 * ```ts
 * const user = await withSpan('db.getUser', () => db.getUser(id))
 * ```
 */
export function withSpan<R>(operation: string, fn: () => R): R {
  const outer = als.getStore()
  if (!outer) return fn()

  const store: ALSStore = {
    trace: { ...outer.trace, spanId: generateSpanId(), parentSpanId: outer.trace.spanId },
    fields: { ...outer.fields },
    logger: outer.logger,
  }
  return als.run(store, () => recordSpan(operation, fn))
}

/** The text a Span records as its `error`. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Time `fn` as a Span covering the *current* Logging Context (no new span ID).
 *
 * Used by `withSpan()` after it opens a nested context, and by Traced Sessions,
 * whose whole Logging Context is the Span. The `span.end` line is written only when
 * the trace is sampled (and `timed` is on). Otherwise a throw is still logged, as one
 * `<operation> failed` line at `ERROR` with `err` and a `span` object without timing
 * (`operation`, `status: 'ERROR'`, `error`), so a query on `span.status` finds it too;
 * success writes nothing.
 *
 * @internal Not exported from the package entry points.
 */
export function recordSpan<R>(operation: string, fn: () => R, timed = true): R {
  const store = als.getStore()
  if (!store) return fn()

  const { logger } = store
  const sampled = timed && (store.trace.traceFlags & 0x01) === 0x01
  const startTime = Date.now()

  const emit = (status: SpanContext['status'], error?: unknown) => {
    if (!sampled) {
      if (status === 'ERROR') {
        const span = { operation, status, error: errorText(error) }
        logger.error({ span, err: error }, '%s failed', operation)
      }
      return
    }
    const endTime = Date.now()
    const span: SpanContext = {
      operation,
      startTime,
      endTime,
      duration: endTime - startTime,
      status,
      ...(status === 'ERROR' ? { error: errorText(error) } : {}),
    }
    if (status === 'ERROR') {
      logger.error({ span, err: error }, 'span.end %s', operation)
    } else {
      logger.info({ span }, 'span.end %s', operation)
    }
  }

  let result: R
  try {
    result = fn()
  } catch (err) {
    emit('ERROR', err)
    throw err
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        emit('OK')
        return value
      },
      (err) => {
        emit('ERROR', err)
        throw err
      },
    ) as R
  }
  emit('OK')
  return result
}

/**
 * Capture the current Logging Context, to re-enter it from a callback the runtime
 * calls outside it. A Workflows `step.do` callback, for one, arrives back over RPC
 * in no Logging Context.
 *
 * @internal Not exported from the package entry points.
 * @returns A function that runs `fn` in the captured Logging Context, or `undefined`
 *   outside a Logging Context.
 */
export function captureLoggingContext(): (<R>(fn: () => R) => R) | undefined {
  const store = als.getStore()
  return store && ((fn) => als.run(store, fn))
}

/**
 * Read the current Trace Context (IDs and flags).
 *
 * @returns {TraceContext | null} A copy of the current Trace Context, or `null` outside a Logging Context.
 *
 * @example
 * ```ts
 * const traceId = getTraceContext()?.traceId
 * ```
 */
export function getTraceContext(): TraceContext | null {
  const store = als.getStore()
  return store ? { ...store.trace } : null
}

/**
 * Get the current Trace Carrier, to pass the trace on over any transport.
 *
 * On the receiving side, continue it with `runWithLogger({ logger, ...carrier })`.
 *
 * @returns {TraceCarrier} `{ traceparent, tracestate? }`, or `{}` outside a Logging Context.
 *
 * @example
 * ```ts
 * await env.QUEUE.send({ ...payload, trace: getTraceCarrier() })
 * ```
 */
export function getTraceCarrier(): TraceCarrier {
  const store = als.getStore()
  return store ? toCarrier(store.trace) : {}
}

/**
 * Read one Context Field of the current Logging Context.
 *
 * @internal Not exported from the package entry points.
 * @param {string} key - The field name (e.g. `'requestId'`).
 * @returns {LogValue | undefined} The value, or `undefined` outside a Logging Context.
 */
export function getContextField(key: string): LogValue | undefined {
  return als.getStore()?.fields[key]
}

/**
 * Replace the sink that receives finished records. Returns the previous sink.
 *
 * @internal Test seam, not exported from the package entry points.
 */
export function _setSink(next: Sink): Sink {
  const previous = sink
  sink = next
  return previous
}

/**
 * Redirect log output to an in-memory array of records, exactly as a runtime
 * sink would serialize them (round-tripped through JSON).
 *
 * @internal Test helper, not part of the public API.
 */
export function _captureEntries(): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  sink = { write: (record) => entries.push(JSON.parse(stringifyRecord(record))) }
  return entries
}

/**
 * Redirect log output to an in-memory array of serialized JSON lines.
 *
 * @internal Test helper, not part of the public API.
 */
export function _captureLines(): string[] {
  const lines: string[] = []
  sink = { write: (record) => lines.push(stringifyRecord(record)) }
  return lines
}

/**
 * Reset isolate-level state (standalone logger cache, Default Logger, one-time warnings).
 * Does not change the sink.
 *
 * Used internally by tests to clear state between runs.
 */
export function _reset(): void {
  _cache.clear()
  unknownLogger = undefined
  defaultLogger = undefined
  warnedOutsideContext = false
  _resetEnvWarnings()
}
