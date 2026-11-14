import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import vm from 'node:vm'
import {
  createLogger,
  getLogger,
  runWithLogger,
  setLoggerContext,
  getTraceContext,
  withSpan,
  _captureEntries,
  _captureLines,
  _setSink,
  _reset,
} from './logger'
import { nodeSink, workersSink, defaultErrorShape, stringifyRecord, type Sink } from './output'
import { messageAfterLevel } from './test-helpers'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

class DbError extends Error {
  code = 'E_DB'
}

/** The same calls, inside a Logging Context, for comparing adapters. */
function logScenario() {
  const logger = createLogger({
    service: 'contract',
    level: 'trace',
    environment: 'test',
    version: '1.0.0',
  })
  runWithLogger({ logger, traceparent: TRACEPARENT, fields: { requestId: 'req-1' } }, () => {
    const log = logger.child({ component: 'db' })
    log.trace('trace line')
    log.debug({ n: 1 }, 'debug %d', 1)
    log.info({ user: 'u-1' }, 'info line')
    log.warn(new Error('bare warning'))
    log.error({ err: new DbError('query failed', { cause: new Error('socket closed') }) }, 'boom')
    log.fatal('fatal line')
  })
}

/** Run `fn` with `next` as the sink, capturing every console method call. */
function captureConsole(next: Sink, fn: () => void): Array<[method: string, line: string]> {
  const calls: Array<[string, string]> = []
  const methods = ['log', 'debug', 'info', 'warn', 'error'] as const
  const spies = methods.map((m) =>
    vi.spyOn(console, m).mockImplementation((line: string) => calls.push([m, line])),
  )
  const previous = _setSink(next)
  try {
    fn()
  } finally {
    _setSink(previous)
    for (const s of spies) s.mockRestore()
  }
  return calls
}

/** Strip what legitimately differs between two runs: time, the new span ID, stack positions. */
const normalize = (line: string) =>
  line
    .replace(/"time":"[^"]+"/, '"time":"<t>"')
    .replace(/"spanId":"[0-9a-f]+"/, '"spanId":"<span>"')
    .replace(/"stack":"(?:\\.|[^"\\])*"/g, '"stack":"<stack>"')

describe('runtime adapters', () => {
  beforeEach(() => _reset())

  it('Node and Workers write byte-identical lines (time aside) for the same calls', () => {
    const node = captureConsole(nodeSink, logScenario)
    const workers = captureConsole(workersSink, logScenario)

    expect(node).toHaveLength(6)
    expect(node.map(([, line]) => normalize(line))).toEqual(
      workers.map(([, line]) => normalize(line)),
    )
  })

  it('Node writes every level to console.log', () => {
    const node = captureConsole(nodeSink, logScenario)
    expect(new Set(node.map(([method]) => method))).toEqual(new Set(['log']))
  })

  it('Workers picks the console method by level', () => {
    const workers = captureConsole(workersSink, logScenario)
    expect(workers.map(([method]) => method)).toEqual([
      'debug',
      'debug',
      'info',
      'warn',
      'error',
      'error',
    ])
  })
})

describe('record shape', () => {
  beforeEach(() => _reset())

  it('starts with time and level, and has no pid or hostname', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info('hello')

    expect(Object.keys(entries[0]).slice(0, 2)).toEqual(['time', 'level'])
    expect(entries[0]).not.toHaveProperty('pid')
    expect(entries[0]).not.toHaveProperty('hostname')
    expect(entries[0]).toMatchObject({ level: 'INFO', service: 'svc', message: 'hello' })
  })

  it('precedence: trace IDs > log-call fields > logger bindings > Context Fields', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    let trace: ReturnType<typeof getTraceContext>

    runWithLogger(
      { logger, traceparent: TRACEPARENT, fields: { requestId: 'ctx', a: 'ctx' } },
      () => {
        trace = getTraceContext()
        setLoggerContext({ b: 'ctx' })
        logger
          .child({ a: 'binding', b: 'binding' })
          .info({ requestId: 'call', traceId: 'forged', parentSpanId: 'forged' }, 'm')
      },
    )

    expect(entries[0]).toMatchObject({
      requestId: 'call',
      a: 'binding',
      b: 'binding',
      traceId: trace!.traceId,
      spanId: trace!.spanId,
      parentSpanId: trace!.parentSpanId,
    })
  })

  it('bindings cannot set time, level, message, errors or args; their values move to args', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' })
      .child({ time: 'T', level: 'BAD', message: 'B', errors: 'E', args: 'A', a: 1 })
      .info('m')
    expect(entries[0]).toMatchObject({ level: 'INFO', message: 'm', a: 1 })
    expect(entries[0].time).not.toBe('T')
    expect(Object.keys(entries[0]).slice(0, 2)).toEqual(['time', 'level'])
    expect(entries[0].errors).toBeUndefined()
    expect(entries[0].args).toEqual([
      { time: 'T', level: 'BAD', message: 'B', errors: 'E', args: 'A' },
    ])
  })

  it('Context Fields cannot set them either, even when the call gives no message', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: createLogger({ service: 'svc' }) }, () => {
      setLoggerContext({ level: 'CTX', message: 'm2', b: 2 })
      createLogger({ service: 'svc' }).info({ a: 1 })
    })
    expect(entries[0]).toMatchObject({ level: 'INFO', a: 1, b: 2 })
    expect(entries[0]).not.toHaveProperty('message')
    expect(entries[0].args).toEqual([{ level: 'CTX', message: 'm2' }])
  })

  it('moved values follow the call’s own args: call, then bindings, then Context Fields', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: createLogger({ service: 'svc' }), fields: { level: 'CTX' } }, () => {
      createLogger({ service: 'svc' }).child({ level: 'BIND' }).warn('m', [1], { level: 'CALL' })
    })
    expect(entries[0]).toMatchObject({ level: 'WARN', message: 'm' })
    expect(entries[0].args).toEqual([[1], { level: 'CALL' }, { level: 'BIND' }, { level: 'CTX' }])
  })

  it('Workers picks the console method from the call’s level, not a binding', () => {
    const calls = captureConsole(workersSink, () =>
      createLogger({ service: 'svc' }).child({ level: 'ERROR' }).info('m'),
    )
    expect(calls.map(([method]) => method)).toEqual(['info'])
  })

  it('a log call cannot invent a parentSpanId on a root trace', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: createLogger({ service: 'svc' }) }, () => {
      createLogger({ service: 'svc' }).info({ parentSpanId: 'forged' }, 'm')
    })
    expect(entries[0]).not.toHaveProperty('parentSpanId')
  })

  it('never throws on circular values or BigInt', () => {
    const entries = _captureEntries()
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop

    createLogger({ service: 'svc' }).info({ loop, big: 10n }, 'odd values')

    expect(entries[0]).toMatchObject({ loop: { name: 'loop', self: '[Circular]' }, big: '10' })
  })
})

describe('errors', () => {
  beforeEach(() => _reset())
  afterEach(() => vi.restoreAllMocks())

  it('keeps a bare Error passed as the first argument', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })

    logger.error(new Error('bare'))
    logger.warn(new Error('with message'), 'custom %s', 'text')

    expect(entries[0]).toMatchObject({ message: 'bare', err: { type: 'Error', message: 'bare' } })
    expect(typeof (entries[0].err as Record<string, unknown>).stack).toBe('string')
    expect(entries[1]).toMatchObject({ message: 'custom text', err: { message: 'with message' } })
  })

  it('serializes own props and nests cause', () => {
    const entries = _captureEntries()
    const err = new DbError('query failed', { cause: new Error('socket closed') })

    createLogger({ service: 'svc' }).error({ err }, 'boom')

    expect(entries[0].err).toMatchObject({
      type: 'DbError',
      message: 'query failed',
      code: 'E_DB',
      cause: { type: 'Error', message: 'socket closed' },
    })
  })

  it('serializes Error values under any top-level key', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).warn({ reason: new TypeError('bad input') }, 'rejected')
    expect(entries[0].reason).toMatchObject({ type: 'TypeError', message: 'bad input' })
  })

  it('cuts off deep cause chains', () => {
    let err = new Error('e0')
    for (let i = 1; i < 10; i++) err = new Error(`e${i}`, { cause: err })

    const serialized = defaultErrorShape(err)
    let depth = 0
    let node = serialized
    while (node.cause && typeof node.cause === 'object') {
      node = node.cause as Record<string, unknown>
      depth++
    }
    expect(depth).toBe(6)
    expect(node.type).toBe('Truncated')
  })

  it('a circular cause chain is "[Circular]" where it loops', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b

    expect(defaultErrorShape(a)).toMatchObject({
      message: 'a',
      cause: { message: 'b', cause: '[Circular]' },
    })
    expect(stringifyRecord(defaultErrorShape(a)).length).toBeGreaterThan(0)
  })

  it('a shared, non-circular Error is serialized in each place', () => {
    const shared = new Error('shared')
    const err = Object.assign(new Error('outer'), { first: shared, second: shared })
    expect(defaultErrorShape(err)).toMatchObject({
      first: { message: 'shared' },
      second: { message: 'shared' },
    })
  })
})

/** An `Error` with a short, fixed stack, so whole serialized copies can be compared. */
const short = <E extends Error>(error: E): E => {
  error.stack = 'stack'
  return error
}
/** How a `short()` Error with `message` serializes, with nothing else on it. */
const plain = (message: string, type = 'Error') => ({ type, message, stack: 'stack' })

describe('errors at any depth', () => {
  beforeEach(() => _reset())

  it('an Error nested in an object has the shape of a top-level one', () => {
    const entries = _captureEntries()
    const err = short(new DbError('query failed', { cause: short(new Error('socket closed')) }))
    createLogger({ service: 'svc' }).error({ detail: { error: err } }, 'm')
    createLogger({ service: 'svc' }).error({ err }, 'm')
    const nested = (entries[0].detail as Record<string, unknown>).error
    expect(nested).toEqual({
      ...plain('query failed', 'DbError'),
      code: 'E_DB',
      cause: plain('socket closed'),
    })
    expect(nested).toEqual(entries[1].err)
  })

  it('Errors in an array, in a field and in args', () => {
    const entries = _captureEntries()
    const attempts = [short(new Error('try 1')), short(new TypeError('try 2')), 'gave up']
    createLogger({ service: 'svc' }).error({ attempts }, 'm')
    createLogger({ service: 'svc' }).error('m', [[short(new Error('deep'))]])
    expect(entries[0].attempts).toEqual([plain('try 1'), plain('try 2', 'TypeError'), 'gave up'])
    expect(entries[1].args).toEqual([[[plain('deep')]]])
  })

  it('an Error in a Map, a Set or a class instance', () => {
    const entries = _captureEntries()
    class Job {
      failure = short(new Error('in a class'))
    }
    const byId = new Map([['a', short(new Error('in a map'))]])
    createLogger({ service: 'svc' }).error({ byId, set: new Set([short(new Error('in a set'))]) })
    createLogger({ service: 'svc' }).error('m', new Job())
    expect(entries[0]).toMatchObject({ byId: [['a', plain('in a map')]], set: [plain('in a set')] })
    expect(entries[1].args).toEqual([{ failure: plain('in a class') }])
  })

  it('an Error nested in Context Fields', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    runWithLogger({ logger, fields: { job: { lastError: short(new Error('ctx')) } } }, () => {
      getLogger().info('in context')
      setLoggerContext({ retry: [short(new Error('set later'))] })
      getLogger().info('after set')
    })
    expect(entries[0].job).toEqual({ lastError: plain('ctx') })
    expect(entries[1].retry).toEqual([plain('set later')])
  })

  it('an Error nested in Logger Bindings', () => {
    const entries = _captureEntries()
    const root = createLogger({ service: 'svc' }, { boot: { error: short(new Error('bound')) } })
    root.info('root')
    root.child({ last: [short(new Error('child'))] }).info('child')
    expect(entries[0].boot).toEqual({ error: plain('bound') })
    expect(entries[1]).toMatchObject({ boot: { error: plain('bound') }, last: [plain('child')] })
  })

  it('a circular structure holding Errors: "[Circular]" where it loops, in both directions', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    // An object that contains itself, and holds an Error.
    const c: Record<string, unknown> = { e: short(new Error('circ')) }
    c.self = c
    // An object holding an Error that holds the object.
    const owner: Record<string, unknown> = {}
    owner.error = Object.assign(short(new Error('owned')), { owner })
    // An Error holding an object holding an Error whose cause is the first.
    const outer = short(new Error('outer')) as Error & Record<string, unknown>
    outer.detail = { inner: short(new Error('inner', { cause: outer })) }
    logger.error({ c, owner }, 'm')
    logger.error(outer)
    logger.error({ wrapped: { outer } }, 'm')
    expect(entries[0].c).toEqual({ e: plain('circ'), self: '[Circular]' })
    expect(entries[0].owner).toEqual({ error: { ...plain('owned'), owner: '[Circular]' } })
    const expected = {
      ...plain('outer'),
      detail: { inner: { ...plain('inner'), cause: '[Circular]' } },
    }
    expect(entries[1].err).toEqual(expected)
    expect(entries[2].wrapped).toEqual({ outer: expected })
  })

  it('an Error whose cause holds an object holding that Error is "[Circular]" there', () => {
    const entries = _captureEntries()
    const first = short(new Error('first')) as Error & { cause?: unknown }
    first.cause = { holder: first, list: [first] }
    createLogger({ service: 'svc' }).error(first)
    createLogger({ service: 'svc' }).error({ deep: { first } }, 'm')
    const expected = { ...plain('first'), cause: { holder: '[Circular]', list: ['[Circular]'] } }
    expect(entries[0].err).toEqual(expected)
    expect((entries[1].deep as Record<string, unknown>).first).toEqual(expected)
  })

  it('the same nested Error twice is a repeat, written again within the budget', () => {
    const entries = _captureEntries()
    const shared = short(new Error('shared'))
    createLogger({ service: 'svc' }).error({ err: shared, a: { e: shared }, b: [shared] }, 'm')
    expect(entries[0]).toMatchObject({
      err: plain('shared'),
      a: { e: plain('shared') },
      b: [plain('shared')],
    })
  })

  it('an AggregateError nested in a field writes its errors', () => {
    const entries = _captureEntries()
    const agg = short(
      new AggregateError([short(new Error('e1')), short(new RangeError('e2')), 3], 'all failed'),
    )
    createLogger({ service: 'svc' }).error({ result: { failure: agg } }, 'm')
    expect((entries[0].result as Record<string, unknown>).failure).toEqual({
      ...plain('all failed', 'AggregateError'),
      errors: [plain('e1'), plain('e2', 'RangeError'), 3],
    })
  })

  it('Errors nested through objects count toward the cause depth limit', () => {
    const entries = _captureEntries()
    let error = short(new Error('e9'))
    for (let i = 8; i >= 0; i--) error = short(new Error(`e${i}`, { cause: { attempt: error } }))
    createLogger({ service: 'svc' }).error({ chain: { error } }, 'm')
    let node = (entries[0].chain as Record<string, Record<string, unknown>>).error
    let depth = 0
    while (node.type !== 'Truncated') {
      node = (node.cause as Record<string, Record<string, unknown>>).attempt
      depth++
    }
    expect(depth).toBe(6) // e0 to e5 written, as for a chain of causes
    expect(node).toEqual({ type: 'Truncated', message: 'cause chain deeper than 5' })
  })

  it('fake Errors and Errors that throw never make the call throw', () => {
    const entries = _captureEntries()
    const fake = Object.create(Error.prototype) as Error
    const throwing = new Proxy(new Error('p'), {
      get() {
        throw new Error('trap')
      },
    })
    const getter = Object.defineProperty(short(new Error('g')), 'code', {
      enumerable: true,
      get() {
        throw new Error('no code')
      },
    })
    const { proxy: revoked, revoke } = Proxy.revocable(new Error('r'), {})
    revoke()
    const logger = createLogger({ service: 'svc' })
    expect(() => {
      logger.error({ n: { fake, throwing, getter, revoked } }, 'nested')
      logger.error({ fake, throwing, getter, revoked }, 'top')
    }).not.toThrow()
    const [nested, top] = entries
    expect(nested.n).toEqual({
      fake: top.fake,
      throwing: top.throwing,
      getter: top.getter,
      revoked: top.revoked,
    })
    expect(top.fake).toMatchObject({ type: 'Error', message: '' })
    expect(top.throwing).toMatchObject({ message: '[Unserializable: Error: trap]' })
    expect(top.getter).toMatchObject({ message: 'g', code: '[Unserializable: Error: no code]' })
    expect(top.revoked).toMatch(/^\[Unserializable: TypeError: .*revoked/)
  })

  it('an Error from another realm is an Error, at the top level and nested', () => {
    const entries = _captureEntries()
    const foreign = vm.runInNewContext('new RangeError("from vm")') as Error
    foreign.stack = 'stack'
    expect(foreign instanceof Error).toBe(false)
    createLogger({ service: 'svc' }).error(foreign)
    createLogger({ service: 'svc' }).error({ detail: { foreign } }, 'm')
    expect(entries[0]).toMatchObject({ message: 'from vm', err: plain('from vm', 'RangeError') })
    expect(entries[1].detail).toEqual({ foreign: plain('from vm', 'RangeError') })
  })

  it('a nested Error with a toJSON is written by it, as JSON does, on both paths', () => {
    const entries = _captureEntries()
    class Coded extends Error {
      toJSON() {
        return `Coded: ${this.message}`
      }
    }
    const coded = new Coded('c')
    const logger = createLogger({ service: 'svc' })
    logger.error({ a: { coded } }, 'fast path') // nothing else sends the line to the walk
    logger.error({ a: { coded }, b: { e: short(new Error('walk')) } }, 'walk')
    logger.error({ coded }, 'top level')
    expect(entries[0].a).toEqual({ coded: 'Coded: c' })
    expect(entries[1].a).toEqual({ coded: 'Coded: c' })
    expect(entries[2].coded).toMatchObject({ type: 'Coded', message: 'c' })
  })

  it('%j %o %O never print a nested Error: the value is routed instead', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info('v=%j', { e: short(new Error('in json')) })
    createLogger({ service: 'svc' }).info('v=%o', [short(new Error('in array'))])
    expect(entries[0]).toMatchObject({ message: 'v=%j', e: plain('in json') })
    expect(entries[1]).toMatchObject({ message: 'v=%o', args: [[plain('in array')]] })
  })

  it('a line with only top-level Errors stays on the fast path; a nested one takes the walk', () => {
    let reads = 0
    const counted = {
      get n() {
        return ++reads
      },
    }
    const lines = _captureLines()
    const logger = createLogger({ service: 'svc' })
    logger.error({ err: new Error('top', { cause: new Error('c') }), counted }, 'm')
    expect(reads).toBe(1) // the walk would read it again
    logger.error({ counted, nested: { e: new Error('nested') } }, 'm') // read, then the walk
    expect(reads).toBe(3)
    expect(JSON.parse(lines[1]).counted).toEqual({ n: 3 })
  })
})

/** How long `fn` takes, in milliseconds. */
const elapsed = (fn: () => void) => {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe('nested Errors keep every bound', () => {
  beforeEach(() => _reset())

  it('one large Error nested 2,000 times: fast, and the line stays bounded', () => {
    const lines = _captureLines()
    const big = new Error('x'.repeat(100_000))
    const items = Array.from({ length: 2000 }, () => ({ err: big }))
    const ms = elapsed(() => createLogger({ service: 'svc' }).error({ items }, 'm'))
    expect(ms).toBeLessThan(500)
    expect(lines[0].length).toBeLessThan(1_000_000)
    const written = JSON.parse(lines[0]).items as { err: unknown }[]
    expect(written).toHaveLength(2000)
    expect(written[0].err).toMatchObject({ type: 'Error', message: big.message })
    expect(written.at(-1)).toEqual({ err: '[Repeated]' })
  })

  it('20 Errors, each holding its own array of all 20: fast, and the line stays bounded', () => {
    const lines = _captureLines()
    const errors = Array.from({ length: 20 }, (_, i) => new Error(`e${i}`))
    for (const error of errors) Object.assign(error, { all: [...errors], by: { ...errors } })
    const ms = elapsed(() => createLogger({ service: 'svc' }).error({ graph: { errors } }, 'm'))
    expect(ms).toBeLessThan(500)
    expect(lines[0].length).toBeLessThan(1_000_000)
    const line = JSON.parse(lines[0])
    expect(line.logError).toBeUndefined()
    expect(line.graph.errors[0].all[0]).toBe('[Circular]')
    expect(line.graph.errors[0].all[1]).toMatchObject({ message: 'e1' })
    expect(lines[0]).toContain('"[Repeated]"')
  })

  it('a wide Error nested 1,001 times under different objects: within the budget', () => {
    const lines = _captureLines()
    const wideError = Object.assign(
      new Error('wide'),
      Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])),
    )
    const holders = Array.from({ length: 1001 }, (_, i) => ({ i, nested: { wideError } }))
    const ms = elapsed(() => createLogger({ service: 'svc' }).error({ holders }, 'm'))
    expect(ms).toBeLessThan(500)
    expect(lines[0].length).toBeLessThan(1_000_000)
    const written = JSON.parse(lines[0]).holders as { nested: { wideError: unknown } }[]
    expect(written[0].nested.wideError).toMatchObject({ message: 'wide', k4999: 4999 })
    expect(written.at(-1)!.nested.wideError).toBe('[Repeated]')
  })
})

/** Strip time, generated span IDs, stacks and span timing, everywhere in a line. */
const normalizeAll = (line: string) =>
  line
    .replace(/"time":"[^"]+"/g, '"time":"<t>"')
    .replace(/"spanId":"[0-9a-f]+"/g, '"spanId":"<span>"')
    .replace(/"parentSpanId":"(?!b7ad)[0-9a-f]+"/g, '"parentSpanId":"<parent>"')
    .replace(/"stack":"(?:\\.|[^"\\])*"/g, '"stack":"<stack>"')
    .replace(/"(start|end)Time":\d+/g, '"$1Time":0')
    .replace(/"duration":\d+/g, '"duration":0')

/**
 * Lines written for the scenario below by the pino-based logger (main at
 * 15a214a, pino 10), captured by running the same calls against that build.
 * Key order included: the internal core must match, except that it writes
 * `message` right after `level` (`messageAfterLevel()`).
 */
const BASELINE_LINES = [
  String.raw`{"time":"<t>","level":"INFO","service":"svc","environment":"test","version":"1.0.0","region":"eu","message":"outside"}`,
  String.raw`{"time":"<t>","level":"DEBUG","requestId":"req-1","a":"call","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"n":1,"message":"debug 1","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"user":"u-1","message":"info line","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"WARN","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"err":{"type":"Error","message":"bare warning","stack":"<stack>"},"message":"bare warning","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"ERROR","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"err":{"type":"DbError","message":"query failed","stack":"<stack>","code":"E_DB","cause":{"type":"Error","message":"socket closed","stack":"<stack>"}},"message":"boom","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"FATAL","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"message":"fatal x {\"k\":1}","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"m":1,"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","a":"ctx","service":"svc","environment":"test","version":"1.0.0","region":"eu","span":{"operation":"op","startTime":0,"endTime":0,"duration":0,"status":"OK"},"message":"span.end op","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"<parent>"}`,
  String.raw`{"time":"<t>","level":"ERROR","requestId":"req-1","a":"ctx","service":"svc","environment":"test","version":"1.0.0","region":"eu","span":{"operation":"op2","startTime":0,"endTime":0,"duration":0,"status":"ERROR","error":"x"},"err":{"type":"Error","message":"x","stack":"<stack>"},"message":"span.end op2","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"<parent>"}`,
]

describe('same lines as the pino-based logger', () => {
  beforeEach(() => _reset())

  it('writes byte-identical lines (time, IDs and stacks aside)', async () => {
    const lines = _captureLines()
    const logger = createLogger(
      { service: 'svc', level: 'debug', environment: 'test', version: '1.0.0' },
      { region: 'eu' },
    )
    logger.trace('dropped by level')
    logger.info('outside')
    await runWithLogger(
      { logger, traceparent: TRACEPARENT, fields: { requestId: 'req-1', a: 'ctx' } },
      async () => {
        const log = logger.child({ component: 'db', a: 'binding' }).child({ sub: 1 })
        log.debug({ n: 1, a: 'call' }, 'debug %d', 1)
        log.info({ user: 'u-1' }, 'info line')
        log.warn(new Error('bare warning'))
        log.error(
          { err: new DbError('query failed', { cause: new Error('socket closed') }) },
          'boom',
        )
        log.fatal('fatal %s %j', 'x', { k: 1 })
        log.info({})
        log.info({ m: 1 })
        withSpan('op', () => 1)
        await withSpan('op2', async () => {
          throw new Error('x')
        }).catch(() => {})
      },
    )
    expect(lines.map(normalizeAll)).toEqual(BASELINE_LINES.map(messageAfterLevel))
  })
})

describe('levels and child loggers', () => {
  beforeEach(() => _reset())

  it('writes only levels at or above the minimum', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc', level: 'warn' })
    logger.trace('t')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    logger.fatal('f')
    expect(entries.map((e) => e.level)).toEqual(['WARN', 'ERROR', 'FATAL'])
  })

  it("'silent' writes nothing, and an unknown level throws as before", () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc', level: 'silent' as never }).fatal('f')
    expect(entries).toHaveLength(0)
    expect(() => createLogger({ service: 'svc', level: 'INFO' as never })).toThrow(
      'unknown level INFO',
    )
  })

  it('child() merges bindings immutably: the parent never sees them', () => {
    const entries = _captureEntries()
    const parent = createLogger({ service: 'svc' }, { a: 'root' })
    const child = parent.child({ a: 'child', b: 1 })
    parent.info('p')
    child.info('c')
    child.child({ c: 2 }).info('g')
    expect(entries[0]).toMatchObject({ a: 'root' })
    expect(entries[0]).not.toHaveProperty('b')
    expect(entries[1]).toMatchObject({ a: 'child', b: 1 })
    expect(entries[1]).not.toHaveProperty('c')
    expect(entries[2]).toMatchObject({ a: 'child', b: 1, c: 2 })
  })
})
