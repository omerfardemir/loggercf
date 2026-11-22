// `loggercf/winston`: winston as Your Own Logger (see docs/loggers/winston.md). No import of
// winston itself: the types below are the few parts of it loggercf uses.
import { adaptLogger, type LogLine } from './adapt'
import { currentContextFields } from './logger'
import {
  defaultErrorShape,
  describeFailure,
  isError,
  isPlainObject,
  takeRecordKeys,
  TRACE_KEYS,
  type LogRecord,
} from './output'
import type { LogFields, Logger, LogLevel } from './types'

/**
 * A winston info object: what a winston logger writes and its formats transform.
 * winston's own keys (`Symbol.for('level')`, `Symbol.for('message')`, `Symbol.for('splat')`)
 * are symbols; every other key is a field of the line.
 */
export interface WinstonInfo {
  /** The winston level name. */
  level: string
  /** The message. */
  message: unknown
  /** The line's fields, and winston's symbol keys. */
  [key: string | symbol]: unknown
}

/**
 * The parts of a winston logger `fromWinston()` uses. A `winston.createLogger()`
 * logger, or one of its `.child()` loggers, is one as it is.
 */
export interface WinstonLike {
  /** Write one info object: the stream method winston's own `log(info)` ends in. */
  write(info: WinstonInfo): unknown
  /** The logger's levels, name to priority (npm's when absent). */
  levels?: Record<string, number>
  /** The logger's `defaultMeta`, written under each line's fields. */
  defaultMeta?: unknown
  /** Whether a level would be written by any transport; lines it says no to are not built. */
  isLevelEnabled?(level: string): boolean
}

/**
 * A winston format: an object with a `transform`, which is all `format.combine()` and
 * `createLogger({ format })` need.
 */
export interface WinstonFormat {
  /**
   * Transform one info object.
   *
   * @param {WinstonInfo} info - The line.
   * @param {unknown} [opts] - The format's options.
   * @returns {WinstonInfo | boolean} The line, or `false` to drop it.
   */
  transform(info: WinstonInfo, opts?: unknown): WinstonInfo | boolean
}

/** Options for `fromWinston()`. */
export interface FromWinstonOptions {
  /**
   * The winston level each loggercf level writes at, in place of the default
   * mapping (see `fromWinston()`). Each must be one of the logger's levels.
   */
  levels?: Partial<Record<LogLevel, string>>
  /**
   * Writes each `Error` on the adapter's lines, at any depth inside plain objects and
   * arrays, in place of loggercf's default shape (`{ type, message, stack, ...own
   * props, cause? }`), which `defaultSerialize` gives. What it returns is handed to
   * winston as it is: return the `Error` itself for a format of yours that writes
   * Errors. When it throws, that `Error` is written in the default shape with
   * `serializeErrorFailed`.
   */
  writeError?: (err: Error, defaultSerialize: (err: Error) => LogRecord) => unknown
}

/** winston's own key for the level, which its transports filter on (triple-beam's `LEVEL`). */
const LEVEL = Symbol.for('level')

/** winston's own key for `format.splat()`'s values (triple-beam's `SPLAT`). */
const SPLAT = Symbol.for('splat')

/**
 * Set on the lines `fromWinston()` writes, which already carry their Context Fields
 * and trace IDs: `contextFields()` leaves them as they are.
 */
const STAMPED = Symbol.for('loggercf.contextFields')

/** What an object inside itself is written as, as winston's `format.json()` writes it. */
const CIRCULAR = '[Circular]'

/** winston's default levels (`winston.config.npm.levels`), for a logger that lists none. */
const NPM_LEVELS: Readonly<Record<string, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6,
}

/**
 * The winston levels each loggercf level writes at, the first one the logger has:
 * its own level of the same name, else the nearest one in npm, syslog and cli levels.
 */
const CANDIDATES: Readonly<Record<LogLevel, readonly string[]>> = {
  trace: ['trace', 'silly', 'debug'],
  debug: ['debug', 'verbose'],
  info: ['info'],
  warn: ['warn', 'warning'],
  error: ['error', 'err'],
  fatal: ['fatal', 'crit', 'error', 'err'],
}

/** loggercf's levels, in the order an error names them. */
const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

/** The keys winston writes itself on an info object: a field can't set them. */
const INFO_KEYS = ['level', 'message'] as const

/**
 * The winston level for each loggercf level.
 *
 * @param {Readonly<Record<string, number>>} levels - The winston logger's levels.
 * @param {Partial<Record<LogLevel, string>>} chosen - The `levels` option.
 * @returns {Record<LogLevel, string>} The mapping.
 * @throws {TypeError} When a chosen level is not one of `levels`, or a level has no candidate in them.
 */
function mapLevels(
  levels: Readonly<Record<string, number>>,
  chosen: Partial<Record<LogLevel, string>>,
): Record<LogLevel, string> {
  const has = (name: string) => Object.hasOwn(levels, name)
  const mapping = {} as Record<LogLevel, string>
  for (const level of LEVELS) {
    const given = chosen[level]
    if (given !== undefined) {
      if (!has(given))
        throw new TypeError(
          `fromWinston: levels.${level}: '${given}' is not one of the winston logger's levels (${Object.keys(levels).join(', ')})`,
        )
      mapping[level] = given
      continue
    }
    const found = CANDIDATES[level].find(has)
    if (found === undefined)
      throw new TypeError(
        `fromWinston: the winston logger has no level for loggercf's '${level}' (tried ${CANDIDATES[level].join(', ')}); map it with the levels option`,
      )
    mapping[level] = found
  }
  return mapping
}

/**
 * Set `key` on `target` as an own, enumerable value. `__proto__` stays a key.
 *
 * @param {Record<string | symbol, unknown>} target - The object to write. Mutated.
 * @param {string} key - The key.
 * @param {unknown} value - The value.
 */
function setOwn(target: Record<string | symbol, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

/**
 * `value` with every `Error` in it written by `serialize`: the value itself, or inside
 * plain objects and arrays at any depth. Copies only what holds an `Error` or a loop,
 * so your objects are never changed. An object inside itself is `"[Circular]"` there,
 * as winston's JSON writes it. Never throws: an object it can't read is kept as it is.
 *
 * @param {unknown} value - A field's value.
 * @param {(err: Error) => unknown} serialize - Writes one `Error`.
 * @param {Set<object>} ancestors - The objects `value` is inside.
 * @returns {unknown} The value, or a copy with its Errors written.
 */
function withErrorsWritten(
  value: unknown,
  serialize: (err: Error) => unknown,
  ancestors: Set<object>,
): unknown {
  if (isError(value)) return serialize(value)
  const isArray = Array.isArray(value)
  if (!isArray && !isPlainObject(value)) return value
  const container = value as Record<string, unknown>
  if (ancestors.has(container)) return CIRCULAR
  ancestors.add(container)
  try {
    let copy: Record<string, unknown> | unknown[] | undefined
    for (const key of Object.keys(container)) {
      const item = container[key]
      const written = withErrorsWritten(item, serialize, ancestors)
      if (written === item) continue
      copy ??= isArray ? [...(value as unknown[])] : { ...container }
      if (isArray) (copy as unknown[])[Number(key)] = written
      else setOwn(copy as Record<string, unknown>, key, written)
    }
    return copy ?? value
  } catch {
    return value
  } finally {
    ancestors.delete(container)
  }
}

/**
 * loggercf's default shape for one `Error`, as `writeError` gets it.
 *
 * @param {Error} err - The `Error`.
 * @returns {LogRecord} `{ type, message, stack, ...own props, cause? }`.
 */
const defaultSerialize = (err: Error): LogRecord => defaultErrorShape(err)

/**
 * The function that writes each `Error` of one line: the `writeError` option, or
 * loggercf's default shape. The same `Error` twice on a line is written once.
 *
 * @param {FromWinstonOptions['writeError']} custom - The `writeError` option.
 * @returns {(err: Error) => unknown} The writer, for one line.
 */
function errorWriter(custom: FromWinstonOptions['writeError']): (err: Error) => unknown {
  const written = new Map<Error, unknown>()
  return (err) => {
    if (written.has(err)) return written.get(err)
    let out: unknown
    if (custom) {
      try {
        out = custom(err, defaultSerialize)
      } catch (thrown) {
        out = { ...defaultSerialize(err), serializeErrorFailed: describeFailure(thrown) }
      }
    } else {
      out = defaultSerialize(err)
    }
    written.set(err, out)
    return out
  }
}

/**
 * The winston info object for one `fromWinston()` line. Strongest first: the trace IDs,
 * the call's fields, the adapted logger's bindings, the winston logger's
 * `defaultMeta`, the Context Fields. A binding or Context Field named `level` or
 * `message` (the Record Keys, for a Context Field) moves to `args`, bindings first.
 *
 * @param {LogLine} line - The call, after Argument Routing.
 * @param {string} level - The winston level it writes at.
 * @param {unknown} defaultMeta - The winston logger's `defaultMeta`.
 * @param {(err: Error) => unknown} serialize - Writes one `Error`.
 * @returns {WinstonInfo} The info object.
 */
function toInfo(
  line: LogLine,
  level: string,
  defaultMeta: unknown,
  serialize: (err: Error) => unknown,
): WinstonInfo {
  const info: WinstonInfo = { level, message: line.message ?? '' }
  const movedFromFields: LogRecord = {}
  const movedFromContext: LogRecord[] = []
  const context = currentContextFields()
  const fromContext = takeRecordKeys(context, movedFromContext) ?? {}
  for (const key of Object.keys(fromContext)) {
    if (!(TRACE_KEYS as readonly string[]).includes(key)) setOwn(info, key, fromContext[key])
  }
  if (typeof defaultMeta === 'object' && defaultMeta !== null) {
    for (const [key, value] of Object.entries(defaultMeta)) {
      if (!(INFO_KEYS as readonly string[]).includes(key)) setOwn(info, key, value)
    }
  }
  for (const key of Object.keys(line.fields)) {
    const value = line.fields[key]
    if ((INFO_KEYS as readonly string[]).includes(key)) {
      if (value !== undefined) movedFromFields[key] = value
      continue
    }
    setOwn(info, key, withErrorsWritten(value, serialize, new Set()))
  }
  const moved = Object.keys(movedFromFields).length > 0 ? [movedFromFields] : []
  moved.push(...movedFromContext)
  if (moved.length > 0) {
    const args = Array.isArray(info.args) ? info.args : []
    info.args = [...args, ...(withErrorsWritten(moved, serialize, new Set()) as LogRecord[])]
  }
  if (context.traceId !== undefined) {
    // As inside loggercf's own lines: the Trace Context's IDs, and no `parentSpanId` on a root trace.
    for (const key of TRACE_KEYS) {
      if (context[key] !== undefined) info[key] = context[key]
      else delete info[key]
    }
  }
  info[LEVEL] = level
  // An empty splat: `format.splat()` reads it (over a `splat` field), so it never formats the message again.
  info[SPLAT] = []
  info[STAMPED] = true
  return info
}

/**
 * Build a loggercf `Logger` over a winston logger, to pass anywhere loggercf takes a
 * Root Logger: `useLogger`, `runWithLogger`, a `TracedEntrypoint`'s Root Logger hook,
 * the Workers helpers' `logger` option. loggercf's own lines (Request Lines,
 * `span.end`, failure lines) then go through winston too, with its transports and
 * formats.
 *
 * Every call goes through loggercf's Argument Routing, so both call styles work and
 * winston gets one info object per call: the formatted message (`printf` placeholders
 * filled, never formatted again by `format.splat()`) and the fields at the top level.
 * Each line carries the current Logging Context's Context Fields and trace IDs, taken
 * at the call. Every `Error` in the fields (`err`, `errors`, at any depth inside plain
 * objects and arrays) is written as `{ type, message, stack, ...own props, cause? }`,
 * so `format.json()` doesn't write it as `{}`.
 *
 * Levels: each loggercf level writes at the winston level of the same name when the
 * logger has it, else at the nearest one: `trace` at `silly` (or `debug`), `fatal` at
 * `crit` (or `error`), `warn` at `warning`, `error` at `err`. The `levels` option
 * overrides any of them. winston filters by level, as it does for its own calls.
 *
 * `.child(bindings)` keeps the bindings in the adapter, so precedence is loggercf's:
 * the trace IDs, then the call's fields, the bindings, winston's `defaultMeta`, and
 * the Context Fields.
 *
 * @template T - The type of user-defined log fields.
 * @param {WinstonLike} logger - A winston logger (or one of its children).
 * @param {FromWinstonOptions} [options] - Level mapping and Error writing.
 * @returns {Logger<T>} The adapted logger.
 * @throws {TypeError} When a loggercf level has no winston level to write at.
 *
 * @example
 * ```ts
 * const w = winston.createLogger({
 *   format: winston.format.combine(contextFields(), winston.format.json()),
 *   transports: [new winston.transports.Console()],
 * })
 * app.use(useLogger(fromWinston(w)))
 * ```
 */
export function fromWinston<T extends LogFields = LogFields>(
  logger: WinstonLike,
  options: FromWinstonOptions = {},
): Logger<T> {
  const levels = mapLevels(logger.levels ?? NPM_LEVELS, options.levels ?? {})
  const { writeError } = options
  return adaptLogger<T>({
    write(line) {
      const level = levels[line.level]
      if (typeof logger.isLevelEnabled === 'function' && !logger.isLevelEnabled(level)) return
      logger.write(toInfo(line, level, logger.defaultMeta, errorWriter(writeError)))
    },
  })
}

/**
 * The current Logging Context's Context Fields, with the trace IDs over them, never
 * `level` or `message`.
 *
 * @returns {LogRecord} The fields; `{}` outside a Logging Context.
 */
function contextEntries(): LogRecord {
  const fields: LogRecord = currentContextFields()
  for (const key of INFO_KEYS) delete fields[key]
  return fields
}

/**
 * A winston format that adds the current Logging Context's Context Fields and trace
 * IDs (`traceId`, `spanId`, `parentSpanId`) to each line: your own winston calls
 * (`w.info(...)`) carry them too. Outside a Logging Context it adds nothing.
 *
 * A key the line already has keeps the line's value, and `level` and `message` are
 * never set. The lines of `fromWinston()` already carry their Context Fields (taken at
 * the call), so it leaves them as they are.
 *
 * A format runs when winston formats the line. With transports that finish each
 * write at once (`Console`, `Stream`), that is during the call. Behind one that
 * doesn't (`File`, `Http`), winston buffers a burst of lines and formats them later,
 * in whatever Logging Context is current then, so they could carry another unit of
 * work's fields: there, use `contextMeta()` instead, which is read at the call.
 *
 * @returns {WinstonFormat} The format, for `format.combine()` or `createLogger({ format })`.
 *
 * @example
 * ```ts
 * const w = winston.createLogger({
 *   format: winston.format.combine(contextFields(), winston.format.json()),
 *   transports: [new winston.transports.Console()],
 * })
 * ```
 */
export function contextFields(): WinstonFormat {
  return {
    transform(info) {
      if (info[STAMPED] === true) return info
      const fields = contextEntries()
      for (const key of Object.keys(fields)) {
        if (!Object.hasOwn(info, key)) setOwn(info, key, fields[key])
      }
      return info
    },
  }
}

/**
 * A winston `defaultMeta` whose keys are the current Logging Context's Context Fields
 * and trace IDs, read each time winston copies it: during the log call, so each line
 * carries its own unit of work's fields whatever its transports do (see
 * `contextFields()`). `fields` are written on every line too, over the Context Fields
 * (as a Root Logger's bindings are); the trace IDs are over both.
 *
 * Which wins between it and a call's own fields is winston's rule for `defaultMeta`:
 * the call's `meta` in `w.info(message, meta)`, `defaultMeta` in `w.info({ message, ... })`.
 *
 * @param {Record<string, unknown>} [fields] - Fixed fields for every line, read once, now.
 * @returns {Record<string, unknown>} The `defaultMeta`.
 *
 * @example
 * ```ts
 * const w = winston.createLogger({
 *   defaultMeta: contextMeta({ service: 'api' }),
 *   format: winston.format.json(),
 *   transports: [new winston.transports.File({ filename: 'app.log' })],
 * })
 * ```
 */
export function contextMeta(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const fixed: LogRecord = {}
  for (const [key, value] of Object.entries(fields)) setOwn(fixed, key, value)
  const current = (): LogRecord => {
    const context = contextEntries()
    const out: LogRecord = {}
    for (const key of Object.keys(context)) {
      if (!(TRACE_KEYS as readonly string[]).includes(key)) setOwn(out, key, context[key])
    }
    for (const key of Object.keys(fixed)) setOwn(out, key, fixed[key])
    for (const key of TRACE_KEYS) if (context[key] !== undefined) setOwn(out, key, context[key])
    return out
  }
  return new Proxy<Record<string, unknown>>(
    {},
    {
      ownKeys: () => Reflect.ownKeys(current()),
      getOwnPropertyDescriptor: (_target, key) => {
        const out = current()
        return typeof key === 'string' && Object.hasOwn(out, key)
          ? { value: out[key], writable: true, enumerable: true, configurable: true }
          : undefined
      },
      get: (_target, key) => (typeof key === 'string' ? current()[key] : undefined),
      has: (_target, key) => typeof key === 'string' && Object.hasOwn(current(), key),
    },
  )
}
