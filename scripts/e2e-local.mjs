// End-to-end check against the real Workers runtime (wrangler dev / workerd).
//
// Builds the package, starts the three dev Workers (main → bind → math) with
// `pnpm dev`, sends requests carrying a known traceparent, and asserts:
//   - HTTP: status, X-Request-Id / X-Trace-Id / traceparent / tracestate response headers, bodies.
//   - Request ID: an invalid incoming X-Request-Id is replaced by a generated UUID.
//   - Service binding fetch: a request through tracedFetcher(env.BIND) arrives with the
//     caller's trace ID and X-Request-Id, and bind-worker's useLogger continues the trace.
//   - Forwarding c.req.raw: a POST with a body, a stale client X-Request-Id and a client
//     traceparent / tracestate, forwarded through tracedFetcher(env.BIND), arrives with the
//     gateway's Request ID and trace (the fetch span as parent), the gateway's tracestate (none
//     when the trace did not continue from the client's), and the same method and body.
//   - Logs: the Workers' own output continues the trace across every RPC hop,
//     with the span chain intact and no duplicate keys on any line, each
//     Worker's `version` read through its Env Mapping, and a console-style
//     call keeping its trailing object as fields.
//   - withLogging(): a plain WorkerEntrypoint gets a Logging Context per call, a new
//     root trace without a carrier, the caller's trace through session(), and Spans.
//   - Request lines: one request.end per request (no request.error), INFO for 200 and ERROR
//     for 500, with the matched route and the main Worker's include / endFields options.
//   - Units of work outside HTTP (dev/main-worker/src/units.ts): a cron run, a queue message
//     continuing the producer's trace, a Workflow step re-entering run's Logging Context, and a
//     Durable Object's RPC methods, fetch and alarm, each with their Context Fields.
//
// Runs on Linux, macOS and Windows.
//
// Env:
//   LOGGERCF_E2E_LOG_DIR       where wrangler stdout/stderr logs go (default: OS temp dir)
//   LOGGERCF_E2E_READY_MS      how long to wait for wrangler to be ready (default: 120000)
//   LOGGERCF_E2E_SKIP_CLEANUP  set to 1 to leave the dev server running

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const logDir = process.env.LOGGERCF_E2E_LOG_DIR || tmpdir()
const outLog = join(logDir, 'loggercf-e2e.out.log')
const errLog = join(logDir, 'loggercf-e2e.err.log')
const readyTimeoutMs = Number(process.env.LOGGERCF_E2E_READY_MS || 120_000)

const PORT = 8787
// wrangler prints `127.0.0.1` on Windows and `localhost` on Linux.
const READY_RE = new RegExp(String.raw`Ready on (http://(?:localhost|127\.0\.0\.1):${PORT})`)
const TRACE_ID = '11111111111111111111111111111111'
const PARENT_SPAN_ID = '2222222222222222'
const REQUEST_ID = 'req-e2e-local'
const REQUEST_HEADERS = {
  traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`,
  tracestate: 'vendor=value',
  'X-Request-Id': REQUEST_ID,
}

// POST /fetcher-forward: a gateway forwarding its own incoming Request (c.req.raw).
const FORWARD_TRACE_ID = '33333333333333333333333333333333'
const FORWARD_PARENT_SPAN_ID = '4444444444444444'
const FORWARD_TRACESTATE = 'vendor=forward'
// Fails useLogger's default check (spaces), so the gateway generates its own Request ID.
const STALE_REQUEST_ID = 'stale client id'
const STALE_TRACESTATE = 'stale=client'
const FORWARD_BODY = '{"item":"forwarded"}'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function portInUse(port) {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })
}

/**
 * `pnpm <script>` as spawn() arguments. Windows needs a shell to run pnpm.cmd,
 * and a shell takes one command string rather than an args array.
 */
function pnpm(script, options) {
  return isWindows
    ? [`pnpm ${script}`, [], { ...options, cwd: repo, shell: true }]
    : ['pnpm', [script], { ...options, cwd: repo }]
}

function runPnpm(script) {
  const result = spawnSync(...pnpm(script, { stdio: 'inherit' }))
  if (result.status !== 0) throw new Error(`pnpm ${script} failed (exit ${result.status})`)
}

function startDevServer() {
  const out = createWriteStream(outLog)
  const err = createWriteStream(errLog)
  const child = spawn(
    ...pnpm('dev', {
      // Own process group on POSIX so cleanup can stop wrangler and workerd together.
      detached: !isWindows,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    }),
  )
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    out.write(chunk)
  })
  child.stderr.on('data', (chunk) => err.write(chunk))
  const flush = () => Promise.all([out, err].map((s) => new Promise((r) => s.end(r))))
  return { child, readStdout: () => stdout, flush }
}

function stopProcessTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

/** Wait for wrangler's Ready line and return the base URL it prints. */
async function waitUntilReady(server) {
  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    const ready = READY_RE.exec(server.readStdout())
    if (ready) return ready[1]
    if (server.child.exitCode !== null) break
    await sleep(500)
  }
  await server.flush()
  throw new Error(
    `wrangler dev did not become ready within ${readyTimeoutMs}ms.\n` +
      `--- stdout\n${safeRead(outLog)}\n--- stderr\n${safeRead(errLog)}`,
  )
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

async function probe(base, path, expectedStatus) {
  const res = await fetch(`${base}${path}`, { headers: REQUEST_HEADERS })
  const text = await res.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep raw text
  }
  return {
    path,
    status: res.status,
    expectedStatus,
    body,
    xRequestId: res.headers.get('X-Request-Id'),
    xTraceId: res.headers.get('X-Trace-Id'),
    traceparent: res.headers.get('traceparent'),
    tracestate: res.headers.get('tracestate'),
  }
}

/** An invalid incoming X-Request-Id must not be echoed; useLogger generates a UUID instead. */
async function checkInvalidRequestId(base, failures) {
  const res = await fetch(`${base}/trace`, { headers: { 'X-Request-Id': 'not a valid id' } })
  await res.arrayBuffer()
  const echoed = res.headers.get('X-Request-Id') ?? ''
  if (!UUID_RE.test(echoed))
    failures.push(
      `invalid X-Request-Id: response X-Request-Id ${JSON.stringify(echoed)}, expected a UUID`,
    )
}

function checkResponses(results, failures) {
  const byPath = Object.fromEntries(results.map((r) => [r.path, r]))
  const traceparentRe = new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`)

  for (const r of results) {
    if (r.status !== r.expectedStatus)
      failures.push(`${r.path} status ${r.status}, expected ${r.expectedStatus}`)
    if (r.xRequestId !== REQUEST_ID) failures.push(`${r.path} X-Request-Id ${r.xRequestId}`)
    if (r.xTraceId !== TRACE_ID) failures.push(`${r.path} X-Trace-Id ${r.xTraceId}`)
    if (!traceparentRe.test(r.traceparent ?? ''))
      failures.push(`${r.path} traceparent ${r.traceparent}`)
    if (r.tracestate !== 'vendor=value') failures.push(`${r.path} tracestate ${r.tracestate}`)
  }

  const expectBody = (path, key, expected) => {
    const actual = byPath[path]?.body?.[key]
    if (actual !== expected)
      failures.push(
        `${path} body.${key} ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      )
  }
  expectBody('/', 'total', 12)
  expectBody('/', 'traceId', TRACE_ID)
  expectBody('/multi-hop', 'result', 15)
  expectBody('/multi-hop', 'traceId', TRACE_ID)
  expectBody('/trace', 'traceId', TRACE_ID)
  expectBody('/trace', 'parentSpanId', PARENT_SPAN_ID)
  expectBody('/error', 'error', 'Division by zero')
  expectBody('/logged', 'direct', 9)
  expectBody('/logged', 'traced', 16)
  expectBody('/logged', 'pong', 'pong')
  expectBody('/logged', 'error', 'LoggedMath failure')
  expectBody('/logged', 'traceId', TRACE_ID)
  expectBody('/fetcher', 'traceId', TRACE_ID)

  // bind-worker's useLogger, reached through tracedFetcher(env.BIND), continued the trace.
  const downstream = byPath['/fetcher']?.body?.downstream ?? {}
  if (downstream.traceId !== TRACE_ID)
    failures.push(`/fetcher downstream traceId ${downstream.traceId}, expected ${TRACE_ID}`)
  if (!traceparentRe.test(downstream.traceparent ?? ''))
    failures.push(`/fetcher downstream received traceparent ${downstream.traceparent}`)
  if (downstream.requestId !== REQUEST_ID)
    failures.push(`/fetcher downstream requestId ${downstream.requestId}, expected ${REQUEST_ID}`)
}

/**
 * tracedFetcher({ spans: true }) logs one span.end fetch in main-worker, and the receiver's
 * lines continue from that span.
 */
function checkFetcher(records, downstream, failures) {
  const spans = records.filter(
    (r) => r.service === 'pino-log-test' && r.message === 'span.end fetch',
  )
  if (spans.length !== 1) {
    failures.push(`logs: ${spans.length} span.end fetch lines in main-worker, expected 1`)
    return
  }
  const [span] = spans
  const expected = { method: 'GET', host: 'bind-test', path: '/echo-trace', statusCode: 200 }
  for (const [key, value] of Object.entries(expected)) {
    if (span[key] !== value)
      failures.push(`logs: span.end fetch ${key} ${JSON.stringify(span[key])}, expected ${value}`)
  }
  if (span.span?.status !== 'OK') failures.push(`logs: span.end fetch status ${span.span?.status}`)
  if (JSON.stringify(span).includes('not-logged'))
    failures.push('logs: span.end fetch logged the query string')
  if (downstream?.parentSpanId !== span.spanId)
    failures.push(
      `logs: bind-worker parent span ${downstream?.parentSpanId} is not the fetch span ${span.spanId}`,
    )

  const echo = records.find((r) => r.message === 'bind.echoTrace')
  if (!echo) {
    failures.push('logs: no bind.echoTrace line from bind-worker')
  } else if (
    echo.service !== 'bind-test' ||
    echo.requestId !== REQUEST_ID ||
    echo.parentSpanId !== span.spanId
  ) {
    failures.push(`logs: bind.echoTrace does not continue the fetch span: ${JSON.stringify(echo)}`)
  }
}

/**
 * POST /fetcher-forward twice, each with a body and a stale client X-Request-Id:
 * - `continued`: a valid client traceparent + tracestate, which the gateway's useLogger
 *   continues, so its context keeps that tracestate;
 * - `new trace`: an invalid traceparent, so the gateway starts a new trace with no tracestate
 *   and the client's tracestate (now stale) must not reach the receiver.
 */
async function sendForwards(base) {
  const send = async (label, traceHeaders) => {
    const res = await fetch(`${base}/fetcher-forward`, {
      method: 'POST',
      headers: {
        ...traceHeaders,
        'X-Request-Id': STALE_REQUEST_ID,
        'Content-Type': 'application/json',
      },
      body: FORWARD_BODY,
    })
    const text = await res.text()
    let body = text
    try {
      body = JSON.parse(text)
    } catch {
      // keep raw text
    }
    return {
      label,
      status: res.status,
      xRequestId: res.headers.get('X-Request-Id'),
      xTraceId: res.headers.get('X-Trace-Id'),
      tracestate: res.headers.get('tracestate'),
      body,
    }
  }
  return [
    await send('continued', {
      traceparent: `00-${FORWARD_TRACE_ID}-${FORWARD_PARENT_SPAN_ID}-01`,
      tracestate: FORWARD_TRACESTATE,
    }),
    await send('new trace', { traceparent: 'not-a-traceparent', tracestate: STALE_TRACESTATE }),
  ]
}

/**
 * What bind-worker received from `tracedFetcher(env.BIND, { forwardRequestId, spans })
 * .fetch(c.req.raw)`, against the gateway's own Request ID, trace and fetch span.
 */
function checkForwards(forwards, base, failures) {
  const records = readLogRecords().map(({ record }) => record)
  for (const f of forwards) {
    const fail = (what) => failures.push(`/fetcher-forward (${f.label}): ${what}`)
    if (f.status !== 200) {
      fail(`status ${f.status}, body ${JSON.stringify(f.body)}`)
      continue
    }
    const continued = f.label === 'continued'
    const traceId = continued ? FORWARD_TRACE_ID : f.xTraceId
    const tracestate = continued ? FORWARD_TRACESTATE : null

    // The gateway: its own Request ID (the client's was rejected), its trace and tracestate.
    if (!UUID_RE.test(f.xRequestId ?? '')) fail(`gateway X-Request-Id ${f.xRequestId}`)
    const traceOk = continued
      ? f.xTraceId === FORWARD_TRACE_ID
      : /^[0-9a-f]{32}$/.test(f.xTraceId ?? '') && f.xTraceId !== FORWARD_TRACE_ID
    if (!traceOk)
      fail(
        `gateway X-Trace-Id ${f.xTraceId}, expected ${continued ? FORWARD_TRACE_ID : 'a new one'}`,
      )
    if (f.tracestate !== tracestate)
      fail(`gateway tracestate ${f.tracestate}, expected ${tracestate}`)

    const spans = records.filter(
      (r) =>
        r.service === 'pino-log-test' && r.traceId === traceId && r.message === 'span.end fetch',
    )
    if (spans.length !== 1) {
      fail(`${spans.length} span.end fetch lines in main-worker, expected 1`)
      continue
    }
    const [span] = spans
    const expectedSpan = {
      method: 'POST',
      host: new URL(base).host,
      path: '/fetcher-forward',
      statusCode: 200,
    }
    for (const [key, value] of Object.entries(expectedSpan)) {
      if (span[key] !== value) fail(`span.end fetch ${key} ${JSON.stringify(span[key])}`)
    }

    // The receiver: the gateway's Request ID, trace, fetch span and tracestate; same method and body.
    const d = f.body?.downstream ?? {}
    const expected = {
      requestId: f.xRequestId,
      xRequestId: f.xRequestId,
      traceId,
      parentSpanId: span.spanId,
      traceparent: `00-${traceId}-${span.spanId}-01`,
      tracestate,
      method: 'POST',
      body: FORWARD_BODY,
    }
    for (const [key, value] of Object.entries(expected)) {
      if (d[key] !== value)
        fail(`downstream ${key} ${JSON.stringify(d[key])}, expected ${JSON.stringify(value)}`)
    }
    if (JSON.stringify(d).includes(STALE_REQUEST_ID)) fail("the client's X-Request-Id reached bind")
    if (JSON.stringify(d).includes(STALE_TRACESTATE))
      fail("the client's stale tracestate reached bind")
  }
}

/** Parse the JSON log lines out of wrangler's output (it adds prefixes and ANSI colors). */
function readLogRecords() {
  const raw = `${safeRead(outLog)}\n${safeRead(errLog)}`
  const lines = []
  for (const line of raw.split(/\r?\n/)) {
    const plain = stripVTControlCharacters(line)
    const start = plain.indexOf('{"')
    const end = plain.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    const json = plain.slice(start, end + 1)
    try {
      lines.push({ json, record: JSON.parse(json) })
    } catch {
      // not a log record
    }
  }
  return lines
}

/** The keys of a JSON object's top level, in order, duplicates kept (JSON.parse drops them). */
function topLevelKeys(json) {
  const keys = []
  let depth = 0
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (ch === '"') {
      let j = i + 1
      while (json[j] !== '"') j += json[j] === '\\' ? 2 : 1
      if (depth === 1 && json[j + 1] === ':') keys.push(JSON.parse(json.slice(i, j + 1)))
      i = j
    } else if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
    }
  }
  return keys
}

/** Lines outside a Logging Context carry the Default Logger's per-process fields, no trace IDs. */
function checkDefaultLogger(failures) {
  const records = readLogRecords().map(({ record }) => record)
  const received = records.find((r) => r.message === 'bind.multiHop received')
  if (!received) {
    failures.push('logs: no bind.multiHop received line (logged outside a Logging Context)')
  } else if (
    received.service !== 'bind-test' ||
    received.environment !== 'development' ||
    received.version !== '1.0.0' ||
    'traceId' in received
  ) {
    failures.push(
      `logs: bind.multiHop received is not from the Default Logger: ${JSON.stringify(received)}`,
    )
  }
  // main-worker builds its Root Logger with defaultLoggerFromEnv() at module scope.
  const start = records.find(
    (r) => r.traceId === TRACE_ID && String(r.message).startsWith('request.start '),
  )
  if (!start) {
    failures.push(
      'logs: no main-worker request.start line for the module-scope Default Logger check',
    )
  } else if (start.service !== 'pino-log-test' || start.environment !== 'development') {
    failures.push(`logs: main-worker request.start lacks its env fields: ${JSON.stringify(start)}`)
  }
}

/** A log record for a failure message. */
const show = (record) => JSON.stringify(record) ?? 'none'

/**
 * withLogging(): math-worker's LoggedMath is a plain WorkerEntrypoint that main's
 * /logged route calls directly, through session(), with fetch, and with a throw.
 */
function checkWithLogging(results, failures) {
  const callerSpanId = results.find((r) => r.path === '/logged')?.body?.spanId
  const lines = readLogRecords()
    .map(({ record }) => record)
    .filter((r) => r.entrypoint === 'LoggedMath')
  const line = (message) => lines.find((r) => r.message === message)

  // Caller not migrated: a plain RPC call, so a new root trace.
  const direct = line('Squared 3 = 9')
  if (
    direct?.service !== 'math-test' ||
    direct?.rpcMethod !== 'square' ||
    !/^[0-9a-f]{32}$/.test(direct?.traceId ?? '') ||
    direct.traceId === TRACE_ID ||
    !/^[0-9a-f]{16}$/.test(direct.spanId ?? '') ||
    'parentSpanId' in direct
  ) {
    failures.push(`logs: plain RPC square(3) is not in a new root trace: ${show(direct)}`)
  }
  // Env Mapping: LoggedMath reads version from version_metadata, as MathSession does.
  if (typeof direct?.version !== 'string' || direct.version === '') {
    failures.push('logs: LoggedMath has no version from its version_metadata binding')
  }

  // Migrated caller (withTrace) and fetch with a traceparent header: both continue main's span.
  for (const [message, rpcMethod] of [
    ['Squared 4 = 16', 'square'],
    ['LoggedMath fetch', 'fetch'],
  ]) {
    const record = line(message)
    if (
      record?.rpcMethod !== rpcMethod ||
      record.traceId !== TRACE_ID ||
      typeof callerSpanId !== 'string' ||
      record.parentSpanId !== callerSpanId
    ) {
      failures.push(
        `logs: ${message} does not continue main's span ${callerSpanId}: ${show(record)}`,
      )
    }
  }

  const spanEnds = (operation) => lines.filter((r) => r.message === `span.end ${operation}`)
  const squares = spanEnds('LoggedMath.square')
  if (squares.length !== 2 || squares.some((r) => r.span?.status !== 'OK')) {
    failures.push(`logs: ${squares.length} OK span.end LoggedMath.square lines, expected 2`)
  }
  const failed = spanEnds('LoggedMath.fail')
  if (
    failed.length !== 1 ||
    failed[0].level !== 'ERROR' ||
    failed[0].span?.status !== 'ERROR' ||
    failed[0].err?.message !== 'LoggedMath failure'
  ) {
    failures.push(`logs: span.end LoggedMath.fail is not one ERROR line with err: ${show(failed)}`)
  }
}

/** Context Fields and trace for each unit of work in dev/main-worker/src/units.ts. */
function checkUnits(results, failures) {
  const body = (path) => results.find((r) => r.path === path)?.body ?? {}
  const records = readLogRecords().map(({ record }) => record)
  const line = (message, where = () => true) =>
    records.find((r) => r.message === message && where(r))
  const isRoot = (r) =>
    /^[0-9a-f]{32}$/.test(r?.traceId ?? '') && r.traceId !== TRACE_ID && !('parentSpanId' in r)
  const expectFields = (label, record, fields) => {
    const wrong = Object.entries(fields).filter(([key, value]) => record?.[key] !== value)
    if (!record || wrong.length > 0)
      failures.push(`logs: ${label} lacks ${JSON.stringify(fields)}: ${show(record)}`)
  }

  // Cron: a new root trace with cron and scheduledTime, and one span.end scheduled.
  const tick = line('cron tick', (r) => r.cron === '* * * * *')
  expectFields('cron tick', tick, { service: 'pino-log-test', worker: 'pino-log-test' })
  if (!isRoot(tick) || typeof tick?.scheduledTime !== 'number')
    failures.push(`logs: cron tick is not a root trace with scheduledTime: ${show(tick)}`)
  const cronSpan = line('span.end scheduled', (r) => r.traceId === tick?.traceId)
  if (cronSpan?.span?.status !== 'OK' || cronSpan.cron !== '* * * * *')
    failures.push(`logs: no OK span.end scheduled for the cron run: ${show(cronSpan)}`)

  // Queue: the consumer continues the producer's span from the `trace` carrier in the body.
  const job = line('queue job processed')
  expectFields('queue job processed', job, {
    queue: 'loggercf-dev-jobs',
    attempts: 1,
    traceId: TRACE_ID,
    parentSpanId: body('/queue').spanId,
  })
  if (typeof job?.messageId !== 'string' || job.messageId === '')
    failures.push(`logs: queue job processed has no messageId: ${show(job)}`)
  const queueSpan = line('span.end queue.message', (r) => r.spanId === job?.spanId)
  if (queueSpan?.span?.status !== 'OK') failures.push('logs: no OK span.end queue.message')

  // Workflow: run continues the creator's trace; the step callback, which arrives over RPC,
  // runs in run's Logging Context with step and attempt, one Span per attempt.
  const { instanceId } = body('/workflow')
  const run = line('Report run', (r) => r.workflowInstanceId === instanceId)
  expectFields('Report run', run, {
    workflowInstanceId: instanceId,
    traceId: TRACE_ID,
    parentSpanId: body('/workflow').spanId,
  })
  for (const attempt of [1, 2]) {
    expectFields(
      `Report doubling attempt ${attempt}`,
      line('Report doubling', (r) => r.workflowInstanceId === instanceId && r.attempt === attempt),
      { step: 'double', traceId: TRACE_ID, parentSpanId: run?.spanId },
    )
  }
  const stepSpans = records.filter(
    (r) => r.message === 'span.end double' && r.workflowInstanceId === instanceId,
  )
  const failedStep = stepSpans.find((r) => r.attempt === 1)
  const okStep = stepSpans.find((r) => r.attempt === 2)
  if (
    stepSpans.length !== 2 ||
    failedStep?.level !== 'ERROR' ||
    failedStep.err?.message !== 'Report flaky' ||
    okStep?.span?.status !== 'OK'
  )
    failures.push(`logs: span.end double is not ERROR then OK per attempt: ${show(stepSpans)}`)
  expectFields(
    'Report done',
    line('Report done', (r) => r.workflowInstanceId === instanceId),
    { doubled: 42, traceId: TRACE_ID },
  )

  // Durable Object: RPC methods and alarm start a root trace; fetch continues the caller's.
  const room = { durableObject: 'Room', objectName: 'e2e-room', service: 'pino-log-test' }
  const joined = line('Room join')
  expectFields('Room join', joined, { ...room, rpcMethod: 'join' })
  if (!isRoot(joined)) failures.push(`logs: Room join is not a root trace: ${show(joined)}`)
  if (!/^[0-9a-f]{64}$/.test(joined?.objectId ?? ''))
    failures.push(`logs: Room join has no objectId beside objectName: ${show(joined)}`)
  expectFields('Room fetch', line('Room fetch'), {
    ...room,
    rpcMethod: 'fetch',
    traceId: TRACE_ID,
    parentSpanId: body('/durable-object').spanId,
  })
  expectFields('Room alarm', line('Room alarm'), { ...room, rpcMethod: 'alarm' })
  const roomFail = line('span.end Room.fail')
  if (
    roomFail?.level !== 'ERROR' ||
    roomFail.err?.message !== 'Room failure' ||
    roomFail.durableObject !== 'Room'
  )
    failures.push(`logs: span.end Room.fail is not one ERROR line with err: ${show(roomFail)}`)
}

/** Wait until wrangler's output has every marker (lines logged after the response), or time out. */
async function waitForOutput(server, markers, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = stripVTControlCharacters(server.readStdout())
    if (markers.every((marker) => out.includes(marker))) return
    await sleep(250)
  }
}

function checkLogs(failures, results) {
  checkDefaultLogger(failures)
  const lines = readLogRecords().filter(({ record }) => record.traceId === TRACE_ID)
  if (lines.length === 0) {
    failures.push('logs: no Worker log lines carry the request traceId')
    return
  }
  checkFetcher(
    lines.map(({ record }) => record),
    results.find((r) => r.path === '/fetcher')?.body?.downstream,
    failures,
  )

  for (const { json } of lines) {
    const keys = topLevelKeys(json)
    const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i)
    if (duplicates.length > 0) {
      failures.push(`logs: duplicate keys ${[...new Set(duplicates)]} in ${json.slice(0, 160)}…`)
    }
  }

  const spans = new Map()
  for (const { record } of lines) {
    if (typeof record.message === 'string' && record.message.startsWith('span.end ')) {
      spans.set(record.message.slice('span.end '.length), record)
    }
  }
  const multiHop = spans.get('bind.multiHop')
  const multiply = spans.get('math.multiply')
  if (!multiHop) failures.push('logs: no span.end bind.multiHop')
  if (!multiply) failures.push('logs: no span.end math.multiply')
  if (multiHop && multiply && multiply.parentSpanId !== multiHop.spanId) {
    failures.push(
      `logs: math.multiply parent ${multiply.parentSpanId} is not bind.multiHop span ${multiHop.spanId}`,
    )
  }
  // Env Mapping: bind reads the default VERSION var, math maps version_metadata (dev/*/wrangler.jsonc).
  if (multiHop && multiHop.version !== '1.0.0') {
    failures.push(`logs: bind.multiHop version ${multiHop.version} is not VERSION 1.0.0`)
  }
  if (multiply && (typeof multiply.version !== 'string' || multiply.version === '')) {
    failures.push('logs: math.multiply has no version from its version_metadata binding')
  }
  const consoleStyle = lines.find(
    ({ record }) => record.message === 'Console-style log with a placeholder',
  )?.record
  if (consoleStyle?.style !== 'console') {
    failures.push('logs: the console-style line is missing, or lost its { style } argument')
  }

  const divideByZero = spans.get('bind.divideByZero')
  if (divideByZero?.span?.status !== 'ERROR' || divideByZero?.err?.message !== 'Division by zero') {
    failures.push('logs: span.end bind.divideByZero is missing its ERROR status or err')
  }

  checkRequestLines(lines, failures)
}

/**
 * useLogger's request lines from the main Worker: one request.end per request, its level from
 * the status, the matched `route`, and the `include` / `endFields` options of dev/main-worker.
 */
function checkRequestLines(lines, failures) {
  const records = lines.map(({ record }) => record)
  const withMessage = (message) => records.filter((r) => r.message === message)

  if (records.some((r) => typeof r.message === 'string' && r.message.startsWith('request.error')))
    failures.push('logs: a request.error line was written; failures belong on request.end')

  const expectRequestEnd = (path, expected) => {
    const ends = withMessage(`request.end GET ${path}`)
    if (ends.length !== 1) {
      failures.push(`logs: ${ends.length} request.end lines for ${path}, expected 1`)
      return
    }
    const [end] = ends
    for (const [key, value] of Object.entries(expected)) {
      if (end[key] !== value)
        failures.push(
          `logs: request.end ${path} ${key} ${JSON.stringify(end[key])}, expected ${JSON.stringify(value)}`,
        )
    }
    if (typeof end.duration !== 'number') failures.push(`logs: request.end ${path} has no duration`)
    if (typeof end.userAgent !== 'string' || end.userAgent === '')
      failures.push(`logs: request.end ${path} has no userAgent (include.userAgent)`)
    if (!String(end.contentType).startsWith('application/json'))
      failures.push(
        `logs: request.end ${path} contentType ${JSON.stringify(end.contentType)} (endFields)`,
      )
  }
  expectRequestEnd('/', { level: 'INFO', statusCode: 200, route: '/', path: '/' })
  expectRequestEnd('/error', { level: 'ERROR', statusCode: 500, route: '/error', path: '/error' })

  if (withMessage('request.start GET /').length !== 1)
    failures.push('logs: expected one request.start GET / (requestStart defaults to true)')
}

async function main() {
  if (await portInUse(PORT))
    throw new Error(`Port ${PORT} is already in use. Stop it before running e2e.`)

  runPnpm('build')
  const server = startDevServer()
  try {
    const base = await waitUntilReady(server)

    const results = []
    for (const [path, status] of [
      ['/', 200],
      ['/multi-hop', 200],
      ['/trace', 200],
      ['/error', 500],
      ['/fetcher', 200],
      ['/logged', 200],
      ['/durable-object', 200],
      ['/queue', 200],
      ['/workflow', 200],
    ]) {
      results.push(await probe(base, path, status))
    }

    const forwards = await sendForwards(base)

    const failures = []
    await checkInvalidRequestId(base, failures)

    // Cron runs through wrangler's scheduled endpoint, not the fetch handler.
    const cron = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`)
    await cron.arrayBuffer()
    if (cron.status !== 200)
      failures.push(`/cdn-cgi/handler/scheduled status ${cron.status}, expected 200`)

    // The queue consumer, the Workflow and the alarm log after their requests return.
    await waitForOutput(server, ['"queue job processed"', '"Report done"', '"Room alarm"'])
    await sleep(1000) // let wrangler flush the Workers' log output
    await server.flush()

    checkResponses(results, failures)
    checkLogs(failures, results)
    checkWithLogging(results, failures)
    checkUnits(results, failures)
    checkForwards(forwards, base, failures)

    if (failures.length > 0) {
      console.error(`E2E failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
      console.error(`Wrangler logs: ${outLog}, ${errLog}`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify([...results, ...forwards], null, 2))
    console.log('E2E passed.')
  } finally {
    if (process.env.LOGGERCF_E2E_SKIP_CLEANUP !== '1') stopProcessTree(server.child)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
