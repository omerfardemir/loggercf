# winston with loggercf

Keep winston, with its transports and formats, and use it as Your Own Logger: loggercf's own lines (Request Lines, `span.end`, failure lines) and your `getLogger()` calls all go through it, so every line shares one output and one format. `loggercf/winston` is the thin part in between:

- `fromWinston(w)`: a loggercf `Logger` over a winston logger, to pass anywhere loggercf takes a Root Logger.
- `contextFields()`: a winston format that adds the current Logging Context's Context Fields and trace IDs to your direct winston calls (`w.info(...)`).
- `contextMeta()`: the same fields as a winston `defaultMeta`, read during the call, for transports that write later (`File`, `Http`).

`loggercf/winston` imports nothing from winston: winston stays your dependency, at your version.

## Install

```sh
npm install loggercf winston
```

On Workers, winston needs the `nodejs_compat` compatibility flag (see [Workers caveats](#workers-caveats)).

## The winston logger

Build it once, at module scope, as you would without loggercf. Add `contextFields()` before `format.json()`:

```ts
import winston from 'winston'
import { contextFields, fromWinston } from 'loggercf/winston'

export const w = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    contextFields(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({ stderrLevels: ['error'], consoleWarnLevels: ['warn'] }),
  ],
})

export const logger = fromWinston(w)
```

`logger` is a loggercf `Logger`. `w` is still your winston logger: call it directly where you like, and its lines carry the Context Fields too.

`format.json()` writes the keys sorted. `winston.format.json({ deterministic: false })` keeps them in the order they were set: `level`, `message`, the Context Fields, the line's fields, then the trace IDs.

## Where it goes

### Hono

```ts
import { Hono } from 'hono'
import { getLogger } from 'loggercf'
import { useLogger } from 'loggercf/hono'
import { logger } from './log'

const app = new Hono()
app.use(useLogger(logger))
app.get('/users/:id', (c) => {
  getLogger().info({ id: c.req.param('id') }, 'loading user')
  return c.text('ok')
})
```

The Request Lines (`request.start`, `request.end`) are written through winston.

### runWithLogger

```ts
import { getLogger, runWithLogger } from 'loggercf'
import { logger } from './log'

await runWithLogger({ logger, fields: { jobId: 'nightly' } }, async () => {
  getLogger().info('started')
})
```

### The Workers helpers

`withScheduled`, `withQueueMessage`, `withWorkflow`, `withLogging` and `tracedWorker` take it as their `logger` option, and register it as the Default Logger the first time they see it, so `getLogger()` outside every Logging Context writes through winston too:

```ts
import { getLogger } from 'loggercf'
import { withScheduled } from 'loggercf/workers'
import { logger } from './log'

export default {
  scheduled: withScheduled(
    async (controller) => {
      getLogger().info({ cron: controller.cron }, 'nightly run')
    },
    { logger },
  ),
}
```

To build it from env, pass a function of env. It is called once per env, so the winston logger is built once per isolate:

```ts
import winston from 'winston'
import { contextFields, fromWinston } from 'loggercf/winston'
import { withScheduled } from 'loggercf/workers'

export default {
  scheduled: withScheduled(async () => {}, {
    logger: (env: Env) =>
      fromWinston(
        winston.createLogger({
          level: env.LOG_LEVEL ?? 'info',
          defaultMeta: { service: env.NAME },
          format: winston.format.combine(contextFields(), winston.format.json()),
          transports: [new winston.transports.Console()],
        }),
      ),
  }),
}
```

With `logger`, the helpers' `env` (Env Mapping), `serializeError` and `redact` options don't apply, and passing them throws a `TypeError`. A raw winston logger is not a `Logger` (it has no `trace` or `fatal`, and logs `(message, meta)`), so passing `w` itself throws too: pass `fromWinston(w)`.

### TracedEntrypoint

Override its Root Logger hook:

```ts
import type { Logger } from 'loggercf'
import { TracedEntrypoint } from 'loggercf/workers'
import { logger } from './log'

export default class extends TracedEntrypoint<Env> {
  protected override get [TracedEntrypoint.rootLogger](): Logger {
    return logger
  }
}
```

## What a line looks like

`span.end` of `withSpan('db.query', ...)` inside a Hono request, through the logger above (with `timestamp()`), as workerd printed it:

```json
{
  "level": "info",
  "message": "span.end db.query",
  "parentSpanId": "904a272d58718c8a",
  "requestId": "req-1",
  "span": {
    "duration": 0,
    "endTime": 1795351374847,
    "operation": "db.query",
    "startTime": 1795351374847,
    "status": "OK"
  },
  "spanId": "897e1965f9b59286",
  "timestamp": "2026-11-22T12:42:54.848Z",
  "traceId": "0af7651916cd43dd8448eb211c80319c"
}
```

And `request.end` for a handler that threw (stack shortened):

```json
{
  "duration": 3,
  "err": { "message": "boom", "stack": "TypeError: boom\n    at ...", "type": "TypeError" },
  "level": "error",
  "message": "request.end GET /fail",
  "method": "GET",
  "path": "/fail",
  "requestId": "ae086dc3-bd04-4bee-ab7d-fe003917c219",
  "route": "/fail",
  "spanId": "7669104bdc6952c6",
  "statusCode": 500,
  "timestamp": "2026-11-22T12:42:54.875Z",
  "traceId": "f9c6e82eca51ea36ee25ed9b646c1fcf"
}
```

## How fromWinston writes a line

**One info object per call.** Every call goes through loggercf's Argument Routing, in either call style (`logger.info({ userId }, 'user %s', name)` or `logger.info('slow', { ms })`). winston gets `{ level, message, ...fields }` through its stream, as `w.log(info)` would write it: the message with its `printf` placeholders already filled, the fields at the top level, `err` / `errors` for Errors and `args` for the values with no better place. A call with no message writes `message: ''`, as winston does.

**`format.splat()` doesn't format it again.** Each info object carries an empty splat, so a `%` in the formatted message (`logger.info('%s', '100%s done')`) stays as it is, and a field named `splat` is only a field.

**Errors are written, not `{}`.** `format.json()` writes an `Error` as `{}`, and `format.errors()` only looks at the info object itself or its `message`. So `fromWinston` writes every `Error` in the line's fields (`err`, `errors`, and inside plain objects and arrays at any depth) in loggercf's default shape, `{ type, message, stack, ...own props, cause? }`, before winston sees it. Your objects are not changed: what holds an `Error` is copied. An object inside itself is `"[Circular]"` there. Pass `writeError` to write them your way:

```ts
const logger = fromWinston(w, {
  writeError: (err, defaultSerialize) => {
    const { stack, ...rest } = defaultSerialize(err)
    return rest
  },
})
```

What it returns goes to winston as it is: return `err` itself if a format of yours writes Errors. When it throws, that `Error` is written in the default shape with `serializeErrorFailed`.

**Context Fields at the call.** Each line carries the current Logging Context's Context Fields and trace IDs, taken during the call, with or without `contextFields()` in your format. Strongest first: the trace IDs, the call's fields, the bindings of `logger.child(...)`, winston's `defaultMeta`, the Context Fields. A binding or Context Field named `level` or `message` moves to `args`, so it can't change the line's level or message.

**`child`.** `logger.child(bindings)` keeps the bindings in the adapter and writes them on each line, so they win over `defaultMeta` and the Context Fields, as loggercf's bindings do. To adapt a winston child, `fromWinston(w.child({ module: 'db' }))` works too; winston writes its child's fields under everything else on the line.

**Filtering is winston's.** A line below the winston logger's level (or every transport's) is not built at all.

**A log call never throws**, whatever a format or transport does.

## Levels

loggercf has six levels, winston's npm levels have no `trace` or `fatal`. Each loggercf level writes at the winston level of the same name when the logger has it, else at the first of these it has:

| loggercf | npm levels (default) | syslog levels | candidates, in order    |
| -------- | -------------------- | ------------- | ----------------------- |
| `trace`  | `silly`              | `debug`       | trace, silly, debug     |
| `debug`  | `debug`              | `debug`       | debug, verbose          |
| `info`   | `info`               | `info`        | info                    |
| `warn`   | `warn`               | `warning`     | warn, warning           |
| `error`  | `error`              | `error`       | error, err              |
| `fatal`  | `error`              | `crit`        | fatal, crit, error, err |

With custom levels that include `trace` and `fatal`, each loggercf level keeps its name:

```ts
const w = winston.createLogger({
  levels: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
  level: 'info',
  transports: [new winston.transports.Console()],
})
```

Override any of them with `levels`. Each must be one of the logger's levels:

```ts
const logger = fromWinston(w, { levels: { trace: 'verbose', info: 'http' } })
```

`fromWinston` throws a `TypeError` when a level has no winston level to write at, or `levels` names one the logger doesn't have.

## Your direct winston calls

`fromWinston`'s lines carry the Context Fields by themselves. For your own `w.info(...)` calls, add one of these to the winston logger.

### contextFields(), the format

Adds the Context Fields and trace IDs to each line inside a Logging Context, and nothing outside one. A key the line already has keeps the line's value. Put it in `format.combine(...)` before the format that writes the line (`json()`, `logstash()`, `printf(...)`).

A format runs when winston formats the line. With `Console` and `Stream` transports, which finish each write at once, that is during the call. Behind a transport that writes later (`File`, `Http`), winston buffers a burst of lines and formats them afterwards, in whatever Logging Context is current then: in a test with 60 lines behind a transport that finished each write a tick later, 28 of them carried another request's fields. `fromWinston`'s own lines are safe from this (the format leaves them as they are), but your direct calls are not. Use `contextMeta()` there.

### contextMeta(), the defaultMeta

```ts
import winston from 'winston'
import { contextMeta } from 'loggercf/winston'

const w = winston.createLogger({
  defaultMeta: contextMeta({ service: 'api' }),
  format: winston.format.json(),
  transports: [new winston.transports.File({ filename: 'app.log' })],
})
```

winston copies `defaultMeta` into each line during the call, so each line carries its own unit of work's fields whatever its transports do. The fields you give it are written on every line, over the Context Fields; the trace IDs are over both. Between it and a call's own fields, winston's rule for `defaultMeta` decides: the call's `meta` wins in `w.info(message, meta)`, and `defaultMeta` wins in `w.info({ message, ... })`.

## What does not apply

The Logger Options configure loggercf's built-in logger, not winston. With your winston logger:

| Logger Option                                                 | With winston                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `level`, `LOG_LEVEL`                                          | winston's `level` (and each transport's). Read it from env in a function of env, as above.                               |
| `service`, `environment`, `version`                           | winston's `defaultMeta`, or `contextMeta({ service })`.                                                                  |
| Span Defaults (`spans`, `LOG_SPAN_LEVEL`, `LOG_SPAN_SLOW_MS`) | None: each Span is at `info` unless its own `level` / `slowMs` options say otherwise.                                    |
| `serializeError` (Error Serializer)                           | `fromWinston`'s `writeError` option, for loggercf's lines. Your direct calls: `format.errors()` or a format of your own. |
| `limits` (Line Limits)                                        | None in winston: write a format that cuts long values.                                                                   |
| `redact` (Redactor)                                           | A format of your own that replaces values before `format.json()`.                                                        |

## Workers caveats

Measured with wrangler 4.160.1 and winston 3.19.0, on a Worker with Hono, `useLogger(fromWinston(w))` and a winston `Console` transport.

**`nodejs_compat` is required.** loggercf itself needs it already (see [Cloudflare Worker Requirements](../../README.md#cloudflare-worker-requirements)), and winston doesn't bundle without it either: it imports `buffer`, `events`, `fs`, `http`, `https`, `os`, `path`, `util` and `zlib`.

```jsonc
// wrangler.jsonc
{
  "compatibility_flags": ["nodejs_compat"],
}
```

**Bundle size.** winston adds about 170 KiB minified, 47 KiB gzipped:

| `wrangler deploy --dry-run`      | raw        | gzip       |
| -------------------------------- | ---------- | ---------- |
| the Worker, with winston         | 554.20 KiB | 104.48 KiB |
| the same Worker, without winston | 153.60 KiB | 37.63 KiB  |
| with winston, `--minify`         | 234.86 KiB | 71.46 KiB  |
| without winston, `--minify`      | 62.95 KiB  | 24.13 KiB  |

**Silence `util.debuglog`.** winston's streams come from `readable-stream`, which calls `util.debuglog('stream')`. workerd's `debuglog` is always on (it has no `NODE_DEBUG`), so each winston line comes with several `STREAM: ...` lines, one of them a dump of the whole info object: 53 of them for 7 log lines in our test. Alias `util` to a copy whose `debuglog` is off:

```js
// util-quiet.js
import util from 'node:util'
export * from 'node:util'
const off = Object.assign(() => {}, { enabled: false })
export const debuglog = () => off
export default { ...util, debuglog }
```

```jsonc
// wrangler.jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "alias": { "util": "./util-quiet.js" },
}
```

**Transports.** Use `Console`. In workerd there is no `console._stdout`, so it writes each line with `console.log`, and with `console.error` / `console.warn` only for the levels in its `stderrLevels` / `consoleWarnLevels`: set them (as in the logger above), or Workers Logs records every line at the `log` level. It finishes each write at once, so `contextFields()` is safe there. The `File` and `Http` transports were not tried in workerd, and a Worker has no lasting disk for a file: to ship lines elsewhere, use Workers Logs, Logpush or a Tail Worker.

**Each line costs a `setImmediate`.** The `Console` transport emits its `logged` event on the next turn, which `nodejs_compat` provides.
