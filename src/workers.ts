import { DurableObject, RpcTarget, WorkerEntrypoint, env as workersEnv } from 'cloudflare:workers'
import type {
  ErrorSerializer,
  LogFields,
  Logger,
  LoggerOptions,
  Span,
  SpanOptions,
  TraceCarrier,
} from './types'
import {
  getLogger,
  getTraceCarrier,
  getTraceContext,
  recordSpan,
  registerDefaultLogger,
  setLoggerContext,
  withSpan,
} from './logger'
import { loggerOptionsFromEnv, type EnvMapping } from './env'
import { extractCarrier } from './trace'
import {
  alreadyWrapped,
  cachedRootLogger,
  defineMethod,
  envRootLogger,
  prototypeMethods,
  registerRootLogger,
  runLogged,
  sameRootLoggerSource,
  withSerializer,
  type Method,
  type RootLoggerSource,
} from './workers-shared'

export { loggerOptionsFromEnv } from './env'
export type { EnvMapping, EnvSource } from './env'
export { withScheduled, withQueueMessage, withWorkflow, tracedStep } from './handlers'
export type { HandlerOptions } from './handlers'

/**
 * What a caller hands a Traced Session: its Trace Carrier plus any Context
 * Fields to propagate. One plain object, so adding keys never changes the
 * `session()` call.
 */
export interface SessionInit extends TraceCarrier {
  /** Context Fields to carry into the receiver's Logging Context. */
  fields?: LogFields
}

/**
 * A service binding whose entrypoint exposes `session(init)`.
 *
 * @template T - The Traced Session type returned by `session()`.
 */
export type TracedServiceBinding<T> = {
  session(init: SessionInit): T
}

/**
 * The isolate's Root Logger, built from the Worker's `env` (read through
 * `import { env } from 'cloudflare:workers'`, so it works at module scope and
 * anywhere without a handler's `env`), and registered as the Default Logger.
 *
 * Reads `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION` by default; pass an Env
 * Mapping to read other vars or derive fields (see `loggerOptionsFromEnv`). The
 * Root Logger is created once per Logger Options and shared with `TracedEntrypoint`
 * and `tracedWorker`. It becomes the Default Logger unless one is already set
 * (first seen wins); `setDefaultLogger()` always replaces it.
 *
 * `options.serializeError` is the Root Logger's `serializeError` (code, so it
 * can't come from env): the same function gives the same Root Logger.
 *
 * @template E - The worker environment type.
 * @param {EnvMapping<E>} [mapping] - Per-field var name or derive function.
 * @param {{ serializeError?: ErrorSerializer }} [options] - The Root Logger's `serializeError`.
 * @returns {Logger} The Root Logger.
 *
 * @example
 * ```ts
 * import { getLogger } from 'loggercf'
 * import { useLogger } from 'loggercf/hono'
 * import { defaultLoggerFromEnv } from 'loggercf/workers'
 *
 * const logger = defaultLoggerFromEnv({ version: (env) => env.CF_VERSION_METADATA.id })
 * app.use(useLogger(logger))
 * getLogger().info('module scope') // service, environment, version from env
 * ```
 */
export function defaultLoggerFromEnv<E = Cloudflare.Env>(
  mapping?: EnvMapping<E>,
  options: { serializeError?: ErrorSerializer } = {},
): Logger {
  const logger = envRootLogger(workersEnv, { env: mapping, serializeError: options.serializeError })
  registerDefaultLogger(logger)
  return logger
}

/**
 * `TracedSession`'s `traced()` for code in this module, so `withLogging()`'s session
 * reaches it even when an RPC method of the same name is on its prototype.
 */
let runTraced: <R>(session: TracedSession<any>, fn: () => R, operation?: string) => R

/**
 * Define a member on one instance: non-enumerable and configurable, like a class
 * member, but not on the prototype, so JSRPC does not expose it (workerd never
 * exposes an `RpcTarget`'s instance properties, as with `env`). Skipped when a
 * subclass already has a member of that name, which then stays what callers reach.
 *
 * @param {object} target - The instance.
 * @param {string} name - The member name.
 * @param {PropertyDescriptor} descriptor - A `value` or a `get`.
 */
function defineInstanceMember(target: object, name: string, descriptor: PropertyDescriptor): void {
  // A member the subclass already declares wins: withLogging's session relies on this
  // when an entrypoint has its own `traced` or `logger` method.
  if (name in target) return
  Object.defineProperty(target, name, { ...descriptor, enumerable: false, configurable: true })
}

/**
 * Base class for Traced Sessions.
 *
 * JSRPC exposes only the methods and getters your subclass declares. The Trace
 * Carrier, Context Fields and Root Logger are `#private`, and `traced`, `logger` and `env` are
 * instance properties, which JSRPC never exposes: a caller holding a session stub
 * cannot call `traced` or read `logger` or `env`.
 * Subclass this with your RPC methods and wrap them with `this.traced()`.
 *
 * @template E - The worker environment type.
 *
 * @example
 * ```ts
 * class MySession extends TracedSession<Env> {
 *   async add(a: number, b: number) {
 *     return this.traced(() => {
 *       this.logger.info({ a, b }, 'adding')
 *       return a + b
 *     }, 'math.add')
 *   }
 * }
 *
 * export default tracedWorker(MySession)
 * ```
 */
export class TracedSession<E = unknown> extends RpcTarget {
  #init: SessionInit
  #rootLogger: Logger
  /** Worker env instance property, never exposed over RPC. */
  protected env: E

  /**
   * Run a function in a Logging Context continuing the caller's trace.
   *
   * Each call gets its own span ID whose parent is the caller's span. When
   * `operation` is provided, the call is reported as a Span (`span.end` with
   * timing and status) if the trace is sampled; for an unsampled trace a throw is
   * still logged, as one `<operation> failed` line at `ERROR`. `options` (`level`,
   * `slowMs`, `fields`) and `span.set()` work as for `withSpan()`; without
   * `operation` there is no Span, so both are ignored. The return value and a throw or
   * rejection pass through unchanged.
   *
   * An instance property, so JSRPC never exposes it; call it as `this.traced(fn, op)`.
   *
   * @template R - The return type of `fn`.
   * @param {(span: Span) => R} fn - The function to execute inside the Logging Context. Gets the Span's handle.
   * @param {string} [operation] - Span operation name (e.g. `'bind.add'`).
   * @param {SpanOptions} [options] - The Span's `level`, `slowMs` and `fields`.
   * @returns {R} The return value of `fn`.
   */
  declare protected readonly traced: <R>(
    fn: (span: Span) => R,
    operation?: string,
    options?: SpanOptions,
  ) => R

  /**
   * The current Logging Context's logger inside `this.traced()`, otherwise the
   * Root Logger. An instance property, so JSRPC never exposes it.
   */
  declare protected readonly logger: Logger

  /**
   * @param {SessionInit} init - The caller's Trace Carrier and Context Fields.
   * @param {Logger} rootLogger - The isolate's Root Logger (`this[TracedEntrypoint.rootLogger]` in a `TracedEntrypoint`).
   * @param {E} env - The worker environment bindings.
   */
  constructor(init: SessionInit, rootLogger: Logger, env: E) {
    super()
    this.#init = { ...init }
    this.#rootLogger = rootLogger
    this.env = env
    defineInstanceMember(this, 'traced', {
      value: <R>(fn: (span: Span) => R, operation?: string, options?: SpanOptions): R =>
        this.#traced(fn, operation, options),
      writable: true,
    })
    defineInstanceMember(this, 'logger', {
      get: (): Logger => (getTraceContext() ? getLogger() : this.#rootLogger),
    })
  }

  /**
   * `traced()`'s implementation.
   *
   * @template R - The return type of `fn`.
   * @param {(span: Span) => R} fn - The function to execute inside the Logging Context.
   * @param {string} [operation] - Span operation name.
   * @param {SpanOptions} [options] - The Span's options.
   * @returns {R} The return value of `fn`.
   */
  #traced<R>(fn: (span: Span) => R, operation?: string, options?: SpanOptions): R {
    return runLogged(
      {
        logger: this.#rootLogger,
        traceparent: this.#init.traceparent,
        tracestate: this.#init.tracestate,
        fields: this.#init.fields,
      },
      fn,
      operation,
      true,
      options,
    )
  }

  static {
    runTraced = (session, fn, operation) => session.#traced(fn, operation)
  }
}

/**
 * The keys of TracedEntrypoint's hooks, public as its statics (`TracedEntrypoint.envMapping`, ...).
 * Symbols, so the hooks are not RPC members: JSRPC exposes an entrypoint's string-keyed
 * methods and getters, never its symbol-keyed ones, and never its constructor's statics.
 */
const ENV_MAPPING: unique symbol = Symbol('loggercf.envMapping')
const LOGGER_OPTIONS: unique symbol = Symbol('loggercf.loggerOptions')
const ROOT_LOGGER: unique symbol = Symbol('loggercf.rootLogger')

/**
 * Base class for RPC worker entrypoints that build Traced Sessions by hand.
 *
 * Reads `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION` from env by default. Its three
 * hooks are getters keyed by symbols, `TracedEntrypoint.envMapping`,
 * `TracedEntrypoint.loggerOptions` and `TracedEntrypoint.rootLogger` (as
 * `Symbol.iterator` keys an iterator): override `[TracedEntrypoint.envMapping]` to read
 * other vars or derive fields, `[TracedEntrypoint.loggerOptions]` to build Logger Options
 * yourself, or `[TracedEntrypoint.rootLogger]` to supply the Root Logger, and read
 * `this[TracedEntrypoint.rootLogger]` to hand it to a Traced Session. A caller holding a
 * service binding cannot reach them: JSRPC exposes only the string-keyed methods and
 * getters your subclass declares.
 *
 * The constructor registers the Root Logger hook's value as the Default Logger unless one
 * is already set (first seen wins), so `getLogger()` in `scheduled()`, `queue()` or a
 * plain RPC method logs with its `service`. The first instance in an isolate reads it
 * before subclass fields are initialized: build hook overrides from `this.env`, not from
 * instance fields, and not from `this.ctx.props` (which differ per caller). A Worker that
 * exports several entrypoints with different services should register its default
 * explicitly at module scope (`defaultLoggerFromEnv()` or `setDefaultLogger()`), because
 * otherwise whichever class is constructed first in an isolate wins.
 *
 * @template E - The worker environment type.
 *
 * @example
 * ```ts
 * export default class extends TracedEntrypoint<Env> {
 *   protected override get [TracedEntrypoint.envMapping](): EnvMapping<Env> {
 *     return { version: (env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id }
 *   }
 *
 *   session(init: SessionInit) {
 *     return new MySession(init, this[TracedEntrypoint.rootLogger], this.env)
 *   }
 * }
 * ```
 */
export class TracedEntrypoint<E = unknown> extends WorkerEntrypoint<E> {
  /** The key of the Env Mapping hook: where the Logger Options hook reads each field from. */
  static readonly envMapping: typeof ENV_MAPPING = ENV_MAPPING
  /** The key of the Logger Options hook: the Logger Options the Root Logger is built from. */
  static readonly loggerOptions: typeof LOGGER_OPTIONS = LOGGER_OPTIONS
  /** The key of the Root Logger hook: the isolate's Root Logger. */
  static readonly rootLogger: typeof ROOT_LOGGER = ROOT_LOGGER

  // Type-only guards (`declare` emits nothing, so the RPC surface stays empty): a subclass
  // that still declares a hook under its old string name, `override` or not, fails to
  // compile instead of being silently ignored and exposed over RPC.
  /** Not a hook: override `[TracedEntrypoint.envMapping]` instead. */
  declare protected readonly envMapping?: never
  /** Not a hook: override `[TracedEntrypoint.loggerOptions]` instead. */
  declare protected readonly loggerOptions?: never
  /** Not a hook: override `[TracedEntrypoint.rootLogger]` instead. */
  declare protected readonly rootLogger?: never

  /**
   * @param {ExecutionContext} ctx - The execution context.
   * @param {E} env - The worker environment bindings.
   */
  constructor(ctx: ExecutionContext, env: E) {
    super(ctx, env)
    registerRootLogger(() => this[ROOT_LOGGER])
  }

  /**
   * Where the Logger Options hook reads each field from. Default: no overrides.
   *
   * @returns {EnvMapping<E>} The per-field var name or derive function.
   */
  protected get [ENV_MAPPING](): EnvMapping<E> {
    return {}
  }

  /**
   * Logger Options from env through the Env Mapping hook (see `loggerOptionsFromEnv`).
   *
   * @returns {LoggerOptions} The Logger Options.
   */
  protected get [LOGGER_OPTIONS](): LoggerOptions {
    return loggerOptionsFromEnv(this.env, this[ENV_MAPPING])
  }

  /**
   * The isolate's Root Logger for the Logger Options hook, created once and shared.
   *
   * @returns {Logger} The Root Logger.
   */
  protected get [ROOT_LOGGER](): Logger {
    return cachedRootLogger(this[LOGGER_OPTIONS])
  }
}

/**
 * Options for `tracedWorker()`.
 *
 * @template E - The worker environment type.
 */
export type TracedWorkerOptions<E = unknown> = RootLoggerSource<E>

/**
 * The env type of a `TracedSession` subclass.
 *
 * @template S - The `TracedSession` subclass.
 */
type SessionEnv<S> = S extends TracedSession<infer E> ? E : unknown

/**
 * Create a `WorkerEntrypoint` class that auto-implements `session()` for
 * the given `TracedSession` subclass. Zero boilerplate.
 *
 * Reads `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION` from env by default;
 * pass `options.env` to read other vars or derive fields.
 *
 * @template S - The `TracedSession` subclass.
 * @param {new (...args: any[]) => S} SessionClass - The session class to wrap.
 * @param {TracedWorkerOptions<SessionEnv<S>>} [options] - `env`: the Env Mapping for the Root Logger.
 * @returns A `WorkerEntrypoint` class with `session()` and `fetch()` implemented.
 *
 * @example
 * ```ts
 * class BindSession extends TracedSession<Env> {
 *   async add(a: number, b: number) {
 *     return this.traced(() => a + b, 'bind.add')
 *   }
 * }
 *
 * // Zero-config entrypoint:
 * export default tracedWorker(BindSession)
 *
 * // Read the version from a `version_metadata` binding:
 * export default tracedWorker(BindSession, {
 *   env: { version: (env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id },
 * })
 *
 * // Or extend if you need scheduled(), etc.:
 * export default class extends tracedWorker(BindSession) {
 *   scheduled() { /* ... *\/ }
 * }
 * ```
 */
export function tracedWorker<S extends TracedSession>(
  SessionClass: new (init: SessionInit, rootLogger: Logger, env: any) => S,
  options: TracedWorkerOptions<SessionEnv<S>> = {},
): {
  new (...args: any[]): {
    session(init: SessionInit): S
    // Declared with the request, as `WorkerEntrypoint#fetch` is, so a subclass can take it.
    fetch(request: Request): Response | Promise<Response>
  }
} {
  const mapping: EnvMapping<SessionEnv<S>> = options.env ?? {}
  const { serializeError } = options
  return class extends TracedEntrypoint<SessionEnv<S>> {
    /** The closed-over mapping, behind the symbol-keyed hook: not an RPC member. */
    protected override get [ENV_MAPPING](): EnvMapping<SessionEnv<S>> {
      return mapping
    }

    /** The options from env, with the closed-over `serializeError`. */
    protected override get [LOGGER_OPTIONS](): LoggerOptions {
      return withSerializer(super[LOGGER_OPTIONS], serializeError)
    }

    /**
     * Cloudflare Workers entrypoints must include a `fetch` method.
     *
     * @returns {Response | Promise<Response>} A 404 response.
     */
    fetch(): Response | Promise<Response> {
      return new Response(null, { status: 404 })
    }

    session(init: SessionInit): S {
      return new SessionClass(init ?? {}, this[ROOT_LOGGER], this.env)
    }
  } as any
}

/**
 * Create a traced session from a service binding.
 *
 * Passes the current Trace Carrier (and `fields`) to `binding.session()`. Outside a
 * Logging Context the carrier is empty and the receiver starts a new root trace.
 *
 * @template T - The session type returned by `binding.session()`.
 * @param {object} binding - The service binding with a `session()` method.
 * @param {LogFields} [fields] - Optional log fields to forward to the session.
 * @returns {T} A traced session stub.
 *
 * @example
 * ```ts
 * const session = tracedSession(c.env.BIND)
 * const result = await session.add(5, 7)
 *
 * // With `using` for auto-disposal:
 * using session = tracedSession(c.env.BIND)
 * const result = await session.add(5, 7)
 * ```
 */
export function tracedSession<T>(binding: TracedServiceBinding<T>, fields?: LogFields): T {
  return binding.session({ ...getTraceCarrier(), ...(fields ? { fields } : {}) })
}

/**
 * Create a traced session, run the callback, and return the result.
 *
 * @template T - The session type returned by `binding.session()`.
 * @template R - The return type of `fn`.
 * @param {object} binding - The service binding with a `session()` method.
 * @param {(session: T) => Promise<R> | R} fn - Callback that receives the traced session.
 * @param {LogFields} [fields] - Optional log fields to forward to the session.
 * @returns {Promise<R>} The result of `fn`.
 *
 * @example
 * ```ts
 * const result = await withTrace(c.env.BIND, s => s.add(5, 7))
 *
 * // With propagated fields:
 * const result = await withTrace(c.env.BIND, s => s.add(5, 7), { requestId: 'abc' })
 * ```
 */
export async function withTrace<T, R>(
  binding: TracedServiceBinding<T>,
  fn: (session: T) => Promise<R> | R,
  fields?: LogFields,
): Promise<R> {
  const session = tracedSession(binding, fields)
  return fn(session)
}

/**
 * Options for `withLogging()`.
 *
 * @template E - The worker environment type.
 */
export interface WithLoggingOptions<E = unknown> extends RootLoggerSource<E> {
  /**
   * Record each call as a Span: one `span.end` with duration and status, at `ERROR`
   * (with `err`) when the method throws or rejects. Default `false`: no `span.end`,
   * but a call that throws or rejects still writes one `<Class>.<method> failed` line
   * at `ERROR` with `err`.
   */
  spans?: boolean
  /**
   * Add `session(init)`, which returns a Traced Session over the same methods, so
   * callers that use `tracedSession()` / `withTrace()` continue their trace.
   * Default `false`: the entrypoint exposes exactly the methods it already has.
   */
  session?: boolean
  /**
   * Wrap `fetch` too, so each request runs in its own Logging Context that continues
   * an incoming `traceparent` header. Default `true`. Set `false` when `fetch` hands
   * the request to a Hono app that uses `useLogger`: `useLogger` opens its own
   * Logging Context and continues `traceparent` itself, and a second one around it
   * would split the request into two root traces. With `false`, `fetch` is inherited
   * unchanged.
   */
  fetch?: boolean
}

/** A `WorkerEntrypoint` subclass, as `withLogging()` accepts it. */
type EntrypointClass = new (ctx: ExecutionContext<any>, env: any) => WorkerEntrypoint<any, any>

/** A `DurableObject` subclass, as `withLogging()` accepts it. */
type DurableObjectSubclass = new (ctx: DurableObjectState<any>, env: any) => DurableObject<any, any>

/**
 * The env type of an entrypoint class, read from its constructor.
 *
 * @template C - The entrypoint class.
 */
type EntrypointEnv<C> = C extends new (ctx: any, env: infer E) => any ? E : unknown

/** Event handlers, which JSRPC never calls by name. */
const HANDLERS = [
  'fetch',
  'connect',
  'email',
  'queue',
  'scheduled',
  'tail',
  'tailStream',
  'test',
  'trace',
] as const

type HandlerName = (typeof HANDLERS)[number]

/**
 * A Durable Object's event handlers, which JSRPC never calls by name. All but
 * `connect` are wrapped: each is one unit of work on the object.
 */
const DURABLE_OBJECT_HANDLERS = [
  'fetch',
  'connect',
  'alarm',
  'webSocketMessage',
  'webSocketClose',
  'webSocketError',
] as const

/**
 * What `withLogging()` does for one kind of class: a `WorkerEntrypoint` or a
 * `DurableObject`.
 */
interface ClassKind {
  /** The runtime base class's prototype, where the method walk stops. */
  base: object
  /** Event handlers, which JSRPC never calls by name, so they are not RPC methods. */
  handlers: readonly string[]
  /** The handlers wrapped as a unit of work each, besides `fetch` (which has its own option). */
  wrappedHandlers: readonly string[]
  /** The Context Field naming the class. */
  classField: 'entrypoint' | 'durableObject'
  /** Whether `session: true` is allowed: a Durable Object gets no extra RPC method. */
  allowsSession: boolean
  /** The Context Fields of one instance, read from its constructor's `ctx`. */
  instanceFields?: (ctx: unknown) => LogFields
}

/** A `WorkerEntrypoint`: its handlers are inherited unchanged. */
const ENTRYPOINT_KIND: ClassKind = {
  base: WorkerEntrypoint.prototype,
  handlers: HANDLERS,
  wrappedHandlers: [],
  classField: 'entrypoint',
  allowsSession: true,
}

/** A `DurableObject`: every handler but `connect` is a unit of work on the object. */
const DURABLE_OBJECT_KIND: ClassKind = {
  base: DurableObject.prototype,
  handlers: DURABLE_OBJECT_HANDLERS,
  wrappedHandlers: DURABLE_OBJECT_HANDLERS.filter((name) => name !== 'fetch' && name !== 'connect'),
  classField: 'durableObject',
  allowsSession: false,
  instanceFields: (ctx) => objectFieldsOf(ctx as DurableObjectState),
}

/**
 * The kind of class `withLogging()` was given.
 *
 * @param {Function} Class - The class.
 * @returns {ClassKind | undefined} Its kind, or `undefined` for any other class.
 */
function kindOf(Class: Function): ClassKind | undefined {
  if (Class.prototype instanceof DurableObject) return DURABLE_OBJECT_KIND
  if (Class.prototype instanceof WorkerEntrypoint) return ENTRYPOINT_KIND
  return undefined
}

/**
 * The Context Fields naming one Durable Object: always `objectId`, and `objectName`
 * too when its ID has a name (`idFromName` / `getByName`).
 *
 * @param {DurableObjectState | undefined} state - The object's `ctx`.
 * @returns {LogFields} The fields, empty when the state has no ID.
 */
function objectFieldsOf(state: DurableObjectState | undefined): LogFields {
  const id = state?.id
  if (!id) return {}
  return { objectId: id.toString(), ...(id.name ? { objectName: id.name } : {}) }
}

/**
 * The RPC methods of an entrypoint instance: its public methods minus the event handlers.
 *
 * @template T - The entrypoint instance type.
 */
type RpcMethodsOf<T> = {
  [
    K in keyof T as K extends HandlerName ? never : T[K] extends (...args: any[]) => any ? K : never
  ]: T[K]
}

/**
 * The classes `withLogging()` returned, with the options each was made with. Kept
 * here, not on the class, so the class carries no extra property.
 */
const loggedClasses = new WeakMap<object, WithLoggingOptions<any>>()

/**
 * Whether two `withLogging()` options produce the same wrapping: the same `spans` and
 * `session` (default `false`), the same `fetch` (default `true`), and Env Mappings
 * with the same keys and values (a derive function compares by identity), and the
 * same `serializeError` function (see `sameRootLoggerSource()`).
 *
 * @param {WithLoggingOptions} a - One set of options.
 * @param {WithLoggingOptions} b - The other.
 * @returns {boolean} `true` when they are the same.
 */
function sameOptions(a: WithLoggingOptions<any>, b: WithLoggingOptions<any>): boolean {
  return (
    !!a.spans === !!b.spans &&
    !!a.session === !!b.session &&
    (a.fetch ?? true) === (b.fetch ?? true) &&
    sameRootLoggerSource(a, b)
  )
}

/**
 * Open a Logging Context around every public method of a plain `WorkerEntrypoint`
 * or a `DurableObject`, with no caller changes.
 *
 * Each RPC method call, and `fetch`, runs in its own Logging Context from the
 * isolate's Root Logger, built with `loggerOptionsFromEnv(this.env, options.env)` and
 * cached like `TracedEntrypoint`'s. When `Class` is a `TracedEntrypoint` subclass,
 * its own Root Logger hook (from its Env Mapping / Logger Options hooks) is used instead,
 * and passing `options.env` throws. A plain RPC call carries no Trace Carrier, so each
 * one starts a new root trace; `fetch` continues the request's `traceparent` header
 * when there is one. `fetch: false` leaves `fetch` unwrapped: use it when `fetch`
 * hands the request to a Hono app that uses `useLogger`, which opens its own Logging
 * Context and continues `traceparent` itself. Every line carries the Context Fields
 * `rpcMethod` (the method name) and `entrypoint` (the class name; left off for an
 * anonymous class). A method called while any Logging Context is active (one public
 * method calling another, or a call inside your own `runWithLogger`) joins that
 * context, as a child Span when `spans` is on, and adds no `rpcMethod` or
 * `entrypoint` of its own.
 *
 * A call that throws or rejects is always logged at `ERROR` with `err`, then rethrown
 * unchanged: with `spans`, as its `span.end` line; without, as one
 * `<Class>.<method> failed` line with `err` and a `span` object without timing, written by the call that
 * opened the Logging Context (a nested call leaves it to that one, so the error is
 * logged once). For an unsampled trace, `spans` writes only that `failed` line too.
 *
 * The methods are wrapped, never changed: arguments, return values (sync or async,
 * an `RpcTarget` or a stub included) and thrown errors pass through as they are.
 * The returned class has the same RPC methods as `Class`; `scheduled`, `queue`,
 * `tail` and the other handlers are inherited unchanged. Its constructor registers
 * the Root Logger as the Default Logger unless one is already set (first seen
 * wins), so `getLogger()` in those handlers logs with `service` too. Getters, and
 * the body of an `async *` method (which runs on each `.next()`), run outside the
 * Logging Context. Methods named like a handler (`trace`, `test`, `email`, `connect`,
 * `queue`, `tail`, `tailStream`) are never wrapped.
 *
 * Only the methods `Class` has when it is wrapped are wrapped. A method added or
 * overridden in a subclass of the returned class runs outside every Logging Context,
 * so put every RPC method on `Class` and extend the result only to add handlers.
 *
 * `session: true` adds `session(init)` for gradual migration: callers that move to
 * `tracedSession()` / `withTrace()` continue their trace, while the rest keep
 * calling the methods directly.
 *
 * Wrapping a class `withLogging()` returned gives back that class when the options
 * are the same, and throws when they differ. Wrapping a subclass of one throws, and
 * so does wrapping a class that extends neither `WorkerEntrypoint` nor `DurableObject`.
 *
 * **Durable Objects.** For a `DurableObject` subclass, `fetch`, every RPC method,
 * `alarm`, `webSocketMessage`, `webSocketClose` and `webSocketError` each run in their
 * own Logging Context (`fetch` continuing a `traceparent` header, the rest starting
 * a new root trace), with the Context Fields `rpcMethod` (the method or handler
 * name), `durableObject` (the class name; left off for an anonymous class),
 * `objectId` (`ctx.id.toString()`, always), and `objectName` (`ctx.id.name`) too for
 * an object reached by name. `connect` is inherited unchanged. `session` is not
 * available: the object gets no extra RPC method. `spans`, `fetch` and `env` work as
 * for an entrypoint.
 *
 * @template C - The entrypoint or Durable Object class.
 * @param {C} Class - A `WorkerEntrypoint` or `DurableObject` subclass.
 * @param {WithLoggingOptions} [options] - `spans`, `session`, `fetch`, and the `env` mapping.
 * @returns A subclass of `Class` whose public methods run in a Logging Context.
 *
 * @example
 * ```ts
 * class SearchWorker extends WorkerEntrypoint<Env> {
 *   async search(q: string) {
 *     getLogger().info({ q }, 'searching') // service, traceId, spanId, rpcMethod, entrypoint
 *   }
 * }
 *
 * export default withLogging(SearchWorker, { spans: true, session: true })
 *
 * class RoomObject extends DurableObject<Env> {
 *   async join(user: string) {
 *     getLogger().info({ user }, 'joined') // ..., rpcMethod, durableObject, objectId, objectName
 *   }
 * }
 *
 * export const Room = withLogging(RoomObject)
 * ```
 */
export function withLogging<C extends EntrypointClass>(
  Class: C,
  options: WithLoggingOptions<EntrypointEnv<C>> & { session: true },
): (new (...args: ConstructorParameters<C>) => InstanceType<C> & {
  session(init: SessionInit): TracedSession<EntrypointEnv<C>> & RpcMethodsOf<InstanceType<C>>
}) &
  C
export function withLogging<C extends EntrypointClass>(
  Class: C,
  options?: WithLoggingOptions<EntrypointEnv<C>>,
): C
export function withLogging<C extends DurableObjectSubclass>(
  Class: C,
  options?: Omit<WithLoggingOptions<EntrypointEnv<C>>, 'session'>,
): C
export function withLogging<C extends EntrypointClass | DurableObjectSubclass>(
  Class: C,
  options: WithLoggingOptions<EntrypointEnv<C>> = {},
): C {
  const {
    spans = false,
    session = false,
    fetch: wrapFetch = true,
    env: mapping,
    serializeError,
  } = options
  const entrypoint = Class.name
  const where = `withLogging(${entrypoint})`

  const kind = kindOf(Class)
  if (!kind) {
    throw new TypeError(
      `${where}: ${entrypoint || 'the class'} does not extend WorkerEntrypoint or DurableObject`,
    )
  }
  if (session && !kind.allowsSession) {
    throw new TypeError(
      `${where}: ${entrypoint} is a Durable Object; session() is only for WorkerEntrypoint classes`,
    )
  }

  if (alreadyWrapped(Class, loggedClasses, (previous) => sameOptions(previous, options), where)) {
    return Class
  }
  if (session && 'session' in Class.prototype) {
    throw new TypeError(`${where}: ${entrypoint} already defines session()`)
  }
  const isTracedEntrypoint = Class.prototype instanceof TracedEntrypoint
  if (isTracedEntrypoint && mapping) {
    throw new TypeError(
      `${where}: ${entrypoint} is a TracedEntrypoint; override its [TracedEntrypoint.envMapping] getter instead of passing env`,
    )
  }
  if (isTracedEntrypoint && serializeError) {
    throw new TypeError(
      `${where}: ${entrypoint} is a TracedEntrypoint; override its [TracedEntrypoint.loggerOptions] getter instead of passing serializeError`,
    )
  }

  const source: RootLoggerSource<any> = { env: mapping, serializeError }

  /**
   * The Root Logger for one wrapped instance (an entrypoint or a Durable Object): its own
   * Root Logger hook for a `TracedEntrypoint`, otherwise the cached one for its env and the
   * Env Mapping.
   *
   * @param {object} target - The wrapped instance.
   * @returns {Logger} The Root Logger.
   */
  const instanceRootLogger = (target: object): Logger =>
    isTracedEntrypoint
      ? (target as unknown as { [ROOT_LOGGER]: Logger })[ROOT_LOGGER]
      : envRootLogger((target as { env: unknown }).env, source)

  /** Each instance's own Context Fields (a Durable Object's `objectId`), read in its constructor. */
  const instanceFields = new WeakMap<object, LogFields>()

  /**
   * The Context Fields of one call: `rpcMethod`, the class name as `entrypoint` or
   * `durableObject` (left off for an anonymous class), and the instance's own fields
   * (`objectId`, `objectName`).
   *
   * @param {string} name - The method name.
   * @param {object} [target] - The instance the method is called on.
   * @returns {LogFields} The Context Fields.
   */
  const fieldsOf = (name: string, target?: object): LogFields => ({
    rpcMethod: name,
    ...(entrypoint ? { [kind.classField]: entrypoint } : {}),
    ...(target ? instanceFields.get(target) : {}),
  })

  /**
   * The operation name of one call, `<Class>.<method>` (the bare method name for an
   * anonymous class): the Span's name with `spans`, and the `<operation> failed`
   * line's without.
   *
   * @param {string} name - The method name.
   * @returns {string} The operation name.
   */
  const operationOf = (name: string): string => (entrypoint ? `${entrypoint}.${name}` : name)

  const readInstanceFields = kind.instanceFields
  const Logged = class extends (Class as EntrypointClass) {
    constructor(ctx: ExecutionContext, env: unknown) {
      super(ctx, env)
      if (readInstanceFields) instanceFields.set(this, readInstanceFields(ctx))
      registerRootLogger(() => instanceRootLogger(this))
    }
  }
  Object.defineProperty(Logged, 'name', { value: entrypoint, configurable: true })

  /**
   * Wrap one method of an entrypoint or Durable Object: a new Logging Context, or a child
   * Span of the current one.
   *
   * @param {string} name - The method name.
   * @param {Method} method - The class's implementation.
   * @param {(args: unknown[]) => TraceCarrier} [carrierOf] - Reads a Trace Carrier from the call's arguments.
   * @returns {Method} The wrapped method.
   */
  const wrap = (name: string, method: Method, carrierOf?: (args: unknown[]) => TraceCarrier) =>
    function (this: object, ...args: unknown[]) {
      const run = () => method.apply(this, args)
      const operation = operationOf(name)
      // Joining a context: a child Span with `spans`; without, the call that opened
      // the context logs a throw, so it is logged once.
      if (getTraceContext()) return spans ? withSpan(operation, run) : run()
      // Without `spans`, no span.end, but a throw is still logged at ERROR.
      return runLogged(
        { logger: instanceRootLogger(this), ...carrierOf?.(args), fields: fieldsOf(name, this) },
        run,
        operation,
        spans,
      )
    }

  const methods = prototypeMethods(Class, kind.base)
  const rpcMethods = [...methods].filter(([name]) => !kind.handlers.includes(name))
  for (const [name, method] of rpcMethods) defineMethod(Logged.prototype, name, wrap(name, method))
  // A Durable Object's alarm and WebSocket handlers are each a unit of work on the object.
  for (const name of kind.wrappedHandlers) {
    const handler = methods.get(name)
    if (handler) defineMethod(Logged.prototype, name, wrap(name, handler))
  }
  // `fetch` is wrapped with its request as a Trace Carrier.
  const fetch = wrapFetch ? methods.get('fetch') : undefined
  if (fetch) {
    defineMethod(
      Logged.prototype,
      'fetch',
      wrap('fetch', fetch, (args) =>
        extractCarrier((header) => (args[0] as Request | undefined)?.headers?.get(header)),
      ),
    )
  }

  if (session) {
    /** What `session(init)` returns: the same RPC methods, continuing the caller's trace. */
    class LoggedSession extends TracedSession<unknown> {
      #target: object

      constructor(init: SessionInit, rootLogger: Logger, env: unknown, target: object) {
        super(init, rootLogger, env)
        this.#target = target
      }

      static {
        for (const [name, method] of rpcMethods) {
          /**
           * One RPC method on the session: the entrypoint's implementation, called on the
           * entrypoint, inside a Logging Context continuing the caller's trace. A caller
           * field named `rpcMethod` or `entrypoint` is replaced.
           *
           * @param {...unknown} args - The call's arguments, passed through unchanged.
           * @returns {unknown} The method's return value, unchanged.
           */
          const sessionMethod = function (this: LoggedSession, ...args: unknown[]) {
            const target = this.#target
            const operation = operationOf(name)
            const run = () => {
              setLoggerContext(fieldsOf(name))
              return method.apply(target, args)
            }
            // Without `spans`, no span.end, but a throw is still logged at ERROR. Through
            // `runTraced`, so a user method named `traced` on this prototype cannot shadow it.
            return spans
              ? runTraced(this, run, operation)
              : runTraced(this, () => recordSpan(operation, run, false))
          }
          defineMethod(this.prototype, name, sessionMethod)
        }
      }
    }

    /**
     * `session(init)` on the entrypoint: a Traced Session over the same RPC methods.
     *
     * @param {SessionInit} [init] - The caller's Trace Carrier and fields.
     * @returns {LoggedSession} The session.
     */
    const sessionOf = function (this: object, init?: SessionInit) {
      return new LoggedSession(
        init ?? {},
        instanceRootLogger(this),
        (this as { env: unknown }).env,
        this,
      )
    }
    defineMethod(Logged.prototype, 'session', sessionOf)
  }

  loggedClasses.set(Logged, { spans, session, fetch: wrapFetch, env: mapping, serializeError })
  return Logged as unknown as C
}
