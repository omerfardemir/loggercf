// Helpers shared by the Line Limits tests (`output/limits.test.ts`, `output/limits.timing.test.ts`).
// Not a test file itself, and not part of the build.
import { createLogger, runWithLogger, getLogger, _captureLines } from '../core/logger'
import type { LineLimits } from '../core/types'

export const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

/** The bytes of a line, as the platform counts them. */
export const bytes = (line: string) => Buffer.byteLength(line, 'utf8')

/**
 * `n` fields whose values are small objects of 30 to 79 characters.
 *
 * @param {number} n - How many fields.
 * @returns {Record<string, unknown>} The fields.
 */
export const nestedFields = (n: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`k${i}`, { s: 'v'.repeat(30 + (i % 50)) }]),
  )

/**
 * `n` flat fields of 60 characters.
 *
 * @param {number} n - How many fields.
 * @returns {Record<string, unknown>} The fields.
 */
export const flatFields = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v'.repeat(60)]))

/** A logger with `limits`, inside a Logging Context, and the lines it writes. */
export function limited(limits: LineLimits) {
  const lines = _captureLines()
  const logger = createLogger(
    { service: 'svc', environment: 'production', version: '1.0.0', limits },
    { region: 'eu' },
  )
  const log = (fn: (l: typeof logger) => void) =>
    runWithLogger({ logger, traceparent: TRACEPARENT }, () => fn(getLogger()))
  const parsed = (i = lines.length - 1) => JSON.parse(lines[i]) as Record<string, any>
  return { lines, log, parsed }
}
