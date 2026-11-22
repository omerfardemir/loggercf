// `loggercf/consola`: consola as Your Own Logger (see docs/loggers/consola.md).
// No import of consola itself: the types below are the parts of it this module uses,
// so neither the bundle nor the published types depend on it.
import { adaptLogger, type LogLine } from './adapt'
import { currentContextFields, getTraceContext } from '../core/logger'
import {
  applyTrace,
  buildRecord,
  describeFailure,
  isError,
  newBudget,
  stringifyRecord,
  TRACE_KEYS,
  type LogRecord,
  type RecordContext,
  type RecordEntry,
} from '../output/output'
import { routeArgs } from '../output/route'
import type { LogFields, Logger, LogLevel } from '../core/types'

/**
 * The parts of a consola instance `fromConsola()` uses: the six level methods, and
 * the level it filters at. `createConsola()` from any consola entry point (`consola`,
 * `consola/core`, `consola/basic`, `consola/browser`) and the default `consola`
 * export are one.
 */
export interface ConsolaLike {
  /** consola's `trace` (level 5). */
  trace(input: object): unknown
  /** consola's `debug` (level 4). */
  debug(input: object): unknown
  /** consola's `info` (level 3). */
  info(input: object): unknown
  /** consola's `warn` (level 1). */
  warn(input: object): unknown
  /** consola's `error` (level 0). */
  error(input: object): unknown
  /** consola's `fatal` (level 0). */
  fatal(input: object): unknown
  /** The most verbose level it writes: a call whose type is above it writes nothing. */
  readonly level?: number
  /** Its options, for the level of each type (when you changed consola's `types`). */
  readonly options?: {
    readonly types?: { readonly [type: string]: { readonly level?: number } | undefined }
  }
}

/** The parts of the log object consola hands each reporter that this module reads. */
export interface ConsolaLogObjectLike {
  /** The call's arguments, console style: a message (maybe with `printf` placeholders), then values. */
  args: unknown[]
  /** consola's numeric level: 0 error and fatal, 1 warn, 2 log, 3 info, 4 debug, 5 trace. */
  level: number
  /** The method called: `info`, `success`, `box`... */
  type: string
  /** The instance's tag (`consola.withTag()`), or `''`. */
  tag: string
  /** When the call was made. */
  date: Date
}

/**
 * A consola reporter: consola calls `log` once per line it writes, with the line's log
 * object and its own options.
 *
 * @template O - The log object it takes.
 * @template C - The context it takes.
 */
export interface ConsolaReporterLike<
  O extends ConsolaLogObjectLike = ConsolaLogObjectLike,
  C = unknown,
> {
  /** Write one line. */
  log(logObj: O, ctx: C): void
}

/**
 * What `fromConsola()` keeps on each log object it hands consola, keyed by a symbol so
 * consola's reporters never print it: the line as `adaptLogger()` routed it, and the
 * Logging Context it was written in. `withContextFields()` sees from it that the
 * Context Fields are already there; `jsonReporter()` writes the line from it.
 */
interface ConsolaLine {
  /** The level method called. */
  level: LogLevel
  /** The formatted message, when the call gave one. */
  message?: string
  /** The line's fields as `adaptLogger()` gave them: bindings, then the call's, `err`, `errors`, `args`. */
  fields: Record<string, unknown>
  /** The Logging Context the line was written in, if any. */
  context?: RecordContext
}

/** The key of a log object's `ConsolaLine`. */
const LINE = Symbol('loggercf.line')

/** A log object `fromConsola()` made. */
type WithLine = { [LINE]?: ConsolaLine }

/**
 * consola's level for each of loggercf's, as consola's default `types` set them.
 */
const CONSOLA_LEVELS: Readonly<Record<LogLevel, number>> = {
  fatal: 0,
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
  trace: 5,
}

/** loggercf's levels, as its `Logger` has them. */
const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

/**
 * Whether consola writes a call to its `level` method, as its own check decides:
 * the type's level against the instance's. When the instance can't say, it does.
 *
 * @param {ConsolaLike} consola - The instance.
 * @param {LogLevel} level - The method.
 * @returns {boolean} `false` only when consola would drop the call.
 */
function writes(consola: ConsolaLike, level: LogLevel): boolean {
  try {
    const max = consola.level
    if (typeof max !== 'number') return true
    const own = consola.options?.types?.[level]?.level
    return (typeof own === 'number' ? own : CONSOLA_LEVELS[level]) <= max
  } catch {
    return true // a getter that throws: let consola decide
  }
}

/**
 * The current Logging Context as a line records it: the Context Fields and the Trace
 * Context.
 *
 * @returns {RecordContext | undefined} It, or `undefined` outside a Logging Context.
 */
function currentContext(): RecordContext | undefined {
  const trace = getTraceContext()
  if (!trace) return undefined
  const fields = currentContextFields()
  for (const key of TRACE_KEYS) delete fields[key] // `trace` holds them
  return { trace, fields }
}

/**
 * A line's fields with its Logging Context's: the Context Fields first, the line's own
 * winning on a shared key, then the trace IDs, which win over both (as on loggercf's
 * own lines).
 *
 * @param {Record<string, unknown>} fields - The line's fields.
 * @param {RecordContext | undefined} context - Its Logging Context.
 * @returns {Record<string, unknown>} A new object.
 */
function withContext(
  fields: Record<string, unknown>,
  context: RecordContext | undefined,
): Record<string, unknown> {
  if (!context) return { ...fields }
  const merged: LogRecord = { ...context.fields, ...fields }
  applyTrace(merged, context.trace)
  return merged
}

/**
 * The arguments consola gets for one line, console style: the message, an object of
 * the fields, and the `Error` under `err` last, on its own, so consola's reporters print
 * its message and stack. The message is left out when it is that `Error`'s message (an
 * `Error`-first call), which the reporters print already. A `%` in the message is
 * doubled when values follow, so a reporter's `printf` (consola's, or `console.log`'s)
 * prints it as it is.
 *
 * @param {string | undefined} message - The formatted message.
 * @param {Record<string, unknown>} fields - The line's fields, Context Fields included.
 * @returns {unknown[]} The arguments.
 */
function consolaArgs(message: string | undefined, fields: Record<string, unknown>): unknown[] {
  const { err, ...rest } = fields
  const error = isError(err) ? err : undefined
  const shown = error ? rest : fields
  const args: unknown[] = []
  if (message !== undefined && message !== error?.message) args.push(message)
  if (Object.keys(shown).length > 0) args.push(shown)
  if (error) args.push(error)
  if (typeof args[0] === 'string' && args.length > 1) args[0] = args[0].replaceAll('%', '%%')
  return args
}

/**
 * The loggercf `Logger` over `logger`, that skips every call consola would filter out,
 * before Argument Routing runs.
 *
 * @template T - The type of user-defined log fields.
 * @param {Logger<T>} logger - The adapted logger.
 * @param {ConsolaLike} consola - The instance it writes through.
 * @returns {Logger<T>} The logger.
 */
function filtered<T extends LogFields>(logger: Logger<T>, consola: ConsolaLike): Logger<T> {
  const out = {
    child: (bindings: Record<string, unknown>) => filtered(logger.child(bindings), consola),
  } as Logger<T>
  for (const level of LEVELS) {
    const write = logger[level]
    out[level] = (...args: unknown[]) => {
      if (writes(consola, level)) (write as (...a: unknown[]) => void)(...args)
    }
  }
  return out
}

/**
 * Build a loggercf `Logger` that writes through a consola instance, to pass anywhere
 * loggercf takes a Root Logger: `useLogger`, `runWithLogger`, a `TracedEntrypoint`'s
 * `[TracedEntrypoint.rootLogger]`, the Workers helpers' `logger` option. Every line of
 * those Logging Contexts, loggercf's own (Request Lines, `span.end`, failure lines)
 * included, then goes through consola's reporters.
 *
 * Each call goes through loggercf's Argument Routing, in either call style, then to
 * consola's method of the same level, as `(message, fields, err)`: the formatted
 * message, one object of the fields, and the `Error` last. Inside a Logging Context,
 * the fields hold its Context Fields and trace IDs too: the line's own fields win over
 * a Context Field, and the trace IDs over both. `child(bindings)` keeps the bindings
 * and writes them in the fields (consola's `withTag` names a tag, not fields: call
 * `fromConsola(consola.withTag('api'))` for one).
 *
 * consola's `level` filters: a call above it is dropped before it is routed. A log call
 * never throws, even when a reporter does.
 *
 * @template T - The type of user-defined log fields.
 * @param {ConsolaLike} consola - The consola instance: `createConsola()`, or the default `consola`.
 * @returns {Logger<T>} The logger.
 *
 * @example
 * ```ts
 * import { createConsola } from 'consola/core'
 * import { fromConsola, jsonReporter } from 'loggercf/consola'
 *
 * const logger = fromConsola(createConsola({ reporters: [jsonReporter()], throttle: 0 }))
 * app.use(useLogger(logger))
 * ```
 */
export function fromConsola<T extends LogFields = LogFields>(consola: ConsolaLike): Logger<T> {
  const logger = adaptLogger<T>({
    write({ level, message, fields }: LogLine) {
      const context = currentContext()
      const line: ConsolaLine = { level, message, fields, context }
      const logObj: { args: unknown[] } & WithLine = {
        args: consolaArgs(message, withContext(fields, context)),
        [LINE]: line,
      }
      consola[level](logObj)
    },
  })
  return filtered(logger, consola)
}

/**
 * Wrap a consola reporter so the lines of your own `consola.info(...)` calls carry the
 * Context Fields and trace IDs too, as the lines of `fromConsola()` do: inside a
 * Logging Context, the reporter gets `currentContextFields()` as one more argument, last.
 * A line from `fromConsola()` already holds them, so it is passed on as it is. The log
 * object the other reporters get is never changed.
 *
 * @template O - The log object the reporter takes.
 * @template C - The context it takes.
 * @param {ConsolaReporterLike<O, C>} reporter - Any consola reporter.
 * @returns {ConsolaReporterLike<O, C>} The wrapped reporter.
 *
 * @example
 * ```ts
 * import { consola } from 'consola'
 *
 * consola.setReporters(consola.options.reporters.map(withContextFields))
 * ```
 */
export function withContextFields<O extends ConsolaLogObjectLike, C>(
  reporter: ConsolaReporterLike<O, C>,
): ConsolaReporterLike<O, C> {
  return {
    log(logObj: O, ctx: C) {
      if ((logObj as WithLine)[LINE]) return reporter.log(logObj, ctx)
      const fields = currentContextFields()
      if (Object.keys(fields).length === 0) return reporter.log(logObj, ctx)
      return reporter.log({ ...logObj, args: [...logObj.args, fields] }, ctx)
    },
  }
}

/** The `console` method each level label is written with, as Cloudflare reads severity from it. */
const CONSOLE_METHODS: Readonly<Record<string, 'debug' | 'info' | 'warn' | 'error'>> = {
  TRACE: 'debug',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'error',
}

/**
 * The loggercf level of a consola log object: its type, when that is one of loggercf's
 * six, else from consola's numeric level (`log`, `success`, `start`... are `info`).
 *
 * @param {ConsolaLogObjectLike} logObj - The log object.
 * @returns {LogLevel} The level.
 */
function levelOf(logObj: ConsolaLogObjectLike): LogLevel {
  if ((LEVELS as readonly string[]).includes(logObj.type)) return logObj.type as LogLevel
  const level = logObj.level
  if (level <= 0) return 'error'
  if (level === 1) return 'warn'
  if (level <= 3) return 'info'
  if (level === 4) return 'debug'
  return 'trace'
}

/**
 * The record `jsonReporter()` writes for one log object: as loggercf writes its own
 * lines, with `tag`, and `type` when it is not a level (`success`, `box`...).
 *
 * @param {ConsolaLogObjectLike} logObj - The log object.
 * @param {string} label - Its level label (`INFO`...).
 * @returns {LogRecord} The record.
 */
function jsonRecord(logObj: ConsolaLogObjectLike, label: string): LogRecord {
  const time = (logObj.date instanceof Date ? logObj.date : new Date()).toISOString()
  const tag = typeof logObj.tag === 'string' && logObj.tag ? { tag: logObj.tag } : {}
  const line = (logObj as WithLine)[LINE]
  if (line) {
    const { errors, args, ...rest } = line.fields
    const bindings: LogRecord = { ...tag, ...rest }
    const entry: RecordEntry = {
      time,
      level: label,
      message: line.message,
      bindings,
      fields: {},
    }
    // Arrays from adaptLogger(); anything else is a binding of that name, a Record Key.
    if (Array.isArray(errors)) entry.errors = errors
    else if (errors !== undefined) bindings.errors = errors
    if (Array.isArray(args)) entry.args = args
    else if (args !== undefined) bindings.args = args
    return buildRecord(entry, line.context)
  }
  const type =
    logObj.type && logObj.type !== label.toLowerCase() && logObj.type !== 'log'
      ? { type: logObj.type }
      : {}
  const budget = newBudget()
  const routed = routeArgs(Array.isArray(logObj.args) ? logObj.args : [], budget)
  return buildRecord(
    { ...routed, time, level: label, bindings: { ...tag, ...type }, budget },
    currentContext(),
  )
}

/**
 * A consola reporter that writes each line as one JSON line, as loggercf writes its own:
 * `time`, `level` (`INFO`...), `message`, the Context Fields, the fields, an `Error`
 * with its `type`, `message` and `stack`, and the trace IDs. Through the `console`
 * method of its level (`console.info`, `console.error`...), so Workers Logs indexes the
 * fields and reads the severity. consola ships no JSON reporter, and its browser
 * reporter (what a Worker gets) writes CSS badges.
 *
 * A line from `fromConsola()` is written as loggercf routed it; your own
 * `consola.info(...)` calls go through loggercf's Argument Routing (the `printf`
 * message, objects merged, `Error`s to `err` / `errors`) and get the Context Fields
 * too, with `tag` (`withTag`) and `type` (when it is not a level: `success`, `box`...).
 * Never throws: a line it can't write is written as `time`, `level` and `logError`.
 *
 * @returns {ConsolaReporterLike} The reporter.
 *
 * @example
 * ```ts
 * import { createConsola } from 'consola/core'
 *
 * const consola = createConsola({ reporters: [jsonReporter()], throttle: 0 })
 * ```
 */
export function jsonReporter(): ConsolaReporterLike {
  return {
    log(logObj: ConsolaLogObjectLike) {
      let level = 'INFO'
      try {
        level = ((logObj as WithLine)[LINE]?.level ?? levelOf(logObj)).toUpperCase()
        console[CONSOLE_METHODS[level]!](stringifyRecord(jsonRecord(logObj, level)))
      } catch (thrown) {
        try {
          const time = new Date().toISOString()
          console[CONSOLE_METHODS[level]!](
            JSON.stringify({ time, level, logError: describeFailure(thrown) }),
          )
        } catch {
          // A reporter never throws: consola would pass it on to the log call.
        }
      }
    },
  }
}
