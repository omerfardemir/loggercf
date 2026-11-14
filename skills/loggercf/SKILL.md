---
name: loggercf
description: Rules for logging and tracing with the loggercf package on Cloudflare Workers or Node.js. Use when adding or changing logs, log fields, spans, trace propagation, Hono logging middleware, Worker-to-Worker RPC over service bindings, queue or cron handlers, or the Wrangler vars loggercf reads, in a project that depends on loggercf.
---

# loggercf

loggercf is new and is not pino's API: use only what this file and the package itself show. For signatures and full examples, read `node_modules/loggercf/README.md`; for exact types, read `node_modules/loggercf/dist/*.d.ts`. Where they disagree with this file, they win.

Imports come from exactly three entry points:

- `loggercf`: core, any runtime.
- `loggercf/hono`: `useLogger`.
- `loggercf/workers`: Traced Sessions, `withLogging`, and the cron, queue and Workflow helpers. This imports `cloudflare:workers`, so it is Workers-only.

## Terms

- **Root Logger**: built by `createLogger` once per isolate or process. Carries per-process data only (service, environment, version).
- **Default Logger**: the Root Logger `getLogger()` writes through outside every Logging Context. Without one, those lines say `service: 'unknown'`.
- **Logging Context**: the scope of one unit of work (HTTP request, RPC call, queue message, cron run). Holds one trace, its Context Fields, and the logger every line is written through. Every line logged inside it gets `traceId`, `spanId` and `parentSpanId` automatically.
- **Context Fields**: per-unit-of-work data (`requestId`, `userId`, ...) on every line in a Logging Context.
- **Trace Carrier**: `{ traceparent, tracestate? }`, the wire form of a trace.
- **Span**: a named, timed sub-operation, logged once as `span.end` when the trace is sampled: at its `level` (default `info`), or at `WARN` once it reaches its Slow Threshold `slowMs` (at its `level` instead, when that is more severe). A Span that throws is always logged at `ERROR`: as its `span.end`, or for an unsampled trace as one `<operation> failed` line.
- **Span Fields**: fields that go on one Span's `span.end` line only (`fields` option, `span.set()`), never on other lines or into the Logging Context.
- **Traced Session**: the RPC target a service binding's `session()` returns. Every method on it continues the caller's trace.
- **Protected Fields**: what `limits.maxRecordBytes` keeps whole while anything else on a line can be trimmed: `time`, `level`, `message`, the trace IDs, `service`, `environment`, `version`, `err.type` and `err.message`.

## Pick the API by unit of work

| Situation                                      | Use                                                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP in a Hono app                             | `app.use(useLogger(rootLogger))`                                                                                                                         |
| Receiving Worker-to-Worker RPC                 | `class S extends TracedSession<Env>`, each method body in `this.traced(fn, 'svc.op')`, `tracedWorker(S)`                                                 |
| Plain `WorkerEntrypoint` RPC, not yet migrated | `export default withLogging(C, { spans: true, session: true })`, then move callers to `withTrace` one by one                                             |
| Durable Object                                 | `withLogging(DO, { spans: true })`: `fetch`, RPC methods, `alarm` and `webSocket*` each get a Logging Context; without `spans` only failures are written |
| Calling another Worker over RPC                | `withTrace(env.SVC, (s) => s.op())`, or `tracedSession(env.SVC)` for several calls                                                                       |
| Cron (`scheduled`)                             | `scheduled: withScheduled(async (controller, env) => { ... })`                                                                                           |
| Queue consumer                                 | your own loop over `batch.messages`, each message's work in `withQueueMessage(batch, message, fn)`                                                       |
| Workflow                                       | `withWorkflow(W)` on the `WorkflowEntrypoint` class, each step as `tracedStep(step, 'name', fn)`                                                         |
| Passing a trace over a queue or to a Workflow  | sender puts `trace: getTraceCarrier()` in the body or params; `withQueueMessage` / `withWorkflow` continue it                                            |
| Node job, any other work                       | `runWithLogger({ logger: rootLogger, ...carrier, fields }, fn)`                                                                                          |
| Outbound HTTP                                  | `tracedFetch(url, init)` in place of `fetch`                                                                                                             |
| Calling another Worker over HTTP (binding)     | `tracedFetcher(env.SVC).fetch(request)` in place of `env.SVC.fetch(request)`                                                                             |
| Timing a sub-operation                         | `withSpan('db.getUser', fn)`; on a hot path `withSpan('db.getUser', fn, { level: 'debug', slowMs: 500 })`                                                |
| Logging from code that receives no logger      | `getLogger()`, which returns the Logging Context's logger, or the Default Logger outside one                                                             |
| Code outside every Logging Context             | register a Default Logger: `defaultLoggerFromEnv()` on Workers, `setDefaultLogger(rootLogger)` elsewhere                                                 |

Queue consumer continuing a producer's trace:

```ts
import { getLogger } from 'loggercf'
import type { TraceCarrier } from 'loggercf'
import { withQueueMessage } from 'loggercf/workers'

interface Job {
  orderId: string
  trace: TraceCarrier // producer sent { orderId, trace: getTraceCarrier() }
}

export default {
  async queue(batch) {
    for (const message of batch.messages) {
      await withQueueMessage(batch, message, async () => {
        getLogger().info({ orderId: message.body.orderId }, 'processing order') // queue, messageId, attempts
        message.ack() // the helper never acks or retries: this code decides
      })
    }
  },
} satisfies ExportedHandler<Cloudflare.Env, Job>
```

## Rules

### One Root Logger per isolate

An isolate serves many requests at once. Build the Root Logger once, at module scope or lazily from `env` on first use, and pass that same instance everywhere. `useLogger`'s factory form runs on every request, so it must cache:

```ts
import { Hono } from 'hono'
import { createLogger, loggerOptionsFromEnv, type Logger } from 'loggercf'
import { useLogger } from 'loggercf/hono'

let rootLogger: Logger | undefined
const app = new Hono()
app.use(useLogger((c) => (rootLogger ??= createLogger(loggerOptionsFromEnv(c.env)))))

export default app
```

```ts wrong
app.use(useLogger((c) => createLogger(loggerOptionsFromEnv(c.env)))) // a new Root Logger per request
```

### Register a Default Logger

Module scope, plain `WorkerEntrypoint` RPC methods, `scheduled`, Durable Object methods and shared packages often run outside every Logging Context. Their `getLogger()` lines say `service: 'unknown'` unless the isolate has a Default Logger. On Workers, build the Root Logger with `defaultLoggerFromEnv()` from `loggercf/workers`: it reads `env` through `cloudflare:workers` (so it works at module scope), takes the same Env Mapping as `loggerOptionsFromEnv`, and registers the logger as the Default Logger unless one is already set. A mapping function's `env` is typed `Cloudflare.Env`, which `wrangler types` fills in. The default is looked up when each line is written, so a `const log = getLogger()` (or `getLogger().child({ component })`) at a shared package's top level picks it up once registered. A Worker with several entrypoints for different services should call `defaultLoggerFromEnv()` (or `setDefaultLogger`) at module scope rather than rely on whichever entrypoint is constructed first. Never register a logger that depends on the request or on `ctx.props`.

```ts
import { Hono } from 'hono'
import { getLogger } from 'loggercf'
import { useLogger } from 'loggercf/hono'
import { defaultLoggerFromEnv } from 'loggercf/workers'

const logger = defaultLoggerFromEnv() // NAME, LOG_LEVEL, ENVIRONMENT, VERSION
const app = new Hono()
app.use(useLogger(logger))

getLogger().info('module loaded') // has service, environment, version; no trace IDs

export default app
```

On Node.js, or to choose the logger yourself, call `setDefaultLogger(rootLogger)` from `loggercf`. It always replaces the current default. `useLogger(rootLogger)`, `defaultLoggerFromEnv()`, `TracedEntrypoint` / `tracedWorker` / `withLogging` / `withWorkflow` (when the class is constructed), and `withScheduled` / `withQueueMessage` (on each call) register their Root Logger only when no default is set yet (first seen wins). `useLogger`'s factory form registers nothing, so with a factory call `setDefaultLogger` yourself or use `defaultLoggerFromEnv()`. Pass the Root Logger itself, never `rootLogger.child({ requestId })` or a logger taken inside a Logging Context: fields passed to `.child()` would appear on every line logged outside a context. `getLogger('name')` with a name still returns a standalone logger without `environment` or `version`.

### Per-request data goes in Context Fields

Pass `requestId`, `userId`, tenant, message id and similar data as `fields` to `runWithLogger`, or call `setLoggerContext({ ... })` inside the Logging Context. Every later line in that context carries them, including `useLogger`'s `request.end` and lines from code that calls `getLogger()`. `useLogger` already adds `requestId`, and `cfRay` when the request has a `cf-ray` header. In Hono, data known from the request alone can come from `useLogger`'s `fields` option, so `request.start` has it too (see [Request lines in Hono](#request-lines-in-hono)).

```ts
import { Hono } from 'hono'
import { createLogger, setLoggerContext, type Logger } from 'loggercf'
import { useLogger } from 'loggercf/hono'

// useLogger sets c.var.logger, c.var.requestId and c.var.traceId; declare them to use them typed
const app = new Hono<{ Variables: { logger: Logger; requestId: string; traceId: string } }>()
app.use(useLogger(createLogger({ service: 'orders' })))
app.get('/orders/:id', (c) => {
  setLoggerContext({ orderId: c.req.param('id') })
  c.var.logger.info('loading order') // has requestId, orderId, traceId, spanId
  return c.text('ok')
})

export default app
```

```ts wrong
const logger = createLogger({ service: 'orders' }, { userId }) // Root Logger bindings are per-process
const log = rootLogger.child({ requestId }) // only this object carries it; getLogger() lines miss it
```

Context Fields do not cross RPC on their own. To carry them to another Worker, pass them as the last argument of `withTrace` or `tracedSession`.

### Request ID in Hono

`useLogger` reuses an incoming `X-Request-Id` only when it is 1 to 128 characters of `A-Z a-z 0-9 _ - = : .`; otherwise it falls back to `c.var.requestId` set by an earlier middleware, then generates a UUID. The chosen ID is on every line, in `c.var.requestId`, and in the `X-Request-Id` response header. When a non-empty incoming ID was rejected, every line also gets `requestIdRejected: true` (never the rejected value; a `cf-ray` rejected as the ID is not recorded as `cfRay`); an empty one counts as none. When the request has a well-formed `cf-ray` header and `trustIncoming` is not `false`, every line also gets `cfRay`; trust it only on requests straight from Cloudflare's edge, since a Worker calling over a service binding `fetch` can set any `cf-ray`. Configure it with the second argument, not with your own header parsing:

```ts
import { Hono } from 'hono'
import { createLogger } from 'loggercf'
import { useLogger } from 'loggercf/hono'

const app = new Hono()
app.use(
  useLogger(createLogger({ service: 'api' }), {
    requestId: {
      from: ['cf-ray', 'x-request-id'], // header names or (c) => string | undefined, first valid wins
      trustIncoming: true, // false: always generate; ignores `from`, c.var.requestId and cf-ray
      // validate: RegExp | (id, c) => boolean, replaces the default check and its 128 cap
      // generate: (c) => string, used when no source is valid
    },
  }),
)

export default app
```

### Request lines in Hono

`useLogger` writes `request.start` and one `request.end` per request. `request.end` has `method`, `path` (never the query string), `route` (the matched pattern, such as `/users/:id`; group by it, not by `path`), `statusCode`, `duration`, and `err` when Hono caught an error. A throw that escapes `useLogger` (a non-`Error` value, or an `onError` that throws) is rethrown unchanged after a `request.end` at `error` with `statusCode: 500` and `statusCodeAssumed: true`: that 500 is a guess, because an outer middleware or the runtime sends the real response, and Hono hands an `Error` thrown by `onError` back to `onError` (an `HTTPException(502)` it throws becomes a 502). Don't read `statusCode` as the sent status on a line with `statusCodeAssumed`. There is no `request.error` line: find failed requests by `err` or by the level of `request.end`. That level is by default `error` for a caught error or a 5xx, `warn` for a 4xx and `info` otherwise; the `level` option changes it, so check the app's `useLogger` options before relying on it. Use the options instead of logging your own per-request summary line:

```ts
import { Hono } from 'hono'
import { createLogger } from 'loggercf'
import { useLogger } from 'loggercf/hono'

const app = new Hono<{ Variables: { userId?: string } }>()
app.use(
  useLogger(createLogger({ service: 'api' }), {
    requestStart: false, // default true; false: request.end only
    fields: (c) => ({ tenant: c.req.header('x-tenant-id') }), // Context Fields: every line
    endFields: (c) => ({ userId: c.get('userId') }), // request.end only, after the handlers
    include: { userAgent: true, cf: true }, // userAgent and cf: { colo, country, asn }; off by default
    // level: (status, err, c) => LogLevel, for request.end
  }),
)

export default app
```

```ts wrong
app.use(async (c, next) => {
  await next()
  c.var.logger.info({ status: c.res.status, url: c.req.url }, 'request done') // duplicates request.end, and logs the query string
})
```

`fields` and `endFields` must be synchronous and return a plain object: an `async` one is a failure. A `fields`, `endFields` or `level` option that fails (throws, returns a Promise or an unknown level, or returns an object that throws when read) does not break the request or drop `request.end`: the line is written without it (or at the default level), with one WARN per option naming it in `hook`. Keys `useLogger` owns, its Owned Keys (`requestId`, `cfRay`, `statusCode`, `duration`, `err`, ...) are dropped from a `fields`/`endFields` result, with one WARN listing them in `droppedKeys`: pick other names. `method`, `path` and `route` are not Owned Keys: return them from `fields` to put them on the handlers' lines; `request.start` and `request.end` still write their own. `fields` runs before routing, so `c.req.routePath` there is not the endpoint's pattern: set `route` from the handler with `setLoggerContext`. A `level` hook that returns `'silent'` counts as an unknown level (default level, one WARN): `request.end` cannot be muted by the hook. For a streamed body, `request.end` is written when the handler returns the `Response`, so `duration` leaves out the streaming and an error while streaming is not on it: log that from the stream's error callback.

### Context helpers need a Logging Context

Call these inside a Logging Context: `useLogger`, `this.traced`, a `withLogging` method, a `withScheduled` handler, a `withQueueMessage` callback, a `withWorkflow` `run` or `tracedStep` callback, or `runWithLogger`. Outside a Logging Context, each one quietly degrades:

- `setLoggerContext` ignores the fields and writes one WARN per isolate: `setLoggerContext called outside a Logging Context; fields ignored`. That WARN in the logs means a call site is outside every Logging Context.
- `withSpan` just runs the function, with no Span.
- `getTraceCarrier()` returns `{}`, and `tracedFetch` / `tracedFetcher` send no Trace Carrier.
- `getLogger()` writes through the Default Logger, or without one a standalone logger with `service: 'unknown'` (or the name you pass). Either way the line has no trace IDs and no Context Fields.

### Traced Sessions: every RPC method runs in `this.traced`

Wrap the body of every RPC method in `this.traced(fn, 'svc.op')`. The operation name makes the call a Span. Inside `traced`, `this.logger` is the Logging Context's logger. Outside it, `this.logger` is the bare Root Logger, with no trace IDs.

Every method and getter on the subclass is an RPC member any caller can call. `traced`, `logger` and `env` are not: they are instance properties, which JSRPC never exposes. Make a helper you do not want callable a `#private` method or a function outside the class, and do not override `traced` or `logger`: TypeScript rejects it, and in plain JavaScript a member with either name replaces the helper and becomes callable over RPC.

```ts
import { TracedSession, tracedWorker, withTrace, type TracedServiceBinding } from 'loggercf/workers'

interface MathService {
  multiply(a: number, b: number): Promise<number>
}

interface Env {
  NAME: string
  LOG_LEVEL: string
  MATH: TracedServiceBinding<MathService> // not the generated `Fetcher` type, which has no session()
}

class BillingSession extends TracedSession<Env> {
  async total(price: number, qty: number, userId: string): Promise<number> {
    return this.traced(async () => {
      this.logger.info({ price, qty }, 'computing total')
      return withTrace(this.env.MATH, (s) => s.multiply(price, qty), { userId })
    }, 'billing.total')
  }
}

export default tracedWorker(BillingSession)
```

`tracedWorker(S)` builds the entrypoint: one Root Logger per isolate from the env vars, a `session(init)` method, and a 404 `fetch`. When the Worker also needs `scheduled`, `queue` or a real `fetch` with logging, extend `TracedEntrypoint` instead. It gives you `this[TracedEntrypoint.rootLogger]`: its hooks are getters keyed by the symbols `TracedEntrypoint.envMapping`, `.loggerOptions` and `.rootLogger`, so a caller holding the binding cannot reach them over RPC. Override `[TracedEntrypoint.envMapping]` (or `.loggerOptions`, `.rootLogger`) to change them, never a getter named `envMapping`, `loggerOptions` or `rootLogger`: TypeScript rejects it, and in plain JavaScript it is an RPC member that `TracedEntrypoint` never calls. A session's constructor is `(init, rootLogger, env)`, and `session()` takes one object, `{ traceparent?, tracestate?, fields? }`:

```ts
import { getLogger } from 'loggercf'
import { TracedEntrypoint, TracedSession, withScheduled, type SessionInit } from 'loggercf/workers'

interface Env {
  NAME: string
  LOG_LEVEL: string
}

class MathSession extends TracedSession<Env> {
  async square(n: number): Promise<number> {
    return this.traced(() => n * n, 'math.square')
  }
}

const nightly = withScheduled(async (controller: ScheduledController, env: Env) => {
  getLogger().info('nightly run') // cron, scheduledTime, traceId
})

export default class extends TracedEntrypoint<Env> {
  session(init: SessionInit) {
    return new MathSession(init, this[TracedEntrypoint.rootLogger], this.env)
  }

  scheduled(controller: ScheduledController) {
    return nightly(controller, this.env, this.ctx)
  }
}
```

### Outbound HTTP sends the Trace Carrier

Use `tracedFetch` for `fetch`, and wrap a service binding with `tracedFetcher` before calling its `fetch`. Do not set `traceparent` by hand, and do not wrap the call in your own retry or `try/catch` for the logger's sake: the wrapper returns or throws exactly what `fetch` or the binding does. It never mutates the `Request` or `init` you pass. Forwarding `c.req.raw` passes the client's headers on as they are, `X-Request-Id` included, unless `forwardRequestId` is on. Its options are off by default:

- `forwardRequestId: true` sends the `requestId` Context Field as `X-Request-Id`, replacing any already on the call (a forwarded `c.req.raw`'s included), so the receiver's `useLogger` reuses this Worker's ID. To send your own ID, leave it off and set the header. On `tracedFetch` the ID goes to whatever host you call.
- `spans: true` logs one `span.end fetch` per call with `method` (as sent), `host`, `path` (no query string) and `statusCode`. A 5xx response is still an `OK` Span (look at `statusCode`); a network failure is an `ERROR` Span, and the error is rethrown. The error is logged as it is, so a message that quotes the URL puts its query string on that line.

```ts
import { Hono } from 'hono'
import { tracedFetch, tracedFetcher } from 'loggercf'
import { useLogger } from 'loggercf/hono'
import { defaultLoggerFromEnv } from 'loggercf/workers'

const app = new Hono<{ Bindings: { API: Fetcher } }>()
app.use(useLogger(defaultLoggerFromEnv()))

app.all('/api/*', (c) => {
  const api = tracedFetcher(c.env.API, { forwardRequestId: true, spans: true })
  return api.fetch(c.req.raw)
})

app.get('/weather', async (c) => {
  const res = await tracedFetch('https://weather.example.com/today', undefined, { spans: true })
  return c.json(await res.json())
})

export default app
```

### Plain `WorkerEntrypoint` RPC: wrap it with `withLogging`

A `WorkerEntrypoint` whose methods are called directly (`env.SVC.method()`) runs them outside every Logging Context. Do not rewrite it into a Traced Session and every caller in one change. Wrap the class with `withLogging` from `loggercf/workers`: each method call (and `fetch`) gets its own Logging Context with `service` from env, a `traceId`, and the Context Fields `rpcMethod` and `entrypoint`. Leave the method bodies alone; `getLogger()` and `setLoggerContext` work inside them.

```ts
import { WorkerEntrypoint } from 'cloudflare:workers'
import { getLogger } from 'loggercf'
import { withLogging } from 'loggercf/workers'

interface Env {
  NAME: string
  LOG_LEVEL: string
}

class SearchWorker extends WorkerEntrypoint<Env> {
  async search(q: string): Promise<string[]> {
    getLogger().info({ q }, 'searching')
    return []
  }
}

// spans: one span.end per call, ERROR on throw. session: adds session(init) for migrated callers.
export default withLogging(SearchWorker, { spans: true, session: true })
```

- A direct call has no Trace Carrier, so it starts a new root trace. Callers that move to `withTrace(env.SVC, (s) => s.search(q))` continue their own trace instead; migrate them one at a time. Type the binding as `SearchService & TracedServiceBinding<SearchService>` while both styles are in use.
- `withLogging` changes nothing a caller sees: same RPC methods, same return values, the same error thrown. It never retries or catches. A throw is always logged at `ERROR`: with `spans` as the `span.end`, without as one `<Class>.<method> failed` line with `err` and `rpcMethod`, once per call that opened the Logging Context. `session: true` is the one addition: a `session(init)` method. The class must not already have a `session` method or getter, own or inherited.
- `scheduled`, `queue` and `tail` are not wrapped. Call a `withScheduled` handler from `scheduled`, and `withQueueMessage` per message from `queue` (see [Cron, queues and Workflows](#cron-queues-and-workflows)).
- When `fetch` hands the request to a Hono app that uses `useLogger` (`return app.fetch(req, this.env, this.ctx)`), pass `fetch: false`. `useLogger` opens its own Logging Context and continues `traceparent`; wrapping `fetch` as well splits each request into two root traces.
- Put every RPC method on the class before wrapping it. A method added or overridden in a subclass of the wrapped class runs outside every Logging Context; extend the wrapped class only to add handlers. The class must extend `WorkerEntrypoint` or `DurableObject` (see [Durable Objects](#durable-objects-wrap-them-with-withlogging)); anything else throws.
- A method named like a handler (`trace`, `test`, `email`, `connect`, `queue`, `tail`, `tailStream`) is never wrapped.
- Only method calls are wrapped. A getter read over RPC, and the body of an `async *` method (it runs on each `.next()`, after the call has returned), log outside the Logging Context. A sync method that returns an un-awaited `RpcPromise` gets a span that ends at once; make it `async` and `await` the call to time it.
- A method called while any Logging Context is active joins it and adds no `rpcMethod` or `entrypoint`: another public method (`this.search()`) gives a child Span `C.search` with the caller's `rpcMethod`, and a call inside a `withScheduled` handler logs with that context's fields only.
- On the `session()` path, caller fields named `rpcMethod` or `entrypoint` are replaced. An anonymous class gets no `entrypoint` field, and its Spans are named by the method alone.
- Wrap a class once. Wrapping the result again with the same options (`spans`, `session`, `fetch`, `env`) returns it; other options, or wrapping a subclass of it, throw.
- It takes the same Env Mapping as `tracedWorker`: `withLogging(C, { env: { version: ... } })`. A `TracedEntrypoint` subclass keeps its own `[TracedEntrypoint.envMapping]` hook instead; passing `env` to it throws.

### Durable Objects: wrap them with `withLogging`

`withLogging(DO)` gives `fetch`, every RPC method, `alarm`, `webSocketMessage`, `webSocketClose` and `webSocketError` each their own Logging Context, with `rpcMethod`, `durableObject` (the class name), `objectId` (always) and `objectName` (too, for an object reached with `getByName` / `idFromName`). RPC methods, `alarm` and the WebSocket handlers start a new root trace; `fetch` continues a `traceparent` header. `session` is not available (it would add an RPC method); `spans`, `fetch` and `env` work as for an entrypoint.

```ts
import { DurableObject } from 'cloudflare:workers'
import { getLogger } from 'loggercf'
import { withLogging } from 'loggercf/workers'

class Room extends DurableObject<Cloudflare.Env> {
  async join(user: string): Promise<void> {
    getLogger().info({ user }, 'joined') // rpcMethod, durableObject: 'Room', objectId, objectName
  }
}

const LoggedRoom = withLogging(Room, { spans: true })
export { LoggedRoom as Room } // the class_name in wrangler.jsonc
```

Export the wrapped class under the `class_name` Wrangler binds. `wrangler types` writes `DurableObjectNamespace<import('./src/index').Room>`, which needs a type named `Room`, and an exported `const` is only a value. If you use it, write `export const Room = withLogging(class Room extends DurableObject<Env> { ... })` and `export type Room = InstanceType<typeof Room>`: the named class expression keeps `durableObject: 'Room'`. The same goes for `withWorkflow`.

### Cron, queues and Workflows

Each helper opens one Logging Context per unit of work and never owns control flow: it does not ack, retry, iterate a batch or catch. Values pass through, and a throw is rethrown unchanged. A throw in a cron run, a queue message's `fn` or a `tracedStep` attempt is always logged at `ERROR` with `err`: as its `span.end` when the trace is sampled, or as one `<operation> failed` line when it is not (a queue carrier or Workflow payload trace with flags `00`). A throw in a Workflow's `run` outside every `tracedStep` is not logged (see below).

- **Cron**: `scheduled: withScheduled(async (controller, env) => { ... })`. A new root trace per run, with `cron` and `scheduledTime`, and one `span.end scheduled`. On a class entrypoint, wrap the handler at module scope and call it from `scheduled(controller) { return nightly(controller, this.env, this.ctx) }`.
- **Queues**: loop over `batch.messages` yourself and run each message's work in `withQueueMessage(batch, message, fn)`. Context Fields `queue`, `messageId` and `attempts`; one `span.end queue.message`. Call `message.ack()` / `message.retry()` in your code. `await` every call: the batch is acked implicitly when `queue` returns, so a missing `await` can ack it while the work still runs and lose its throw. `await Promise.all(batch.messages.map((m) => withQueueMessage(batch, m, fn)))` is safe: each call has its own Logging Context. The producer sends `{ ...payload, trace: getTraceCarrier() }`; the consumer then continues that trace.
- **Workflows**: wrap the class, `export const Report = withWorkflow(ReportWorkflow)`, so `run` gets `workflowInstanceId`. Write each step as `tracedStep(step, 'name', [config], fn)` in place of `step.do(...)`: same arguments and overloads, one Span per attempt with `step`, `stepCount` (`ctx.step.count`, which tells apart a name repeated in a loop) and `attempt`. A rollback handler runs in the run's context too, as a Span `rollback <name>` with `rollback: true`; a function-valued `retries.delay` runs outside every Logging Context. A plain `step.do` callback logs outside every Logging Context, because the engine calls it back over RPC. Pass `trace: getTraceCarrier()` in the params to `create()` to continue the creator's trace.

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { getLogger, type TraceCarrier } from 'loggercf'
import { tracedStep, withWorkflow } from 'loggercf/workers'

interface Params {
  userId: string
  trace?: TraceCarrier // creator sent { userId, trace: getTraceCarrier() }
}

class Welcome extends WorkflowEntrypoint<Cloudflare.Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    const name = await tracedStep(step, 'load user', async () => `user-${event.payload.userId}`)
    await tracedStep(
      step,
      'send email',
      { retries: { limit: 3, delay: '10 seconds' } },
      async () => {
        getLogger().info({ name }, 'sending') // workflowInstanceId, step, stepCount, attempt
      },
    )
  }
}

const LoggedWelcome = withWorkflow(Welcome)
export { LoggedWelcome as Welcome }
```

- Do not put random values, `Date.now()` or trace IDs in a step's name or config: the step name is its identity on replay. `tracedStep` adds nothing to either.
- Lines logged in `run` outside a step repeat on every replay. `run` writes no Span of its own.
- A throw in `run` outside every `tracedStep` (validation, code between steps, a plain `step.do`) is **not logged**: the engine also throws in `run` for pause, terminate and restart, and nothing documented tells those apart from your errors, so `withWorkflow` never logs a rejected `run`. Put every unit of work, validation included, in a `tracedStep`.
- Without `trace` in the params, each replay of `run` gets a new `traceId`; join one instance's lines on `workflowInstanceId`.

### Spans on hot paths: `level`, `slowMs`, Span Fields

Wrapping every query or cache read in a Span at `INFO` floods the log. Give hot-path Spans `level: 'debug'` and a Slow Threshold: with `LOG_LEVEL=info`, fast ones write nothing (the logger's level filters them; they are never dropped otherwise), slow ones write `span.end` at `WARN`, and a throw is always `ERROR`. Put a result on the `span.end` line with `span.set()` rather than a separate log line:

```ts
import { withSpan } from 'loggercf'

declare const cache: { get(key: string): Promise<string | null> }

export async function readCached(key: string): Promise<string | null> {
  return withSpan(
    'cache.read',
    async (span) => {
      const value = await cache.get(key)
      span.set({ hit: value !== null }) // on span.end only
      return value
    },
    { level: 'debug', slowMs: 200, fields: { cache: 'users' } },
  )
}
```

- `this.traced(fn, 'svc.op', options)` takes the same options, and `fn` gets the same `span`. A function that takes no argument still works.
- Set the defaults once instead of on every call: `createLogger({ service, spans: { level: 'debug', slowMs: 500 } })`, or the vars `LOG_SPAN_LEVEL` / `LOG_SPAN_SLOW_MS` for the helpers that build the Root Logger from env (`tracedWorker`, `TracedEntrypoint`, `withLogging`, `withScheduled`, `withQueueMessage`, `withWorkflow`, `defaultLoggerFromEnv`). A Span's own options win; `slowMs: Infinity` turns a default Slow Threshold off for one Span.
- `withLogging` method Spans, the handler helpers' Spans and `tracedStep` take no per-call options: only the defaults apply.
- Span Fields never reach other lines: not the work's own lines, not a nested Span, not the unsampled `<operation> failed` line. For fields on every line, use `setLoggerContext`.
- `span.set()` after the Span ended, or on an unsampled trace, does nothing. It never throws.
- Span Fields cannot set `span` or `err` (the Span Owned Keys): they are dropped, with one `WARN` naming them. Values for the moved keys (`message`, `level`, `traceId`, ...) land in `args`, as for any log call.

### Log call shape

Two call styles work, and no argument is ever dropped. Prefer the structured style (fields or an `Error` first, then the message) for data you want to query. The console style (message first) also keeps every argument: a trailing object's keys become top-level fields, the first trailing `Error` becomes `err`, extra strings and numbers join the message, and anything else goes to an `args` array.

```ts
import { createLogger } from 'loggercf'

const logger = createLogger({ service: 'api' })
const err = new Error('payment declined')

// structured
logger.error(err)
logger.error({ err, orderId: 'o-1' }, 'charge failed')
logger.info({ orderId: 'o-1' }, 'charged')

// console style: same fields on the line
logger.error('charge failed', err, { orderId: 'o-1' })
logger.info('charged %s', 'o-1', { amount: 42 })

try {
  throw new Error('declined')
} catch (e) {
  logger.error(e, 'charge failed') // e is unknown: also fine as { err: e } or after the message
}
```

An `Error | undefined` that is unset writes nothing when the message follows it: `logger.error(maybeErr, 'failed %s', id)` gives `failed id1`. Alone, or before anything but a string, it is a leading primitive, like a number: `String(value)` is the message, the value is in `args` (as `null`), and the arguments after it are routed as usual. `logger.error(maybeErr)` gives the message `undefined`, and `logger.info(undefined, { a: 1 })` the message `undefined` with `a: 1` as a field. After a leading object or `Error`, an `undefined` in the message's place lands in `args`.

An `Error` is serialized with type, message, stack, own fields, an `AggregateError`'s `errors`, and `cause`, at any depth: `{ failures: [e] }` and `{ ctx: { err: e } }` write `e` the same way as a top-level `err`, in fields, `args`, Context Fields and logger bindings alike. Errors nest up to 5 levels, counted through any objects between them; a deeper one is `{ "type": "Truncated", ... }`. A nested `Error` with its own `toJSON` is written by that `toJSON`, as JSON does. `%j`, `%o` and `%O` don't print an `Error` or a value holding one; it is routed like a later argument instead. A value that can't be serialized (a getter or a `toJSON` that throws) becomes `"[Unserializable: <reason>]"` on its own; the rest of the line is kept. `printf` placeholders (`%s %d %i %f %j %o %O %%`) take arguments in order. `%s %d %i %f` don't print an object: the placeholder stays in the text and the object is routed like a later argument:

```ts wrong
logger.info('loaded order %s', order) // message stays 'loaded order %s', order's keys spill onto the line; use logger.info({ order }, 'loaded order')
```

`%s` with an `Error` prints its message and still routes the `Error` to `err`: `logger.error('failed: %s', e)` gives `failed: boom`, with `err` and its stack. `%s` with a `Date` prints its ISO string.

`traceId`, `spanId` and `parentSpanId` are added to every line in a Logging Context. A log call's objects can't set them, or the other moved keys (`time`, `level`, `message`, `service`, `environment`, `version`, `errors`, `args`, `err`): an object's values for those keys land in `args` instead. Logger bindings (`createLogger`, `.child()`) and Context Fields can't set `time`, `level`, `message`, `errors` or `args` either; their values for those keys land in `args` too. An object's `err`, and a string `message` when the call has no other message, are used while still unset. To read the trace IDs, call `getTraceContext()`.

### Errors with user data, and line size

By default an `Error` is written with every own property, and nothing is cut. Library errors often carry the request or response as own properties (the AI SDK's `APICallError` has `requestBodyValues`, the full prompt). In production, leave those keys out with `omitErrorKeys` and bound each line with `limits`; leave both off locally. loggercf has no key list of its own, so name the keys this app's errors carry.

```ts
import { createLogger, loggerOptionsFromEnv, omitErrorKeys } from 'loggercf'

declare const env: { ENVIRONMENT?: string }

const logger = createLogger({
  ...loggerOptionsFromEnv(env),
  ...(env.ENVIRONMENT === 'production' && {
    serializeError: omitErrorKeys(['requestBodyValues', 'responseBody']),
    limits: { maxStringLength: 8_192, maxRecordBytes: 200_000 },
  }),
})
```

- `serializeError(err, defaultSerialize)` writes every `Error` on the line, at any depth; `omitErrorKeys(keys, serializer?)` builds one, and lists what it left out as `omitted`. Don't strip keys from an `Error` before logging it, and don't log `err.message` instead of `err`: you lose the stack and `cause`.
- A serializer that throws, or returns anything but an object (`undefined`, a Promise from an `async` one), never breaks the log call: that `Error` is written the default way, with `serializeErrorFailed`. Keep it synchronous.
- A line logged from inside the serializer writes each `Error` as only `{ type, message, serializeErrorFailed: 'logged from inside serializeError' }`, so it can't leak the keys being left out.
- `type` is never left out: it is always the class name.
- `maxStringLength` cuts longer strings to that many characters plus `…[truncated from <n> chars]`. `maxRecordBytes` trims a larger line to fit, largest values first, keeping the Protected Fields. Workers Logs caps each log at 256 KB and truncates a larger one, which breaks its JSON; `200_000` leaves room.
- A Span's `span.error` is the thrown message as a plain string: `serializeError` and `omitErrorKeys(['message'])` don't change it.
- The Workers helpers (`withLogging`, `withScheduled`, `withQueueMessage`, `withWorkflow`, `tracedWorker`, `defaultLoggerFromEnv`) read the limits from the vars `LOG_MAX_STRING_LENGTH` and `LOG_MAX_RECORD_BYTES`, and take `serializeError` as an option (`defaultLoggerFromEnv(mapping, { serializeError })`). A `TracedEntrypoint` sets both in its `[TracedEntrypoint.loggerOptions]` getter.
- Define `serializeError` once, at module scope, choosing it from `env` (`import { env } from 'cloudflare:workers'`), and pass that same constant everywhere. The helpers cache their Root Logger by the function, and the hook and the helpers' options are read on every request or message. `omitErrorKeys(keys)` with no second argument gives the same function for the same keys, but any other function written inline builds a Root Logger per call, and past 16 of them one `WARN` says so.

```ts
import { env } from 'cloudflare:workers'
import { omitErrorKeys, type LoggerOptions } from 'loggercf'
import { TracedEntrypoint, withQueueMessage } from 'loggercf/workers'

interface Job {
  orderId: string
}

// Once, at module scope.
const serializeError =
  (env as { ENVIRONMENT?: string }).ENVIRONMENT === 'production'
    ? omitErrorKeys(['requestBodyValues', 'responseBody'])
    : undefined

export default class extends TracedEntrypoint {
  protected override get [TracedEntrypoint.loggerOptions](): LoggerOptions {
    return { ...super[TracedEntrypoint.loggerOptions], serializeError }
  }

  async queue(batch: MessageBatch<Job>) {
    for (const message of batch.messages) {
      await withQueueMessage(batch, message, async () => message.ack(), { serializeError })
    }
  }
}
```

```ts wrong
// A new function on every request or message: a new Root Logger each time.
return {
  ...super[TracedEntrypoint.loggerOptions],
  serializeError: (err, d) => ({ ...d(err), body: undefined }),
}
await withQueueMessage(batch, message, fn, {
  serializeError: omitErrorKeys(['body'], mySerializer),
})
```

## Wrangler setup

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "NAME": "billing-worker",
    "LOG_LEVEL": "info",
    "ENVIRONMENT": "production",
    "VERSION": "1.0.0",
  },
  "services": [{ "binding": "MATH", "service": "math-worker" }],
}
```

- `nodejs_compat` is required, because loggercf uses `AsyncLocalStorage` from `node:async_hooks`.
- `loggerOptionsFromEnv(env)`, `tracedWorker`, `withLogging` and `TracedEntrypoint` read `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION`. A missing `NAME` becomes `service: 'unknown'` and a missing `LOG_LEVEL` becomes `'info'`. A missing or empty `ENVIRONMENT` or `VERSION` is left off the log line (0.0.1 wrote `'unknown'` for a missing one).
- `LOG_LEVEL` must be lowercase: one of `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. `silent` writes nothing at all. Any other value (including `DEBUG` and `SILENT`) falls back to `'info'` and writes one `WARN` per isolate that names the bad value.
- `LOG_SPAN_LEVEL` (a lowercase level, not `silent`) and `LOG_SPAN_SLOW_MS` (milliseconds, `0` or more) set the Root Logger's Span Defaults. Unset, Spans write at `info` with no Slow Threshold. An invalid value is ignored, with one `WARN` per isolate.
- `LOG_MAX_STRING_LENGTH` (an integer, `1` or more) and `LOG_MAX_RECORD_BYTES` (an integer, `1024` or more) set the Root Logger's `limits`. Unset, nothing is cut: set them in the production environment's `vars` only. An invalid value is ignored, with one `WARN` per isolate.
- To read other vars, pass a mapping. Each field (`service`, `level`, `environment`, `version`, `spanLevel`, `spanSlowMs`, `maxStringLength`, `maxRecordBytes`) takes a var name or a function of env. Fields you leave out keep their default var. The same mapping goes to `tracedWorker(S, { env })` or `withLogging(C, { env })`, or to a `[TracedEntrypoint.envMapping]` getter on a `TracedEntrypoint` subclass.

```ts
import { createLogger, loggerOptionsFromEnv } from 'loggercf'
import { TracedSession, tracedWorker } from 'loggercf/workers'

interface Env {
  NAME: string
  RELEASE: string
  CF_VERSION_METADATA: WorkerVersionMetadata // "version_metadata": { "binding": "CF_VERSION_METADATA" }
}

declare const env: Env

const logger = createLogger(loggerOptionsFromEnv(env, { version: 'RELEASE' }))

class BillingSession extends TracedSession<Env> {}

export default tracedWorker(BillingSession, {
  env: { version: (e) => e.CF_VERSION_METADATA?.tag || e.CF_VERSION_METADATA?.id },
})
```

- The `version_metadata` binding name is yours to choose in Wrangler, so loggercf never reads it by itself: map it with a function as above. `id` is the deployed version's ID and `tag` is the `--tag` from `wrangler deploy` or `wrangler versions upload`, which is `""` without `--tag` and in local dev: hence `tag || id`. Keep the `?.`, or a missing binding throws inside the Root Logger getter and every `session()` call fails.
- On Node.js there is no Wrangler config: call `createLogger({ service, level, environment, version })` or `createLogger(loggerOptionsFromEnv(process.env))` at startup.
