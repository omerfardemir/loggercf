import type { LogFields, Logger, LogLevel } from './types'
import { copyBindings, newBudget, takeRecordKeys, type LogRecord } from './output'
import { routeArgs } from './route'

/**
 * One log call as `adaptLogger()` hands it to a `LineTarget`: Argument Routing has
 * placed every argument, and nothing is serialized yet, so your logger writes the
 * values its own way (an `Error` is still an `Error`).
 */
export interface LogLine {
  /** The level method that was called. */
  level: LogLevel
  /** The formatted message (`printf` placeholders filled), when the call gave one. */
  message?: string
  /**
   * The line's fields, a plain object: the logger's bindings (when the target has no
   * `child`), then the call's fields, which win on a shared key. A binding for a Record
   * Key (`time`, `level`, `message`, `errors`, `args`) moves to `args`, as in the
   * built-in logger. `err` is the first
   * `Error` (or a structured call's `err`), `errors` the ones after it, and `args`
   * the Overflow: the values with no better place, in call order.
   */
  fields: Record<string, unknown>
}

/**
 * What `adaptLogger()` writes through: usually a few lines around your own logger.
 */
export interface LineTarget {
  /**
   * Write one line. Filtering by level is yours: loggercf calls every level. A
   * throw is never passed on to the log call.
   */
  write(line: LogLine): void
  /**
   * Your logger's own child, for `.child(bindings)`. Without it, the adapted logger
   * keeps the bindings itself and writes them in each line's `fields`. When it
   * throws, it is as if it were absent, for that child.
   */
  child?(bindings: Record<string, unknown>): LineTarget
}

/** loggercf's levels, as its `Logger` has them. */
const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

/**
 * Copy `source`'s entries onto `target`. `__proto__` stays a key, never the prototype.
 *
 * @param {Record<string, unknown>} target - The object to write. Mutated.
 * @param {LogRecord} source - The entries to copy.
 */
function assignOwn(target: Record<string, unknown>, source: LogRecord): void {
  for (const key of Object.keys(source)) {
    Object.defineProperty(target, key, {
      value: source[key],
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
}

/**
 * The `LogLine` for one call.
 *
 * @param {LogLevel} level - The level method called.
 * @param {LogRecord} bindings - The bindings the adapted logger keeps itself.
 * @param {unknown[]} input - The call's arguments.
 * @returns {LogLine} The line.
 */
function toLine(level: LogLevel, bindings: LogRecord, input: unknown[]): LogLine {
  const { fields, message, errors, args } = routeArgs(input, newBudget())
  // As in the built-in logger, bindings can't set a Record Key: their values move to `args`.
  const moved: unknown[] = []
  const out: Record<string, unknown> = {}
  assignOwn(out, takeRecordKeys(bindings, moved as LogRecord[]) ?? {})
  assignOwn(out, fields)
  if (errors && errors.length > 0) out.errors = errors
  const overflow = [...moved, ...(args ?? [])]
  if (overflow.length > 0) out.args = overflow
  return message === undefined ? { level, fields: out } : { level, message, fields: out }
}

/**
 * The adapted logger over `target`, with `bindings` it keeps itself.
 *
 * @template T - The type of user-defined log fields.
 * @param {LineTarget} target - Where its lines go.
 * @param {LogRecord} bindings - Bindings written in each line's fields.
 * @returns {Logger<T>} The logger.
 */
function makeAdapted<T extends LogFields>(target: LineTarget, bindings: LogRecord): Logger<T> {
  const logger = {
    child(more: Record<string, unknown>): Logger<T> {
      const copy = copyBindings(more) // read now: a log call never runs the getters
      if (typeof target.child === 'function') {
        try {
          return makeAdapted<T>(target.child(copy), bindings)
        } catch {
          // Fall through: keep the bindings here, as for a target with no `child`.
        }
      }
      const merged: LogRecord = {}
      assignOwn(merged, bindings)
      assignOwn(merged, copy)
      return makeAdapted<T>(target, merged)
    },
  } as Logger<T>
  for (const level of LEVELS) {
    logger[level] = (...input: unknown[]) => {
      try {
        target.write(toLine(level, bindings, input))
      } catch {
        // A log call never throws.
      }
    }
  }
  return logger
}

/**
 * Build a loggercf `Logger` over your own logger, from a `LineTarget` that writes one
 * line. Every call, in either call style, goes through loggercf's Argument Routing
 * first, so `write` gets the message (placeholders filled) and the fields apart.
 *
 * Use it for a logger whose methods are not loggercf-shaped (`(fields, message, ...args)`
 * and `child(bindings)`), to pass it anywhere loggercf takes a Root Logger: `useLogger`,
 * `runWithLogger`, the Workers helpers' `logger` option. loggercf's own lines (Request
 * Lines, `span.end`, failure lines) then go through it too. A pino logger needs no
 * adapter.
 *
 * The adapted logger adds nothing of its own: no time, no level filter, no Context
 * Fields. Add `currentContextFields()` in `write`, or in your logger's own per-line
 * hook, so the lines carry `traceId`, `spanId` and the Context Fields.
 *
 * @template T - The type of user-defined log fields.
 * @param {LineTarget} target - Writes one line, and optionally makes a child.
 * @returns {Logger<T>} The adapted logger.
 *
 * @example
 * ```ts
 * const logger = adaptLogger({
 *   write: ({ level, message, fields }) => console.log(level, message, { ...currentContextFields(), ...fields }),
 * })
 * ```
 */
export function adaptLogger<T extends LogFields = LogFields>(target: LineTarget): Logger<T> {
  return makeAdapted<T>(target, {})
}
