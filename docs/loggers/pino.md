# Using pino with loggercf

pino can be [Your Own Logger](../../CONTEXT.md): the Root Logger every line of a Logging Context is written through, loggercf's own lines (Request Lines, `span.end`, failure lines) included. A pino logger answers the Logger Port as it is. There is no adapter: you pass the pino logger wherever loggercf takes a `Logger`, and add `currentContextFields` as its `mixin` so its lines carry the Context Fields and trace IDs.

loggercf keeps doing the Cloudflare plumbing: Logging Contexts, trace propagation, Request Lines, Spans, `withLogging`, the cron, queue and Workflow helpers. pino does the writing: its levels, serializers, redaction and destination.

Everything below was checked with pino 10.4 (`src/pino.test.ts`), and the Workers part with wrangler 4.160 and `wrangler dev`.

## Install

```bash
pnpm add loggercf pino
```

## The Root Logger

Build one pino logger per process or isolate, at module scope:

```ts
import pino from 'pino'
import { currentContextFields } from 'loggercf'

export const logger = pino({
  level: 'info',
  // loggercf's own lines call the message `message`; pino calls it `msg` by default.
  messageKey: 'message',
  // Per-process fields only. Replaces pino's default `pid` and `hostname`.
  base: { service: 'api', environment: 'production', version: '1.4.0' },
  // The current Logging Context's Context Fields, traceId, spanId and parentSpanId.
  mixin: currentContextFields,
  // Optional: write `level` and `time` the way loggercf's own lines do ("INFO", ISO 8601).
  formatters: { level: (label) => ({ level: label.toUpperCase() }) },
  timestamp: pino.stdTimeFunctions.isoTime,
})
```

- **`mixin: currentContextFields`** is what puts `requestId`, `userId`, `traceId`, `spanId` and `parentSpanId` on pino's lines. pino calls it for every line; outside a Logging Context it returns `{}`, so the line gets nothing. Without it, lines written inside a Logging Context have no Context Fields and no trace IDs (the Request Lines still have `requestId`, which they pass themselves).
- **`messageKey: 'message'`** is recommended, not required. loggercf's built-in core writes `message`, so with it a query on `message` finds lines from both. Without it pino writes `msg`, and a call field named `message` is a plain field.
- **`base`** holds what loggercf's Logger Options would have held: `service`, `environment`, `version`. Per-unit-of-work data never goes there or in a `.child()` of the Root Logger; it goes in Context Fields (`setLoggerContext`, or the `fields` of `runWithLogger`).

Register it as the Default Logger if code at module scope logs before any helper has seen it:

```ts
import { setDefaultLogger } from 'loggercf'

setDefaultLogger(logger)
```

`useLogger`, `TracedEntrypoint`, `tracedWorker` and the Workers helpers register it themselves the first time they see it, unless a Default Logger is already set.

## Hono

```ts
import { Hono } from 'hono'
import { getLogger, setLoggerContext, withSpan } from 'loggercf'
import { useLogger } from 'loggercf/hono'
import { logger } from './logger'

const app = new Hono()
app.use(useLogger(logger))

app.get('/users/:id', async (c) => {
  setLoggerContext({ userId: c.req.param('id') })
  getLogger().info({ step: 1 }, 'loading user')
  const user = await withSpan('db.getUser', () => db.getUser(c.req.param('id')))
  return c.json(user)
})
```

`getLogger()` inside the request is a `.child({})` of your pino logger (one per Logging Context), typed as loggercf's `Logger`. pino's other methods (`isLevelEnabled`, `bindings`, ...) are there at runtime but not on that type; call them on your pino logger.

## Any other unit of work: `runWithLogger`

In Node.js, or for work no helper covers:

```ts
import { getLogger, runWithLogger } from 'loggercf'
import { logger } from './logger'

await runWithLogger(
  { logger, traceparent: job.trace?.traceparent, fields: { jobId: job.id } },
  async () => {
    getLogger().info('processing') // jobId, traceId, spanId (and parentSpanId when continued)
  },
)
```

In Node.js pino's default destination (stdout) and its transports work as usual. On Workers, see [Cloudflare Workers](#cloudflare-workers) below.

## Workers helpers: the `logger` option

`withScheduled`, `withQueueMessage`, `withWorkflow`, `withLogging` and `tracedWorker` take your logger as `logger`, in place of the Root Logger they would build from env:

```ts
import { withLogging, withQueueMessage, withScheduled, withWorkflow } from 'loggercf/workers'
import { logger } from './logger'

export const LoggedSearch = withLogging(Search, { logger })
export const LoggedReport = withWorkflow(Report, { logger })

export default {
  scheduled: withScheduled(nightly, { logger }),
  async queue(batch: MessageBatch<Job>) {
    for (const message of batch.messages) {
      await withQueueMessage(batch, message, () => handle(message.body), { logger })
    }
  },
}
```

It can also be a function of env, called once per env (once per isolate):

```ts
const scheduled = withScheduled(nightly, {
  logger: (env: Env) => logger.child({ version: env.CF_VERSION_METADATA?.id }),
})
```

A logger given this way becomes the Default Logger unless one is already set. `env`, `serializeError` and `redact` configure the logger loggercf builds, so passing one of them with `logger` throws: configure pino instead. `withLogging` on a `TracedEntrypoint` subclass throws too: override its Root Logger hook.

## `TracedEntrypoint`

Override the Root Logger hook and return the module-scope logger. The getter is read more than once, so return the same instance rather than building one in it:

```ts
import type { Logger } from 'loggercf'
import { TracedEntrypoint, TracedSession, type SessionInit } from 'loggercf/workers'
import { logger } from './logger'

class MySession extends TracedSession<Env> {
  add(a: number, b: number) {
    return this.traced(() => {
      this.logger.info({ a, b }, 'adding')
      return a + b
    }, 'math.add')
  }
}

export default class extends TracedEntrypoint<Env> {
  protected override get [TracedEntrypoint.rootLogger](): Logger {
    return logger
  }

  session(init: SessionInit) {
    return new MySession(init, this[TracedEntrypoint.rootLogger], this.env)
  }
}
```

`tracedWorker(MySession, { logger })` does the same in one line.

## What loggercf's own lines look like

These are real lines from the Worker in [Cloudflare Workers](#cloudflare-workers) below, for `GET /users/42` with a `traceparent` and `X-Request-Id: req-7f3a`, pretty-printed here (pino writes each as one line) and with the stack shortened. A Span:

```json
{
  "level": "INFO",
  "time": "2026-11-22T12:38:11.927Z",
  "service": "api",
  "environment": "production",
  "requestId": "req-7f3a",
  "userId": "42",
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "spanId": "79d5812f8e692039",
  "parentSpanId": "b9419067b6d11b56",
  "span": {
    "operation": "db.getUser",
    "startTime": 1795351091927,
    "endTime": 1795351091927,
    "duration": 0,
    "status": "OK"
  },
  "message": "span.end db.getUser"
}
```

A Span that threw, at `ERROR`, with `err` written by pino's `err` serializer:

```json
{
  "level": "ERROR",
  "time": "2026-11-22T12:38:11.928Z",
  "service": "api",
  "environment": "production",
  "requestId": "req-7f3a",
  "userId": "42",
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "spanId": "fa8eaa773ab16716",
  "parentSpanId": "b9419067b6d11b56",
  "span": {
    "operation": "db.fail",
    "startTime": 1795351091928,
    "endTime": 1795351091928,
    "duration": 0,
    "status": "ERROR",
    "error": "no row"
  },
  "err": { "type": "TypeError", "message": "no row", "stack": "TypeError: no row\n    at ..." },
  "message": "span.end db.fail"
}
```

The `request.end` Request Line:

```json
{
  "level": "INFO",
  "time": "2026-11-22T12:38:11.929Z",
  "service": "api",
  "environment": "production",
  "requestId": "req-7f3a",
  "userId": "42",
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "spanId": "b9419067b6d11b56",
  "parentSpanId": "b7ad6b7169203331",
  "method": "GET",
  "path": "/users/42",
  "route": "/users/:id",
  "statusCode": 200,
  "duration": 3,
  "message": "request.end GET /users/42"
}
```

loggercf passes its messages as `printf` templates (`logger.info({ span }, 'span.end %s', operation)`); pino fills the `%s` in. The keys are the ones loggercf's built-in core writes, in pino's order: `level` and `time` first, then `base`, then the mixin's fields and the call's fields, and the message last. `requestId` is written once on the Request Lines, though both the call and the mixin give it: pino merges the two objects before writing.

A Span's own options (`level`, `slowMs`, `fields`, `span.set()`) still apply, and pino's `level` filters loggercf's own lines like any other: at `level: 'warn'` there is no `request.end` for a 200.

## What doesn't apply

The Logger Options configure loggercf's built-in core, so they do nothing with pino:

| Logger Option                        | With pino                                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service`, `environment`, `version`  | pino's `base`                                                                                                                                              |
| `level`                              | pino's `level`                                                                                                                                             |
| Span Defaults (`spans`)              | none: give each Span its own `level` and `slowMs`. An OK Span writes at `info` unless it says otherwise                                                    |
| `serializeError`, `omitErrorKeys`    | pino's [`serializers`](https://getpino.io/#/docs/api?id=serializers-object) (`err` by default) and `errorKey`                                              |
| `redact`, `redactKeys`               | pino's [`redact`](https://getpino.io/#/docs/redaction) (paths, `censor`, `remove`)                                                                         |
| `limits`                             | none. Workers Logs truncates a log over 256 KB, which is then no longer valid JSON; keep large values out of your lines, or cut them in a `formatters.log` |
| Env Mapping (`LOG_LEVEL`, `NAME`...) | none: read the vars yourself when you build the logger (on Workers, `import { env } from 'cloudflare:workers'` works at module scope)                      |

## Where pino and loggercf's core differ

### Call styles

pino takes the structured call style, as loggercf's core does: fields or an `Error` first, then a `printf` message.

```ts
logger.info({ userId: 42 }, 'user %s signed in', 'ada') // {"userId":42,"message":"user ada signed in"}
logger.error(err) // err serialized, message = err.message
logger.error(err, 'charge failed')
logger.error({ err, orderId: 'o-1' }) // message = err.message
```

The console style is different. loggercf's core routes every argument (see [Call styles](../../README.md#call-styles)); pino keeps the message and what its placeholders take, and **drops the rest without a trace**:

```ts
getLogger().info('user signed in', { userId: 'u-42' }) // {"message":"user signed in"}: userId is lost
getLogger().error('charge failed', err) // {"message":"charge failed"}: err is lost
getLogger().info('user %s', 'ada', { plan: 'pro' }) // {"message":"user ada"}: plan is lost
```

pino's own types reject these calls, but `getLogger()` is typed as loggercf's `Logger`, which accepts them, so they compile. If your code uses the console style, route it with a `logMethod` hook:

```ts
const logger = pino({
  mixin: currentContextFields,
  hooks: {
    // info('message', { fields }) or error('message', err) -> info({ fields }, 'message')
    logMethod(args, method) {
      const [message, value] = args as unknown[]
      if (
        args.length === 2 &&
        typeof message === 'string' &&
        !message.includes('%') &&
        typeof value === 'object' &&
        value !== null
      ) {
        return method.apply(this, [value, message] as never)
      }
      return method.apply(this, args)
    },
  },
})
```

### Errors

pino's `err` serializer writes an `Error` under `err` as `{ type, message, stack, ...own fields }`. Its `cause` is folded in: `message` is `"outer: inner"` and `stack` ends with `caused by: TypeError: inner ...`. loggercf's core writes the `cause` as a nested Error instead; `pino.stdSerializers.errWithCause` does the same.

An `Error` anywhere but under `err` is written by `JSON.stringify`, which gives `{}`: in another field, nested in an object, or the `originalErr` of a `request.end` (when `onError` itself throws). Name the keys that can hold one:

```ts
const logger = pino({
  mixin: currentContextFields,
  serializers: {
    err: pino.stdSerializers.errWithCause,
    originalErr: pino.stdSerializers.errWithCause,
  },
})
```

### Key collisions

loggercf's core keeps some keys for itself (the Record Keys and Moved Keys); pino doesn't, and writes every key it is given, duplicates included:

- **A call's fields win over the mixin.** pino merges the mixin's object under the call's, so `getLogger().info({ traceId: 'mine' })` replaces the Logging Context's `traceId` (loggercf's core would move it to `args`). To make the Logging Context win, merge the other way, into a new object so the call's object is left as it was:

  ```ts
  pino({
    mixin: currentContextFields,
    mixinMergeStrategy: (mergeObject, mixinObject) => ({ ...mergeObject, ...mixinObject }),
  })
  ```

- **A Context Field or a call field named `level` or `time`** (or `msg`, or `message` with `messageKey: 'message'`) is written a second time in the same line. A JSON parser keeps the last one, so a Context Field `level: 'custom'` replaces the line's level when the line is read. The message pino writes is the last key, so it still wins. Don't name Context Fields after pino's keys.
- **A `.child()` binding and a Context Field of the same name** are both written, the binding first; the Context Field wins when the line is read.
- **`base` replaces `pid` and `hostname`.** Without `base`, every line has both.

## Cloudflare Workers

### Which pino build you get

pino's `package.json` has a `browser` field, and wrangler bundles for Workers with it, so `import pino from 'pino'` gets **`pino/browser.js`**, with or without `nodejs_compat`. That build is a different logger:

- it has no `mixin` and no `base`: both are ignored, so lines carry no Context Fields or trace IDs, and no `service`;
- by default it calls `console.info(fields, 'span.end %s', operation)` with the arguments as given, so the `%s` is never filled in and nothing is JSON;
- `messageKey` and `serializers` take effect only with its `browser` options (`write` or `asObject`, and `serialize`), and `formatters` must be given under `browser`.

The Node build works in workerd with `nodejs_compat` (which loggercf needs anyway, for `AsyncLocalStorage`): `mixin`, `base`, `messageKey`, `formatters`, `serializers`, `redact` and `hooks` all behave as in Node.js. Point `pino` at it with a wrangler `alias`, and give it a destination that writes through `console`.

### The recipe

`wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  // Bundle pino's Node build, not its browser build.
  "alias": { "pino": "pino/pino.js" },
}
```

`src/logger.ts`:

```ts
import pino from 'pino'
import { env } from 'cloudflare:workers'
import { currentContextFields } from 'loggercf'

/** Writes each line with the console method for its level, so Cloudflare sees its severity. */
const consoleDestination = {
  [Symbol.for('pino.metadata')]: true,
  lastLevel: 0,
  write(line: string) {
    if (this.lastLevel >= 50) console.error(line)
    else if (this.lastLevel >= 40) console.warn(line)
    else if (this.lastLevel >= 30) console.info(line)
    else console.debug(line)
  },
}

export const logger = pino(
  {
    level: env.LOG_LEVEL ?? 'info',
    messageKey: 'message',
    base: { service: env.NAME, environment: env.ENVIRONMENT },
    mixin: currentContextFields,
    formatters: { level: (label) => ({ level: label.toUpperCase() }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  consoleDestination,
)
```

The destination gets one JSON line per call and writes it with `console.debug`, `info`, `warn` or `error` by level, as loggercf's own Workers sink does. `Symbol.for('pino.metadata')` is [pino's documented way](https://getpino.io/#/docs/api?id=metadata) for a destination to be told each line's level (`lastLevel`: 10 trace ... 60 fatal). pino's default destination (stdout) also writes in `wrangler dev`, where lines appear prefixed with `stdout:`, all at one severity; it was not checked on deployed Workers.

The sample lines in [What loggercf's own lines look like](#what-loggercfs-own-lines-look-like) come from this recipe, with `useLogger(logger)`, `withSpan` and `withScheduled(..., { logger: (env) => logger.child(...) })`, under `wrangler dev`.

### What doesn't work

- **Transports.** `pino.transport()` and the `transport` option run on worker threads (thread-stream), which Workers doesn't have. In workerd, `pino.transport({ target: 'pino/file' })` throws `ReferenceError: __dirname is not defined`. Format and ship lines with the destination instead, or with Workers Logs and its destinations.
- **The Node build without `nodejs_compat`.** With the alias but without the flag, the bundle fails (`Could not resolve "worker_threads"`, `"fs"`, `"events"`, ...).
- **`pino.destination()` / `sonic-boom` to a file.** Workers have no writable file system for logs; use a `console` destination.

### Bundle size

Measured with `wrangler deploy --dry-run` (wrangler 4.160, pino 10.4):

| Worker                                                           | Upload    | gzip     |
| ---------------------------------------------------------------- | --------- | -------- |
| pino only, `import pino from 'pino'` (browser build)             | 40.4 KiB  | 8.5 KiB  |
| pino only, Node build through the `alias`                        | 163.7 KiB | 30.7 KiB |
| Hono + loggercf, built-in logger                                 | 162.4 KiB | 39.9 KiB |
| the same app with pino's Node build (the recipe above)           | 325.9 KiB | 70.1 KiB |
| the same app with pino's browser build (the recipe further down) | 188.5 KiB | 44.2 KiB |

pino's Node build adds about 160 KiB (30 KiB gzipped) to a Worker; the browser build about 26 KiB (4 KiB gzipped). loggercf's built-in core stays in the bundle either way: `getLogger()` falls back to it outside every Logging Context until a Default Logger is registered.

### If you keep the browser build

If bundle size matters more than `mixin`, the browser build can be made to write JSON lines with the Context Fields, through its `browser` options:

```ts
import pino from 'pino' // pino/browser.js, without the alias
import { currentContextFields } from 'loggercf'

export const logger = pino({
  level: 'info',
  messageKey: 'message',
  serializers: { err: pino.stdSerializers.err },
  browser: {
    serialize: true,
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
      // In place of `mixin`, which this build ignores.
      log: (object) => ({ ...currentContextFields(), ...object }),
    },
    write: (object) => console.log(JSON.stringify(object)),
  },
}).child({ service: 'api' }) // In place of `base`, which this build ignores.
```

What differs from the Node build, seen in `wrangler dev`:

- the Context Fields and trace IDs come first in the line, before `time` and `level`;
- every line goes to `console.log`, one severity (the `write` function gets the object, not the level; read `object.level` to choose);
- its `err` serializer writes `msg`, not `message`, inside `err`: `{ type, msg, stack }`;
- `logger.error(err)` spreads the `Error` at the top level (`type`, `msg`, `stack`), with no `err` key and no message;
- `serialize: true` replaces `err` in **your** object: after `logger.error(fields, 'x')`, `fields.err` is the serialized object, not the `Error`;
- it has no `hooks`, so the `logMethod` recipe above doesn't apply.
