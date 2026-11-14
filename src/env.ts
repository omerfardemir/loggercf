import { createLogger } from './logger'
import { isMaxRecordBytes, isMaxStringLength, MIN_RECORD_BYTES } from './limits'
import type { LineLimits, LoggerOptions, LogLevel, SpanDefaults } from './types'

type LoggerLevel = NonNullable<LoggerOptions['level']>

/**
 * Where one Logger Options field comes from: the name of an env var, or a
 * function that derives the value from env (e.g. from a `version_metadata` binding).
 *
 * A number is used as its string form (`"VERSION": 2` gives `'2'`). A missing
 * var, an empty string, any other non-string value, or `undefined` from the
 * function counts as absent.
 *
 * @template E - The worker or process environment type.
 */
export type EnvSource<E = unknown> = string | ((env: E) => string | undefined)

/**
 * Per-field override of the env vars `loggerOptionsFromEnv()` reads. Fields you
 * leave out keep their default var: `NAME`, `LOG_LEVEL`, `ENVIRONMENT`, `VERSION`,
 * `LOG_SPAN_LEVEL`, `LOG_SPAN_SLOW_MS`, `LOG_MAX_STRING_LENGTH`, `LOG_MAX_RECORD_BYTES`.
 *
 * @template E - The worker or process environment type.
 *
 * @example
 * ```ts
 * const mapping: EnvMapping<Env> = {
 *   // or 'RELEASE' to read another var
 *   version: (env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id,
 * }
 * ```
 */
export interface EnvMapping<E = unknown> {
  /** Source of `service`. Default `'NAME'`; falls back to `'unknown'` when absent. */
  service?: EnvSource<E>
  /**
   * Source of `level`. Default `'LOG_LEVEL'`; falls back to `'info'` when absent or invalid.
   * `'silent'` writes nothing.
   */
  level?: EnvSource<E>
  /** Source of `environment`. Default `'ENVIRONMENT'`; omitted when absent. */
  environment?: EnvSource<E>
  /** Source of `version`. Default `'VERSION'`; omitted when absent. */
  version?: EnvSource<E>
  /**
   * Source of `spans.level`, the level of an OK `span.end`. Default `'LOG_SPAN_LEVEL'`;
   * omitted when absent or invalid (Spans then write at `'info'`). `'silent'` is not a
   * Span level.
   */
  spanLevel?: EnvSource<E>
  /**
   * Source of `spans.slowMs`, the Slow Threshold in milliseconds. Default
   * `'LOG_SPAN_SLOW_MS'`; omitted when absent or not a number `>= 0`.
   */
  spanSlowMs?: EnvSource<E>
  /**
   * Source of `limits.maxStringLength`. Default `'LOG_MAX_STRING_LENGTH'`; omitted
   * when absent or not an integer `>= 1` (strings are then never cut).
   */
  maxStringLength?: EnvSource<E>
  /**
   * Source of `limits.maxRecordBytes`. Default `'LOG_MAX_RECORD_BYTES'`; omitted
   * when absent or not an integer `>= 1024` (lines are then never trimmed).
   */
  maxRecordBytes?: EnvSource<E>
}

const DEFAULT_VARS = {
  service: 'NAME',
  level: 'LOG_LEVEL',
  environment: 'ENVIRONMENT',
  version: 'VERSION',
  spanLevel: 'LOG_SPAN_LEVEL',
  spanSlowMs: 'LOG_SPAN_SLOW_MS',
  maxStringLength: 'LOG_MAX_STRING_LENGTH',
  maxRecordBytes: 'LOG_MAX_RECORD_BYTES',
} as const

/** The levels `LOG_LEVEL` accepts, lowercase only. `'silent'` writes nothing, as in 0.0.1. */
const LOG_LEVELS: readonly LoggerLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
]

/** The levels `LOG_SPAN_LEVEL` accepts: every level but `'silent'`. */
const SPAN_LEVELS = LOG_LEVELS.filter((level): level is LogLevel => level !== 'silent')

/** A field whose invalid value writes a warning. */
type CheckedField = 'level' | 'spanLevel' | 'spanSlowMs' | 'maxStringLength' | 'maxRecordBytes'

/** The fields whose invalid-value warning has been written in this isolate. */
const warnedInvalid = new Set<CheckedField>()

/**
 * The var a field is read from, as the warnings name it: the var name, or the field
 * name for a derive function.
 *
 * @param {EnvSource} source - The field's source.
 * @param {string} field - The field's name in the Env Mapping.
 * @returns {string} The name to show.
 */
function sourceName(source: EnvSource<any>, field: string): string {
  return typeof source === 'string' ? source : field
}

/**
 * Write a warning once per field per isolate, through a logger with the other Logger
 * Options, so it carries `service`, `environment` and `version`.
 *
 * @param {CheckedField} field - The field with the invalid value.
 * @param {LoggerOptions} options - The other Logger Options.
 * @param {object} fields - The warning's fields.
 * @param {string} message - The warning.
 */
function warnInvalid(
  field: CheckedField,
  options: LoggerOptions,
  fields: object,
  message: string,
): void {
  if (warnedInvalid.has(field)) return
  warnedInvalid.add(field)
  const { service, environment, version } = options
  createLogger({ service, environment, version }).warn(fields, message)
}

/**
 * Read one field from env through its source. Absent values become `undefined`.
 *
 * @template E - The environment type.
 * @param {E} env - The environment object.
 * @param {EnvSource<E>} source - Var name or derive function.
 * @returns {string | undefined} The non-empty string (or finite number as a string), or `undefined`.
 */
function read<E>(env: E, source: EnvSource<E>): string | undefined {
  const value: unknown =
    typeof source === 'function' ? source(env) : (env as Record<string, unknown> | null)?.[source]
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Validate a level, falling back to `'info'`. An invalid value writes one WARN per isolate.
 *
 * @param {string | undefined} value - The level read from env.
 * @param {string} levelVar - The var it was read from (or `'level'` for a function), named in the warning.
 * @param {LoggerOptions} options - The other Logger Options, so the warning carries `service` etc.
 * @returns {LoggerLevel} A valid level, `'silent'` included.
 */
function resolveLevel(
  value: string | undefined,
  levelVar: string,
  options: LoggerOptions,
): LoggerLevel {
  if (value === undefined) return 'info'
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LoggerLevel
  warnInvalid(
    'level',
    options,
    { invalidLevel: value, validLevels: [...LOG_LEVELS] },
    `${levelVar} "${value}" is not a valid log level; using "info"`,
  )
  return 'info'
}

/**
 * The Span Defaults read from env. An invalid value is left out, and writes one WARN
 * per field per isolate.
 *
 * @param {(key: 'spanLevel' | 'spanSlowMs') => string | undefined} field - Reads one field.
 * @param {(key: 'spanLevel' | 'spanSlowMs') => string} name - The var a field is read from.
 * @param {LoggerOptions} options - The other Logger Options, for the warnings.
 * @returns {SpanDefaults | undefined} The Span Defaults, or `undefined` when none is set.
 */
function resolveSpans(
  field: (key: 'spanLevel' | 'spanSlowMs') => string | undefined,
  name: (key: 'spanLevel' | 'spanSlowMs') => string,
  options: LoggerOptions,
): SpanDefaults | undefined {
  const spans: SpanDefaults = {}
  const level = field('spanLevel')
  if (level !== undefined && (SPAN_LEVELS as readonly string[]).includes(level)) {
    spans.level = level as LogLevel
  } else if (level !== undefined) {
    warnInvalid(
      'spanLevel',
      options,
      { invalidLevel: level, validLevels: [...SPAN_LEVELS] },
      `${name('spanLevel')} "${level}" is not a valid span level; using "info"`,
    )
  }
  const slowMs = field('spanSlowMs')
  // An empty var is already absent; a blank one would be `Number(' ') === 0`.
  const ms = slowMs !== undefined && slowMs.trim() !== '' ? Number(slowMs) : NaN
  if (ms >= 0) {
    spans.slowMs = ms
  } else if (slowMs !== undefined) {
    warnInvalid(
      'spanSlowMs',
      options,
      { invalidSlowMs: slowMs },
      `${name('spanSlowMs')} "${slowMs}" is not a number of milliseconds >= 0; no slow threshold`,
    )
  }
  return Object.keys(spans).length > 0 ? spans : undefined
}

/**
 * A whole number read from env, or `NaN`.
 *
 * @param {string | undefined} value - The value read from env.
 * @returns {number} The number; `NaN` when absent or blank.
 */
function numberFrom(value: string | undefined): number {
  // An empty var is already absent; a blank one would be `Number(' ') === 0`.
  return value !== undefined && value.trim() !== '' ? Number(value) : NaN
}

/**
 * The `limits` read from env. An invalid value is left out, and writes one WARN
 * per field per isolate.
 *
 * @param {(key: 'maxStringLength' | 'maxRecordBytes') => string | undefined} field - Reads one field.
 * @param {(key: 'maxStringLength' | 'maxRecordBytes') => string} name - The var a field is read from.
 * @param {LoggerOptions} options - The other Logger Options, for the warnings.
 * @returns {LineLimits | undefined} The limits, or `undefined` when none is set.
 */
function resolveLimits(
  field: (key: 'maxStringLength' | 'maxRecordBytes') => string | undefined,
  name: (key: 'maxStringLength' | 'maxRecordBytes') => string,
  options: LoggerOptions,
): LineLimits | undefined {
  const limits: LineLimits = {}
  const maxString = field('maxStringLength')
  const chars = numberFrom(maxString)
  if (isMaxStringLength(chars)) {
    limits.maxStringLength = chars
  } else if (maxString !== undefined) {
    warnInvalid(
      'maxStringLength',
      options,
      { invalidMaxStringLength: maxString },
      `${name('maxStringLength')} "${maxString}" is not an integer >= 1; strings are not cut`,
    )
  }
  const maxRecord = field('maxRecordBytes')
  const bytes = numberFrom(maxRecord)
  if (isMaxRecordBytes(bytes)) {
    limits.maxRecordBytes = bytes
  } else if (maxRecord !== undefined) {
    warnInvalid(
      'maxRecordBytes',
      options,
      { invalidMaxRecordBytes: maxRecord },
      `${name('maxRecordBytes')} "${maxRecord}" is not an integer >= ${MIN_RECORD_BYTES}; lines are not trimmed`,
    )
  }
  return Object.keys(limits).length > 0 ? limits : undefined
}

/**
 * Build Logger Options from env.
 *
 * By default it reads `NAME`, `LOG_LEVEL`, `ENVIRONMENT`, `VERSION`, the Span
 * Defaults `LOG_SPAN_LEVEL` and `LOG_SPAN_SLOW_MS` (as `spans.level` and
 * `spans.slowMs`), and the `limits` `LOG_MAX_STRING_LENGTH` and
 * `LOG_MAX_RECORD_BYTES` (as `limits.maxStringLength` and
 * `limits.maxRecordBytes`). Pass a mapping to read other var names or derive a
 * field with a function. `service` falls back to `'unknown'` and `level` to
 * `'info'`; an absent `environment`, `version`, Span Default or limit is left out,
 * so log lines omit it (and `spans` or `limits` is left out when both of its
 * fields are). `level` accepts `'silent'`, which writes nothing. An invalid level
 * falls back to `'info'`, and an invalid Span Default or limit is left out; each
 * writes one WARN per isolate. `serializeError` is code, so it never comes from
 * env: add it to the result.
 *
 * @template E - The worker or process environment type.
 * @param {E} env - The worker or process environment object.
 * @param {EnvMapping<E>} [mapping] - Per-field var name or derive function.
 * @returns {LoggerOptions} Logger Options derived from env.
 *
 * @example
 * ```ts
 * loggerOptionsFromEnv(env) // NAME, LOG_LEVEL, ENVIRONMENT, VERSION
 * loggerOptionsFromEnv(env, { version: 'RELEASE' }) // read another var
 * loggerOptionsFromEnv(env, {
 *   version: (e) => e.CF_VERSION_METADATA?.tag || e.CF_VERSION_METADATA?.id, // derive it
 * })
 * ```
 */
export function loggerOptionsFromEnv<E = unknown>(
  env: E,
  mapping: EnvMapping<E> = {},
): LoggerOptions {
  const source = (key: keyof EnvMapping) => mapping[key] ?? DEFAULT_VARS[key]
  const field = (key: keyof EnvMapping) => read(env, source(key))
  const environment = field('environment')
  const version = field('version')
  const options: LoggerOptions = {
    service: field('service') ?? 'unknown',
    ...(environment ? { environment } : {}),
    ...(version ? { version } : {}),
  }
  const level = resolveLevel(field('level'), sourceName(source('level'), 'level'), options)
  const name = (key: keyof EnvMapping) => sourceName(source(key), key)
  const spans = resolveSpans(field, name, options)
  const limits = resolveLimits(field, name, options)
  return { ...options, level, ...(spans ? { spans } : {}), ...(limits ? { limits } : {}) }
}

/**
 * Re-arm the one-time invalid-value warnings.
 *
 * @internal Called by `_reset()` in tests; not part of the public API.
 */
export function _resetEnvWarnings(): void {
  warnedInvalid.clear()
}
