// Logging Context helpers for the units of work outside HTTP and RPC: cron runs,
// queue messages and Workflows. Exported from `loggercf/workers`.
//
// None of them owns control flow: they never ack, retry, iterate a batch, catch an
// error or decide anything about the work. Arguments and return values pass through
// unchanged, and a throw is logged and rethrown as it is.

import {
  WorkflowEntrypoint,
  env as workersEnv,
  type WorkflowBackoff,
  type WorkflowDelayDuration,
  type WorkflowDelayFunction,
  type WorkflowStep,
  type WorkflowStepConfig,
  type WorkflowStepContext,
  type WorkflowStepRollbackOptions,
} from 'cloudflare:workers'
import type { LogFields, Logger } from './types'
import { captureLoggingContext, setLoggerContext, withSpan } from './logger'
import {
  alreadyWrapped,
  carrierFromBody,
  defineMethod,
  envRootLogger,
  prototypeMethods,
  registerRootLogger,
  runLogged,
  sameRootLoggerSource,
  type Method,
  type RootLoggerSource,
} from './workers-shared'

/**
 * Options for `withScheduled()`, `withQueueMessage()` and `withWorkflow()`.
 *
 * @template E - The worker environment type.
 */
export type HandlerOptions<E = Cloudflare.Env> = RootLoggerSource<E>

/**
 * The isolate's cached Root Logger for `env` and a helper's options, registered as
 * the Default Logger unless one is already set (first seen wins).
 *
 * @param {unknown} env - The Worker's env.
 * @param {RootLoggerSource<any>} source - The helper's `env` and `serializeError` options.
 * @returns {Logger} The Root Logger.
 */
function registeredEnvRootLogger(env: unknown, source: RootLoggerSource<any>): Logger {
  const logger = envRootLogger(env, source)
  registerRootLogger(() => logger)
  return logger
}

/**
 * Run a `scheduled` (cron) handler in a Logging Context.
 *
 * Each run starts a new root trace, with the Context Fields `cron` and
 * `scheduledTime` (ms since the epoch, as the controller gives it), and is recorded
 * as one Span, `span.end scheduled`: `INFO` with its duration, or `ERROR` with `err`
 * when the handler throws or rejects (a new root trace is always sampled). The Root Logger is built from the handler's
 * `env` through `options.env`, cached per isolate, and registered as the Default
 * Logger unless one is already set (first seen wins).
 *
 * The handler gets the same arguments, its return value is returned as it is, and a
 * throw is rethrown unchanged. The wrapper never calls `controller.noRetry()`.
 *
 * On a class entrypoint, wrap the handler once at module scope and call it from the
 * `scheduled` method with `this.env` and `this.ctx`.
 *
 * @template E - The worker environment type.
 * @template R - The handler's return type.
 * @param {(controller: ScheduledController, env: E, ctx: ExecutionContext) => R} handler - The `scheduled` handler.
 * @param {HandlerOptions<E>} [options] - `env`: the Env Mapping for the Root Logger.
 * @returns A `scheduled` handler with the same signature.
 *
 * @example
 * ```ts
 * export default {
 *   fetch: app.fetch,
 *   scheduled: withScheduled(async (controller, env: Env) => {
 *     getLogger().info('nightly cleanup') // ..., traceId, cron, scheduledTime
 *   }),
 * } satisfies ExportedHandler<Env>
 *
 * // On a class entrypoint:
 * const nightly = withScheduled(async (controller, env: Env) => { ... })
 * export default class extends WorkerEntrypoint<Env> {
 *   scheduled(controller: ScheduledController) {
 *     return nightly(controller, this.env, this.ctx)
 *   }
 * }
 * ```
 */
export function withScheduled<E = Cloudflare.Env, R = void | Promise<void>>(
  handler: (controller: ScheduledController, env: E, ctx: ExecutionContext) => R,
  options: HandlerOptions<E> = {},
): (controller: ScheduledController, env: E, ctx: ExecutionContext) => R {
  const { env: mapping, serializeError } = options
  const source: RootLoggerSource<E> = { env: mapping, serializeError }
  return function scheduled(this: unknown, controller, env, ctx) {
    return runLogged(
      {
        logger: registeredEnvRootLogger(env, source),
        fields: { cron: controller.cron, scheduledTime: controller.scheduledTime },
      },
      () => handler.call(this, controller, env, ctx),
      'scheduled',
    )
  }
}

/**
 * Run the work for one queue message in its own Logging Context. Call it inside
 * your own loop over `batch.messages`: it never iterates the batch, and never calls
 * `ack`, `retry`, `ackAll` or `retryAll`. Your code decides those.
 *
 * The Context Fields are `queue` (from the batch), `messageId` and `attempts`. When
 * the message body carries a Trace Carrier under `trace` (the producer sent
 * `{ ...payload, trace: getTraceCarrier() }`), the message continues the producer's
 * trace; otherwise it starts a new root trace. The body is never changed. Each call
 * is recorded as one Span, `span.end queue.message`: `INFO` with its duration, or
 * `ERROR` with `err` when `fn` throws or rejects. When the carrier's trace is not
 * sampled (flags `00`), no `span.end` is written, but a throw still writes one
 * `queue.message failed` line at `ERROR` with `err`. `fn`'s return value is returned
 * as it is, and a throw is rethrown unchanged.
 *
 * Await (or return) it from `queue`: the batch is acked implicitly when the handler
 * returns, so a call left unawaited may still be running when it is acked, and its
 * throw is lost. Running the messages concurrently with
 * `Promise.all(batch.messages.map((m) => withQueueMessage(batch, m, ...)))` is safe:
 * each call has its own Logging Context.
 *
 * The Root Logger is built from the Worker's env (read through
 * `import { env } from 'cloudflare:workers'`, as `defaultLoggerFromEnv` does) with
 * `options.env`, cached per isolate, and registered as the Default Logger unless one
 * is already set (first seen wins).
 *
 * @template R - The return type of `fn`.
 * @template E - The worker environment type.
 * @param {Pick<MessageBatch, 'queue'>} batch - The batch the message came in.
 * @param {Pick<Message, 'id' | 'attempts' | 'body'>} message - The message.
 * @param {() => R} fn - The work for this message.
 * @param {HandlerOptions<E>} [options] - `env`: the Env Mapping for the Root Logger.
 * @returns {R} The return value of `fn`, unchanged.
 *
 * @example
 * ```ts
 * // Producer, inside a Logging Context:
 * await env.ORDERS.send({ ...order, trace: getTraceCarrier() })
 *
 * // Consumer:
 * export default {
 *   async queue(batch, env) {
 *     for (const message of batch.messages) {
 *       await withQueueMessage(batch, message, async () => {
 *         getLogger().info('processing') // ..., traceId, queue, messageId, attempts
 *         message.ack()
 *       })
 *     }
 *   },
 * } satisfies ExportedHandler<Env, Order>
 * ```
 */
export function withQueueMessage<R, E = Cloudflare.Env>(
  batch: Pick<MessageBatch, 'queue'>,
  message: Pick<Message, 'id' | 'attempts' | 'body'>,
  fn: () => R,
  options: HandlerOptions<E> = {},
): R {
  return runLogged(
    {
      logger: registeredEnvRootLogger(workersEnv, options),
      ...carrierFromBody(message.body),
      fields: { queue: batch.queue, messageId: message.id, attempts: message.attempts },
    },
    // A closure, so `fn` is called with no arguments, exactly as without the wrapper.
    () => fn(),
    'queue.message',
  )
}

/** A `WorkflowEntrypoint` subclass, as `withWorkflow()` accepts it. */
type WorkflowClass = new (ctx: ExecutionContext<any>, env: any) => WorkflowEntrypoint<any, any>

/**
 * The env type of a class, read from its constructor.
 *
 * @template C - The class.
 */
type ClassEnv<C> = C extends new (ctx: any, env: infer E) => any ? E : unknown

/** The classes `withWorkflow()` returned, with the options each was made with. */
const workflowClasses = new WeakMap<object, RootLoggerSource<any>>()

/**
 * Run a Workflow's `run(event, step)` in a Logging Context, with the Context Field
 * `workflowInstanceId`.
 *
 * When the payload carries a Trace Carrier under `trace` (the creator called
 * `env.WORKFLOW.create({ params: { ...params, trace: getTraceCarrier() } })`), every
 * execution of `run` continues that trace, so its replays share one `traceId`;
 * otherwise each execution starts a new root trace. The Root Logger is built from
 * the Workflow's env through `options.env`, cached per isolate, and registered as
 * the Default Logger in the constructor unless one is already set (first seen wins).
 *
 * `run` itself is not recorded as a Span, and a rejection of `run` is not logged:
 * the engine replays it from the top after every sleep, wait or restart, and uses
 * thrown errors for its own control flow (a pause or termination surfaces in it as a
 * throw, and no documented marker tells those apart from your errors), so one "run"
 * Span or an `ERROR` line on rejection would misreport. A throw outside every
 * `tracedStep()` (validation before the first step, code between steps, a plain
 * `step.do`) is therefore not logged by `withWorkflow`; it shows as the instance's
 * error in the Workflows dashboard. Put each unit of work in a `tracedStep()`, for one
 * Span per attempt, `ERROR` on a throw.
 *
 * Without `payload.trace`, each execution of `run` starts its own root trace, so the
 * replays of one instance have different `traceId`s; join them on
 * `workflowInstanceId`, or pass `trace: getTraceCarrier()` in the params for one
 * trace.
 *
 * Nothing about the Workflow changes: no step is added, the event, `step` and the
 * return value pass through as they are, and a throw is rethrown unchanged. `run`
 * must be a method on the class (not a class field), and the returned class should
 * be the one exported. Wrapping the result again with the same `env` and
 * `serializeError` returns it; other options, or a subclass of it, throw.
 *
 * @template C - The Workflow class.
 * @param {C} Class - A `WorkflowEntrypoint` subclass.
 * @param {HandlerOptions} [options] - `env`: the Env Mapping for the Root Logger; `serializeError`: its `serializeError`.
 * @returns A subclass of `Class` whose `run` runs in a Logging Context.
 *
 * @example
 * ```ts
 * class ReportWorkflow extends WorkflowEntrypoint<Env, Params> {
 *   async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
 *     const rows = await tracedStep(step, 'fetch rows', async () => fetchRows())
 *     getLogger().info({ rows: rows.length }, 'fetched') // ..., workflowInstanceId
 *   }
 * }
 *
 * export const Report = withWorkflow(ReportWorkflow)
 * ```
 */
export function withWorkflow<C extends WorkflowClass>(
  Class: C,
  options: HandlerOptions<ClassEnv<C>> = {},
): C {
  const name = Class.name
  const where = `withWorkflow(${name})`

  if (!(Class.prototype instanceof WorkflowEntrypoint)) {
    throw new TypeError(`${where}: ${name || 'the class'} does not extend WorkflowEntrypoint`)
  }
  const same = (previous: RootLoggerSource<any>) => sameRootLoggerSource(previous, options)
  if (alreadyWrapped(Class, workflowClasses, same, where)) {
    return Class
  }
  const run = prototypeMethods(Class, WorkflowEntrypoint.prototype).get('run')
  if (!run) {
    throw new TypeError(
      `${where}: ${name} has no run() method; define run as a method, not a field`,
    )
  }

  const { env: mapping, serializeError } = options
  const source: RootLoggerSource<any> = { env: mapping, serializeError }
  /** The Root Logger for one Workflow instance, from its env. */
  const instanceRootLogger = (target: object) =>
    envRootLogger((target as { env: unknown }).env, source)

  const Logged = class extends (Class as WorkflowClass) {
    constructor(ctx: ExecutionContext, env: unknown) {
      super(ctx, env)
      registerRootLogger(() => instanceRootLogger(this))
    }
  }
  Object.defineProperty(Logged, 'name', { value: name, configurable: true })

  /**
   * `run` in a Logging Context: the class's implementation, called unchanged.
   *
   * @param {...unknown} args - `event`, `step`, and anything else, passed through.
   * @returns {unknown} The return value of `run`, unchanged.
   */
  const loggedRun = function (this: object, ...args: unknown[]) {
    const event = args[0] as { instanceId?: unknown; payload?: unknown } | undefined
    const fields: LogFields =
      typeof event?.instanceId === 'string' ? { workflowInstanceId: event.instanceId } : {}
    return runLogged(
      { logger: instanceRootLogger(this), ...carrierFromBody(event?.payload), fields },
      () => run.apply(this, args),
    )
  }
  defineMethod(Logged.prototype, 'run', loggedRun)

  workflowClasses.set(Logged, source)
  return Logged as unknown as C
}

/**
 * The Context Fields of one step attempt: `step`, plus `stepCount` (which call of a
 * step with this name it is, 1 for the first) and `attempt` when the engine passes
 * a step context.
 *
 * @param {string} name - The step name.
 * @param {unknown} ctx - The step context `step.do` passed to the callback.
 * @returns {LogFields} The Context Fields.
 */
function stepFields(name: string, ctx: unknown): LogFields {
  const { step, attempt } = (ctx ?? {}) as { step?: { count?: unknown }; attempt?: unknown }
  return {
    step: name,
    ...(typeof step?.count === 'number' ? { stepCount: step.count } : {}),
    ...(typeof attempt === 'number' ? { attempt } : {}),
  }
}

/** `WorkflowStepConfig` with a delay function, as `step.do`'s overloads tell it apart. */
type StepConfigWithDelayFunction = Omit<WorkflowStepConfig, 'retries'> & {
  retries: { limit: number; delay: WorkflowDelayFunction; backoff?: WorkflowBackoff }
}

/** `WorkflowStepConfig` with a fixed delay, as `step.do`'s overloads tell it apart. */
type StepConfigWithStaticDelay = Omit<WorkflowStepConfig, 'retries'> & {
  retries?: { limit: number; delay: WorkflowDelayDuration | number; backoff?: WorkflowBackoff }
}

/**
 * `step.do(name, ...)` with each attempt recorded as a Span, named after the step,
 * with the Context Fields `step`, `stepCount` and `attempt`. Takes the same arguments
 * as `step.do` after `step`, with the same overloads: an optional config, the
 * callback, and optional rollback options.
 *
 * Call it inside `run` of a class wrapped with `withWorkflow()`. The engine calls the
 * callback back over RPC, outside the Logging Context `run` opened; `tracedStep`
 * re-enters it, so lines in the callback carry `workflowInstanceId` and the run's
 * trace too, and the Span's parent is the run's span. A retried attempt writes its
 * own Span: `ERROR` with `err` for an attempt that throws, `INFO` for the one that
 * succeeds. For an unsampled trace only a throw is written, as one `<name> failed`
 * line at `ERROR`. A step whose result the engine already has (on a replay) runs no
 * callback, so it writes nothing. `stepCount` is the engine's `ctx.step.count`, so a
 * step name repeated in a loop can be told apart.
 *
 * The rollback handler re-enters the run's Logging Context the same way, as a Span
 * named `rollback <name>`, with `step`, `stepCount` and `rollback: true`. A
 * function-valued `retries.delay` is not wrapped: it runs outside every Logging
 * Context, so lines it writes carry no trace (keep it a pure computation).
 *
 * Determinism is kept: `step.do` is called once, with the same name, the same config
 * object, and a callback that returns the original's value (or throws its error)
 * unchanged. The rollback options are copied (`rollbackConfig` included, as the same
 * object), never changed, so the handler can be wrapped. No step is added. Outside a
 * Logging Context it calls `step.do` with the arguments untouched.
 *
 * @template T - The step's return type.
 * @param {WorkflowStep} step - The `step` passed to `run`.
 * @param {string} name - The step name, as for `step.do`.
 * @param {WorkflowStepConfig} [config] - The step config, as for `step.do`, passed through unchanged.
 * @param {(ctx: WorkflowStepContext) => Promise<T>} callback - The step's work, as for `step.do`.
 * @param {WorkflowStepRollbackOptions<T>} [rollbackOptions] - The rollback handler and its config, as for `step.do`.
 * @returns {Promise<T>} What `step.do` returns, unchanged.
 *
 * @example
 * ```ts
 * const user = await tracedStep(step, 'load user', async () => db.getUser(id))
 * await tracedStep(step, 'charge', { retries: { limit: 3, delay: '5 seconds' } }, async (ctx) => {
 *   getLogger().info('charging') // ..., workflowInstanceId, step: 'charge', stepCount, attempt
 * })
 * ```
 */
export function tracedStep<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  callback: (ctx: WorkflowStepContext) => Promise<T>,
  rollbackOptions?: WorkflowStepRollbackOptions<T>,
): Promise<T>
// The config overloads mirror `step.do`'s and keep its order: the broad
// `WorkflowStepConfig` one must stay last, or it shadows the narrowing ones.
export function tracedStep<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  config: StepConfigWithDelayFunction,
  callback: (ctx: WorkflowStepContext<WorkflowDelayFunction>) => Promise<T>,
  rollbackOptions?: WorkflowStepRollbackOptions<T, WorkflowDelayFunction>,
): Promise<T>
export function tracedStep<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  config: StepConfigWithStaticDelay,
  callback: (ctx: WorkflowStepContext<WorkflowDelayDuration | number>) => Promise<T>,
  rollbackOptions?: WorkflowStepRollbackOptions<T, WorkflowDelayDuration | number>,
): Promise<T>
export function tracedStep<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  config: WorkflowStepConfig,
  callback: (ctx: WorkflowStepContext) => Promise<T>,
  rollbackOptions?: WorkflowStepRollbackOptions<T>,
): Promise<T>
export function tracedStep(step: WorkflowStep, name: string, ...rest: unknown[]): Promise<unknown> {
  const stepDo = (args: unknown[]) =>
    (step as unknown as { do: (...a: unknown[]) => Promise<unknown> }).do(name, ...args)

  const enter = captureLoggingContext()
  const at = typeof rest[0] === 'function' ? 0 : 1
  const callback = rest[at]
  if (!enter || typeof callback !== 'function') return stepDo(rest)

  const args = [...rest]
  args[at] = (...callbackArgs: unknown[]) =>
    enter(() =>
      withSpan(name, () => {
        setLoggerContext(stepFields(name, callbackArgs[0]))
        return (callback as Method).apply(undefined, callbackArgs)
      }),
    )

  const options = rest[at + 1] as { rollback?: unknown } | undefined
  const rollback = options?.rollback
  if (typeof rollback === 'function') {
    args[at + 1] = {
      ...options,
      rollback: (...rollbackArgs: unknown[]) =>
        enter(() =>
          withSpan(`rollback ${name}`, () => {
            const { ctx } = (rollbackArgs[0] ?? {}) as { ctx?: unknown }
            const { attempt: _attempt, ...fields } = stepFields(name, ctx)
            setLoggerContext({ ...fields, rollback: true })
            return (rollback as Method).apply(undefined, rollbackArgs)
          }),
        ),
    }
  }
  return stepDo(args)
}
