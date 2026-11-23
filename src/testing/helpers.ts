// Shared by the tests. Not a test file itself, and not part of the build.
import type { Logger } from '../core/types'

/** Throws, as a hand-written Logger's method might. */
const loggerBroke = (): never => {
  throw new Error('logger broke')
}

/** A hand-written Logger whose every level throws, and whose `child` is itself. */
export const brokenLogger: Logger = {
  trace: loggerBroke,
  debug: loggerBroke,
  info: loggerBroke,
  warn: loggerBroke,
  error: loggerBroke,
  fatal: loggerBroke,
  child: () => brokenLogger,
}

/**
 * A line captured from the pino-based logger, with `message` moved to just
 * after `level`, where loggercf writes it. pino wrote it after the fields.
 * Every value, and the order of every other key, is unchanged.
 *
 * @param {string} line - One captured JSON line.
 * @returns {string} The same line with `message` third.
 */
export function messageAfterLevel(line: string): string {
  const { time, level, ...rest } = JSON.parse(line) as Record<string, unknown>
  if (!('message' in rest)) return line
  const { message, ...fields } = rest
  return JSON.stringify({ time, level, message, ...fields })
}

/** One call a `recordingLogger()` received. */
export interface RecordedCall {
  /** The level method called. */
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  /** The arguments it got, as given. */
  args: unknown[]
  /** The bindings of every `.child()` above the logger that got it, merged. */
  bindings: Record<string, unknown>
}

/**
 * A hand-written Logger that records every call instead of writing it: a stand-in
 * for the user's own logger.
 *
 * @returns {{ logger: Logger, calls: RecordedCall[] }} The logger, and the calls it and its children got.
 */
export function recordingLogger(): { logger: Logger; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const make = (bindings: Record<string, unknown>): Logger => {
    const record =
      (level: RecordedCall['level']) =>
      (...args: unknown[]) => {
        calls.push({ level, args, bindings })
      }
    return {
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      fatal: record('fatal'),
      child: (more) => make({ ...bindings, ...more }),
    }
  }
  return { logger: make({}), calls }
}
