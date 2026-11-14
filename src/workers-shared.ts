// Internals shared by the Workers helpers (`workers.ts`, `handlers.ts`).
// Not an entry point: nothing here is exported from the package.

import type {
  ErrorSerializer,
  Logger,
  LoggerOptions,
  Redactor,
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
  /**
   * The Root Logger's `redact` (see `LoggerOptions`): code, so it can't come from
   * env; choose it per environment in code. The same object gives the same Root
   * Logger, so define it once, at module scope (`redactKeys()` gives the same one
   * for the same keys, even inline).
   */
  redact?: Redactor | false
}

/** The code-only Logger Options of a helper's options: all but the Env Mapping. */
export type CodeOptions = Pick<RootLoggerSource, 'serializeError' | 'redact'>

/**
 * A helper's Root Logger source: the `env`, `serializeError` and `redact` of its
 * options, and nothing else. One place to list them, for every helper.
 *
 * @param {RootLoggerSource<E>} options - A helper's options.
 * @returns {RootLoggerSource<E>} Its Root Logger source.
 */
export function rootLoggerSource<E>(options: RootLoggerSource<E>): RootLoggerSource<E> {
  const { env, serializeError, redact } = options
  return { env, serializeError, redact }
}

/**
 * Whether two helpers' Root Logger sources are the same: the same Env Mapping
 * (see `sameEnvMapping()`), the same `serializeError` function and the same
 * `redact` object (`false` and absent are the same).
 *
 * @param {RootLoggerSource<any>} a - One helper's options.
 * @param {RootLoggerSource<any>} b - The other's.
 * @returns {boolean} `true` when they give the same Root Logger.
 */
export function sameRootLoggerSource(a: RootLoggerSource<any>, b: RootLoggerSource<any>): boolean {
  return (
    sameEnvMapping(a.env, b.env) &&
    a.serializeError === b.serializeError &&
    (a.redact || undefined) === (b.redact || undefined)
  )
}

/** Stands for a code-only option that is not set, in `rootLoggers`. */
const ABSENT = {}

/**
 * Root Loggers by their code-only options, by identity: `serializeError`, then
 * `redact` (`ABSENT` for one that is not set), then by their other Logger Options
 * (see `optionsKey()`), one per isolate. Weak, so the loggers built for a
 * function or a redactor nothing else holds (one made in a request) go when it
 * does, instead of piling up in the isolate.
 *
 * Safe to share across concurrent requests because a Root Logger carries only
 * per-process data; per-request data lives in each Logging Context.
 */
let rootLoggers = new WeakMap<object, WeakMap<object, Map<string, Logger>>>()

/** A code-only option that is cached by identity. */
type CodeOptionKey = 'serializeError' | 'redact'

/** The functions and objects of each code-only option Root Loggers were built with in this isolate. */
let codeSeen: Record<CodeOptionKey, WeakSet<object>> = {
  serializeError: new WeakSet(),
  redact: new WeakSet(),
}

/** How many of each code-only option have had Root Loggers built in this isolate. */
let codeCounts: Record<CodeOptionKey, number> = { serializeError: 0, redact: 0 }

/**
 * Past this many `serializeError` functions, or `redact` objects, one WARN says a
 * new one is made on each call. A Worker needs one per Root Logger, usually one in
 * all.
 */
const MAX_CODE_OPTIONS = 16

/**
 * The cache key for Logger Options: every option but the code-only ones.
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
 * Count a code-only option's function or object the first time it is seen. The
 * first one past `MAX_CODE_OPTIONS` writes one WARN per isolate.
 *
 * @param {CodeOptionKey} option - Which option.
 * @param {object} value - Its function or object.
 * @param {LoggerOptions} options - The Logger Options, for the warning.
 */
function countCodeOption(option: CodeOptionKey, value: object, options: LoggerOptions): void {
  const seen = codeSeen[option]
  if (seen.has(value)) return
  seen.add(value)
  if (++codeCounts[option] !== MAX_CODE_OPTIONS + 1) return
  const { service, environment, version } = options
  const logger = createLogger({ service, environment, version })
  if (option === 'serializeError') {
    logger.warn(
      { serializeErrorFunctions: codeCounts[option] },
      'serializeError is a new function each call; define it once at module scope',
    )
  } else {
    logger.warn(
      { redactObjects: codeCounts[option] },
      'redact is a new object each call; define it once at module scope',
    )
  }
}

/**
 * Get the isolate's Root Logger for these Logger Options, creating it once.
 * A `serializeError` and a `redact` are matched by identity: another function or
 * object, even one that does the same, gets a Root Logger of its own.
 *
 * @param {LoggerOptions} options - Logger Options (usually from `loggerOptionsFromEnv`).
 * @returns {Logger} The cached Root Logger.
 */
export function cachedRootLogger(options: LoggerOptions): Logger {
  const { serializeError, redact } = options
  const bySerializer: object = typeof serializeError === 'function' ? serializeError : ABSENT
  const byRedactor: object = typeof redact === 'object' && redact !== null ? redact : ABSENT
  let forSerializer = rootLoggers.get(bySerializer)
  if (!forSerializer) rootLoggers.set(bySerializer, (forSerializer = new WeakMap()))
  let loggers = forSerializer.get(byRedactor)
  if (!loggers) forSerializer.set(byRedactor, (loggers = new Map()))
  const key = optionsKey(options)
  let logger = loggers.get(key)
  if (!logger) {
    logger = createLogger(options) // first: an invalid option throws, and is not counted
    if (bySerializer !== ABSENT) countCodeOption('serializeError', bySerializer, options)
    if (byRedactor !== ABSENT) countCodeOption('redact', byRedactor, options)
    loggers.set(key, logger)
  }
  return logger
}

/** Test only: forget every cached Root Logger and the code-only option counts. */
export function _resetRootLoggers(): void {
  rootLoggers = new WeakMap()
  codeSeen = { serializeError: new WeakSet(), redact: new WeakSet() }
  codeCounts = { serializeError: 0, redact: 0 }
}

/**
 * The isolate's cached Root Logger for a Worker env, read through a helper's
 * Env Mapping, with the code-only options it was given.
 *
 * @param {unknown} env - The Worker's env.
 * @param {RootLoggerSource<any>} [source] - The helper's `env`, `serializeError` and `redact` options.
 * @returns {Logger} The cached Root Logger.
 */
export function envRootLogger(env: unknown, source: RootLoggerSource<any> = {}): Logger {
  return cachedRootLogger(withCodeOptions(loggerOptionsFromEnv(env, source.env), source))
}

/**
 * Logger Options with a helper's `serializeError` and `redact` added, when it
 * has them.
 *
 * @param {LoggerOptions} options - The Logger Options.
 * @param {CodeOptions} code - The helper's `serializeError` and `redact` options.
 * @returns {LoggerOptions} `options`, or a copy with them.
 */
export function withCodeOptions(options: LoggerOptions, code: CodeOptions): LoggerOptions {
  const { serializeError, redact } = code
  if (serializeError === undefined && redact === undefined) return options
  const out: LoggerOptions = { ...options }
  if (serializeError !== undefined) out.serializeError = serializeError
  if (redact !== undefined) out.redact = redact
  return out
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
