# loggercf

Structured logging and distributed trace propagation for Cloudflare Workers (and Node.js), including across Worker-to-Worker RPC where the platform offers no header channel.

## Language

### Logging

**Logging Context**:
The per-unit-of-work scope (an HTTP request, an RPC call, a queue message, a cron run, a Workflow run, a Durable Object call or alarm) that carries one Trace Context, the Context Fields, and the logger every log line in that work is written through.
_Avoid_: Request Scope, ALS context, store. Not to be confused with Hono's `Context` (`c`).

**Context Fields**:
The per-unit-of-work key-value data attached to every log line inside a Logging Context (e.g. `requestId`, `userId`). Isolated per Logging Context; never shared across concurrent work.
_Avoid_: bindings, context, metadata

**Request ID**:
The Context Field (`requestId`) that names one HTTP request in its Logging Context. The Hono middleware takes it from a configured source (a header such as `X-Request-Id` or `cf-ray`, or `c.var.requestId` from an earlier middleware) only when it passes validation, and generates one otherwise (always, when incoming IDs are not trusted). A rejected incoming value is marked with `requestIdRejected: true`, never logged. `cf-ray`, when present and trusted, is also recorded as its own Context Field, `cfRay`.
_Avoid_: correlation ID, trace ID (that is the Trace Context's)

**Request Lines**:
The lines the Hono middleware writes about one HTTP request itself: an optional `request.start`, and one `request.end` that records the outcome (`statusCode`, `duration`, `route`, and `err` when Hono caught an error) at a level chosen from it. `route` is the matched route pattern, not the concrete path; the query string is never on them. For a throw that escapes the middleware, the response is decided above it (an outer middleware, Hono calling `onError` again, or the runtime), so `request.end` records an assumed `statusCode: 500`, marked `statusCodeAssumed: true`.
_Avoid_: access log, `request.error` (folded into `request.end`)

**Owned Keys**:
The keys the Hono middleware writes itself on the Request Lines and as Context Fields that a `fields` or `endFields` hook cannot set (`requestId`, `requestIdRejected`, `cfRay`, `statusCode`, `statusCodeAssumed`, `duration`, `err`, `originalErr`, and `userAgent` / `cf` when they are included). They are dropped from a hook's result, and one WARN names them, never their values. `method`, `path` and `route` are not Owned Keys: a hook may set them, so they appear on the handlers' lines, but the Request Lines always write their own, which win.
_Avoid_: protected keys, own keys, reserved keys

**Root Logger**:
The logger built once per process or isolate from Logger Options, carrying only per-process data (`service`, `environment`, `version`) and its Span Defaults. It never holds per-unit-of-work data, because an isolate serves many requests concurrently.
_Avoid_: base logger, factory

**Default Logger**:
The Root Logger (or a `.child()` of one with per-process fields only) an isolate registers for code that runs outside every Logging Context (module scope, plain RPC methods, `scheduled`, shared packages); `getLogger()` writes through it there. Set with `setDefaultLogger`, or registered by `useLogger`, `TracedEntrypoint`, `tracedWorker`, `withLogging`, `withScheduled`, `withQueueMessage`, `withWorkflow` or `defaultLoggerFromEnv` the first time they see a Root Logger, unless one is already set. It carries no Context Fields, so no unit of work's data reaches another through it. `getLogger()` outside a Logging Context resolves it when each line is written, so a logger kept at module scope before registration still uses it.
_Avoid_: global logger, fallback logger

**Logger Options**:
The per-process configuration a Root Logger is built from: service name, minimum level (or `silent`, which writes nothing), environment, version, the Span Defaults, the Error Serializer and the Line Limits.

**Env Mapping**:
Where each Logger Options field is read from in a Worker's (or process's) env: a var name or a function of env. Unmapped fields read `NAME`, `LOG_LEVEL`, `ENVIRONMENT`, `VERSION`, `LOG_SPAN_LEVEL`, `LOG_SPAN_SLOW_MS`, `LOG_MAX_STRING_LENGTH` and `LOG_MAX_RECORD_BYTES`. The Error Serializer is code, so it has no var: the Workers helpers take it as a `serializeError` option.
_Avoid_: env config, var map

**Argument Routing**:
The rule that places every argument of a log call in the line (the message, top-level fields, `err` / `errors`, or the Overflow), for both the structured call style (fields or an `Error` first) and the console style (message first). Most arguments land in one part; a leading number, boolean, `BigInt`, or an `undefined` / `null` not followed by a string, lands in two (it is the message, and its value is in the Overflow), and the arguments after it are routed as usual. An `Error` a `%s` takes lands in two as well: its message is printed, and the `Error` is `err` / `errors`. No argument is ever dropped: the only argument that writes nothing is a leading `undefined` / `null` directly followed by the message (an unset `Error | undefined`). Inside an object, an `undefined` property is left out, as JSON leaves it out (in fields and under `%j` alike), and an `undefined` array item is `null`. A value that can't be read or serialized is replaced, on its own, by an `[Unserializable: <reason>]` stand-in. It runs before serialization, so routed values are serialized like any field, and an `Error` the same way wherever it lands, nested inside a value included.
_Avoid_: argument parsing, normalization

**Record Keys**:
The keys loggercf writes itself on every log line: `time`, `level`, `message`, `errors` and `args`. A log call's objects, Logger Bindings and Context Fields can't set them: their values for these keys move to the Overflow, so a `.child({ level: 'ERROR' })` can't change a line's severity. A log call's objects can't set the wider Moved Keys either.
_Avoid_: own keys, reserved keys, core keys. Not to be confused with the Hono middleware's Owned Keys.

**Moved Keys**:
The keys a log call's objects can't set: the Record Keys, `service`, `environment` and `version` (from the Root Logger's Logger Options), the trace IDs (`traceId`, `spanId`, `parentSpanId`) and `err`. An object's values for them move to the Overflow, one object per argument. Two are taken from an object while still unset: `err`, and a string `message` when the call has no other message. Logger Bindings and Context Fields are held only to the Record Keys.
_Avoid_: reserved keys, protected keys, the keys loggercf writes itself

**Logger Bindings**:
The fixed fields a logger writes on every line: a Root Logger's `service`, `environment` and `version`, `createLogger`'s second argument, and the fields of each `.child()` merged in. Read once, when the logger is built, never at a log call. Per-unit-of-work data belongs in Context Fields instead.
_Avoid_: logger fields, child fields

**Overflow**:
The `args` field of a log line: the values of a log call that have no better place (arrays, class instances, functions, a leading `undefined` / `null` not followed by a string, an `undefined` / `null` in the message's place after a leading object or `Error`, a long string or `BigInt` the message can't hold again within the Re-write Budget, an object's values for the Moved Keys, and a Logger Binding's or Context Field's value for a Record Key), in call order. Present only when non-empty.
_Avoid_: extras, rest, leftovers

**Re-write Budget**:
What one log line may write again of what it already holds: 10,000 values, or 65,536 characters of keys and strings, inside repeats (an object written before on the line, the same `Error` again, nested as deep, an object whose `toJSON` was already called, a string of 1,024 characters or more the line already holds, or the text of a `BigInt`, a function or a symbol that long). The message and the rest of the line spend from the same one. A repeat that doesn't fit is `"[Repeated]"` as a whole, so a line holds its first copies plus about one budget, however shared its values are. Serializing an `Error` again, in a graph of Errors with cycles, has a budget of its own of the same size.
_Avoid_: quota, limit, the line's budget

**Error Serializer**:
The `serializeError` Logger Option, `(err, defaultSerialize) => object`: writes every `Error` on a Root Logger's lines, at any depth, in place of the default shape. Called once per `Error` and line. What it returns is serialized like any value: an `Error` inside it goes through it again, a loop is `"[Circular]"`, and the Re-write Budget and the Line Limits apply. `defaultSerialize` gives the default shape with the values nested in it kept as they are. It is user code: when it throws, or returns anything but an object (a Promise included), that `Error` is written in the default shape with `serializeErrorFailed`. A line logged while it runs writes each `Error` as only `type`, `message` and `serializeErrorFailed`. The Workers helpers cache their Root Logger by its identity, so it is defined once, at module scope. `omitErrorKeys(keys)` builds one that leaves the given own keys out (never `type`) and lists them as `omitted`, the same function for the same keys; loggercf has no list of its own.
_Avoid_: error formatter, redaction

**Line Limits**:
The `limits` Logger Option, off by default. `maxStringLength` cuts a longer string value, wherever it is, to that many characters plus `…[truncated from <n> chars]`. `maxRecordBytes` trims a line larger than that many UTF-8 bytes to fit, largest values first, keeping the Protected Fields. Whatever they cut or trim is marked in the line.
_Avoid_: truncation (only one of the two), size cap

**Protected Fields**:
What `maxRecordBytes` keeps whole while anything else on a line can go: `time`, `level`, `message`, the trace IDs, `service`, `environment`, `version`, and `err`'s `type` and `message`. Only when they alone don't fit are `message` and `err.message` cut too. `maxStringLength` never cuts them, except `message` and `err.message`.
_Avoid_: Record Keys, Moved Keys, Owned Keys (each is another rule)

**Entrypoint Hook**:
One of the three getters a `TracedEntrypoint` subclass overrides to supply its Env Mapping, Logger Options or Root Logger, keyed by the symbols `TracedEntrypoint.envMapping`, `.loggerOptions` and `.rootLogger`. Symbol-keyed so they stay off the entrypoint's RPC surface: a caller holding its Service Binding reaches only the string-keyed methods and getters the subclass declares.
_Avoid_: config getter
Not to be confused with the Hono middleware's `fields` / `endFields` hooks.

### Tracing

**Trace Context**:
The W3C identity of the current work: trace ID, current span ID, optional parent span ID, trace flags, and optional tracestate.
_Avoid_: trace, traceparent (that is only its wire form)

**Trace Carrier**:
The wire form of a Trace Context: a `traceparent` value plus an optional `tracestate`, as it travels in HTTP headers, an RPC `session()` call, or a queue message body or Workflow payload (under the key `trace`, where `withQueueMessage` and `withWorkflow` read it).
_Avoid_: trace headers, propagation context

**Span**:
A named, timed operation within a Logging Context, reported once on completion with its duration and status, as its `span.end` line: at its level when it succeeds (`info` unless its options or the Span Defaults say otherwise), at `WARN` once it reaches its Slow Threshold (or at its level, when that is more severe), and always at `ERROR` when it throws. For an unsampled trace only a failure is reported: one `<operation> failed` line at `ERROR`, with no timing.

**Slow Threshold**:
A Span's `slowMs`: the duration, in milliseconds, at or above which a Span that succeeds writes its `span.end` at `WARN` (or at its level, when that is more severe). A faster Span is still written, at its level; to keep fast Spans out of the log, give them a level the logger filters.
_Avoid_: timeout, latency budget

**Span Defaults**:
The level and Slow Threshold a Root Logger gives every Span in the Logging Contexts it opens (`createLogger({ spans })`, or `LOG_SPAN_LEVEL` / `LOG_SPAN_SLOW_MS` through the Env Mapping). Each Span's own options override them. A hand-written Logger has none.

**Span Fields**:
Fields a Span writes on its `span.end` line and on no other: given up front as its `fields` option, or added from inside its work with `span.set()`. They never enter the Logging Context, never reach a nested Span, and are not on the unsampled `<operation> failed` line. Serialized like a log call's fields, so the Moved Keys and the Re-write Budget apply.
_Avoid_: span attributes, span context

**Span Owned Keys**:
The keys a `span.end` line writes itself, which Span Fields cannot set: `span` and `err`. They are dropped from the Span Fields, and one WARN per operation (per isolate, for up to 100 operations) names them, never their values.
_Avoid_: reserved span keys. Not to be confused with the Hono middleware's Owned Keys or the Moved Keys.

**Traced Session**:
An RPC target returned by a Service Binding's `session()` call that carries the caller's Trace Context privately, so every RPC method on it runs inside a Logging Context continuing the caller's trace.
_Avoid_: traced RPC, RPC wrapper
