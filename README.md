# loggercf

Structured logging for Cloudflare Workers and Node.js, with no runtime dependencies: per-request context via `AsyncLocalStorage`, W3C trace propagation, and a Session Factory pattern for RPC trace propagation across service bindings.

## Install

```bash
pnpm add loggercf
# Hono is an optional peer dependency
pnpm add hono
```

## Entry Points

| Import             | Contents                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loggercf`         | Core: `createLogger`, `runWithLogger`, `withSpan`, `getLogger`, `setDefaultLogger`, `setLoggerContext`, `loggerOptionsFromEnv`, `tracedFetch`, `tracedFetcher`, trace utilities, types      |
| `loggercf/hono`    | `useLogger`, `generateId` — Hono middleware; `UseLoggerOptions`, `RequestIdOptions`, `RequestIdSource` types                                                                                |
| `loggercf/workers` | `TracedSession`, `TracedEntrypoint`, `tracedWorker`, `withLogging`, `withTrace`, `tracedSession`, `defaultLoggerFromEnv`, `withScheduled`, `withQueueMessage`, `withWorkflow`, `tracedStep` |

## How Trace Propagation Works

Every log line includes `traceId`, `spanId`, and optionally `parentSpanId`. When a request flows through multiple workers, they all share the same `traceId`:

```
User → main-worker (traceId: abc, spanId: 111)
         → bind-worker (traceId: abc, spanId: 222, parentSpanId: 111)
              → math-worker (traceId: abc, spanId: 333, parentSpanId: 222)
              → math-worker (traceId: abc, spanId: 444, parentSpanId: 222)
```

Search your log backend for `traceId = "abc"` to see the entire request across all workers. See [docs/rpc-trace-propagation.md](docs/rpc-trace-propagation.md) for the technical deep-dive.

---

## Cloudflare Worker Requirements

`loggercf` uses `AsyncLocalStorage` through `node:async_hooks`.
Cloudflare Workers must enable Node.js compatibility in `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
}
```

`loggerOptionsFromEnv()`, `tracedWorker()`, `withLogging()` and `TracedEntrypoint` read these environment variables by default:

```jsonc
{
  "vars": {
    "NAME": "my-worker",
    "LOG_LEVEL": "info",
    "ENVIRONMENT": "production",
    "VERSION": "1.0.0",
  },
}
```

| Var           | Logger Option | When absent             |
| ------------- | ------------- | ----------------------- |
| `NAME`        | `service`     | `'unknown'`             |
| `LOG_LEVEL`   | `level`       | `'info'`                |
| `ENVIRONMENT` | `environment` | left off every log line |
| `VERSION`     | `version`     | left off every log line |

`LOG_LEVEL` must be one of `trace`, `debug`, `info`, `warn`, `error` or `fatal` (lowercase). A missing or empty value means `'info'`. Any other value falls back to `'info'` and writes one `WARN` per isolate with `invalidLevel` and `validLevels`.

Using other var names, or deriving a field from a binding, takes a mapping (see [`loggerOptionsFromEnv`](#loggeroptionsfromenvenv-mapping)). To use Cloudflare's [version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/) as `version`, add the binding under a name of your choice and map it with a function:

```jsonc
{
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
}
```

```ts
export default tracedWorker(MySession, {
  env: { version: (env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id },
})
```

Use this exact form. `tag` is `""` for a deploy without `--tag` (on `wrangler deploy` or `wrangler versions upload`) and in local dev, and an empty string counts as absent, so `.tag` alone would silently drop `version`; `.id` is always set. Keep the `?.`: without it, a missing binding throws inside the Root Logger getter, so every `session()` call on the entrypoint fails. Note that `version` is then a tag on tagged deploys and a version UUID on untagged ones, and under `wrangler dev` the ID is a new random UUID on every start; tag every deploy if you query by `version`.

### Upgrading from 0.0.1

Changes to the Logger Options read from env:

- An absent `ENVIRONMENT` or `VERSION` is left off every log line; 0.0.1 logged `'unknown'` (an empty one was already left off). Update any query or alert on `environment = "unknown"` or `version = "unknown"`.
- An empty `NAME` gives `service: 'unknown'` (0.0.1: `service: ""`).
- A numeric `VERSION` is logged as a string (`2` becomes `"2"`), and `VERSION: 0`, which 0.0.1 left off, is now logged as `"0"`.
- An invalid `LOG_LEVEL` falls back to `'info'` with one `WARN`; 0.0.1 threw.
- `LOG_LEVEL: "silent"` is no longer accepted. In 0.0.1 it muted all logs; now it falls back to `'info'` with a `WARN`, so **a Worker that had `"silent"` starts writing info-level logs**. Change it before upgrading. The quietest level is `fatal`: only `logger.fatal()` lines are written. There is no off switch.

Changes to the Hono middleware (`useLogger`):

- `request.error` lines are gone. A request that failed has one `request.end` with `err`. Move any alert or query on `request.error` to `request.end` with `err` present, or to its level.
- `request.end` is no longer always `INFO`: it is `WARN` for a 4xx response and `ERROR` for a 5xx or a caught error (change it with the `level` option). Queries that count `INFO` `request.end` lines miss failed requests.
- A throw that escapes `useLogger` (one Hono's `onError()` did not answer) now gets a `request.end` at `ERROR` with `statusCode: 500` and `statusCodeAssumed: true`, then is rethrown unchanged; 0.0.1 wrote no `request.end` for it.

## Core API (`loggercf`)

### `createLogger(options)`

Create a **Root Logger**: build it once per process or isolate and share it. Works the same on Node.js and CF Workers (see [Log Output](#log-output)).

```ts
import { createLogger } from 'loggercf'

const logger = createLogger({
  service: 'my-worker',
  level: 'debug',
  environment: 'production',
  version: '1.2.3',
})

logger.info({ userId: 'u-42' }, 'Request started')
// → {"time":"...","level":"INFO","service":"my-worker","environment":"production","version":"1.2.3","userId":"u-42","message":"Request started"}
```

`level` defaults to `'info'`. `service`, `environment` and `version` are on every line. An optional second argument adds more fixed fields. Keep these to per-process data: an isolate serves many requests at once, so per-request data (`requestId`, `userId`, ...) belongs in a Logging Context's fields (see `runWithLogger`).

### `getLogger(service?)`

Get the current Logging Context's logger. Outside any Logging Context, `getLogger()` returns a logger that writes through the **Default Logger** (see [`setDefaultLogger`](#setdefaultloggerlogger)) registered when each line is written, or, while none is registered, through a standalone logger with `service: 'unknown'`. `getLogger(service)` with a name returns a standalone logger cached per `service`, with no `environment` or `version`, whether or not a default is set. This suits code that doesn't know whether it runs inside a context. Where you do know, prefer your Root Logger or `runWithLogger`.

```ts
import { getLogger } from 'loggercf'

// Inside useLogger / traced() / runWithLogger:
const log = getLogger() // the Logging Context's logger
log.info('has traceId automatically')

// Outside a Logging Context:
const log = getLogger() // writes through the Default Logger, or service: 'unknown' without one
const cron = getLogger('cron') // cached standalone logger
```

### `setDefaultLogger(logger)`

Register a Root Logger as the isolate's **Default Logger**: the logger `getLogger()` writes through outside every Logging Context. Code that runs outside a context (module scope, plain `WorkerEntrypoint` RPC methods, `scheduled`, Durable Object methods, shared packages) then logs with that logger's `service`, `environment` and `version` instead of `service: 'unknown'`.

```ts
import { createLogger, getLogger, loggerOptionsFromEnv, setDefaultLogger } from 'loggercf'

const logger = createLogger(loggerOptionsFromEnv(process.env))
setDefaultLogger(logger)

getLogger().info('starting') // service, environment and version from env
```

- Outside a context the line has no trace IDs and no Context Fields. Context Fields live in each Logging Context, never on the logger, so the Default Logger cannot carry one request's data into other work.
- Pass the Root Logger itself, not a logger taken from inside a Logging Context. A `.child({ ... })` of it is accepted, but the fields passed to `.child()` go on every line logged outside a context, so they must be per-process data too.
- `setDefaultLogger` replaces the current default, including one registered automatically. Calling it again replaces it again. The one exception is a logger taken from `getLogger()` outside a Logging Context (see below).
- The default is looked up when each line is written, not when `getLogger()` is called. A shared package that keeps `const log = getLogger()` at its top level (which runs before your app's module body) still logs with your `service` once the default is registered; only lines written before that say `service: 'unknown'`. `getLogger().child({...})` at module scope is fine too: the child follows the Default Logger as well. Registering a logger taken from `getLogger()` outside a Logging Context changes nothing: `setDefaultLogger(getLogger())` is a no-op. A `.child()` of it is ignored too while no default is set (its fields are dropped), so a later `useLogger`, `TracedEntrypoint` or `setDefaultLogger` call can still register your Root Logger; once a default is set, it registers a child of that default.
- The logger you register or pass to `useLogger`, and a `TracedEntrypoint`'s `rootLogger` / `envMapping` / `loggerOptions` overrides, must not depend on the request or on `ctx.props`: the first one registered stays the default for the isolate.
- A Worker that exports several entrypoints with different services should register its default explicitly at module scope (`defaultLoggerFromEnv()` or `setDefaultLogger()`). Otherwise whichever entrypoint class is constructed first in an isolate wins.

`useLogger(rootLogger)`, `TracedEntrypoint`, `tracedWorker`, `withLogging`, `withScheduled`, `withQueueMessage`, `withWorkflow` and `defaultLoggerFromEnv` register their Root Logger the first time they see one, unless a default is already set: first seen wins. On Workers, [`defaultLoggerFromEnv()`](#defaultloggerfromenvmapping) builds and registers one from `env` with no setup.

### `setLoggerContext(fields)`

Add fields to the current Logging Context. All subsequent log lines in that context include them. Fields set inside a `withSpan()` stay inside that span.

```ts
import { setLoggerContext } from 'loggercf'

setLoggerContext({ userId: 'u-42', feature: 'checkout' })
// All logs from this point include userId and feature
```

Outside a Logging Context the fields are **ignored**, and one `WARN` line naming the ignored keys is written per isolate. An isolate serves many requests at once, so fields stored outside a context would leak into unrelated requests.

### `runWithLogger(options, fn)`

Open a **Logging Context**: the single way to scope logging to one unit of work (HTTP request, RPC call, queue message, cron run). `useLogger`, `TracedSession` and the Workers helpers use it under the hood. On Workers, prefer the helper for the unit of work: [`withScheduled`](#withscheduledhandler-options) for cron, [`withQueueMessage`](#withqueuemessagebatch-message-fn-options) for queue messages, [`withWorkflow`](#withworkflowclass-options-and-tracedstepstep-name-) for Workflows and [`withLogging`](#withloggingclass-options) for RPC entrypoints and Durable Objects. Use `runWithLogger` for any other work, such as a Node.js job.

```ts
import { runWithLogger, createLogger, getLogger } from 'loggercf'

const logger = createLogger({ service: 'billing-jobs' }) // Root Logger, created once

for (const job of await loadJobs()) {
  await runWithLogger(
    {
      logger,
      traceparent: job.trace?.traceparent, // optional: continue a trace
      tracestate: job.trace?.tracestate, // optional
      fields: { jobId: job.id }, // optional: per-unit-of-work fields
    },
    async () => {
      getLogger().info('processing') // has traceId, spanId, jobId
    },
  )
}
```

Without a valid `traceparent` a new root trace starts. Either way the context gets its own `spanId`. `fields` is copied, never mutated.

### `withSpan(operation, fn)`

Time a sub-operation as a **Span** nested in the current Logging Context: new `spanId`, `parentSpanId` = the current span, same `traceId`. Works sync or async; errors are logged and rethrown. Logs `span.end` only when the trace is sampled; for an unsampled trace a throw still writes one `<operation> failed` line at `ERROR` with `err` and a `span` object without timing (`operation`, `status: 'ERROR'`, `error`), so a query on `span.status = 'ERROR'` finds both. An error the app catches inside the Span still counts: the Span threw, so it is an `ERROR` line. Outside a Logging Context it just runs `fn`.

```ts
import { withSpan } from 'loggercf'

app.get('/users/:id', async (c) => {
  const user = await withSpan('db.getUser', () => db.getUser(c.req.param('id')))
  return c.json(user)
})
```

### `getTraceContext()`

Read the current Trace Context (IDs and flags). Returns `null` outside a Logging Context.

```ts
import { getTraceContext } from 'loggercf'

const trace = getTraceContext()
// { traceId: '...', spanId: '...', parentSpanId: '...', traceFlags: 1 }
```

### `getTraceCarrier()`

Get the current **Trace Carrier**, `{ traceparent, tracestate? }`, to pass the trace on over any transport. Returns `{}` outside a Logging Context. Its keys match `runWithLogger`'s options, so the receiving side just spreads it in.

```ts
import { getTraceCarrier, runWithLogger } from 'loggercf'

// Producer: put the carrier in the message
await env.QUEUE.send({ ...payload, trace: getTraceCarrier() })

// Any other consumer: continue the same trace
await runWithLogger({ logger, ...msg.body.trace }, async () => {
  /* ... */
})
```

`useLogger` (HTTP headers), `tracedFetch` / `tracedFetcher` (outgoing requests) and `tracedSession` / `withTrace` (RPC) do this for you. So do [`withQueueMessage`](#withqueuemessagebatch-message-fn-options) and [`withWorkflow`](#withworkflowclass-options-and-tracedstepstep-name-), which read the carrier from the body's or payload's `trace` key.

### `tracedFetch(input, init?, options?)`

`fetch` that sends the current Trace Carrier as `traceparent` / `tracestate` headers. Takes the same arguments as `fetch`, plus optional [`options`](#outgoing-request-options). Outside a Logging Context it is plain `fetch`.

```ts
import { tracedFetch } from 'loggercf'

const res = await tracedFetch('https://api.example.com/items', { method: 'POST', body })
// Record the call as a Span:
const res2 = await tracedFetch('https://api.example.com/items', undefined, { spans: true })
```

### `tracedFetcher(binding, options?)`

Wrap a service binding (a `Fetcher`) so every call through its HTTP interface sends the current Trace Carrier, as `fetch(input, init)` or `fetch(request)`, and the receiving Worker's `useLogger` continues the trace. Use it when Workers talk over HTTP through bindings (a gateway forwarding to internal Workers); for RPC methods use [`withTrace`](#withtracebinding-fn-fields) instead.

```ts
import { tracedFetcher } from 'loggercf'

app.all('/api/*', async (c) => {
  const api = tracedFetcher(c.env.API, { forwardRequestId: true, spans: true })
  // Same Request, plus traceparent / tracestate, and this Worker's Request ID as X-Request-Id
  // (replacing the client's, which useLogger may have rejected)
  return api.fetch(c.req.raw)
})
```

- It returns the binding's own type. `connect()` and every other member pass through to the binding unchanged; only `fetch` is wrapped. Hand the original binding (not the wrapper) to anything that stores or transfers it.
- Nothing you pass is mutated. The Trace Carrier goes in a new `Headers`, starting from the headers `fetch` would send (`init.headers` when given, otherwise the `Request`'s). A `tracestate` already there is dropped, since it belongs to another `traceparent`. A `Request` is passed on as it is, with only the new headers beside it, so its body (streaming included) is neither read nor copied, and its `method`, `redirect`, `signal` and `cf` still apply. A `Request` passed as `init` (`fetch(url, request)`) is read into a plain `init`, so its body too is left for the binding to read, as with `fetch`. Its workerd `fetcher` is kept, so `tracedFetch(url, request)` goes where plain `fetch` would.
- Outside a Logging Context, `fetch` calls the binding with exactly the arguments you gave it.
- It never retries, catches or changes an error: the call returns or rejects with exactly what the binding does. A header value that is not safe to send (one with a line break, say) is left out rather than making the call throw.

### Outgoing request options

`tracedFetch` and `tracedFetcher` take the same options. All are off by default.

| Option             | Effect                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forwardRequestId` | Sends the current Request ID (the `requestId` Context Field) as `X-Request-Id`, so the receiver's `useLogger` can reuse it (if it passes that side's validation). It replaces any `X-Request-Id` already on the call, in `init` or on the `Request`, so forwarding `c.req.raw` sends your ID, not the client's. To send your own ID instead, leave this off and set the header. With no `requestId`, the headers are left alone. |
| `spans`            | Logs one Span per call, `span.end fetch`, with `method` (as `fetch` sends it: `patch` stays `patch`), `host`, `path` and the response `statusCode`. `path` is the pathname only, never the query string, which can carry tokens. The downstream work's parent span is this Span.                                                                                                                                                 |

On `tracedFetch`, `forwardRequestId` sends your Request ID to whatever host you call, third parties included.

A Span's status says whether the call completed, not what it answered. Any response, 5xx included, is `OK` (filter on `statusCode` to find failing responses; the receiver's own logs record its errors). A call that throws or rejects, such as a network failure, is logged at `ERROR` with the error, then the same error is rethrown. The error is logged as it is, since it is rethrown unchanged: if its message quotes the URL (`Failed to parse URL from /x?token=abc`), the query string is on that line. Like every Span, `span.end` is written only when the trace is sampled; for an unsampled trace a throw writes one `fetch failed` line at `ERROR` instead.

```json
{
  "level": "INFO",
  "message": "span.end fetch",
  "method": "GET",
  "host": "api.internal",
  "path": "/users/42",
  "statusCode": 200,
  "span": { "operation": "fetch", "duration": 12, "status": "OK", "...": "..." },
  "traceId": "...",
  "spanId": "...",
  "parentSpanId": "..."
}
```

### `loggerOptionsFromEnv(env, mapping?)`

Map Worker (or `process.env`) variables into `LoggerOptions`: `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION` by default (see [Cloudflare Worker Requirements](#cloudflare-worker-requirements) for fallbacks).

`mapping` overrides where each field comes from: `service`, `level`, `environment` or `version` take a var name or a function `(env) => string | undefined`. Fields you leave out keep their default var. A mapped field doesn't fall back to its default var. A number is used as its string form; an empty string or any other non-string value counts as absent.

```ts
import { createLogger, loggerOptionsFromEnv } from 'loggercf'

const logger = createLogger(loggerOptionsFromEnv(env))

// Read the version from another var:
createLogger(loggerOptionsFromEnv(env, { version: 'RELEASE' }))

// Or derive it, e.g. from a `version_metadata` binding:
createLogger(
  loggerOptionsFromEnv(env, {
    version: (e) => e.CF_VERSION_METADATA?.tag || e.CF_VERSION_METADATA?.id,
  }),
)
```

The `EnvMapping<Env>` type describes the mapping.

---

## Hono Middleware (`loggercf/hono`)

### `useLogger(loggerOrFactory, options?)`

Creates a Hono middleware that:

1. Picks the request ID: a valid incoming one, otherwise a new UUID (see [Request ID](#request-id))
2. Opens a Logging Context via `runWithLogger`, continuing `traceparent` / `tracestate` from the request
3. Adds `requestId` (and `cfRay` when the request has a `cf-ray` header) to the Logging Context's fields so they appear on every log line
4. Sets `c.var.logger`, `c.var.requestId`, and `c.var.traceId` for use in route handlers
5. Sets response headers: `X-Request-Id`, `X-Trace-Id`, `traceparent` (and `tracestate` when present)
6. Lets Hono own error responses, then writes one `request.end` with the final `c.res.status`, at a level picked from it (see [Request lines](#request-lines))

```ts
import { Hono } from 'hono'
import { useLogger } from 'loggercf/hono'
import { createLogger, loggerOptionsFromEnv, setLoggerContext, type Logger } from 'loggercf'

const app = new Hono()

// Option A: shared Root Logger (recommended)
app.use(useLogger(createLogger({ service: 'my-worker' })))

// Option B: build the Root Logger from c.env, once per isolate
let rootLogger: Logger | undefined
app.use(useLogger((c) => (rootLogger ??= createLogger(loggerOptionsFromEnv(c.env)))))

app.get('/', (c) => {
  setLoggerContext({ userId: 'u-42' })
  c.var.logger.info('Hello world') // includes traceId, spanId, userId
  return c.text('ok')
})
```

With a logger instance (Option A), `useLogger` registers it as the [Default Logger](#setdefaultloggerlogger) unless one is already set, so `getLogger()` outside a request logs with its `service`. A factory's logger (Option B) is not registered, because nothing guarantees it returns a Root Logger rather than a per-request child. Register it yourself with `setDefaultLogger`, or on Workers build it with `useLogger(defaultLoggerFromEnv())`, which needs no `c.env`.

#### Request ID

Any client can send an `X-Request-Id`, so `useLogger` only reuses one that looks like an ID. The first valid value wins, in this order:

1. Each source in `requestId.from`, in order. The default is `['x-request-id']`.
2. `c.var.requestId`, when an earlier middleware set it (for example `generateId`).
3. `requestId.generate(c)`, by default `crypto.randomUUID()`.

With `trustIncoming: false`, steps 1 and 2 are skipped and the ID is always generated.

Every value from steps 1 and 2 must pass `requestId.validate`. The default accepts 1 to 128 characters of `A-Z a-z 0-9 _ - = : .` (`/^[\w\-=:.]{1,128}$/`), which covers UUIDs and `cf-ray` values. A value that fails, such as a 100 KB string or one with spaces or quotes, is skipped, so the line, `c.var.requestId` and the `X-Request-Id` response header carry the next valid value or a generated one. When a non-empty value was rejected (by the checks, or by a `validate` that throws), every line of the request also gets `requestIdRejected: true`, so you can tell "the client sent a bad ID" from "the client sent none". An empty value, or a source that returns nothing, a non-string or throws, counts as "none". The rejected value itself is never logged; a `cf-ray` rejected as the request ID (through the `cf-ray` source in `from`) is not recorded as `cfRay` either. A source, `validate` or `generate` that throws never fails the request; each `useLogger()` writes at most one `WARN` for a throwing source or `validate` and one for a bad `generate` result, through its Root Logger (without the error message, which may echo the ID). `validate` must return `true` to accept: any other value, including a Promise, rejects.

Because the ID is echoed in the `X-Request-Id` response header, it must also be a safe header value (printable ASCII, no leading or trailing space) whatever `validate` says. The generated ID is not validated, but a `generate` that throws or returns a value that is not a safe header value (for example `''` or a string with a newline) is replaced by `crypto.randomUUID()`, with one `WARN` per `useLogger()`. So the line, `c.var.requestId` and the response header always agree.

```ts
import { Hono } from 'hono'
import { useLogger } from 'loggercf/hono'
import { createLogger } from 'loggercf'

const logger = createLogger({ service: 'api' })
const app = new Hono()

app.use(
  useLogger(logger, {
    requestId: {
      // a source is a header name (case-insensitive) or a function (c) => string | undefined
      from: ['cf-ray', 'x-request-id'], // prefer Cloudflare's Ray ID, then the client's header
      trustIncoming: true, // false: always generate; no header chooses the ID or adds cfRay (the Trace Carrier still applies)
      validate: /^[\w\-=:.]{1,128}$/, // or (id, c) => boolean; replaces the default, length cap included
      generate: () => crypto.randomUUID(),
    },
  }),
)
```

| Option          | Default               | Effect                                                                                                                      |
| --------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `from`          | `['x-request-id']`    | Sources to read, in order. `[]` reads none. `c.var.requestId` is always tried after them. An invalid header name throws.    |
| `trustIncoming` | `true`                | `false` always generates the ID: `from` and `c.var.requestId` are ignored, and `cfRay` is not recorded.                     |
| `validate`      | 1–128 of `\w - = : .` | A `RegExp` or `(id, c) => boolean`. Applies to `from` sources and `c.var.requestId`. Anchor a pattern and bound its length. |
| `generate`      | `crypto.randomUUID()` | `(c) => string`, called only when no source gives a valid ID.                                                               |

`trustIncoming: false` also ignores `c.var.requestId`, because a middleware such as `generateId({ contextKey: 'requestId', headerName: 'X-Request-Id' })` copies a client header into it. To trust an ID your own code computed, leave `trustIncoming` on and pass it as a function source in `from`.

When the request has a `cf-ray` header, its value is also recorded as `cfRay` on every line, whether or not it is the request ID (except with `trustIncoming: false`). Use it to look a request up in Cloudflare's own logs. It must pass the default format check above (a custom `validate` does not apply to it); otherwise `cfRay` is left out. Only trust `cf-ray` on requests that reach the Worker straight from Cloudflare's edge: a Worker called over a service binding `fetch` receives whatever headers the calling Worker sends, `cf-ray` included, and under `wrangler dev`, in tests or on Node.js a client can send any value.

#### Request lines

`useLogger` writes `request.start` when the request arrives and one `request.end` when it is done. A failed request is that same single `request.end`, with `err`: there is no separate `request.error` line.

| Field               | On         | Value                                                                                                                                                                    |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `method`            | start, end | `GET`, `POST`, ...                                                                                                                                                       |
| `path`              | start, end | The URL pathname. The query string is never logged, because it often carries tokens and personal data.                                                                   |
| `route`             | start, end | The matched route pattern, such as `/users/:id`, so requests to one endpoint can be grouped.                                                                             |
| `statusCode`        | end        | The final `c.res.status`, after `onError()` and `notFound()` ran. For a throw that escapes `useLogger`, an assumed `500` ([see below](#when-a-throw-escapes-uselogger)). |
| `statusCodeAssumed` | end        | `true` only when a throw escaped `useLogger`, so it could not see the response and `statusCode: 500` is an assumption. Absent otherwise.                                 |
| `duration`          | end        | Milliseconds spent in the handlers after `useLogger`, until they return the `Response` ([streamed bodies](#streamed-responses) end later).                               |
| `err`               | end        | The error Hono caught (`c.error`), when there is one, or the value thrown past `useLogger`.                                                                              |
| `originalErr`       | end        | When a throw escapes after Hono caught a different error (for example, `onError()` threw): the error Hono caught (`c.error`). `err` is then the value that escaped.      |
| `userAgent`         | start, end | With `include: { userAgent: true }`, when the request has a `User-Agent` header.                                                                                         |
| `cf`                | start, end | With `include: { cf: true }`: `{ colo, country, asn }` from `request.cf`, when present.                                                                                  |
| _yours_             | every line | The keys the `fields` option returns, as Context Fields.                                                                                                                 |
| _yours_             | end        | The keys the `endFields` option returns.                                                                                                                                 |

```ts
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { defaultRequestEndLevel, useLogger } from 'loggercf/hono'
import { createLogger } from 'loggercf'

const app = new Hono<{ Variables: { userId?: string } }>()

app.use(
  useLogger(createLogger({ service: 'api' }), {
    requestStart: false, // default true; false writes request.end only
    // default: error for a caught error or a 5xx, warn for a 4xx, info otherwise
    level: (status, err, c) =>
      err instanceof HTTPException && status < 500 ? 'warn' : defaultRequestEndLevel(status, err),
    fields: (c) => ({ tenant: c.req.header('x-tenant-id') }), // every line, from the start
    endFields: (c) => ({ userId: c.get('userId') }), // request.end only, after the handlers ran
    include: { userAgent: true, cf: true }, // off by default
  }),
)
```

| Option         | Default                  | Effect                                                                                                                                                                |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestStart` | `true`                   | `false` writes no `request.start`.                                                                                                                                    |
| `level`        | `defaultRequestEndLevel` | `(statusCode, err, c) => LogLevel` for `request.end`. The default is `error` when `c.error` is set or the status is 5xx, `warn` for 4xx, `info` otherwise.            |
| `fields`       | none                     | `(c) => fields`, synchronous, called before the handlers. Added as Context Fields, so they are on `request.start`, every line the handlers write, and `request.end`.  |
| `endFields`    | none                     | `(c) => fields`, synchronous, called after the handlers, so it sees `c.var` values they set. Added to `request.end` only.                                             |
| `include`      | `{}`                     | `{ userAgent?: boolean, cf?: boolean }`. Adds the `User-Agent` header and Cloudflare's `request.cf` `colo`, `country` and `asn` to `request.start` and `request.end`. |

Neither `fields` nor `endFields` can set the keys `useLogger` owns (its **Owned Keys**): `requestId`, `requestIdRejected`, `cfRay`, `method`, `path`, `route`, `statusCode`, `statusCodeAssumed`, `duration`, `err` and `originalErr`, plus `userAgent` and `cf` when `include` turns them on. Those keys are dropped from the hooks' results, even when the request has no value for them (no `cf-ray` header, no error). So that the removal stays visible, the first time each hook returns one, a WARN with `hook` and `droppedKeys` (the key names, never their values) reports it, once per hook per `useLogger()` call. For app data such as a user or tenant ID, use these hooks; for the request details Cloudflare provides, use `include`.

A hook result that sets `level`, `time` or `message` currently overrides that key of the record, on every line for `fields` and on `request.end` for `endFields`. Avoid those names until [#21](https://github.com/omerfardemir/loggercf/issues/21) settles how such keys are routed.

A throwing `HTTPException` sets `c.error`, so with the default `level` a `throw new HTTPException(401)` is logged at `error`. The example above logs those at `warn`.

**`route`** is the pattern of the endpoint the request was routed to, including a sub-app's base path (`/api/items/:id`), read from Hono's `matchedRoutes(c)`:

- On `request.end`, it is the route that answered, when that route was registered for a method (`app.get`, `app.post`, `app.on`, ...). A method-registered middleware ahead of the handler, such as `app.get('*', cache(...))`, does not hide the handler.
- Otherwise, and on `request.start` (written before any handler runs), it is the first route registered for a method among those that matched after `useLogger`. So a middleware registered with `app.use` that answers early (an auth check returning 401) still logs the handler's pattern, and a catch-all registered later (`app.get('*', spaFallback)`) does not replace it.
- When no method route matched, it is the last matched route: an `app.all()` handler's pattern, or, for a request no handler matched (a 404 from `notFound()`), the last matching middleware's, such as `/*` for `app.use(useLogger(...))`.

The two lines differ only when a method-registered middleware runs before the handler: `request.start` can only expect that middleware's pattern. Group by `route` on `request.end`.

So a cache-style `app.get('*', cache(...))` that answers a hit itself logs `route: '/*'` on that `request.end`, while a miss, answered by the handler, logs the handler's pattern. Register such a middleware with `app.use` if hits should be grouped under the handler's pattern too.

**When an option fails**, `useLogger` does not let the error reach your app and does not drop a line. A `fields` that throws, returns anything but a plain object or `undefined` (a Promise from an `async` function, a string, an array), or returns an object that throws while `useLogger` reads it (a throwing getter, a Proxy), leaves its fields off the request's lines; such an `endFields` leaves its fields off `request.end`; a `level` that throws or returns an unknown level uses the default level. Each option's first failure is reported in one WARN per `useLogger()` call, with `hook` naming the option and either `err` (what it threw; a non-`Error` value as `{ type, message }`) or `returned`; later failures of the same option are not repeated. For `fields` and `endFields`, `returned` is only the type of the result (`string`, `array`, `Promise`, `thenable`, ...), never the value, which could be a token. For `level`, it is the string returned only when it is a level name in the wrong case (such as `WARN`); any other string is reported as `string`, and anything else by its type. `useLogger` never calls `then` on a thenable that is not a `Promise` (from the same realm: on Node, a Promise built in another `vm` context counts as a thenable, so its rejection is not handled).

A value that cannot be written, such as one whose `toJSON` throws, is replaced on the line by an `[Unserializable: ...]` marker, so the line is kept. If a line still cannot be written (the sink itself throws), it is lost, but it never changes the response, and a thrown value `useLogger` rethrows stays the same. That covers `request.start`, `request.end` and the WARNs above.

`useLogger()` does not handle errors, or create or replace error responses. It lets Hono run downstream handlers and app-level `onError()` normally, then reads `c.error` and the final `c.res.status` after `await next()`. A throw that escapes `await next()` is logged and rethrown unchanged ([see below](#when-a-throw-escapes-uselogger)).

##### Streamed responses

For a streamed body (`stream()`, `streamText()`, `streamSSE()` from `hono/streaming`, or a `Response` with a `ReadableStream`), the handler returns the `Response` before the body is sent, and `request.end` is written then. So `duration` does not include the time spent streaming, and an error while streaming happens after `request.end`: it is not on that line. Log it from the stream's own error callback.

##### When a throw escapes `useLogger`

Hono turns a thrown `Error` into a response. A throw it does not handle (a non-`Error` value such as `throw 'boom'`, or an `onError()` that throws) makes `await next()` reject: `useLogger` still writes `request.end` at `error`, with `err` (an `Error` as usual, any other value as `{ type, message }`), then rethrows the same value unchanged. The `level` option is not called for it, and no response headers are set, because there is no response yet.

`useLogger` cannot see the response that is sent after that, so that line's `statusCode: 500` is an assumption (what a runtime answers an uncaught exception with), marked with `statusCodeAssumed: true`. The real status is decided above `useLogger`:

- An outer middleware that catches the throw sends whatever it sets: a `503`, or even a `200`, while the line says `ERROR` and `500`.
- When `onError()` throws an `Error`, Hono catches it one level up, at `useLogger`'s own middleware, and calls `onError()` again with that new error. So an `onError()` that throws `new HTTPException(502)` and answers an `HTTPException` with `err.getResponse()` sends a `502`. On that line, `err` is the `HTTPException` and `originalErr` is the handler's error that `onError()` was handling.
- With nothing above it, the runtime answers the uncaught exception, usually with a `500`.

---

## CF Workers RPC (`loggercf/workers`)

Propagate trace context across Cloudflare Worker service bindings using the **Session Factory pattern**.

### Why?

CF Workers RPC has no header/metadata channel. You can't attach a `traceparent` to `c.env.BIND.add(5, 7)`. The Session Factory solves this by passing the Trace Carrier via `binding.session({ traceparent, tracestate, fields })`, which returns an `RpcTarget` with the trace stored in a private field.

### `TracedSession<Env>`

Base class for RPC sessions. Extends `RpcTarget`. Your RPC methods go here.

```ts
import { TracedSession, tracedWorker } from 'loggercf/workers'

interface Env {
  NAME: string
  LOG_LEVEL: string
  ENVIRONMENT: string
  VERSION: string
}

class MySession extends TracedSession<Env> {
  async add(a: number, b: number): Promise<number> {
    return this.traced(() => {
      this.logger.info({ a, b }, 'Adding')
      return a + b
    }, 'my-service.add') // optional: operation name enables span logging
  }
}

export default tracedWorker(MySession)
```

**Key members:**

| Member                        | Description                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `this.traced(fn, operation?)` | Runs `fn` in a Logging Context continuing the caller's trace. Optional `operation` reports the call as a Span. |
| `this.logger`                 | Request-scoped logger (must be called inside `traced()`)                                                       |
| `this.env`                    | Worker env (bindings, vars) — for multi-hop RPC calls                                                          |

### `tracedWorker(SessionClass, options?)`

Creates a `WorkerEntrypoint` with a `session(init)` method that instantiates your session class. Zero boilerplate. `options.env` is an env mapping (see [`loggerOptionsFromEnv`](#loggeroptionsfromenvenv-mapping)); the env type comes from your session class.

```ts
// This is your entire worker export:
export default tracedWorker(MySession)

// Read other vars for the Root Logger:
export default tracedWorker(MySession, {
  env: {
    service: 'SERVICE_NAME',
    version: (env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id,
  },
})

// Or extend it if you need scheduled(), queue(), etc. (see withScheduled):
const nightly = withScheduled(async (controller, env: Env) => {
  /* ... */
})

export default class extends tracedWorker(MySession) {
  scheduled(controller: ScheduledController) {
    return nightly(controller, this.env, this.ctx)
  }
}
```

### `withTrace(binding, fn, fields?)`

**Caller-side** one-liner. Calls `binding.session({ ...getTraceCarrier(), fields })` and passes the session to your callback.

```ts
import { withTrace } from 'loggercf/workers'

// In a route handler or another traced() method:
const result = await withTrace(c.env.BIND, (s) => s.add(5, 7))

// With propagated fields — appear on all downstream logs:
const result = await withTrace(c.env.BIND, (s) => s.add(5, 7), { requestId: 'abc' })
```

### `tracedSession(binding, fields?)`

Lower-level alternative to `withTrace` — returns the session for multiple calls:

```ts
import { tracedSession } from 'loggercf/workers'

const session = tracedSession(c.env.BIND)
const a = await session.add(1, 2)
const b = await session.add(3, 4)

// With propagated fields:
const session = tracedSession(c.env.BIND, { requestId: 'abc' })
```

### Multi-Hop RPC

Sessions have access to `this.env`, so they can call other service bindings with `withTrace`:

```ts
class BindSession extends TracedSession<Env> {
  async multiHop(value: number): Promise<number> {
    return this.traced(async () => {
      // bind-worker → math-worker (trace propagates automatically)
      const multiplied = await withTrace(this.env.MATH, (s) => s.multiply(value, 3))
      const divided = await withTrace(this.env.MATH, (s) => s.divide(multiplied, 2))
      return divided
    }, 'bind.multiHop')
  }
}
```

All workers in the chain share the same `traceId`.

### `TracedEntrypoint<Env>`

Alternative to `tracedWorker()` for manual entrypoint setup. Extends `WorkerEntrypoint` and provides `this.loggerOptions` from env vars (`NAME`, `LOG_LEVEL`, `ENVIRONMENT`, `VERSION`) and `this.rootLogger`, built from them once per isolate. Its constructor registers `this.rootLogger` as the [Default Logger](#setdefaultloggerlogger) unless one is already set, so `getLogger()` in `scheduled()`, `queue()` or a plain RPC method logs with its `service`; `tracedWorker()` does the same. Because the constructor reads `rootLogger` until a default is set, build `envMapping` / `loggerOptions` overrides from `this.env`, not from subclass instance fields. Override the `envMapping` getter to read other vars (same mapping as [`loggerOptionsFromEnv`](#loggeroptionsfromenvenv-mapping)), or override `loggerOptions` to build the options yourself.

```ts
import {
  TracedEntrypoint,
  TracedSession,
  type EnvMapping,
  type SessionInit,
} from 'loggercf/workers'

class MySession extends TracedSession<Env> {
  /* ... */
}

export default class extends TracedEntrypoint<Env> {
  protected override get envMapping(): EnvMapping<Env> {
    return { version: (env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id }
  }

  session(init: SessionInit) {
    return new MySession(init, this.rootLogger, this.env)
  }

  scheduled(controller: ScheduledController) {
    return nightly(controller, this.env, this.ctx) // a withScheduled() handler
  }
}
```

### `defaultLoggerFromEnv(mapping?)`

The zero-config way to get a [Default Logger](#setdefaultloggerlogger) on Workers. It reads the Worker's `env` through `import { env } from 'cloudflare:workers'`, so it works at module scope and in code that never receives `env`. It builds the Root Logger from `loggerOptionsFromEnv(env, mapping)`, registers it as the Default Logger unless one is already set, and returns it.

```ts
import { Hono } from 'hono'
import { getLogger } from 'loggercf'
import { useLogger } from 'loggercf/hono'
import { defaultLoggerFromEnv } from 'loggercf/workers'

const logger = defaultLoggerFromEnv() // NAME, LOG_LEVEL, ENVIRONMENT, VERSION
// or: defaultLoggerFromEnv({ version: (env) => env.CF_VERSION_METADATA.id })

const app = new Hono()
app.use(useLogger(logger))

getLogger().info('module scope') // service, environment and version from env
```

The Root Logger is created once per Logger Options and is the same instance `TracedEntrypoint`, `tracedWorker` and `withLogging` use for the same env. `mapping` takes the same [Env Mapping](#loggeroptionsfromenvenv-mapping) as `loggerOptionsFromEnv`; its env type defaults to `Cloudflare.Env` (from `wrangler types`). A `setDefaultLogger` call made before it keeps its logger as the default; one made after it replaces it.

### `withLogging(Class, options?)`

Opens a Logging Context around every public method of an existing `WorkerEntrypoint`, without changing its callers. Use it for RPC Workers that have not moved to Traced Sessions yet: without it, their methods run outside every Logging Context, so their lines have no `traceId`, no Context Fields, and `setLoggerContext` is ignored. It wraps [Durable Objects](#durable-objects) too.

```ts
import { WorkerEntrypoint } from 'cloudflare:workers'
import { getLogger } from 'loggercf'
import { withLogging } from 'loggercf/workers'

class SearchWorker extends WorkerEntrypoint<Env> {
  async search(q: string): Promise<string[]> {
    getLogger().info({ q }, 'searching') // service, traceId, spanId, rpcMethod, entrypoint
    return []
  }
}

export default withLogging(SearchWorker, { spans: true })
```

- Each RPC method call, and `fetch`, gets its own Logging Context from the isolate's Root Logger, built with `loggerOptionsFromEnv(this.env, options.env)` and shared with `TracedEntrypoint` and `tracedWorker`. Every line in it carries the Context Fields `rpcMethod` (the method name) and `entrypoint` (the class name).
- A plain RPC call carries no Trace Carrier, so each call starts a new root trace. `fetch` continues an incoming `traceparent` header.
- If `fetch` hands the request to a Hono app that uses `useLogger` (`fetch(req) { return app.fetch(req, this.env, this.ctx) }`), pass `fetch: false`. `useLogger` opens its own Logging Context and continues `traceparent` itself; with `fetch` wrapped as well, one request is split into two root traces. With `fetch: false`, `fetch` is inherited unchanged and the RPC methods are still wrapped.
- A method called while any Logging Context is active joins that context, as a child Span when `spans` is on, and adds no `rpcMethod` or `entrypoint` of its own. That covers a public method called from another one (`this.normalize(q)`) and a call made inside another helper's context (from a [`withScheduled`](#withscheduledhandler-options) handler, say). Inside another method's context, its lines keep the caller's `rpcMethod`: when `nested()` calls `this.search()`, the child Span is `X.search`, but every line in it says `rpcMethod: 'nested'`.
- A call that throws or rejects is always logged at `ERROR` with `err`, then rethrown unchanged. With `spans`, that is its `span.end` line. Without, it is one `<Class>.<method> failed` line (`SearchWorker.search failed`) with `operation`, `err` and the call's Context Fields, written by the call that opened the Logging Context; a nested call leaves it to that one, so each error is logged once.
- The class is wrapped, not changed: arguments, return values (sync or async, an `RpcTarget` or a stub included) and thrown errors pass through as they are. The returned class has exactly the RPC methods `Class` has. `scheduled`, `queue`, `tail` and the other handlers are inherited unchanged; they log through the [Default Logger](#setdefaultloggerlogger), which the constructor registers unless one is already set (first seen wins).
- `entrypoint` is the class's `name`. A build that minifies class names changes it. An anonymous class (`withLogging(class extends WorkerEntrypoint { ... })`) gets no `entrypoint` field, and its Spans are named by the method alone.
- Only the methods the class has when it is wrapped are wrapped. Put every RPC method on the class before wrapping it. A method added or overridden in a subclass of the wrapped class (`class Ext extends withLogging(A) { extra() {} }`) runs outside every Logging Context, so extend the wrapped class only to add handlers.
- The class must extend `WorkerEntrypoint` or `DurableObject` (see [Durable Objects](#durable-objects)). Wrapping anything else throws.
- A `TracedEntrypoint` subclass keeps its own `rootLogger`, so its `envMapping` / `loggerOptions` overrides apply. Passing `env` as well throws; override `envMapping` instead.
- Wrapping a class that `withLogging` returned gives back the same class when the options are the same (`spans`, `session`, `fetch` and `env`), and throws when they differ. Wrapping a subclass of one throws too. This keeps each call to one `span.end`.
- With `session: true`, a field the caller passes named `rpcMethod` or `entrypoint` is replaced by the receiver's.
- Only method calls are wrapped. A method named like a handler (`trace`, `test`, `email`, `connect`, `queue`, `tail` or `tailStream`) is never wrapped. These run outside the Logging Context: a getter read over RPC, and the body of an `async *` method, which runs on each `.next()`, after the call has returned. A sync method that returns an un-awaited `RpcPromise` gets a span that ends when the method returns, not when the promise settles (`spans` treats only a real `Promise` as async). Make the method `async` and `await` the call to time it.

| Option    | Default | Description                                                                                                                                                                                                                                                                                                |
| --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spans`   | `false` | Record each call as a [Span](#span-logging) named `<Class>.<method>`: one `span.end` with duration and status, at `ERROR` with `err` when the method throws or rejects. Without it, a throw is still logged, as one `<Class>.<method> failed` line at `ERROR`. The error is rethrown unchanged either way. |
| `session` | `false` | Add `session(init)`, which returns a Traced Session over the same methods (see below). Throws if the class already has a `session` method or getter, own or inherited.                                                                                                                                     |
| `fetch`   | `true`  | Wrap `fetch` in its own Logging Context. Pass `false` when `fetch` hands the request to a Hono app that uses `useLogger`, which opens one itself.                                                                                                                                                          |
| `env`     | `{}`    | [Env Mapping](#loggeroptionsfromenvenv-mapping) for the Root Logger.                                                                                                                                                                                                                                       |

#### Durable Objects

`withLogging` takes a `DurableObject` subclass too. `fetch`, every RPC method, `alarm`, `webSocketMessage`, `webSocketClose` and `webSocketError` each run in their own Logging Context, with the Context Fields `rpcMethod` (the method or handler name), `durableObject` (the class name), `objectId` (`ctx.id.toString()`, always) and, for an object reached with `getByName` / `idFromName`, `objectName` (`ctx.id.name`). Join lines on `objectId` for any object, or on `objectName` for named ones.

```ts
import { DurableObject } from 'cloudflare:workers'
import { getLogger } from 'loggercf'
import { withLogging } from 'loggercf/workers'

class Room extends DurableObject<Env> {
  async join(user: string) {
    getLogger().info({ user }, 'joined') // ..., rpcMethod, durableObject: 'Room', objectId, objectName
  }

  async alarm() {
    getLogger().info('alarm') // its own Logging Context, rpcMethod: 'alarm'
  }
}

const LoggedRoom = withLogging(Room, { spans: true })
export { LoggedRoom as Room } // the class_name in wrangler.jsonc
```

- A call on a stub carries no Trace Carrier, so RPC methods, `alarm` and the WebSocket handlers start a new root trace. `fetch` continues an incoming `traceparent` header (pass it from the caller, as in the `/durable-object` route of `dev/main-worker`); `fetch: false` leaves it unwrapped, as for an entrypoint.
- `spans`, `fetch` and `env` work as above. `session` is not available: the object gets no RPC method it did not have. `connect` is inherited unchanged.
- The constructor, and code it runs in `blockConcurrencyWhile`, runs outside every Logging Context and logs through the Default Logger.
- `wrangler types` refers to the export as a type (`DurableObjectNamespace<import('./src/index').Room>`), and a `const` holding the wrapped class is only a value. Write `export const Room = withLogging(class Room extends DurableObject<Env> { ... })` and `export type Room = InstanceType<typeof Room>`: the named class expression keeps `durableObject: 'Room'`, and the type alias gives `wrangler types` its type (see `dev/main-worker/src/units.ts`).

#### Migrating to Traced Sessions one caller at a time

Traced Sessions change both sides of a call at once. In an app with many RPC Workers and call sites, migrate in three steps instead:

1. **Wrap the receiver** with `withLogging(SearchWorker, { spans: true })`. Every call now logs with `service`, a `traceId` and `rpcMethod`, and no caller changes. Each call is still a new root trace.
2. **Add `session()` on the receiver** with `withLogging(SearchWorker, { spans: true, session: true })`. The entrypoint gains a `session(init)` method; callers that call `env.SEARCH.search(q)` directly keep working.
3. **Move callers to `tracedSession` one at a time.** Change `env.SEARCH.search(q)` to `withTrace(env.SEARCH, (s) => s.search(q))`, or `tracedSession(env.SEARCH)` for several calls. That caller's calls now continue its trace: the receiver's lines carry the caller's `traceId`, `parentSpanId` is the caller's span, and Context Fields passed to `withTrace` arrive too.

```ts
import { withTrace, type TracedServiceBinding } from 'loggercf/workers'

interface SearchService {
  search(q: string): Promise<string[]>
}

interface Env {
  // Both call styles work during the migration.
  SEARCH: SearchService & TracedServiceBinding<SearchService>
}

async function lookup(env: Env) {
  const before = await env.SEARCH.search('cats') // not migrated: a new root trace in SEARCH
  const after = await withTrace(env.SEARCH, (s) => s.search('cats')) // continues this trace
  return [before, after]
}
```

Once every caller uses a Traced Session, you can stay on `withLogging`, or move the methods into a `TracedSession` subclass with `tracedWorker()` to name each Span yourself with `this.traced(fn, 'op')`. Callers do not change again.

### `withScheduled(handler, options?)`

Runs a `scheduled` (cron) handler in a Logging Context. Each run starts a new root trace, carries the Context Fields `cron` and `scheduledTime` (ms since the epoch), and is recorded as one Span, `span.end scheduled`: `INFO` with its duration, or `ERROR` with `err` when the handler throws or rejects. A new root trace is always sampled, so the Span is always written.

```ts
import { getLogger } from 'loggercf'
import { withScheduled } from 'loggercf/workers'

export default {
  fetch: app.fetch,
  scheduled: withScheduled(async (controller, env: Env) => {
    getLogger().info('nightly cleanup') // service, traceId, cron, scheduledTime
  }),
} satisfies ExportedHandler<Env>
```

- The Root Logger comes from the handler's `env` through `loggerOptionsFromEnv(env, options.env)`, cached per isolate and registered as the [Default Logger](#setdefaultloggerlogger) unless one is already set (first seen wins).
- The handler gets the same arguments; its return value is returned and a throw rethrown unchanged. It never calls `controller.noRetry()`.
- On a class entrypoint (`WorkerEntrypoint`, `TracedEntrypoint`, `tracedWorker(...)`, `withLogging(...)`), wrap the handler once at module scope and call it from the method with `this.env` and `this.ctx`:

```ts
const nightly = withScheduled(async (controller, env: Env) => {
  /* ... */
})

export default class extends WorkerEntrypoint<Env> {
  scheduled(controller: ScheduledController) {
    return nightly(controller, this.env, this.ctx)
  }
}
```

Locally, `wrangler dev` runs it on `GET /cdn-cgi/handler/scheduled?cron=*+*+*+*+*`.

### `withQueueMessage(batch, message, fn, options?)`

Runs the work for one queue message in its own Logging Context. Call it inside your own loop: it never iterates the batch and never calls `ack`, `retry`, `ackAll` or `retryAll`. Your code decides those.

```ts
import { getLogger, getTraceCarrier } from 'loggercf'
import { withQueueMessage } from 'loggercf/workers'

// Producer, inside a Logging Context: put the Trace Carrier under `trace`
await env.ORDERS.send({ ...order, trace: getTraceCarrier() })

// Consumer
export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      await withQueueMessage(batch, message, async () => {
        getLogger().info('processing') // ..., traceId, queue, messageId, attempts
        message.ack()
      })
    }
  },
} satisfies ExportedHandler<Env, Order>
```

- Context Fields: `queue` (the batch's queue name), `messageId` and `attempts`.
- When the body has a Trace Carrier under `trace`, the message continues the producer's trace (its `parentSpanId` is the producer's span). Otherwise it starts a new root trace. The body is never changed.
- Each call is one Span, `span.end queue.message`: `INFO` with its duration, `ERROR` with `err` when `fn` throws or rejects. `fn`'s value is returned and a throw rethrown unchanged, so a message you neither `ack` nor `retry` follows the queue's own rules.
- It takes the batch because a message does not know its queue's name.
- For an unsampled trace (`traceFlags` `00`) the `span.end` timing line is skipped, but a throw is still logged: one `queue.message failed` line at `ERROR` with `err` and a `span` object without timing (`operation`, `status: 'ERROR'`, `error`). A new root trace is always sampled.
- `await` (or return) every call. The batch is acked implicitly when `queue` returns, so with a missing `await` the handler can return, and the batch be acked, while the work is still running, and its throw is lost.
- Running the messages concurrently is safe: `await Promise.all(batch.messages.map((m) => withQueueMessage(batch, m, () => handle(m))))`. Each call has its own Logging Context, so Context Fields and traces never mix between messages.
- The Root Logger is built from the Worker's env (`import { env } from 'cloudflare:workers'`, as [`defaultLoggerFromEnv`](#defaultloggerfromenvmapping) reads it) with `options.env` as the Env Mapping, and registered as the Default Logger unless one is already set.

### `withWorkflow(Class, options?)` and `tracedStep(step, name, ...)`

`withWorkflow` returns a subclass of a `WorkflowEntrypoint` whose `run(event, step)` runs in a Logging Context with the Context Field `workflowInstanceId`. `tracedStep(step, name, [config], callback, [rollbackOptions])` calls `step.do` with the same arguments (and the same overloads, so a delay-function config narrows the callback's `ctx` as `step.do` does) and records each attempt as a Span named after the step, with the Context Fields `step`, `stepCount` (the engine's `ctx.step.count`: which call of a step with this name it is, so a name repeated in a loop is told apart) and `attempt`.

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { getLogger, getTraceCarrier } from 'loggercf'
import { tracedStep, withWorkflow } from 'loggercf/workers'

export const Report = withWorkflow(
  class Report extends WorkflowEntrypoint<Env, Params> {
    async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
      const rows = await tracedStep(step, 'fetch rows', async () => fetchRows(event.payload))
      await tracedStep(step, 'send', { retries: { limit: 3, delay: '5 seconds' } }, async (ctx) => {
        getLogger().info({ rows: rows.length }, 'sending') // workflowInstanceId, step, stepCount, attempt
      })
    }
  },
) // the class_name in wrangler.jsonc
export type Report = InstanceType<typeof Report> // for `wrangler types`

// Creator, to continue its trace in the Workflow:
await env.REPORT.create({ params: { ...params, trace: getTraceCarrier() } })
```

- The engine calls a step's callback back over RPC, outside the Logging Context `run` opened. `tracedStep` re-enters it, so lines in the callback carry `workflowInstanceId` and the run's trace, and the step's Span is a child of the run's span. A plain `step.do` callback logs outside every Logging Context.
- Each attempt writes its own `span.end <step>`: `ERROR` with `err` for an attempt that throws (the error is rethrown so the engine retries), `INFO` for the one that succeeds. For an unsampled trace (`traceFlags` `00`) the `span.end` timing line is skipped, but a throw is still logged: one `<step> failed` line at `ERROR` with `err` and a `span` object without timing (`operation`, `status: 'ERROR'`, `error`). A step the engine already has a result for (on a replay) runs no callback and writes nothing.
- A rollback handler (`rollbackOptions.rollback`) also arrives over RPC; `tracedStep` re-enters the run's Logging Context for it as a Span `rollback <step>`, with `step`, `stepCount` and `rollback: true`. A function-valued `retries.delay` is not wrapped: it runs outside every Logging Context (its lines carry no trace), so keep it a pure computation of the delay.
- Replay and determinism are kept: `step.do` is called once per `tracedStep`, with the same name and the same config object, and the callback's value or error passes through unchanged. The rollback options are passed as a copy with the handler wrapped (the same `rollbackConfig` object); your object is not changed. No step is added, and nothing random reaches a step's name or config.
- When the payload has a Trace Carrier under `trace`, `run` continues it, so every replay of one instance shares the creator's `traceId`. Without one, each execution of `run` (every replay after a sleep, wait or restart) starts a new root trace, so one instance's lines span several `traceId`s: join them on `workflowInstanceId`, or pass `trace: getTraceCarrier()` to `create()`.
- `run` itself writes no Span: it is replayed from the top after every sleep and wait, and a pause or termination surfaces in it as a throw. Lines logged in `run` outside a step repeat on each replay.
- **A throw outside every `tracedStep` is not logged.** That covers validation before the first step, code between steps, and a plain `step.do`. The engine uses thrown errors in `run` for its own control flow (pause, terminate, restart; locally these are `Error`s whose message starts with `Aborting engine:`), and neither `@cloudflare/workers-types` nor the Workflows docs define a marker that tells them apart from your errors in production, so `withWorkflow` does not log when `run` rejects rather than log engine control as `ERROR`. Such a throw still fails the instance and shows as its error in the Workflows dashboard and `instance.status()`. Put every unit of work, validation included, in a `tracedStep`, which logs each failed attempt.
- `run` must be a method, not a class field. The Root Logger comes from the Workflow's `env` with `options.env`, registered as the Default Logger in the constructor unless one is already set. Wrapping the result again with the same options returns it; a subclass of it throws. As for Durable Objects, add `export type Report = InstanceType<typeof Report>` if `wrangler types` refers to the export as a type.
- Outside a Logging Context (a class not wrapped with `withWorkflow`), `tracedStep` calls `step.do` with the arguments untouched and logs nothing.

### Service Type Convention

Define shared service method interfaces and use `TracedServiceBinding<T>` for Worker bindings:

```ts
import type { TracedServiceBinding } from 'loggercf/workers'

export interface BindService {
  add(a: number, b: number): Promise<number>
  multiHop(value: number): Promise<number>
}
```

Then type your env bindings:

```ts
interface Env {
  BIND: TracedServiceBinding<BindService>
  MATH: TracedServiceBinding<MathService>
}
```

---

## Span Logging

Pass an operation name as the second argument to `traced()` to report the RPC call as a Span (or use `withSpan()` for a sub-operation anywhere in a Logging Context):

```ts
return this.traced(() => {
  // your logic
  return result
}, 'math.multiply')
```

Emits a span-end log on completion:

```json
{
  "level": "INFO",
  "span": {
    "operation": "math.multiply",
    "startTime": 1777021502058,
    "endTime": 1777021502059,
    "duration": 1,
    "status": "OK"
  },
  "message": "span.end math.multiply",
  "traceId": "...",
  "spanId": "...",
  "parentSpanId": "..."
}
```

On error, `status` is `"ERROR"` with an `error` field, logged at error level.

The span object intentionally does **not** duplicate `traceId`/`spanId`/`parentSpanId` — those are already on every log line.

Outgoing HTTP calls can be Spans too: pass `spans: true` to `tracedFetch` or `tracedFetcher` (see [Outgoing request options](#outgoing-request-options)).

Span logging is **optional**. Without an operation name, `traced()` only opens the Logging Context. `span.end` lines are skipped when the trace is unsampled (`traceFlags` bit 0 unset), but a throw never is: for an unsampled trace a Span that throws writes one `<operation> failed` line at `ERROR`, with `err` and a `span` object without timing (`operation`, `status: 'ERROR'`, `error`).

```json
{
  "level": "ERROR",
  "message": "db.query failed",
  "operation": "db.query",
  "err": { "type": "Error", "message": "...", "stack": "..." },
  "traceId": "...",
  "spanId": "..."
}
```

---

## Log Output

### Call styles

Both styles work, and can be mixed. **No argument is ever dropped**: every value you pass ends up in one documented place in the line. One gap remains inside values, until [#8](https://github.com/omerfardemir/loggercf/issues/8): an `Error` nested inside a field is written as `{}` (see [The line](#the-line)).

```ts
// Structured (recommended for fields you want to query): fields or an Error first, then the message
logger.info({ userId: 'u-42' }, 'user signed in')
logger.error(err, 'charge failed')
logger.error({ err, orderId: 'o-1' }, 'charge failed')

// Console style: the message first, then anything
logger.info('user signed in', { userId: 'u-42' }) // {"message":"user signed in","userId":"u-42"}
logger.error('charge failed', err) // {"message":"charge failed","err":{...}}
logger.info('user %s signed in', 'ada', { plan: 'pro' }) // {"message":"user ada signed in","plan":"pro"}
logger.error('scope', 'Failed to create task', { detail: 'x' }) // {"message":"scope Failed to create task","detail":"x"}
logger.info('items', [1, 2, 3]) // {"message":"items","args":[[1,2,3]]}
logger.error('two failures', e1, e2) // {"err":{...e1},"errors":[{...e2}],...}
```

The message supports `printf` placeholders: `%s` (string), `%d` / `%f` (number), `%i` (integer), `%j` / `%o` / `%O` (JSON), `%%` (a literal `%`, when there are arguments). Each placeholder takes the next argument. `%s`, `%d`, `%i` and `%f` don't print an object or an array (an `Error` or a `Date` included): the placeholder stays in the text and the value is routed like a later argument, so its fields are kept (`logger.info('n=%d', { a: 1 })` → `{"message":"n=%d","a":1}`). `%d`, `%i` and `%f` don't print a function or a string that isn't a number either (`NaN` would lose it): `logger.info('id=%d', 'abc')` → `{"message":"id=%d abc"}`. `%s` prints a function's source, and `%d` / `%i` print a `BigInt` exactly. Use `%j` to print an object inline. `%j`, `%o` and `%O` don't print an `Error` (JSON would write `{}`), or a value JSON can't write as it is (a `BigInt`, a function or a symbol inside it, a circular reference, a getter or a `toJSON` that throws): that value is routed the same way, so `logger.error('failed: %o', err)` keeps `err` with its stack, and a circular object keeps all its keys. A `Map` prints as `[key, value]` pairs and a `Set` as an array. Primitives print exactly as with `printf`. Any other `%` sequence takes an argument too (as `50% off %s` does), and that argument is routed like a later one: write `50%% off %s`.

In a `catch`, where the error is `unknown`, `logger.error(e)`, `logger.error(e, 'msg')`, `logger.error({ err: e }, 'msg')` and `logger.error('msg', e)` all compile. Otherwise the first argument must be a string, an `Error` (a `string | Error`, `Error | undefined` or `Error | null` union is fine) or an object: `logger.info(42)` does not compile. An unset `Error | undefined` followed by the message writes nothing, and the message is still formatted: `logger.error(maybeErr, 'failed %s', id)` → `{"message":"failed id1"}`. Without a string after it (alone, or before anything else), it is a leading primitive, like a number: `String(value)` is the message, the value is in `args` (as `null`), and the arguments after it are routed as usual. So `logger.error(maybeErr)` → `{"message":"undefined","args":[null]}`, `logger.info(undefined, { a: 1 })` → `{"message":"undefined","a":1,"args":[null]}` and `logger.info(null, 42)` → `{"message":"null 42","args":[null]}`.

A `Logger<T>` whose `T` is still a type parameter (inside a function generic over `T`) can't take a structured call: the fields can't be checked against an unresolved `T`. Console-style and `Error`-first calls still work; for fields, use `Logger` or a concrete `Logger<AppFields>`.

### Where each argument goes

| Argument                                                                                                                                                                                                                                                     | Goes to                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **First**: a string                                                                                                                                                                                                                                          | the message (with placeholders)                                                  |
| **First**: an `Error`                                                                                                                                                                                                                                        | `err`; the message defaults to `err.message`                                     |
| **First**: a plain object                                                                                                                                                                                                                                    | its keys, at the top level                                                       |
| **First**: a number, boolean or `BigInt`                                                                                                                                                                                                                     | `args`, and `String(value)` is the message                                       |
| **First**: `undefined` or `null` followed by a string (e.g. an `Error \| undefined` that is unset)                                                                                                                                                           | nothing; the string is the message (with placeholders)                           |
| **First**: `undefined` or `null` alone or before a non-string (the arguments after it are routed as usual, as after a number)                                                                                                                                | `args`, and `String(value)` (`"undefined"` / `"null"`) is the message            |
| **First**: anything else (array, class instance, function, symbol)                                                                                                                                                                                           | `args`                                                                           |
| **Second**, after a first `Error`, plain object, array, class instance, function or symbol: a string                                                                                                                                                         | the message (with placeholders)                                                  |
| **Second**, after a first `Error`, plain object, array, class instance, function or symbol: `undefined` or `null`                                                                                                                                            | `args`                                                                           |
| **Any later argument** a placeholder takes                                                                                                                                                                                                                   | the message                                                                      |
| **Later**: an `Error`                                                                                                                                                                                                                                        | `err` if not set yet, otherwise `errors: [...]`                                  |
| **Later**: a plain object                                                                                                                                                                                                                                    | its keys, at the top level (a later object wins over an earlier one)             |
| **Later**: a string, number, boolean, `null`, `undefined`, `BigInt`                                                                                                                                                                                          | appended to the message after a space, like `console.log('a', 'b', 3)` → `a b 3` |
| **Later**: anything else (array, class instance, `Date`, function, symbol)                                                                                                                                                                                   | `args`                                                                           |
| A placeholder that can't print its argument (`%d` with `null` or `'abc'`, `%j` with `undefined`, `%s` / `%d` / `%i` / `%f` with an object or array, `%d` / `%i` / `%f` with a function, `%j` / `%o` / `%O` with an `Error`, a `BigInt` or a circular object) | the placeholder stays in the text; the argument is routed like a later one       |

`args` (the overflow) is an array in call order, present only when something went there. An object can't set the moved keys: the record keys (`time`, `level`, `message`, `errors`, `args`, see [The line](#the-line)), `service`, `environment`, `version`, `traceId`, `spanId` and `parentSpanId`. Those keys of an object move to `args`, as one object per argument. Two keys are taken from an object while they are still unset: `err`, and a string `message` when the call gives no other message (`logger.info({ message: 'hi' })`). An own `__proto__` key (as `JSON.parse` creates) and a `toJSON` method also move to `args`, the method as `"[Function: toJSON]"`, so neither can change or replace the line.

```ts
logger.info('x', { level: 'custom', traceId: 'mine', a: 1 })
// {"level":"INFO","a":1,"message":"x","traceId":"<real>",...,"args":[{"level":"custom","traceId":"mine"}]}
```

### The line

Every runtime builds the same JSON line, one per log call (covered by a test that compares the two):

- Starts with `time` (ISO 8601) and `level` (`TRACE` … `FATAL`); no `pid` or `hostname`.
- When keys collide: loggercf always writes `time`, `level`, `message`, `errors` and `args` itself (the record keys), and the trace IDs (`traceId`, `spanId`, `parentSpanId`) inside a Logging Context. Logger bindings and Context Fields can't set them either: their values for the record keys move to `args` (after the call's own `args`, logger bindings first), so a `.child({ level: 'ERROR' })` can't change a line's severity. For every other key, strongest first: fields passed to the log call (which can't set `service`, `environment` or `version`, see above) → logger bindings (`createLogger` / `.child()`) → Context Fields.
- Errors become `{ type, message, stack, ...own fields (e.g. code), errors, cause }`, with `cause`, an `AggregateError`'s `errors` and every own field that is an `Error` nested the same way, up to 5 levels: at the top level, in `errors`, and inside `args` items (e.g. `args: [{ err }]`). An `Error` that refers back to itself (`err.self = err`, a `cause` loop) is `"[Circular]"` where it loops. The same `Error` passed more than once is a repeat (see below).
- An `Error` nested inside a field, deeper than the places above, is written as `{}` until [#8](https://github.com/omerfardemir/loggercf/issues/8): `logger.error('m', { failures: [e1], ctx: { err: e2 } })` writes `failures: [{}]` and `ctx: { err: {} }`. Pass such errors as arguments (`logger.error('m', e1, e2)`), or as a top-level `err`.
- An `undefined` property is left out, as JSON leaves it out: `{ a: undefined, b: 1 }` writes only `b`, as a field and under `%j` alike. An `undefined` array item is `null`.
- `BigInt` is written as a string, a function as `"[Function: name]"` (`"[Function: anonymous]"` without a name), a symbol as `"Symbol(description)"` (boxed or not), a `Map` as an array of `[key, value]` pairs and a `Set` as an array.
- An object that contains itself is written as `"[Circular]"` where it loops. An object that appears more than once without a loop (`{ p: shared, q: shared }`, the same `Error` twice, an object whose `toJSON` returns a new object each time) is written in full each time, within a budget per line: 10,000 values, or 65,536 characters of keys and strings, written again inside repeats at any depth. A string of 1,024 characters or more that the line already holds counts its length against the same budget; shorter strings repeat freely. The line has one budget, which the message's `%j` / `%o` / `%O` placeholders spend from too. A repeat that doesn't fit the budget is `"[Repeated]"` as a whole (never cut part way), so a wide or deeply shared structure adds at most that budget to the line.
- A log call never throws. A value that can't be read or serialized (a getter or a `toJSON` that throws, a `Proxy` whose traps throw) is written as `"[Unserializable: <reason>]"`, in place of that value only: the rest of the line, `err` included, is kept. Logger bindings are read once, when `.child()` or `createLogger` is called, the same way. A minimal line is the last resort, for a failure no single value explains: a value nested so deep that writing it overflows the stack, a line too long to build as a string (`Invalid string length`), or the output itself failing (the console method throws). It has `time`, `level`, the trace IDs, the logger bindings, the message template as given, and `logError` describing the failure.

Only the final write differs, detected at startup:

- **CF Workers** (`navigator.userAgent === 'Cloudflare-Workers'`): `console.debug` / `info` / `warn` / `error` by level, so Cloudflare assigns the right severity.
- **Node.js**: `console.log` for every level (stdout).

---

## Agent skill

The package ships an [Agent Skill](https://agentskills.io) at `skills/loggercf/SKILL.md` for AI coding agents working in your project. It covers which API fits each unit of work (Hono, Worker RPC, queues, cron), the rules the types can't express (one Root Logger per isolate, per-request data in Context Fields, `this.traced` around every RPC method, log call shape) and the Wrangler setup. For signatures it points back to this README.

With pnpm 12.11 or later, run `pnpm approve` after installing and approve `loggercf`'s skills. pnpm then links the skill into your agents' skill directories (`.claude/skills`, `.cursor/skills`, `.agents/skills`, ...). See [pnpm's agent skills docs](https://pnpm.io/agent-skills).

---

## Development

```
loggercf/
├── src/                  # loggercf source and colocated *.test.ts
│   ├── index.ts          # Core entry: logger, Logging Context, Trace Carrier, types
│   ├── hono.ts           # loggercf/hono entry
│   └── workers.ts        # loggercf/workers entry
├── dev/                  # Local Worker fixtures for e2e verification (not published)
│   ├── services.d.ts     # Shared RPC service interfaces
│   ├── main-worker/      # Gateway worker (Hono + routes)
│   ├── bind-worker/      # Mid-tier worker (single + multi-hop RPC, HTTP over its binding)
│   └── math-worker/      # Leaf worker (multiply, divide)
├── skills/loggercf/     # Agent skill shipped in the package
├── scripts/e2e-local.mjs # Starts the dev workers, probes trace propagation, checks their logs
└── docs/                 # Design deep-dives
```

The dev workers import `loggercf` by package name, which resolves to this package's built `dist/` — run `pnpm build` before `pnpm dev`.

| Script                             | Purpose                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm build`                       | Build `dist/` with tsdown                                                    |
| `pnpm test`                        | Run unit tests (Vitest)                                                      |
| `pnpm typecheck` / `typecheck:dev` | Typecheck the package / the dev workers (needs a build)                      |
| `pnpm check:skill`                 | Typecheck the ts snippets in `skills/**/SKILL.md` (needs a build)            |
| `pnpm lint` / `lint:fix`           | Lint with oxlint                                                             |
| `pnpm format` / `format:check`     | Format with oxfmt                                                            |
| `pnpm dev`                         | Run all three dev workers on `http://localhost:8787`                         |
| `pnpm e2e:local`                   | Build, start the dev workers, assert trace propagation in responses and logs |
| `pnpm release:check`               | Everything above plus `npm pack --dry-run`                                   |

CI (`.github/workflows/ci.yml`) runs every check above, plus the e2e, on Ubuntu for each pull request and push to `main`.

## Releasing

Releases are cut by hand from the **Publish** workflow (Actions → Publish → Run workflow) on `main`. Pick `patch`, `minor`, or `major` and it:

1. runs the full CI suite on that commit,
2. bumps `package.json`, commits `chore(release): vX.Y.Z`, and tags `vX.Y.Z`,
3. pushes the commit and tag to `main` together (rejected if `main` moved after you started it),
4. publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements),
5. creates a GitHub Release with generated notes.

npm authenticates the workflow through [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so there is no npm token or repository secret.

If npm publish fails after step 3, the version commit and tag are already on `main`. Fix the cause, then publish that tag by hand (`git checkout vX.Y.Z && pnpm install && npm publish --access public`, logged in with 2FA) and create the release with `gh release create vX.Y.Z --verify-tag --generate-notes`. Don't re-run the workflow, because it would bump the version again.

## License

[MIT](LICENSE)
