import { describe, it, expect, beforeEach } from 'vitest'
import { formatMessage, routeArgs, MOVED_KEYS } from './route'
import {
  createLogger,
  runWithLogger,
  getLogger,
  getTraceContext,
  _captureEntries,
  _reset,
  _setSink,
} from './logger'
import type { Logger } from './types'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

function onTick() {}

class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

describe('formatMessage', () => {
  it('returns the template and every argument when there is nothing to format', () => {
    expect(formatMessage('plain', [1, { a: 1 }])).toEqual({
      message: 'plain',
      unprinted: [1, { a: 1 }],
    })
    expect(formatMessage('100%%', [])).toEqual({ message: '100%%', unprinted: [] })
  })

  it('returns the arguments the placeholders did not take, in order', () => {
    expect(formatMessage('%s', ['a', 'b', { c: 1 }])).toEqual({
      message: 'a',
      unprinted: ['b', { c: 1 }],
    })
  })

  // Pino consumed these arguments without printing them. The text stays the
  // same; the argument is now kept.
  it.each([
    ['%d', [null], '%d', [null]],
    ['%d', [undefined], '%d', [undefined]],
    ['%j', [undefined], '%j', [undefined]],
    ['%x %s', ['A', 'B'], '%x B', ['A']],
    ['50% off %s', ['x'], '50% off %s', ['x']],
    ['a %d %s', [null, 'x'], 'a %d x', [null]],
  ])('keeps what pino dropped: %j with %j', (template, args, message, unprinted) => {
    expect(formatMessage(template, args)).toEqual({ message, unprinted })
  })

  it('%j %o %O do not print an Error; it is returned unprinted', () => {
    const err = new Error('boom')
    for (const code of ['j', 'o', 'O']) {
      expect(formatMessage(`failed: %${code}`, [err])).toEqual({
        message: `failed: %${code}`,
        unprinted: [err],
      })
    }
  })

  it('%j %o %O keep a value JSON cannot write, a real cycle included', () => {
    const throwing = {
      toJSON() {
        throw new Error('nope')
      },
    }
    const nested = { n: 10n }
    const sym = Symbol('s')
    for (const value of [10n, nested, throwing, sym]) {
      expect(formatMessage('v=%j', [value])).toEqual({ message: 'v=%j', unprinted: [value] })
    }
    const cycle: Record<string, unknown> = { n: 1 }
    cycle.self = cycle
    expect(formatMessage('v=%o', [cycle])).toEqual({ message: 'v=%o', unprinted: [cycle] })
    const withFunction = { a: 1, f: onTick }
    expect(formatMessage('v=%O', [withFunction])).toEqual({
      message: 'v=%O',
      unprinted: [withFunction],
    })
    const shared = { a: 1 }
    expect(formatMessage('v=%j', [{ x: shared, y: shared }])).toEqual({
      message: 'v={"x":{"a":1},"y":{"a":1}}',
      unprinted: [],
    })
  })

  it('%d %i %f do not print a function or a non-numeric string; %s prints them', () => {
    for (const code of ['d', 'i', 'f']) {
      expect(formatMessage(`n=%${code}`, [onTick])).toEqual({
        message: `n=%${code}`,
        unprinted: [onTick],
      })
    }
    expect(formatMessage('n=%s', [onTick])).toEqual({
      message: `n=${String(onTick)}`,
      unprinted: [],
    })
    expect(formatMessage('%d %i %f %s', ['abc', 'x', '', 'abc'])).toEqual({
      message: '%d %i 0 abc',
      unprinted: ['abc', 'x'],
    })
  })

  it('%j %o %O write an anonymous function as on the line', () => {
    expect(
      formatMessage(
        '%o',
        [() => {}].map((f) => f),
      ),
    ).toEqual({
      message: '[Function: anonymous]',
      unprinted: [],
    })
  })

  it('never throws on values that cannot be converted', () => {
    const sym = Symbol('s')
    const bare = Object.create(null) as object
    expect(formatMessage('%d %s', [sym, bare])).toEqual({
      message: '%d %s',
      unprinted: [sym, bare],
    })
  })
})

describe('routeArgs', () => {
  it('returns no message and no fields for a call with no arguments', () => {
    expect(routeArgs([])).toEqual({ fields: {} })
  })

  it('leading string: the template, formatted with the arguments after it', () => {
    expect(routeArgs(['user %s', 'ada'])).toEqual({ fields: {}, message: 'user ada' })
  })

  it('leading Error: err, with the message defaulting to err.message', () => {
    const err = new Error('boom')
    expect(routeArgs([err])).toEqual({ fields: { err }, message: 'boom' })
    expect(routeArgs([err, undefined])).toEqual({
      fields: { err },
      message: 'boom',
      args: [undefined],
    })
    expect(routeArgs([err, 'failed %s', 'job'])).toEqual({
      fields: { err },
      message: 'failed job',
    })
    expect(routeArgs([err, { id: 1 }])).toEqual({ fields: { err, id: 1 }, message: 'boom' })
  })

  it('leading plain object: merged at the top level, err included', () => {
    const span = { operation: 'op' }
    const err = new Error('x')
    expect(routeArgs([{ span, err }, 'span.end %s', 'op'])).toEqual({
      fields: { span, err },
      message: 'span.end op',
    })
    expect(routeArgs([{ a: 1 }])).toEqual({ fields: { a: 1 } })
    expect(routeArgs([{ a: 1 }, undefined])).toEqual({ fields: { a: 1 }, args: [undefined] })
    expect(routeArgs([{ a: 1 }, null, 'x'])).toEqual({
      fields: { a: 1 },
      message: 'x',
      args: [null],
    })
    expect(routeArgs([Object.assign(Object.create(null), { a: 1 })])).toEqual({ fields: { a: 1 } })
  })

  it('leading primitive other than a string: the message, and the value in args', () => {
    expect(routeArgs([42])).toEqual({ fields: {}, message: '42', args: [42] })
    expect(routeArgs([false, 'x'])).toEqual({ fields: {}, message: 'false x', args: [false] })
    expect(routeArgs([10n])).toEqual({ fields: {}, message: '10', args: [10n] })
  })

  it('leading undefined or null, then a string: writes nothing, and the string is the template', () => {
    expect(routeArgs([undefined, 'failed %s', 'id1'])).toEqual({
      fields: {},
      message: 'failed id1',
    })
    expect(routeArgs([null, 'failed %s', 'id1'])).toEqual({ fields: {}, message: 'failed id1' })
  })

  it('leading undefined or null alone or before a non-string: a leading primitive', () => {
    expect(routeArgs([undefined])).toEqual({
      fields: {},
      message: 'undefined',
      args: [undefined],
    })
    expect(routeArgs([null])).toEqual({ fields: {}, message: 'null', args: [null] })
    expect(routeArgs([null, 42])).toEqual({ fields: {}, message: 'null 42', args: [null] })
    expect(routeArgs([undefined, { a: 1 }])).toEqual({
      fields: { a: 1 },
      message: 'undefined',
      args: [undefined],
    })
    expect(routeArgs([undefined, undefined, 'x'])).toEqual({
      fields: {},
      message: 'undefined undefined x',
      args: [undefined],
    })
  })

  it('leading array or class instance: args, and a following string is the template', () => {
    const point = new Point(1, 2)
    expect(routeArgs([[1, 2], 'items %d', 3])).toEqual({
      fields: {},
      message: 'items 3',
      args: [[1, 2]],
    })
    expect(routeArgs([point])).toEqual({ fields: {}, args: [point] })
  })

  it('remaining Errors: the first becomes err when unset, the rest go to errors', () => {
    const [e1, e2, e3] = [new Error('1'), new Error('2'), new Error('3')]
    expect(routeArgs(['m', e1, e2, e3])).toEqual({
      fields: { err: e1 },
      message: 'm',
      errors: [e2, e3],
    })
    expect(routeArgs([e1, 'm', e2])).toEqual({ fields: { err: e1 }, message: 'm', errors: [e2] })
    expect(routeArgs([{ err: 'string thrown' }, 'm', e1])).toEqual({
      fields: { err: 'string thrown' },
      message: 'm',
      errors: [e1],
    })
  })

  it('remaining plain objects: merged at the top level, later wins', () => {
    expect(routeArgs([{ a: 1, b: 1 }, 'm', { b: 2, c: 2 }, { c: 3 }])).toEqual({
      fields: { a: 1, b: 2, c: 3 },
      message: 'm',
    })
  })

  it('plain objects, leading or not: Moved Keys move to args as one object per argument', () => {
    expect(
      routeArgs([
        { service: 'other', a: 1 },
        'm',
        { level: 'custom', b: 2, traceId: 'mine' },
        { message: 'other', c: 3 },
      ]),
    ).toEqual({
      fields: { a: 1, b: 2, c: 3 },
      message: 'm',
      args: [{ service: 'other' }, { level: 'custom', traceId: 'mine' }, { message: 'other' }],
    })
    for (const key of MOVED_KEYS) {
      if (key === 'err') continue
      expect(routeArgs(['m', { [key]: 'v' }]).args).toEqual([{ [key]: 'v' }])
      expect(routeArgs([{ [key]: 'v' }, 'm']).args).toEqual([{ [key]: 'v' }])
    }
  })

  it('an object’s err sets err while it is unset, and moves to args after', () => {
    const [e1, e2] = [new Error('1'), new Error('2')]
    expect(routeArgs(['m', { err: e1, id: 1 }])).toEqual({
      fields: { err: e1, id: 1 },
      message: 'm',
    })
    expect(routeArgs([e1, 'm', { err: e2 }])).toEqual({
      fields: { err: e1 },
      message: 'm',
      args: [{ err: e2 }],
    })
  })

  it('an object’s string message is the message only when the call gives none', () => {
    expect(routeArgs([{ message: 'hi', a: 1 }])).toEqual({ fields: { a: 1 }, message: 'hi' })
    expect(routeArgs([{ message: 'hi', level: 'x' }])).toEqual({
      fields: {},
      message: 'hi',
      args: [{ level: 'x' }],
    })
    expect(routeArgs([{ message: 'hi' }, 'm'])).toEqual({
      fields: {},
      message: 'm',
      args: [{ message: 'hi' }],
    })
    expect(routeArgs([{ message: 42 }])).toEqual({ fields: {}, args: [{ message: 42 }] })
    expect(routeArgs([{ a: 1 }, { message: 'one' }, { message: 'two' }])).toEqual({
      fields: { a: 1 },
      message: 'one',
      args: [{ message: 'two' }],
    })
  })

  it('remaining primitives: appended to the message, space separated', () => {
    expect(routeArgs(['a', 'b', 3, true, null, undefined, 10n])).toEqual({
      fields: {},
      message: 'a b 3 true null undefined 10',
    })
    expect(routeArgs([{ a: 1 }, 42])).toEqual({ fields: { a: 1 }, message: '42' })
    expect(routeArgs(['', 'x'])).toEqual({ fields: {}, message: ' x' })
  })

  it('remaining arrays, class instances, functions, symbols: args, in call order', () => {
    const fn = Math.max
    const sym = Symbol('s')
    const point = new Point(1, 2)
    const date = new Date(0)
    expect(routeArgs(['m', [1], point, fn, sym, date])).toEqual({
      fields: {},
      message: 'm',
      args: [[1], point, fn, sym, date],
    })
  })

  it('an own __proto__ key (from JSON.parse) moves to args and cannot hide err', () => {
    const err = new Error('real')
    const parsed = JSON.parse('{"__proto__": {"err": "inherited"}, "a": 1}') as object
    const routed = routeArgs(['m', parsed, err])
    expect(Object.getPrototypeOf(routed.fields)).toBeNull()
    expect(routed.fields.err).toBe(err)
    expect(routed.fields.a).toBe(1)
    expect(routed.errors).toBeUndefined()
    expect(routed.args).toHaveLength(1)
    expect(Object.hasOwn(routed.args?.[0] as object, '__proto__')).toBe(true)
  })

  it('a function-valued toJSON moves to args as text; other toJSON values are fields', () => {
    const routed = routeArgs(['m', { a: 1, toJSON: () => 'replaced' }])
    expect(routed.fields).toEqual({ a: 1 })
    expect(routed.args).toEqual([{ toJSON: '[Function: toJSON]' }])
    expect(routeArgs([{ toJSON: 'plain' }]).fields).toEqual({ toJSON: 'plain' })
  })

  it('never mutates its input', () => {
    const lead = { a: 1 }
    const trail = { b: 2, level: 'x' }
    const input = [lead, 'm %s', 'v', trail]
    routeArgs(input)
    expect(input).toEqual([{ a: 1 }, 'm %s', 'v', { b: 2, level: 'x' }])
  })
})

/** Run `log` once inside a Logging Context and return the record. */
function record(log: (l: Logger) => void): Record<string, unknown> {
  const entries = _captureEntries()
  runWithLogger({ logger: createLogger({ service: 'svc' }), traceparent: TRACEPARENT }, () =>
    log(getLogger()),
  )
  expect(entries).toHaveLength(1)
  return entries[0]
}

describe('log call examples (issue #21), in both call styles', () => {
  beforeEach(() => _reset())

  it('string then object', () => {
    for (const r of [
      record((l) => l.info('string then object', { a: 1 })),
      record((l) => l.info({ a: 1 }, 'string then object')),
    ]) {
      expect(r).toMatchObject({ level: 'INFO', message: 'string then object', a: 1 })
    }
  })

  it('an error after the message', () => {
    const err = new Error('boom')
    for (const r of [
      record((l) => l.error('Error fetching', err)),
      record((l) => l.error(err, 'Error fetching')),
    ]) {
      expect(r).toMatchObject({
        message: 'Error fetching',
        err: { type: 'Error', message: 'boom', stack: err.stack },
      })
    }
  })

  it('extra strings join the message, objects merge', () => {
    for (const r of [
      record((l) => l.error('scope', 'Failed to create task', { detail: 'x' })),
      record((l) => l.error({ detail: 'x' }, 'scope', 'Failed to create task')),
    ]) {
      expect(r).toMatchObject({ message: 'scope Failed to create task', detail: 'x' })
    }
  })

  it('structured with extra objects', () => {
    for (const r of [
      record((l) => l.info({ a: 1 }, 'structured with extra', { b: 2 })),
      record((l) => l.info('structured with extra', { a: 1 }, { b: 2 })),
    ]) {
      expect(r).toMatchObject({ message: 'structured with extra', a: 1, b: 2 })
    }
  })

  it('placeholders, then fields', () => {
    for (const r of [
      record((l) => l.info('user %s signed in', 'ada', { plan: 'pro' })),
      record((l) => l.info({ plan: 'pro' }, 'user %s signed in', 'ada')),
    ]) {
      expect(r).toMatchObject({ message: 'user ada signed in', plan: 'pro' })
      expect(r).not.toHaveProperty('args')
    }
  })

  it('an array goes to args', () => {
    for (const r of [
      record((l) => l.info('items', [1, 2, 3])),
      record((l) => l.info({}, 'items', [1, 2, 3])),
    ]) {
      expect(r).toMatchObject({ message: 'items', args: [[1, 2, 3]] })
    }
  })

  it('Moved Keys cannot be overwritten; their values land in args', () => {
    let traceId: string | undefined
    for (const r of [
      record((l) => {
        traceId = getTraceContext()!.traceId
        l.info('x', { level: 'custom', traceId: 'mine' })
      }),
      record((l) => l.info({ level: 'custom', traceId: 'mine' }, 'x')),
    ]) {
      expect(r).toMatchObject({
        level: 'INFO',
        message: 'x',
        traceId,
        args: [{ level: 'custom', traceId: 'mine' }],
      })
    }
  })

  it('an Error | undefined that is undefined: the template still formats', () => {
    const maybeErr = undefined as Error | undefined
    const r = record((l) => l.error(maybeErr, 'failed %s', 'id1'))
    expect(r).toMatchObject({ level: 'ERROR', message: 'failed id1' })
    expect(r).not.toHaveProperty('args')
    expect(r).not.toHaveProperty('err')
  })

  it('an undefined after a leading object or Error is in args, not the message', () => {
    expect(record((l) => l.info({ a: 1 }, undefined))).toMatchObject({ a: 1, args: [null] })
    const r = record((l) => l.error(new Error('boom'), undefined))
    expect(r).toMatchObject({ message: 'boom', args: [null], err: { message: 'boom' } })
  })

  it('a leading undefined or null with no message after it is the message', () => {
    const maybeErr = undefined as Error | undefined
    expect(record((l) => l.error(maybeErr))).toMatchObject({
      message: 'undefined',
      args: [null],
    })
    const r = record((l) => (l.error as (...args: unknown[]) => void)(null, { a: 1 }))
    expect(r).toMatchObject({
      message: 'null',
      a: 1,
      args: [null],
    })
  })

  it('after a leading undefined or null that is the message, later arguments route as usual', () => {
    const fields = record((l) => (l.info as (...args: unknown[]) => void)(undefined, { a: 1 }))
    expect(fields).toMatchObject({ message: 'undefined', a: 1, args: [null] })
    expect(fields).not.toHaveProperty('err')
    const word = record((l) => (l.info as (...args: unknown[]) => void)(null, 42))
    expect(word).toMatchObject({ message: 'null 42', args: [null] })
    // After a leading object, the nullish in the message's place is in args; later strings are words.
    const after = record((l) => (l.info as (...args: unknown[]) => void)({ a: 1 }, null, 'x', 'y'))
    expect(after).toMatchObject({ message: 'x y', a: 1, args: [null] })
  })

  it('an Error under %o is err, not {}', () => {
    const err = new Error('boom')
    const r = record((l) => l.error('failed: %o', err))
    expect(r).toMatchObject({ message: 'failed: %o', err: { message: 'boom', stack: err.stack } })
  })

  it('a BigInt under %j is a word, not "[Circular]"', () => {
    expect(record((l) => l.info('v=%j', 10n))).toMatchObject({ message: 'v=%j 10' })
  })

  it('two errors: err and errors', () => {
    const [e1, e2] = [new Error('first'), new TypeError('second')]
    for (const r of [
      record((l) => l.error('two failures', e1, e2)),
      record((l) => l.error(e1, 'two failures', e2)),
    ]) {
      expect(r).toMatchObject({
        message: 'two failures',
        err: { type: 'Error', message: 'first' },
        errors: [{ type: 'TypeError', message: 'second' }],
      })
    }
  })

  it('an object’s err, in either position', () => {
    const err = new Error('boom')
    for (const r of [
      record((l) => l.error('failed', { err, orderId: 'o-1' })),
      record((l) => l.error({ err, orderId: 'o-1' }, 'failed')),
    ]) {
      expect(r).toMatchObject({ message: 'failed', orderId: 'o-1', err: { message: 'boom' } })
    }
  })

  it('serializes Errors in args, one level down', () => {
    const r = record((l) =>
      l.error(new Error('first'), 'failed', { err: new Error('inner') }, [new Error('listed')]),
    )
    expect(r.args).toMatchObject([{ err: { message: 'inner' } }, [{ message: 'listed' }]])
  })

  it('a __proto__ key from JSON.parse: the real Error stays err, the value lands in args', () => {
    const parsed = JSON.parse('{"__proto__": {"err": "x"}, "userId": "u-1"}') as object
    const r = record((l) => l.error('failed', parsed, new Error('real')))
    expect(r).toMatchObject({ userId: 'u-1', err: { message: 'real' } })
    expect(r.errors).toBeUndefined()
    expect(JSON.stringify(r.args)).toBe('[{"__proto__":{"err":"x"}}]')
  })

  it('a trailing object with a toJSON method cannot replace the line', () => {
    const r = record((l) => l.info('m', { a: 1, toJSON: () => 'replaced' }))
    expect(r).toMatchObject({ level: 'INFO', message: 'm', a: 1 })
    expect(r.args).toEqual([{ toJSON: '[Function: toJSON]' }])
  })

  it('a function under %d is in args, not NaN', () => {
    const r = record((l) => l.info('n=%d', onTick))
    expect(r).toMatchObject({ message: 'n=%d', args: ['[Function: onTick]'] })
  })

  it('keeps functions and symbols in args', () => {
    const r = record((l) => l.info('m', function handler() {}, Symbol('tag')))
    expect(r.args).toEqual(['[Function: handler]', 'Symbol(tag)'])
  })
})

/** An object whose `boom` getter throws. */
const throwingGetter = () =>
  Object.defineProperty({}, 'boom', {
    enumerable: true,
    get() {
      throw new Error('getter failed')
    },
  })

/** An object whose nested `toJSON` throws. */
const throwingToJSON = () => ({
  nested: {
    toJSON() {
      throw new TypeError('toJSON failed')
    },
  },
})

/**
 * Capture entries, but make the sink throw on its next write only, as no single value can.
 *
 * @returns {Record<string, unknown>[]} The captured entries.
 */
function failNextWrite(): Record<string, unknown>[] {
  const entries = _captureEntries()
  const capture = _setSink({ write: () => {} })
  let failed = false
  _setSink({
    write(line) {
      if (!failed) {
        failed = true
        throw new Error('sink hiccup')
      }
      capture.write(line)
    },
  })
  return entries
}

describe('a log call never throws', () => {
  beforeEach(() => _reset())

  it.each([
    [
      'a getter that throws, console style',
      (l: Logger) => l.info('m %s', 'x', throwingGetter()),
      { boom: '[Unserializable: Error: getter failed]' },
    ],
    [
      'a getter that throws, structured',
      (l: Logger) => l.info(throwingGetter(), 'm %s', 'x'),
      { boom: '[Unserializable: Error: getter failed]' },
    ],
    [
      'a toJSON that throws',
      (l: Logger) => l.info('m %s', 'x', throwingToJSON()),
      { nested: '[Unserializable: TypeError: toJSON failed]' },
    ],
  ])('%s: only that value is replaced', (_name, log, replaced) => {
    const r = record(log)
    expect(r).toMatchObject({
      level: 'INFO',
      service: 'svc',
      message: 'm x',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      ...replaced,
    })
    expect(r.logError).toBeUndefined()
  })

  it('the minimal line keeps its own time and level; bindings for them move to args', () => {
    const entries = failNextWrite()
    runWithLogger({ logger: createLogger({ service: 'svc' }), traceparent: TRACEPARENT }, () =>
      createLogger({ service: 'svc' })
        .child({ level: 'BAD', time: 'T', traceId: 'forged' })
        .info('m %s', 'x'),
    )
    expect(entries[0]).toMatchObject({
      level: 'INFO',
      message: 'm %s',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      args: [{ level: 'BAD', time: 'T' }],
    })
    expect(entries[0].time).not.toBe('T')
    expect(entries[0].logError).toBe('log call failed: Error: sink hiccup')
  })

  it('a binding that cannot be serialized is replaced, and the line kept', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' }).child(throwingToJSON())
    expect(() => logger.warn('m')).not.toThrow()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'WARN',
      message: 'm',
      service: 'svc',
      nested: '[Unserializable: TypeError: toJSON failed]',
    })
    expect(entries[0].logError).toBeUndefined()
  })

  it('writes nothing, and does not throw, when the sink itself always fails', () => {
    const previous = _setSink({
      write() {
        throw new Error('sink down')
      },
    })
    try {
      expect(() => createLogger({ service: 'svc' }).error('m')).not.toThrow()
    } finally {
      _setSink(previous)
    }
  })

  it('never reads a disabled level’s arguments', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc', level: 'warn' }).info('m', throwingGetter())
    expect(entries).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------- */
/* Property: for any mix of argument types, every value is in the record.    */
/* ------------------------------------------------------------------------- */

/** mulberry32: a tiny seeded PRNG, so failures reproduce. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Kind =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'null'
  | 'object'
  | 'movedKeysObject'
  | 'error'
  | 'array'
  | 'instance'
  | 'function'
  | 'symbol'
  | 'undefined'
  | 'sharedKey'
  | 'percent'
  | 'protoObject'
  | 'toJSONObject'
const KINDS: Kind[] = [
  'string',
  'number',
  'bigint',
  'boolean',
  'null',
  'object',
  'movedKeysObject',
  'error',
  'array',
  'instance',
  'function',
  'symbol',
  'undefined',
  'sharedKey',
  'percent',
  'protoObject',
  'toJSONObject',
]
const MOVED = [...MOVED_KEYS]

/**
 * One generated argument, with the unique token that must appear in the
 * serialized record. Booleans, `null` and `undefined` carry no token; they are
 * counted. `shared` objects all use the key `shared`: later objects win, so
 * only the last one's token must appear.
 */
interface Generated {
  value: unknown
  token?: string
  shared?: boolean
}

function generator(seed: number) {
  const random = prng(seed)
  let n = 0
  const pick = <V>(items: readonly V[]) => items[Math.floor(random() * items.length)]
  const token = () => `tok${seed}x${n++}`

  const make = (kind: Kind): Generated => {
    const t = token()
    switch (kind) {
      case 'string':
        return { value: t, token: t } // no `%`: placeholders are covered by printf.test.ts
      case 'number': {
        const num = 100000 + n
        return { value: num, token: String(num) }
      }
      case 'bigint':
        return { value: BigInt(200000 + n), token: String(200000 + n) }
      case 'boolean':
        return { value: random() < 0.5 }
      case 'null':
        return { value: null }
      case 'object':
        return { value: { [`key_${t}`]: t }, token: t }
      case 'movedKeysObject':
        return { value: { [pick(MOVED)]: t, [`key_${t}`]: 1 }, token: t }
      case 'error':
        return { value: new Error(t), token: t }
      case 'array':
        return { value: [t], token: t }
      case 'instance':
        return { value: new Point(300000 + n, 0), token: String(300000 + n) }
      case 'function':
        return { value: Object.defineProperty(() => {}, 'name', { value: t }), token: t }
      case 'symbol':
        return { value: Symbol(t), token: t }
      case 'undefined':
        return { value: undefined }
      case 'sharedKey':
        return { value: { shared: t }, token: t, shared: true }
      case 'percent':
        // `%%` collapses; `%c` and `% ` take an argument without printing it.
        return { value: `${t} 100%% %c 50% off`, token: t }
      case 'protoObject':
        return { value: JSON.parse(`{"__proto__":{"err":"${t}"},"key_${t}":1}`), token: t }
      case 'toJSONObject':
        return {
          value: {
            [`key_${t}`]: 1,
            toJSON: Object.defineProperty(() => 'x', 'name', { value: t }),
          },
          token: t,
        }
    }
  }

  return () => {
    const count = Math.floor(random() * 7) // 0..6 arguments
    const generated = Array.from({ length: count }, () => make(pick(KINDS)))
    // Later objects win for the same key: only the last `shared` value is kept.
    const last = generated.reduce((found, g, i) => (g.shared ? i : found), -1)
    return generated.map((g, i) => (g.shared && i !== last ? { ...g, token: undefined } : g))
  }
}

describe('routing property', () => {
  beforeEach(() => _reset())

  it('every value passed to a log method is found in the serialized record', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc', level: 'trace' }).child({ component: 'c' })
    const runs = 500

    for (let seed = 1; seed <= runs; seed++) {
      const generated = generator(seed)()
      const values = generated.map((g) => g.value)
      runWithLogger({ logger, traceparent: TRACEPARENT }, () =>
        (getLogger().info as (...a: unknown[]) => void)(...values),
      )

      const line = JSON.stringify(entries[entries.length - 1])
      for (const token of generated.flatMap((g) => (g.token === undefined ? [] : [g.token]))) {
        expect(line, `seed ${seed}: ${token}`).toContain(token)
      }

      // Tokenless values (true, false, null, undefined) are words in the
      // message or items in args (where JSON writes `undefined` as `null`).
      const r = entries[entries.length - 1]
      const words = typeof r.message === 'string' ? r.message.split(' ') : []
      const overflow = Array.isArray(r.args) ? r.args : []
      const count = (literal: unknown) => values.filter((v) => v === literal).length
      const wordCount = (word: string) => words.filter((w) => w === word).length
      for (const literal of [true, false]) {
        const found = wordCount(String(literal)) + overflow.filter((v) => v === literal).length
        expect(found, `seed ${seed}: ${String(literal)}`).toBeGreaterThanOrEqual(count(literal))
      }
      // The one nullish value that writes nothing: an unset `Error | undefined` before the message.
      const unsetError = values[0] == null && typeof values[1] === 'string' ? 1 : 0
      const nullish = count(null) + count(undefined) - unsetError
      const foundNullish =
        wordCount('null') + wordCount('undefined') + overflow.filter((v) => v === null).length
      expect(foundNullish, `seed ${seed}: null/undefined`).toBeGreaterThanOrEqual(nullish)

      const lastShared = generated.filter((g) => g.shared).at(-1)
      expect(r.shared, `seed ${seed}: shared`).toBe(lastShared?.token)
      expect(r.logError, `seed ${seed}: logError`).toBeUndefined()
      expect(r).toMatchObject({ level: 'INFO', service: 'svc', component: 'c' })
    }
    expect(entries).toHaveLength(runs)
  }, 30_000) // 500 runs: generous for loaded CI machines
})
