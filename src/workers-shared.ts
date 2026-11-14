// Internals shared by the Workers helpers (`workers.ts`, `handlers.ts`).
// Not an entry point: nothing here is exported from the package.

import type {
  ErrorSerializer,
  Logger,
  LoggerOptions,
  Span,
  SpanOptions,
  TraceCarrier,
} from './types'
import {
  createLogger,
  hasDefaultLogger,
  NOOP_SPAN,
  recordSpan,
  registerDefaultLogger,
  runWithLogger,
} from './logger'
import { loggerOptionsFromEnv, type EnvMapping } from './env'

/**
 * Where a Workers helper's Root Logger comes from, besides the env itself: the
 * Env Mapping, and the Logger Options that are code, so env can't hold them.
 * Shared by the options of every helper that builds its Root Logger from env.
 *
 * @template E - The worker environment type.
 */
export interface RootLoggerSource<E = unknown> {
  /** Where the Root Logger's options come from in env (see `loggerOptionsFromEnv`). */
  env?: EnvMapping<E>
  /**
   * The Root Logger's `serializeError` (see `LoggerOptions`): code, so it can't come
   * from env. The same function gives the same Root Logger, so define it once, at
   * module scope, not in the call.
   */
  serializeError?: ErrorSerializer
}

/**
 * Whether two helpers' Root Logger sources are the same: the same Env Mapping
 * (see `sameEnvMapping()`) and the same `serializeError` function.
 *
 * @param {RootLoggerSource<any>} a - One helper's options.
 * @param {RootLoggerSource<any>} b - The other's.
 * @returns {boolean} `true` when they give the same Root Logger.
 */
export function sameRootLoggerSource(a: RootLoggerSource<any>, b: RootLoggerSource<any>): boolean {
  return sameEnvMapping(a.env, b.env) && a.serializeError === b.serializeError
}

/**
 * Root Loggers without a `serializeError`, keyed by their other Logger Options
 * (see `optionsKey()`), one per isolate.
 *
 * Safe to share across concurrent requests because a Root Logger carries only
 * per-process data; per-request data lives in each Logging Context.
 */
const rootLoggers = new Map<string, Logger>()

/**
 * Root Loggers with a `serializeError`, by that function, then by their other
 * Logger Options. Weak, so the loggers built for a function nothing else holds
 * (a closure made in a request) go when it does, instead of piling up in the
 * isolate.
 */
let serializerRootLoggers = new WeakMap<ErrorSerializer, Map<string, Logger>>()

/** How many `serializeError` functions have had Root Loggers built in this isolate. */
let serializersSeen = 0

/**
 * Past this many `serializeError` functions, one WARN says a new one is made on
 * each call. A Worker needs one per Root Logger, usually one in all.
 */
const MAX_SERIALIZERS = 16

/**
 * The cache key for Logger Options: every option but `serializeError`.
 *
 * @param {LoggerOptions} options - The Logger Options.
 * @returns {string} The key.
 */
function optionsKey(options: LoggerOptions): string {
  const { service, level, environment, version, spans, limits } = options
  return JSON.stringify([
    service,
    level,
    environment,
    version,
    spans?.level,
    spans?.slowMs,
    limits?.maxStringLength,
    limits?.maxRecordBytes,
  ])
}

/**
 * The Root Loggers built with `serializeError`, made empty the first time it is
 * seen. The first one past `MAX_SERIALIZERS` writes one WARN per isolate.
 *
 * @param {ErrorSerializer} serializeError - The function.
 * @param {LoggerOptions} options - The Logger Options, for the warning.
 * @returns {Map<string, Logger>} Its Root Loggers, by `optionsKey()`.
 */
function loggersFor(serializeError: ErrorSerializer, options: LoggerOptions): Map<string, Logger> {
  let loggers = serializerRootLoggers.get(serializeError)
  if (loggers) return loggers
  loggers = new Map()
  serializerRootLoggers.set(serializeError, loggers)
  if (++serializersSeen === MAX_SERIALIZERS + 1) {
    const { service, environment, version } = options
    createLogger({ service, environment, version }).warn(
      { serializeErrorFunctions: serializersSeen },
      'serializeError is a new function each call; define it once at module scope',
    )
  }
  return loggers
}

/**
 * Get the isolate's Root Logger for these Logger Options, creating it once.
 * A `serializeError` is matched by identity: another function, even one that
 * does the same, gets a Root Logger of its own.
 *
 * @param {LoggerOptions} options - Logger Options (usually from `loggerOptionsFromEnv`).
 * @returns {Logger} The cached Root Logger.
 */
export function cachedRootLogger(options: LoggerOptions): Logger {
  const { serializeError } = options
  const loggers =
    typeof serializeError === 'function' ? loggersFor(serializeError, options) : rootLoggers
  const key = optionsKey(options)
  let logger = loggers.get(key)
  if (!logger) {
    logger = createLogger(options)
    loggers.set(key, logger)
  }
  return logger
}

/** Test only: forget every cached Root Logger and the `serializeError` count. */
export function _resetRootLoggers(): void {
  rootLoggers.clear()
  serializerRootLoggers = new WeakMap()
  serializersSeen = 0
}

/**
 * The isolate's cached Root Logger for a Worker env, read through a helper's
 * Env Mapping, with the `serializeError` it was given in code.
 *
 * @param {unknown} env - The Worker's env.
 * @param {RootLoggerSource<any>} [source] - The helper's `env` and `serializeError` options.
 * @returns {Logger} The cached Root Logger.
 */
export function envRootLogger(env: unknown, source: RootLoggerSource<any> = {}): Logger {
  return cachedRootLogger(
    withSerializer(loggerOptionsFromEnv(env, source.env), source.serializeError),
  )
}

/**
 * Logger Options with a helper's `serializeError` added, when it has one.
 *
 * @param {LoggerOptions} options - The Logger Options.
 * @param {ErrorSerializer} [serializeError] - The helper's `serializeError` option.
 * @returns {LoggerOptions} `options`, or a copy with `serializeError`.
 */
export function withSerializer(
  options: LoggerOptions,
  serializeError: ErrorSerializer | undefined,
): LoggerOptions {
  return serializeError === undefined ? options : { ...options, serializeError }
}

/**
 * Register the isolate's Root Logger as the Default Logger unless one is already set
 * (first seen wins). Shared by every Workers helper.
 *
 * @param {() => Logger} rootLogger - Resolves the Root Logger; called only while no default is set.
 */
export function registerRootLogger(rootLogger: () => Logger): void {
  // Once a default is set, skip working out the Logger Options on every request or RPC call.
  if (!hasDefaultLogger()) registerDefaultLogger(rootLogger())
}

/**
 * Run `fn` in a new Logging Context, as a Span covering that context when
 * `operation` is given. Shared by `TracedSession.traced()`, `withLogging()` and the
 * handler helpers.
 *
 * @template R - The return type of `fn`.
 * @param {Parameters<typeof runWithLogger>[0]} context - The Logging Context to open.
 * @param {(span: Span) => R} fn - The function to run in it. Gets the Span's handle (a
 *   no-op one without `operation`).
 * @param {string} [operation] - Span operation name; no Span without it.
 * @param {boolean} [timed] - `false` writes no `span.end`, only the `<operation> failed`
 *   line on a throw (see `recordSpan`).
 * @param {SpanOptions} [options] - The Span's options; ignored without `operation`.
 * @returns {R} The return value of `fn`, unchanged.
 */
export function runLogged<R>(
  context: Parameters<typeof runWithLogger>[0],
  fn: (span: Span) => R,
  operation?: string,
  timed = true,
  options?: SpanOptions,
): R {
  return runWithLogger(
    context,
    operation ? () => recordSpan(operation, fn, timed, options) : () => fn(NOOP_SPAN),
  )
}

/** Any method, as stored on a prototype. */
export type Method = (...args: any[]) => unknown

/**
 * Define a method the way a class body does: non-enumerable, writable, configurable.
 *
 * @param {object} target - The prototype.
 * @param {string} name - The method name; also the function's `name`.
 * @param {Method} fn - The method.
 */
export function defineMethod(target: object, name: string, fn: Method): void {
  Object.defineProperty(fn, 'name', { value: name, configurable: true })
  Object.defineProperty(target, name, {
    value: fn,
    writable: true,
    enumerable: false,
    configurable: true,
  })
}

/**
 * The methods JSRPC can see on a class: functions on its prototype chain below
 * `base` (`WorkerEntrypoint.prototype`, `DurableObject.prototype` or
 * `WorkflowEntrypoint.prototype`), nearest definition first, without `constructor`,
 * accessors, or a method an accessor or field-like value shadows.
 *
 * @param {Function} Class - The class.
 * @param {object} base - The runtime base class's prototype, where the walk stops.
 * @returns {Map<string, Method>} Method name to the class's implementation.
 */
export function prototypeMethods(Class: Function, base: object): Map<string, Method> {
  const methods = new Map<string, Method>()
  const seen = new Set<string>(['constructor'])
  for (
    let proto: object | null = Class.prototype;
    proto && proto !== base && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name)) continue
      seen.add(name)
      const { value } = Object.getOwnPropertyDescriptor(proto, name)!
      if (typeof value === 'function') methods.set(name, value as Method)
    }
  }
  return methods
}

/**
 * The double-wrap guards shared by `withLogging()` and `withWorkflow()`: a class the
 * helper already returned is accepted again only with the same options, and a
 * subclass of one is rejected.
 *
 * @template O - The helper's options.
 * @param {Function} Class - The class being wrapped.
 * @param {WeakMap<object, O>} wrapped - The classes the helper returned, with their options.
 * @param {(previous: O) => boolean} sameAs - Whether the new options match a class's.
 * @param {string} where - The helper call, for error messages (`withLogging(Name)`).
 * @returns {boolean} `true` when `Class` is already wrapped with the same options.
 */
export function alreadyWrapped<O>(
  Class: Function,
  wrapped: WeakMap<object, O>,
  sameAs: (previous: O) => boolean,
  where: string,
): boolean {
  const helper = where.slice(0, where.indexOf('('))
  const previous = wrapped.get(Class)
  if (previous !== undefined) {
    if (sameAs(previous)) return true
    throw new TypeError(`${where}: ${Class.name} is already wrapped with other options`)
  }
  for (let base = Object.getPrototypeOf(Class); base; base = Object.getPrototypeOf(base)) {
    if (wrapped.has(base)) {
      throw new TypeError(
        `${where}: ${Class.name} extends a class already wrapped by ${helper}(); wrap one of them, not both`,
      )
    }
  }
  return false
}

/**
 * Read the Trace Carrier a producer put in a message body or payload as
 * `{ ...payload, trace: getTraceCarrier() }`. Anything else, including a `trace`
 * of another shape, gives an empty carrier (a new root trace).
 *
 * @param {unknown} body - A queue message body or a Workflow payload.
 * @returns {TraceCarrier} The carrier, with absent or non-string values omitted.
 */
export function carrierFromBody(body: unknown): TraceCarrier {
  if (typeof body !== 'object' || body === null) return {}
  const trace = (body as { trace?: unknown }).trace
  if (typeof trace !== 'object' || trace === null) return {}
  const { traceparent, tracestate } = trace as Record<string, unknown>
  if (typeof traceparent !== 'string') return {}
  return { traceparent, ...(typeof tracestate === 'string' ? { tracestate } : {}) }
}

/**
 * Whether two Env Mappings have the same keys and values (a derive function
 * compares by identity). An absent mapping equals an empty one.
 *
 * @param {object} [a] - One mapping.
 * @param {object} [b] - The other.
 * @returns {boolean} `true` when they are the same.
 */
export function sameEnvMapping(a: object | undefined, b: object | undefined): boolean {
  const envA = (a ?? {}) as Record<string, unknown>
  const envB = (b ?? {}) as Record<string, unknown>
  const keys = new Set([...Object.keys(envA), ...Object.keys(envB)])
  return [...keys].every((key) => envA[key] === envB[key])
}
