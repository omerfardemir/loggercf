import { describe, it, expect, beforeEach } from 'vitest'
import {
  createLogger,
  getLogger,
  runWithLogger,
  setDefaultLogger,
  _captureEntries,
  _reset,
  _setSink,
} from './logger'
import { serializeError, stringifyRecord } from './output'
import type { Logger } from './types'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

/** A chain of `depth` nodes, each `{ l: next, r: next }`: two paths to every node below it. */
function dag(depth: number, leaf: unknown = { big: 1n }): unknown {
  let node = leaf
  for (let i = 0; i < depth; i++) node = { l: node, r: node }
  return node
}

/** An object whose `a` getter throws `thrown`. */
const throwing = (thrown: unknown = 1): Record<string, unknown> =>
  Object.defineProperty({}, 'a', {
    enumerable: true,
    get() {
      throw thrown
    },
  })

/** A revoked Proxy: every trap, `getPrototypeOf` included, throws. */
const revoked = () => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return proxy
}
/** A Proxy whose `getPrototypeOf` trap throws (`instanceof`, `Array.isArray` on a revoked one). */
const noPrototype = () =>
  new Proxy(
    { b: 2 },
    {
      getPrototypeOf() {
        throw new Error('no prototype')
      },
    },
  )
const REVOKED = /^\[Unserializable: TypeError: .*revoked.*\]$/

/** How long `fn` takes, in milliseconds. */
const elapsed = (fn: () => void) => {
  const start = performance.now()
  fn()
  return performance.now() - start
}

/** One object with `keys` numeric keys. */
const wide = (keys: number) =>
  Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${i}`, i]))

/** Log `fields` once and return the written line, as the sink receives it. */
const lineFor = (fields: Record<string, unknown>) => {
  let line = ''
  _setSink({ write: (record) => (line = stringifyRecord(record)) })
  createLogger({ service: 'svc' }).info(fields, 'msg')
  return line
}

describe('shared references are not cycles, and stay linear', () => {
  beforeEach(() => _reset())

  it('a repeated, non-cyclic object is written again', () => {
    const entries = _captureEntries()
    const sh = { x: 1 }
    createLogger({ service: 'svc' }).info('m', { p: sh, q: sh })
    expect(entries[0]).toMatchObject({ p: { x: 1 }, q: { x: 1 } })
  })

  it('a real cycle is still "[Circular]"', () => {
    const entries = _captureEntries()
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    createLogger({ service: 'svc' }).info('m', { loop })
    expect(entries[0].loop).toEqual({ name: 'loop', self: '[Circular]' })
  })

  it('%j with a deeply shared structure runs in well under 100 ms (depth 30)', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    const ms = elapsed(() => logger.info('v=%j', dag(30)))
    expect(ms).toBeLessThan(100)
    expect(entries[0].message).toBe('v=%j') // a BigInt inside: routed, not printed
    expect(entries[0].logError).toBeUndefined()
    expect(entries[0]).toHaveProperty('l')
  })

  it('a field or %j with a deeply shared structure runs in well under 100 ms (depth 30)', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    const ms = elapsed(() => {
      logger.info('m', { tree: dag(30, { n: 1 }) })
      logger.info('m %j', dag(30, { n: 1 }))
    })
    expect(ms).toBeLessThan(100)
    expect(JSON.stringify(entries)).toContain('"[Repeated]"')
    expect(entries.map((e) => e.logError)).toEqual([undefined, undefined])
  })

  for (const [keys, copies] of [
    [20_000, 1001],
    [2_000, 1500],
  ]) {
    it(`a ${keys}-key object shared ${copies} times: fast, and the line stays bounded`, () => {
      const shared = wide(keys)
      const once = JSON.stringify(shared).length
      let line = ''
      const ms = elapsed(
        () => (line = lineFor({ items: Array.from({ length: copies }, () => shared) })),
      )
      expect(ms).toBeLessThan(500)
      // One full copy, re-written values up to the budget, then `"[Repeated]"` for the rest.
      expect(line.length).toBeLessThan(once + 200_000 + copies * '"[Repeated]",'.length)
      const items = JSON.parse(line).items as unknown[]
      expect(items).toHaveLength(copies)
      expect(items[0]).toEqual(shared)
      expect(items.at(-1)).toBe('[Repeated]')
      expect(JSON.parse(line).logError).toBeUndefined()
    })
  }

  it('a repeat is written in full or not at all, never cut part way', () => {
    const shared = wide(6_000) // fits the budget once, not twice
    const items = JSON.parse(lineFor({ items: [shared, shared, shared, shared] })).items
    for (const item of items)
      expect(item === '[Repeated]' || Object.keys(item).length === 6_000).toBe(true)
    expect(items[1]).toEqual(shared)
    expect(items.at(-1)).toBe('[Repeated]')
  })

  it('a non-repeated large object is written in full', () => {
    const big = wide(50_000)
    const parsed = JSON.parse(lineFor({ big, other: wide(50_000) }))
    expect(parsed.big).toEqual(big)
    expect(parsed.other).toEqual(big)
  })

  it('a shared object with a long string counts its bytes too', () => {
    const shared = { s: 'x'.repeat(100_000) }
    const line = lineFor({ items: Array.from({ length: 50 }, () => shared) })
    expect(line.length).toBeLessThan(300_000)
    expect(JSON.parse(line).items.at(-1)).toBe('[Repeated]')
  })
})

describe('Map and Set', () => {
  beforeEach(() => _reset())

  it('a Map is [key, value] pairs and a Set an array, in fields and args', () => {
    const entries = _captureEntries()
    const map = new Map<unknown, unknown>([
      ['a', 1],
      [{ k: 1 }, new Set([2])],
    ])
    createLogger({ service: 'svc' }).info('m', { map, set: new Set(['x', 'y']) }, [map])
    expect(entries[0]).toMatchObject({
      map: [
        ['a', 1],
        [{ k: 1 }, [2]],
      ],
      set: ['x', 'y'],
      args: [
        [
          [
            ['a', 1],
            [{ k: 1 }, [2]],
          ],
        ],
      ],
    })
  })

  it('%j %o %O print a Map as pairs and a Set as an array', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info('%j %o %O', new Map([['a', 1]]), new Set([1]), {
      m: new Map(),
    })
    expect(entries[0].message).toBe('[["a",1]] [1] {"m":[]}')
  })
})

describe('placeholders keep values they cannot print', () => {
  beforeEach(() => _reset())

  it('%d %i %f with a non-numeric string: unprinted, appended as a word', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info('id=%d', 'abc')
    logger.info('id=%i', 'abc')
    logger.info('id=%f', 'abc')
    logger.info('n=%d', NaN)
    expect(entries.map((e) => e.message)).toEqual(['id=%d abc', 'id=%i abc', 'id=%f abc', 'n=NaN'])
  })

  it('%d %i print a BigInt exactly', () => {
    const entries = _captureEntries()
    const big = 123456789012345678901234567890n
    createLogger({ service: 'svc' }).info('%d %i', big, big)
    expect(entries[0].message).toBe(`${big} ${big}`)
  })

  it('a cyclic object under %j %o %O is routed with all its keys', () => {
    const entries = _captureEntries()
    const loop: Record<string, unknown> = { name: 'loop', n: 1 }
    loop.self = loop
    createLogger({ service: 'svc' }).info('v=%o', loop)
    expect(entries[0]).toMatchObject({
      message: 'v=%o',
      name: 'loop',
      n: 1,
      self: { name: 'loop', n: 1, self: '[Circular]' },
    })
  })
})

describe('errors that reference themselves', () => {
  beforeEach(() => _reset())

  it('an Error with e.self = e keeps err', () => {
    const entries = _captureEntries()
    const e = new Error('boom') as Error & { self?: unknown }
    e.self = e
    createLogger({ service: 'svc' }).error('failed', e)
    expect(entries[0]).toMatchObject({
      message: 'failed',
      err: { type: 'Error', message: 'boom', self: '[Circular]' },
    })
    expect(entries[0].logError).toBeUndefined()
  })

  it('serializeError never throws on a getter that throws', () => {
    const e = Object.defineProperty(new Error('boom'), 'code', {
      enumerable: true,
      get() {
        throw new Error('no code')
      },
    })
    expect(serializeError(e)).toMatchObject({
      message: 'boom',
      code: '[Unserializable: Error: no code]',
    })
  })
})

describe('one bad value does not cost the rest of the line', () => {
  beforeEach(() => _reset())

  it('a getter that throws: only that value is replaced; err and the message stay', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).error('failed', new Error('boom'), throwing())
    expect(entries[0]).toMatchObject({
      level: 'ERROR',
      message: 'failed',
      err: { type: 'Error', message: 'boom' },
      a: '[Unserializable: 1]',
    })
    expect(entries[0].logError).toBeUndefined()
  })

  it('a nested toJSON that throws: only that value is replaced', () => {
    const entries = _captureEntries()
    const bad = {
      toJSON() {
        throw new TypeError('toJSON failed')
      },
    }
    createLogger({ service: 'svc' }).info('m %s', 'x', { ok: 1, deep: { bad, fine: 2 } })
    expect(entries[0]).toMatchObject({
      message: 'm x',
      ok: 1,
      deep: { bad: '[Unserializable: TypeError: toJSON failed]', fine: 2 },
    })
    expect(entries[0].logError).toBeUndefined()
  })

  it('a getter in a leading object or an args item is replaced too', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info(throwing(new Error('x')), 'm')
    logger.info('m', [throwing()])
    expect(entries[0]).toMatchObject({ message: 'm', a: '[Unserializable: Error: x]' })
    expect(entries[1]).toMatchObject({ message: 'm', args: [[{ a: '[Unserializable: 1]' }]] })
  })

  it('a revoked Proxy in a field, an args item or an Error: only that value is replaced', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info({ p: revoked(), a: 1 }, 'msg')
    logger.info('msg', [revoked()], { a: 1 })
    logger.info('msg', { p: revoked() }, { a: 1 }, [1])
    const err = Object.assign(new Error('boom'), { p: revoked() })
    logger.error('failed', err, { a: 1 })
    logger.error('caused', new Error('outer', { cause: revoked() }))

    expect(entries.map((e) => e.logError)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(entries[0]).toMatchObject({ message: 'msg', a: 1, p: expect.stringMatching(REVOKED) })
    expect(entries[1]).toMatchObject({ message: 'msg', a: 1 })
    expect((entries[1].args as unknown[][])[0][0]).toMatch(REVOKED)
    expect(entries[2]).toMatchObject({
      message: 'msg',
      a: 1,
      args: [[1]],
      p: expect.stringMatching(REVOKED),
    })
    expect(entries[3]).toMatchObject({
      message: 'failed',
      a: 1,
      err: { message: 'boom', p: expect.stringMatching(REVOKED) },
    })
    expect(entries[4]).toMatchObject({
      err: { message: 'outer', cause: expect.stringMatching(REVOKED) },
    })
  })

  it('a Proxy whose getPrototypeOf throws, as a field, an args item or in one', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info({ p: noPrototype(), a: 1 }, 'msg')
    logger.info('msg', noPrototype(), [noPrototype()], { a: 1 })
    expect(entries.map((e) => e.logError)).toEqual([undefined, undefined])
    expect(entries[0]).toMatchObject({ message: 'msg', a: 1 })
    expect(entries[0].p).toMatch(/^\[Unserializable: Error: no prototype\]$/)
    expect(entries[1]).toMatchObject({ message: 'msg', a: 1 })
    expect(JSON.stringify(entries[1].args)).toContain('[Unserializable: Error: no prototype]')
  })

  it('a revoked Proxy leading, or under %j and %s, is routed as a stand-in', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info(revoked(), 'msg %s', 'x', { a: 1 })
    logger.info('v=%j s=%s', revoked(), revoked(), { a: 1 })
    expect(entries.map((e) => e.logError)).toEqual([undefined, undefined])
    expect(entries[0]).toMatchObject({ message: 'msg x', a: 1 })
    expect(entries[0].args).toEqual([expect.stringMatching(REVOKED)])
    expect(entries[1]).toMatchObject({ message: 'v=%j s=%s', a: 1 })
    expect(entries[1].args).toEqual([
      expect.stringMatching(REVOKED),
      expect.stringMatching(REVOKED),
    ])
  })

  it('a revoked Proxy as a Context Field or a binding keeps the line', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' }).child({ bad: revoked(), b: 1 })
    runWithLogger({ logger, fields: { ctx: revoked(), r: 1 } }, () => getLogger().info('m %s', 'x'))
    expect(entries[0]).toMatchObject({ message: 'm x', b: 1, r: 1 })
    expect(entries[0].bad).toMatch(REVOKED)
    expect(entries[0].ctx).toMatch(REVOKED)
    expect(entries[0].logError).toBeUndefined()
  })

  it('the minimal line is the last resort: when writing the full line fails', () => {
    const entries = _captureEntries()
    const capture = _setSink({ write: () => {} }) // the capture sink installed above
    let calls = 0
    _setSink({
      write(record) {
        if (calls++ === 0) throw new Error('sink hiccup')
        capture.write(record)
      },
    })
    createLogger({ service: 'svc' }).info('m %s', 'x')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'INFO', service: 'svc', message: 'm %s' })
    expect(entries[0].logError).toBe('log call failed: Error: sink hiccup')
  })
})

describe('bindings that cannot be read', () => {
  beforeEach(() => _reset())

  it('.child() with a throwing getter does not throw, then or at a log call', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    let child: Logger | undefined
    expect(() => (child = logger.child(throwing()))).not.toThrow()
    expect(() => child!.info('x')).not.toThrow()
    expect(entries[0]).toMatchObject({ message: 'x', service: 'svc', a: '[Unserializable: 1]' })
  })

  it('createLogger bindings with a throwing getter do not throw', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' }, throwing() as Record<string, string>)
    logger.info('x')
    expect(entries[0]).toMatchObject({ message: 'x', a: '[Unserializable: 1]' })
  })

  it('getLogger().child() outside a Logging Context: the log call does not throw', () => {
    const entries = _captureEntries()
    const child = getLogger().child(throwing())
    expect(() => child.info('x')).not.toThrow()
    setDefaultLogger(createLogger({ service: 'orders' }))
    expect(() => child.info('y')).not.toThrow()
    expect(entries).toMatchObject([
      { service: 'unknown', message: 'x', a: '[Unserializable: 1]' },
      { service: 'orders', message: 'y', a: '[Unserializable: 1]' },
    ])
  })

  it('a default whose .child() throws: the forwarder still writes the line', () => {
    const entries = _captureEntries()
    const root = createLogger({ service: 'orders' })
    setDefaultLogger({
      ...root,
      child() {
        throw new Error('no child')
      },
    })
    expect(() => getLogger().child({ k: 1 }).info('x')).not.toThrow()
    expect(entries[0]).toMatchObject({ message: 'x', k: 1 })
  })
})

describe('the serializer', () => {
  it('never calls the record’s own toJSON', () => {
    const record = Object.assign(Object.create(null), {
      a: 1,
      toJSON: () => {
        throw new Error('x')
      },
    })
    expect(JSON.parse(stringifyRecord(record))).toEqual({ a: 1, toJSON: '[Function: toJSON]' })
  })

  it('keeps JSON’s own conversions: Date, NaN, undefined in arrays and objects', () => {
    const date = new Date(0)
    expect(stringifyRecord({ date, n: NaN, list: [undefined, 1], gone: undefined })).toBe(
      '{"date":"1970-01-01T00:00:00.000Z","n":null,"list":[null,1]}',
    )
  })

  it('a boxed BigInt is its digits, like a BigInt', () => {
    expect(stringifyRecord({ n: Object(10n), list: [Object(10n)] })).toBe(
      '{"n":"10","list":["10"]}',
    )
  })

  it('a toJSON whose result refers back to its object is "[Circular]" there', () => {
    const self = {
      toJSON() {
        return { x: this }
      },
    }
    expect(JSON.parse(stringifyRecord({ self }))).toEqual({ self: { x: '[Circular]' } })
  })

  it('a toJSON that returns its own object writes its keys, as JSON does', () => {
    const own = {
      a: 1,
      toJSON() {
        return this
      },
    }
    expect(JSON.parse(stringifyRecord({ own, again: own }))).toEqual({
      own: { a: 1, toJSON: '[Function: toJSON]' },
      again: { a: 1, toJSON: '[Function: toJSON]' },
    })
  })

  it('an undefined property is left out, as JSON does, in a field and under %j alike', () => {
    _reset()
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info('m', { a: undefined, b: 1, list: [undefined] })
    logger.info('v=%j', { a: undefined, b: 1 })
    expect(entries[0]).toMatchObject({ message: 'm', b: 1, list: [null] })
    expect(entries[0]).not.toHaveProperty('a')
    expect(entries[1].message).toBe('v={"b":1}')
    expect(entries[1]).not.toHaveProperty('a')
  })

  it('an own __proto__ key stays a key', () => {
    const record = JSON.parse('{"__proto__":{"x":1},"a":1}')
    expect(stringifyRecord(record)).toBe('{"__proto__":{"x":1},"a":1}')
  })
})

describe('inside a Logging Context', () => {
  beforeEach(() => _reset())

  it('a bad value keeps the trace IDs and Context Fields', () => {
    const entries = _captureEntries()
    runWithLogger(
      { logger: createLogger({ service: 'svc' }), traceparent: TRACEPARENT, fields: { r: 1 } },
      () => getLogger().warn('m', throwing()),
    )
    expect(entries[0]).toMatchObject({
      r: 1,
      a: '[Unserializable: 1]',
      traceId: '0af7651916cd43dd8448eb211c80319c',
    })
  })
})

/** A revoked Proxy of a function: `typeof` is `'function'`, every read throws. */
const revokedFn = () => {
  const { proxy, revoke } = Proxy.revocable(function target() {}, {})
  revoke()
  return proxy
}

describe('functions whose name cannot be read', () => {
  beforeEach(() => _reset())

  it('a class whose static name getter throws: only that value is replaced', () => {
    const entries = _captureEntries()
    class Svc {
      static get name(): string {
        throw new Error('x')
      }
    }
    createLogger({ service: 'svc' }).info({ a: 1, Svc }, 'm')
    expect(entries[0]).toMatchObject({ a: 1, message: 'm', Svc: '[Unserializable: Error: x]' })
    expect(entries[0].logError).toBeUndefined()
  })

  it('a revoked function Proxy as a field, in args, under %o and as a toJSON', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info('m', { fn: revokedFn(), a: 1 })
    logger.info('m', revokedFn(), [revokedFn()])
    logger.info('v=%o', revokedFn(), { a: 1 })
    logger.info('m', { toJSON: revokedFn(), a: 1 })
    expect(entries.map((e) => e.logError)).toEqual([undefined, undefined, undefined, undefined])
    expect(entries[0]).toMatchObject({ message: 'm', a: 1, fn: expect.stringMatching(REVOKED) })
    expect(entries[1].args).toEqual([
      expect.stringMatching(REVOKED),
      [expect.stringMatching(REVOKED)],
    ])
    expect(entries[2]).toMatchObject({ message: 'v=%o', a: 1 })
    expect(entries[2].args).toEqual([expect.stringMatching(REVOKED)])
    expect(entries[3]).toMatchObject({ message: 'm', a: 1 })
    expect(entries[3].args).toEqual([{ toJSON: expect.stringMatching(REVOKED) }])
  })

  it('a revoked function Proxy as a binding keeps every line of that logger', () => {
    const entries = _captureEntries()
    // The binding types have no functions; at runtime a binding can still be one.
    const logger = createLogger({ service: 'svc' }, { fn: revokedFn() as unknown as string })
    logger.info('one')
    logger.child({ b: 1 }).warn('two')
    expect(entries.map((e) => e.logError)).toEqual([undefined, undefined])
    expect(entries.map((e) => e.message)).toEqual(['one', 'two'])
    expect(entries[0].fn).toMatch(REVOKED)
  })

  it('a function whose name is not a string is anonymous, under %o and on the line', () => {
    const entries = _captureEntries()
    const odd: unknown = Object.defineProperty(() => {}, 'name', {
      value: {
        toString() {
          throw new Error('no text')
        },
      },
    })
    createLogger({ service: 'svc' }).info('v=%o', odd, { f: odd })
    expect(entries[0]).toMatchObject({
      message: 'v=[Function: anonymous]',
      f: '[Function: anonymous]',
    })
    expect(entries[0].logError).toBeUndefined()
  })

  it('a Map or Set that cannot be iterated is replaced on its own', () => {
    const entries = _captureEntries()
    class BadMap extends Map {
      override [Symbol.iterator](): MapIterator<[unknown, unknown]> {
        throw new Error('no entries')
      }
    }
    class BadSet extends Set {
      override [Symbol.iterator](): SetIterator<unknown> {
        throw new Error('no items')
      }
    }
    createLogger({ service: 'svc' }).info('m', { map: new BadMap(), set: new BadSet(), a: 1 })
    expect(entries[0]).toMatchObject({
      a: 1,
      map: '[Unserializable: Error: no entries]',
      set: '[Unserializable: Error: no items]',
    })
  })

  it('an args array with an item whose getter throws keeps its other items', () => {
    const entries = _captureEntries()
    const list = Object.defineProperty([1, 2, 3], 1, {
      enumerable: true,
      get() {
        throw new Error('no item')
      },
    })
    createLogger({ service: 'svc' }).info('m', list)
    expect(entries[0].args).toEqual([[1, '[Unserializable: Error: no item]', 3]])
  })
})

/** `levels` Errors deep, each with `width` own properties pointing at the next level. */
function errorGraph(levels: number, width: number): Error {
  let next: Error | undefined
  for (let level = levels; level > 0; level--) {
    const error = new Error(`level ${level}`) as Error & Record<string, unknown>
    if (next) for (let i = 0; i < width; i++) error[`p${i}`] = next
    next = error
  }
  return next!
}

describe('an Error is serialized once per line', () => {
  beforeEach(() => _reset())

  it('an Error graph 5 deep and 20 wide: well under 1 s, with a bounded line', () => {
    const lines: string[] = []
    _setSink({ write: (record) => lines.push(stringifyRecord(record)) })
    const ms = elapsed(() => createLogger({ service: 'svc' }).error(errorGraph(5, 20), 'm'))
    expect(ms).toBeLessThan(500)
    expect(lines[0].length).toBeLessThan(1_000_000)
    const line = JSON.parse(lines[0])
    expect(line.logError).toBeUndefined()
    expect(line.err.p0.message).toBe('level 2')
    expect(line.err.p0.p0.p0.p0.message).toBe('level 5')
  })

  it('one large Error passed 2,000 times: the line is bounded', () => {
    const lines: string[] = []
    _setSink({ write: (record) => lines.push(stringifyRecord(record)) })
    const big = new Error('x'.repeat(100_000))
    createLogger({ service: 'svc' }).error('m', ...Array.from({ length: 2000 }, () => big))
    expect(lines[0].length).toBeLessThan(1_000_000)
    const line = JSON.parse(lines[0])
    expect(line.err.message).toBe(big.message)
    expect(line.errors).toHaveLength(1999)
    expect(line.errors.at(-1)).toBe('[Repeated]')
  })

  it('an Error passed twice is written twice, while it fits the budget', () => {
    const entries = _captureEntries()
    const e = new Error('twice')
    createLogger({ service: 'svc' }).error('m', e, e, [e])
    expect(entries[0].err).toMatchObject({ type: 'Error', message: 'twice' })
    expect(entries[0].errors).toEqual([entries[0].err])
    expect(entries[0].args).toEqual([[entries[0].err]])
  })

  it('a cycle through an Error is still "[Circular]"', () => {
    const entries = _captureEntries()
    const a = new Error('a') as Error & { b?: Error }
    const b = new Error('b', { cause: a })
    a.b = b
    createLogger({ service: 'svc' }).error(a, 'm', b)
    expect(entries[0].err).toMatchObject({ message: 'a', b: { message: 'b', cause: '[Circular]' } })
    expect(entries[0].errors).toEqual([expect.objectContaining({ message: 'b' })])
  })

  it('an AggregateError writes its errors, nested like cause', () => {
    const entries = _captureEntries()
    const agg = new AggregateError([new Error('e1'), new TypeError('e2'), 'plain'], 'agg')
    createLogger({ service: 'svc' }).error(agg)
    expect(entries[0].err).toMatchObject({
      type: 'AggregateError',
      message: 'agg',
      errors: [{ type: 'Error', message: 'e1' }, { type: 'TypeError', message: 'e2' }, 'plain'],
    })
  })

  it('an AggregateError holding one Error 2,000 times stays bounded', () => {
    const lines: string[] = []
    _setSink({ write: (record) => lines.push(stringifyRecord(record)) })
    const big = new Error('x'.repeat(100_000))
    const agg = new AggregateError(
      Array.from({ length: 2000 }, () => big),
      'agg',
    )
    createLogger({ service: 'svc' }).error(agg)
    expect(lines[0].length).toBeLessThan(1_000_000)
    expect(JSON.parse(lines[0]).err.errors.at(-1)).toBe('[Repeated]')
  })
})

describe('one re-write budget per line', () => {
  beforeEach(() => _reset())

  it('%j 500 times with one wide object: the message is bounded', () => {
    const lines: string[] = []
    _setSink({ write: (record) => lines.push(stringifyRecord(record)) })
    const shared = wide(20_000)
    const once = JSON.stringify(shared).length
    createLogger({ service: 'svc' }).info(
      '%j '.repeat(500),
      ...Array.from({ length: 500 }, () => shared),
    )
    const line = JSON.parse(lines[0])
    expect(line.logError).toBeUndefined()
    expect(line.message.length).toBeLessThan(once + 200_000 + 500 * 3)
    expect(line.message.startsWith(`${JSON.stringify(shared)} %j`)).toBe(true)
    expect(line.k19999).toBe(19_999) // the unprinted copies are routed
  })

  it('the message and the fields share it', () => {
    const entries = _captureEntries()
    const shared = wide(6_000) // its repeat fits the budget once, not twice
    createLogger({ service: 'svc' }).info('v=%j', [shared, shared], { items: [shared, shared] })
    expect(entries[0].message).toBe(`v=${JSON.stringify([shared, shared])}`)
    expect(entries[0].items).toEqual([shared, '[Repeated]'])
  })

  it('an object only in a placeholder that gave up is not a repeat for the next one', () => {
    const entries = _captureEntries()
    const inner = { n: 1 }
    createLogger({ service: 'svc' }).info('%j %j', { inner, big: 1n }, inner)
    expect(entries[0].message).toBe('%j {"n":1}')
  })
})

describe('repeated long strings count against the budget', () => {
  beforeEach(() => _reset())

  it('one 100 kB string 2,000 times: the line is bounded', () => {
    const long = 'x'.repeat(100_000)
    const line = lineFor({ a: Array.from({ length: 2000 }, () => long) })
    expect(line.length).toBeLessThan(1_000_000)
    const a = JSON.parse(line).a as unknown[]
    expect(a).toHaveLength(2000)
    expect(a[0]).toBe(long)
    expect(a.at(-1)).toBe('[Repeated]')
  })

  it('short strings repeat freely, and a long one is written again while it fits', () => {
    const long = 'y'.repeat(2_000)
    const parsed = JSON.parse(lineFor({ s: Array(20_000).fill('short'), l: [long, long, long] }))
    expect(parsed.s).toEqual(Array(20_000).fill('short'))
    expect(parsed.l).toEqual([long, long, long])
  })
})

describe('a shared object with a toJSON is a repeat too', () => {
  beforeEach(() => _reset())

  /** A chain of `depth` nodes whose `toJSON` returns a new `{ l, r }`, both the next node. */
  class Node {
    constructor(readonly next: unknown) {}
    toJSON() {
      return { l: this.next, r: this.next }
    }
  }
  const chain = (depth: number) => {
    let node: unknown = { leaf: 1 }
    for (let i = 0; i < depth; i++) node = new Node(node)
    return node
  }

  it('a chain of toJSON nodes 30 deep: well under 1 s, with a bounded line', () => {
    let line = ''
    const ms = elapsed(() => (line = lineFor({ tree: chain(30) })))
    expect(ms).toBeLessThan(500)
    expect(line.length).toBeLessThan(1_000_000)
    expect(line).toContain('"[Repeated]"')
    expect(JSON.parse(line).logError).toBeUndefined()
  })

  it('a toJSON that returns a new wide object, shared 200 times, is bounded', () => {
    const big = wide(20_000)
    const fresh = { toJSON: () => ({ ...big }) }
    const items = JSON.parse(lineFor({ items: Array.from({ length: 200 }, () => fresh) }))
      .items as unknown[]
    expect(items[0]).toEqual(big)
    expect(items.at(-1)).toBe('[Repeated]')
  })

  it('a shared Date is written every time: its toJSON gives a string', () => {
    const at = new Date(0)
    const rows = JSON.parse(lineFor({ rows: Array.from({ length: 20_000 }, () => at) }))
      .rows as unknown[]
    expect(rows.every((row) => row === '1970-01-01T00:00:00.000Z')).toBe(true)
  })
})

describe('boxed primitives are told by their brand, not their tag', () => {
  class Money {
    amount = 5
    get [Symbol.toStringTag]() {
      return 'Number'
    }
  }
  class Throwing {
    a = 1
    get [Symbol.toStringTag](): string {
      throw new Error('no tag')
    }
  }
  const sh = { x: 1 }

  const fakes = () => ({
    m: new Money(),
    t: new Throwing(),
    n: Object.assign(Object.create(Number.prototype), { a: 2 }),
    s: Object.create(Symbol.prototype),
  })

  it('an object with a fake tag or prototype is written as an object, on both paths', () => {
    const expected = { m: { amount: 5 }, t: { a: 1 }, n: { a: 2 }, s: {} }
    expect(JSON.parse(stringifyRecord(fakes()))).toEqual(expected)
    expect(JSON.parse(stringifyRecord({ ...fakes(), p: sh, q: sh }))).toMatchObject(expected)
  })

  it('real boxed values are unwrapped the same way on both paths', () => {
    const boxed = {
      n: Object(1),
      s: Object('s'),
      b: Object(false),
      big: Object(10n),
      sym: Object(Symbol('d')),
    }
    const expected = { n: 1, s: 's', b: false, big: '10', sym: 'Symbol(d)' }
    expect(JSON.parse(stringifyRecord({ ...boxed }))).toEqual(expected)
    expect(JSON.parse(stringifyRecord({ ...boxed, p: sh, q: sh }))).toMatchObject(expected)
  })
})
