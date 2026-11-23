export type {
  LogFields,
  TraceContext,
  TraceCarrier,
  SpanContext,
  Span,
  SpanOptions,
  SpanDefaults,
  LoggerOptions,
  ErrorSerializer,
  LineLimits,
  Redactor,
  RedactKeysOptions,
  Logger,
  LogLevel,
} from './core/types'

export {
  createLogger,
  runWithLogger,
  withSpan,
  getLogger,
  setDefaultLogger,
  setLoggerContext,
  getTraceContext,
  getTraceCarrier,
  currentContextFields,
} from './core/logger'
export { adaptLogger } from './loggers/adapt'
export type { LineTarget, LogLine } from './loggers/adapt'
export { omitErrorKeys } from './output/omit'
export { redactKeys } from './output/redact'
export { tracedFetch, tracedFetcher } from './trace/fetch'
export type { TracedFetchOptions } from './trace/fetch'
export { loggerOptionsFromEnv } from './core/env'
export type { EnvMapping, EnvSource } from './core/env'
export type {
  TracedServiceBinding,
  SessionInit,
  TracedWorkerOptions,
  WithLoggingOptions,
  HandlerOptions,
} from './workers'
