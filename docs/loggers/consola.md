# consola with loggercf

Keep [consola](https://github.com/unjs/consola) as your logger and let loggercf do the Cloudflare plumbing: the Logging Context, trace propagation, the Hono Request Lines, Spans, `withLogging`, the cron, queue and Workflow helpers. `loggercf/consola` turns a consola instance into Your Own Logger: every line of a Logging Context, loggercf's own included (`request.start` / `request.end`, `span.end`, `<operation> failed`), goes through consola's reporters, with the Context Fields and trace IDs on it.

It is a thin adapter over `adaptLogger()` (from `loggercf`). It does not import consola: it takes any consola instance you build, so it adds no dependency and works with every consola entry point.

```ts
import { createConsola } from 'consola/core'
import { fromConsola, jsonReporter } from 'loggercf/consola'

const consola = createConsola({ reporters: [jsonReporter()], throttle: 0 })
const logger = fromConsola(consola) // a loggercf Logger
```

## Install

```sh
pnpm add loggercf consola
```

`loggercf/consola` works with consola 3. Its types are structural (`ConsolaLike`, `ConsolaReporterLike`), so `createConsola()` from `consola`, `consola/core`, `consola/basic` or `consola/browser`, and the default `consola` export, are accepted as they are, without a cast.

## Which consola to import

| Runtime            | Import                                         | Reporter to use                                                                                          |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers | `import { createConsola } from 'consola/core'` | `jsonReporter()`: one JSON line per log, for Workers Logs                                                |
| Node.js            | `import { createConsola } from 'consola'`      | consola's own (FancyReporter in a terminal, BasicReporter in CI), wrapped with `contextFieldsReporter()` |

In a Worker, wrangler resolves `consola`, `consola/basic` and `consola/browser` to consola's browser build, with or without `nodejs_compat`: its export conditions send everything but Node to `dist/browser.mjs`, whose only reporter is `BrowserReporter` (CSS badges for the browser console). `consola/core` is the same `Consola` class with no reporter, and the smallest; give it `jsonReporter()`. See [Workers caveats](#workers-caveats).

## Build the instance

**Workers:**

```ts
import { createConsola } from 'consola/core'
import { jsonReporter } from 'loggercf/consola'

export const consola = createConsola({
  reporters: [jsonReporter()],
  throttle: 0, // write every line: see "consola's throttle" below
})
```

**Node.js**, keeping consola's terminal output:

```ts
import { createConsola } from 'consola'
import { contextFieldsReporter } from 'loggercf/consola'

export const consola = createConsola({ throttle: 0 })
consola.setReporters(consola.options.reporters.map(contextFieldsReporter))
```

`contextFieldsReporter()` and `jsonReporter()` matter only for the calls you make on consola directly (`consola.info(...)`); the lines of `fromConsola()` carry the Context Fields whatever the reporter. See [Context Fields](#context-fields).

## `fromConsola(consola)`

```ts
function fromConsola<T extends LogFields = LogFields>(consola: ConsolaLike): Logger<T>
```

A loggercf `Logger` over the instance, to pass anywhere loggercf takes a Root Logger. Give it the per-process fields with `.child()`: consola has no field bindings of its own (`withTag` sets a tag, which `fromConsola(consola.withTag('api'))` keeps).

```ts
import { fromConsola } from 'loggercf/consola'
import { consola } from './consola'

export const logger = fromConsola(consola).child({ service: 'api', environment: 'production' })
```

### Hono

```ts
import { Hono } from 'hono'
import { getLogger } from 'loggercf'
import { useLogger } from 'loggercf/hono'
import { logger } from './logger'

const app = new Hono()
app.use(useLogger(logger)) // registers it as the Default Logger too

app.get('/orders/:id', (c) => {
  getLogger().info({ orderId: c.req.param('id') }, 'order loaded')
  return c.text('ok')
})

export default app
```

### `runWithLogger`

```ts
import { getLogger, runWithLogger } from 'loggercf'
import { logger } from './logger'

await runWithLogger({ logger, fields: { jobId: 'nightly-1' } }, async () => {
  getLogger().info('job started') // through consola, with jobId, traceId and spanId
})
```

### The Workers helpers' `logger` option

`withScheduled`, `withQueueMessage`, `withWorkflow`, `withLogging` and `tracedWorker` take `logger`: a `Logger`, or a function of env that returns one, called once per env (once per isolate). Each opens its Logging Contexts over it and registers it as the Default Logger unless one is already set.

```ts
import { createConsola, LogLevels } from 'consola/core'
import { getLogger } from 'loggercf'
import { fromConsola, jsonReporter } from 'loggercf/consola'
import { withScheduled } from 'loggercf/workers'

interface Env {
  NAME: string
  LOG_LEVEL?: string
}

/** One consola-backed Root Logger per env, with its level from LOG_LEVEL. */
const logger = (env: Env) =>
  fromConsola(
    createConsola({
      level: env.LOG_LEVEL === 'debug' ? LogLevels.debug : LogLevels.info,
      reporters: [jsonReporter()],
      throttle: 0,
    }),
  ).child({ service: env.NAME })

export default {
  scheduled: withScheduled<Env>(
    () => {
      getLogger().info('nightly run')
    },
    { logger },
  ),
}
```

`env`, `serializeError` and `redact` configure the logger loggercf builds, so passing one of them with `logger` throws. A raw consola instance is not a `Logger` (it has no `child`), so `{ logger: consola }` throws too; pass `fromConsola(consola)`.

### `TracedEntrypoint`

Override the Root Logger hook. Build it from `this.env`: the constructor reads the hook to register the Default Logger.

```ts
import type { Logger } from 'loggercf'
import { fromConsola } from 'loggercf/consola'
import { TracedEntrypoint, TracedSession, type SessionInit } from 'loggercf/workers'
import { consola } from './consola'

interface Env {
  NAME: string
}

class MathSession extends TracedSession<Env> {
  add(a: number, b: number) {
    return this.traced(() => a + b, 'math.add')
  }
}

export default class extends TracedEntrypoint<Env> {
  protected override get [TracedEntrypoint.rootLogger](): Logger {
    return fromConsola(consola).child({ service: this.env.NAME })
  }

  session(init: SessionInit) {
    return new MathSession(init, this[TracedEntrypoint.rootLogger], this.env)
  }
}
```

Every call builds a new logger here, which is cheap (`fromConsola` keeps no state but the instance); hold one at module scope when the fields do not depend on env.

## How a line is handed to consola

Each call goes through loggercf's Argument Routing first, in either call style (`logger.info({ orderId }, 'order %s', id)` or `logger.info('order', { orderId })`). consola's method of the same level then gets, console style:

1. the formatted message (its `printf` placeholders filled),
2. one plain object of the fields: the Context Fields, the `.child()` bindings, the call's fields, `errors` (each `Error` after the first) and `args` (the Overflow), then the trace IDs,
3. the `Error` under `err`, last and on its own, so consola's reporters print its message and stack (and `cause`).

An argument is left out when empty. An `Error`-first call (`logger.error(err)`) gets no separate message, as its message is the `Error`'s and the reporters print it already. A `%` in the message is doubled when values follow it, so a reporter's own `printf` (consola's, or `console.log`'s) prints the message as it is.

Precedence on a shared key is loggercf's own: the call's fields win over the bindings, which win over a Context Field; the trace IDs (`traceId`, `spanId`, `parentSpanId`) win over all three.

A log call never throws, even when a reporter does.

## Context Fields

| Line                                                                           | Carries the Context Fields and trace IDs                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| loggercf's own and `getLogger()`'s, through `fromConsola()`                    | always: `fromConsola()` merges `currentContextFields()` into the fields object |
| your `consola.info(...)`, with `jsonReporter()`                                | yes: merged into the JSON line, the call's fields winning, the trace IDs last  |
| your `consola.info(...)`, with a reporter wrapped in `contextFieldsReporter()` | yes: `currentContextFields()` appended as the last argument                    |
| your `consola.info(...)`, with any other reporter                              | no                                                                             |

Each line gets them once: both reporters recognise a line from `fromConsola()` (by a symbol-keyed property consola's reporters never print) and leave it as it is. `contextFieldsReporter()` never changes the log object the other reporters get. The `.child()` bindings of your loggercf logger (`service`...) are on its lines only, not on your direct consola calls.

## Levels

loggercf calls consola's method of the same name, so consola's `level` filters as it does for your own calls. A call consola would drop is skipped before Argument Routing runs.

| loggercf | consola method | consola level | `jsonReporter()` `level` | `console` method |
| -------- | -------------- | ------------- | ------------------------ | ---------------- |
| `trace`  | `trace`        | 5             | `TRACE`                  | `debug`          |
| `debug`  | `debug`        | 4             | `DEBUG`                  | `debug`          |
| `info`   | `info`         | 3             | `INFO`                   | `info`           |
| `warn`   | `warn`         | 1             | `WARN`                   | `warn`           |
| `error`  | `error`        | 0             | `ERROR`                  | `error`          |
| `fatal`  | `fatal`        | 0             | `FATAL`                  | `error`          |

consola's own types are written by `jsonReporter()` at the level of their number (`log`, `success`, `start`, `ready`, `fail` and `box` are `INFO`), with `type` on the line (`"type":"success"`); `tag` is written when the instance has one.

consola's default level is `info` (3): `trace` and `debug` lines, `span.end` at `debug` included, are dropped unless you raise it (`createConsola({ level: LogLevels.debug })` or `consola.level = LogLevels.trace`). In Node, `createConsola()` from `consola` starts at `warn` (1) under `NODE_ENV=test` or `TEST`, at `debug` under `DEBUG`, and reads `CONSOLA_LEVEL`; `consola/core` always starts at `info`.

## What it looks like

loggercf's own lines and a direct consola call, from one request to a Hono app with `useLogger(fromConsola(consola).child({ service: 'api' }))`, a handler that logs, calls `consola.success('cache warmed')`, and runs a failing `withSpan('db.query', ...)`.

**consola's BasicReporter** (Node, not a terminal), reporters wrapped with `contextFieldsReporter()`, stack shortened:

```text
[info] request.start GET /orders/42 { requestId: 'req-1',
  service: 'api',
  method: 'GET',
  path: '/orders/42',
  route: '/orders/:id',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: '9d58d9503a29c749',
  parentSpanId: 'b7ad6b7169203331' }
[info] order 42 loaded { requestId: 'req-1',
  service: 'api',
  orderId: '42',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: '9d58d9503a29c749',
  parentSpanId: 'b7ad6b7169203331' }
[success] cache warmed { requestId: 'req-1',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: '9d58d9503a29c749',
  parentSpanId: 'b7ad6b7169203331' }
[error] span.end db.query { requestId: 'req-1',
  service: 'api',
  span:
   { operation: 'db.query',
     startTime: 1795351306132,
     endTime: 1795351306132,
     duration: 0,
     status: 'ERROR',
     error: 'connection reset' },
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: '20119cbe99b5845e',
  parentSpanId: '9d58d9503a29c749' } connection reset
  at ...
[info] request.end GET /orders/42 { requestId: 'req-1',
  service: 'api',
  method: 'GET',
  path: '/orders/42',
  route: '/orders/:id',
  statusCode: 200,
  duration: 2,
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: '9d58d9503a29c749',
  parentSpanId: 'b7ad6b7169203331' }
```

**`jsonReporter()`** (the same request; in a Worker, each line is one `console.info` / `console.error` call), stack shortened:

```json
{"time":"2026-11-22T12:41:50.750Z","level":"INFO","message":"request.start GET /orders/42","requestId":"req-1","service":"api","method":"GET","path":"/orders/42","route":"/orders/:id","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"3d8142333b285aca","parentSpanId":"b7ad6b7169203331"}
{"time":"2026-11-22T12:41:50.751Z","level":"INFO","message":"order 42 loaded","requestId":"req-1","service":"api","orderId":"42","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"3d8142333b285aca","parentSpanId":"b7ad6b7169203331"}
{"time":"2026-11-22T12:41:50.751Z","level":"INFO","message":"cache warmed","requestId":"req-1","type":"success","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"3d8142333b285aca","parentSpanId":"b7ad6b7169203331"}
{"time":"2026-11-22T12:41:50.751Z","level":"ERROR","message":"span.end db.query","requestId":"req-1","service":"api","span":{"operation":"db.query","startTime":1795351310751,"endTime":1795351310751,"duration":0,"status":"ERROR","error":"connection reset"},"err":{"type":"Error","message":"connection reset","stack":"Error: connection reset\n    at ..."},"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"14fd57948815c553","parentSpanId":"3d8142333b285aca"}
{"time":"2026-11-22T12:41:50.754Z","level":"INFO","message":"request.end GET /orders/42","requestId":"req-1","service":"api","method":"GET","path":"/orders/42","route":"/orders/:id","statusCode":200,"duration":2,"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"3d8142333b285aca","parentSpanId":"b7ad6b7169203331"}
```

## `jsonReporter()`

```ts
function jsonReporter(): ConsolaReporterLike
```

consola ships no JSON reporter. This one writes each line as one JSON line, the way loggercf writes its own: `time`, `level` (`INFO`...), `message`, the Context Fields, the fields, the trace IDs, and every `Error` as `{ type, message, stack, ... }` (with `cause` and an `AggregateError`'s `errors`), at any depth. It writes through the `console` method of the line's level (table above), which is where Workers Logs reads the severity, and one JSON string per line is what Workers Logs indexes field by field.

A line from `fromConsola()` is written as loggercf routed it. Your own `consola.info(...)` calls go through loggercf's Argument Routing (the `printf` message, objects merged, the first `Error` to `err` and the rest to `errors`, other values to `args`). It never throws: a line it can't write is written as `time`, `level` and `logError`.

## `contextFieldsReporter(reporter)`

```ts
function contextFieldsReporter<O extends ConsolaLogObjectLike, C>(
  reporter: ConsolaReporterLike<O, C>,
): ConsolaReporterLike<O, C>
```

Wraps any consola reporter so your direct consola calls inside a Logging Context carry the Context Fields and trace IDs: the reporter gets `currentContextFields()` as one more argument, last. Outside a Logging Context, and for lines from `fromConsola()`, it passes the log object on unchanged.

```ts
import { consola } from 'consola'
import { contextFieldsReporter } from 'loggercf/consola'

consola.setReporters(consola.options.reporters.map(contextFieldsReporter))
```

## consola's throttle

By default consola collapses identical lines (same type, tag and arguments) logged within a second of each other: after the sixth it holds them back and writes one `(repeated N times)` line from a `setTimeout` a second later. In a Worker that timer may never run once the response is sent, and held lines are lost; on a server, two identical `request.end` lines are rare but not impossible. Pass `throttle: 0` to write every line.

## What does not apply

Your consola instance writes the lines, so the Logger Options that configure loggercf's built-in core do not apply to them:

- **Span Defaults** (`createLogger({ spans })`, `LOG_SPAN_LEVEL`, `LOG_SPAN_SLOW_MS`): a Span is `info` (`WARN` at its Slow Threshold, `ERROR` when it throws) unless its own options say otherwise.
- **Error Serializer** (`serializeError`, `omitErrorKeys`): consola's reporters print an `Error` their way; `jsonReporter()` writes the default shape.
- **Line Limits** (`limits`, `LOG_MAX_STRING_LENGTH`, `LOG_MAX_RECORD_BYTES`): nothing is cut or trimmed.
- **Redactor** (`redact`, `redactKeys`): nothing is redacted. Redact in a reporter of your own.
- **Env Mapping**: `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION` are not read. Set the level on the consola instance, and `service` / `environment` / `version` with `.child()` (a function of env, as above, reads them from env).

Passing `env`, `serializeError` or `redact` together with a helper's `logger` option throws, so none of them is silently ignored.

## Workers caveats

Measured with wrangler 4.160.1 (`wrangler deploy --dry-run`, compatibility date 2026-04-22) and consola 3.4.2.

- **`nodejs_compat`**: loggercf needs it (`AsyncLocalStorage` from `node:async_hooks`). consola does not: every consola entry point bundles and runs without it, and enabling it changes nothing about which consola build is used.
- **Which build**: `consola`, `consola/basic` and `consola/browser` all resolve to `dist/browser.mjs` (core plus `BrowserReporter`); `consola/core` resolves to `dist/core.mjs` alone. None of them imports a `node:` module in a Worker.
- **`BrowserReporter` in workerd**: it calls `console.log('%cinfo%c request.end GET /', style, '', fields)`. Locally, `wrangler dev` drops the CSS and prints `info request.end GET / { ... }` with the object and an `Error`'s stack, readable but not one JSON line, so Workers Logs cannot index its fields. Use `consola/core` with `jsonReporter()`.
- **Bundle size**, Total Upload as wrangler reports it:

  | Worker                                                | Unminified (gzip)    | `--minify` (gzip)   |
  | ----------------------------------------------------- | -------------------- | ------------------- |
  | consola alone, `consola/core`                         | 14.1 KiB (3.9 KiB)   | 5.6 KiB (2.2 KiB)   |
  | consola alone, `consola` (browser build)              | 16.1 KiB (4.5 KiB)   | 6.5 KiB (2.6 KiB)   |
  | Hono + loggercf (`useLogger`, `createLogger`)         | 142.1 KiB (34.9 KiB) | 57.6 KiB (22.2 KiB) |
  | Hono + loggercf + `consola/core` + `loggercf/consola` | 166.9 KiB (40.8 KiB) | 68.2 KiB (25.8 KiB) |

  So consola through loggercf adds about 25 KiB (6 KiB gzip) unminified, 11 KiB (3.6 KiB gzip) minified, to a Worker already using loggercf.

- **Real output** from `wrangler dev`, `consola/core` with `jsonReporter()`, `GET /` with a `traceparent`:

  ```json
  {"time":"2026-11-22T12:39:37.786Z","level":"INFO","message":"handler ran","requestId":"05532430-9bd4-42a4-8ba6-bc8475bec1aa","service":"consola-worker","userId":42,"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"44fd20a568121f9a","parentSpanId":"b7ad6b7169203331"}
  {"time":"2026-11-22T12:39:37.786Z","level":"INFO","message":"direct consola call","requestId":"05532430-9bd4-42a4-8ba6-bc8475bec1aa","type":"success","a":1,"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"44fd20a568121f9a","parentSpanId":"b7ad6b7169203331"}
  {"time":"2026-11-22T12:39:37.786Z","level":"INFO","message":"request.end GET /","requestId":"05532430-9bd4-42a4-8ba6-bc8475bec1aa","service":"consola-worker","method":"GET","path":"/","route":"/","statusCode":200,"duration":1,"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"44fd20a568121f9a","parentSpanId":"b7ad6b7169203331"}
  ```

- **Throttle**: pass `throttle: 0` (see [consola's throttle](#consolas-throttle)).
