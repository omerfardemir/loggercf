import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import {
  createLogger,
  getLogger,
  runWithLogger,
  setLoggerContext,
  withSpan,
  _captureEntries,
  _reset,
} from './logger'
import { useLogger } from './middleware'
import { omitErrorKeys } from './omit'
import type { ErrorSerializer } from './types'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

/** A library error that carries user content as own properties, as AI SDK errors do. */
class APICallError extends Error {
  requestBodyValues = { prompt: 'user secret prompt' }
  responseBody = 'x'.repeat(50)
  statusCode = 429
  constructor(message = 'rate limited', options?: ErrorOptions) {
    super(message, options)
  }
}

/** What `tagging()` writes for an `Error` with this message. */
const custom = (message: string) => ({ type: 'Error', message, tag: 'custom' })

/** A serializer that writes the default shape, plus `kind`, and `first`: its cause, the default way. */
const wrapping: ErrorSerializer = (err, defaultSerialize) => ({
  ...defaultSerialize(err),
  kind: 'wrapped',
  first: err.cause instanceof Error ? defaultSerialize(err.cause) : undefined,
})

/** A serializer that writes the default shape. */
const passThrough: ErrorSerializer = (err, defaultSerialize) => defaultSerialize(err)

/** A serializer that writes `{ type, message, tag }`, and counts its calls by Error. */
function tagging(tag = 'custom') {
  const calls = new Map<Error, number>()
  const serializer: ErrorSerializer = (err) => {
    calls.set(err, (calls.get(err) ?? 0) + 1)
    return { type: err.name, message: err.message, tag }
  }
  return { serializer, calls }
}

describe('serializeError in Logger Options', () => {
  beforeEach(() => _reset())

  it('replaces the default shape for err, errors, nested fields, args, bindings and Context Fields', () => {
    const entries = _captureEntries()
    const { serializer } = tagging()
    const logger = createLogger(
      { service: 'svc', serializeError: serializer },
      { boot: new Error('binding') },
    )
    runWithLogger({ logger, fields: { ctxErr: new Error('context') } }, () => {
      getLogger().error(
        'm',
        new Error('first'),
        new Error('second'),
        { nested: { deep: [new Error('field')] } },
        [new Error('in args')],
      )
    })
    expect(entries[0]).toMatchObject({
      err: custom('first'),
      errors: [custom('second')],
      nested: { deep: [custom('field')] },
      args: [[custom('in args')]],
      boot: custom('binding'),
      ctxErr: custom('context'),
    })
    expect(JSON.stringify(entries[0])).not.toContain('stack')
  })

  it('is used for span.end and the <operation> failed line', async () => {
    const entries = _captureEntries()
    const { serializer } = tagging()
    const logger = createLogger({ service: 'svc', serializeError: serializer })
    await runWithLogger({ logger, traceparent: TRACEPARENT }, async () => {
      await expect(
        withSpan('db.query', () => Promise.reject(new Error('db down'))),
      ).rejects.toThrow('db down')
    })
    const unsampled = TRACEPARENT.replace(/-01$/, '-00')
    runWithLogger({ logger, traceparent: unsampled }, () => {
      expect(() =>
        withSpan('db.query', () => {
          throw new Error('unsampled')
        }),
      ).toThrow('unsampled')
    })
    expect(entries.map((e) => [e.message, e.err])).toEqual([
      ['span.end db.query', { type: 'Error', message: 'db down', tag: 'custom' }],
      ['db.query failed', { type: 'Error', message: 'unsampled', tag: 'custom' }],
    ])
  })

  it("is used for request.end's err in the Hono middleware", async () => {
    const entries = _captureEntries()
    const { serializer } = tagging()
    const app = new Hono()
    app.use(useLogger(createLogger({ service: 'svc', serializeError: serializer })))
    app.get('/boom', () => {
      throw new APICallError()
    })
    app.onError((_err, c) => c.text('failed', 500))
    expect((await app.request('/boom')).status).toBe(500)
    const end = entries.find((e) => String(e.message).startsWith('request.end'))
    expect(end?.err).toEqual({ type: 'Error', message: 'rate limited', tag: 'custom' })
  })

  it('is kept by .child() loggers', () => {
    const entries = _captureEntries()
    const { serializer } = tagging('child')
    createLogger({ service: 'svc', serializeError: serializer })
      .child({ a: 1 })
      .error(new Error('x'))
    expect(entries[0].err).toEqual({ type: 'Error', message: 'x', tag: 'child' })
  })

  it('defaultSerialize gives the default shape, and the Errors inside it go through the serializer', () => {
    const entries = _captureEntries()
    const root = new Error('root', { cause: new Error('inner', { cause: new Error('leaf') }) })
    createLogger({
      service: 'svc',
      serializeError: (err, defaultSerialize) => ({ ...defaultSerialize(err), seen: true }),
    }).error(root)
    expect(entries[0].err).toMatchObject({
      type: 'Error',
      message: 'root',
      stack: expect.any(String),
      seen: true,
      cause: {
        message: 'inner',
        seen: true,
        cause: { message: 'leaf', seen: true },
      },
    })
  })

  it('is called once per Error and line, wherever and however often the Error appears', () => {
    const entries = _captureEntries()
    const { serializer, calls } = tagging()
    const shared = new Error('shared')
    const a = new Error('a', { cause: shared })
    const b = new Error('b', { cause: shared })
    const logger = createLogger({
      service: 'svc',
      serializeError: (e, d) => ({ ...serializer(e, d), cause: e.cause }),
    })
    logger.error('m', a, b, { again: [shared, shared] }, [shared])
    expect([...calls.values()]).toEqual([1, 1, 1])
    expect(entries[0].errors).toEqual([expect.objectContaining({ message: 'b' })])
    // A second line calls it again.
    logger.error(shared)
    expect(calls.get(shared)).toBe(2)
  })

  it('a cause loop through the serializer is "[Circular]", and does not loop', () => {
    const entries = _captureEntries()
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b
    let calls = 0
    createLogger({
      service: 'svc',
      serializeError: (err, defaultSerialize) => {
        calls++
        return { message: err.message, cause: defaultSerialize(err.cause as Error) }
      },
    }).error(a)
    expect(calls).toBe(1) // `b` was written through defaultSerialize, which skips the serializer
    expect(entries[0].err).toMatchObject({
      message: 'a',
      cause: { message: 'b', cause: '[Circular]' },
    })
  })

  it('an Error nested deeper than 5 levels is cut off, as by default', () => {
    const entries = _captureEntries()
    let err: Error = new Error('e9')
    for (let i = 8; i >= 0; i--) err = new Error(`e${i}`, { cause: err })
    createLogger({
      service: 'svc',
      serializeError: (e) => ({ message: e.message, cause: e.cause }),
    }).error(err)
    let node = entries[0].err as Record<string, unknown>
    for (let i = 0; i < 5; i++) node = node.cause as Record<string, unknown>
    expect(node).toMatchObject({ message: 'e5', cause: { type: 'Truncated' } })
  })

  it('returning the Error itself, or another one, writes its default shape, without looping', () => {
    const entries = _captureEntries()
    const other = new Error('other')
    const logger = createLogger({
      service: 'svc',
      serializeError: (err) =>
        (err.message === 'swap' ? other : err) as unknown as Record<string, unknown>,
    })
    logger.error(new Error('same', { cause: new Error('swap') }))
    expect(entries[0].err).toMatchObject({
      type: 'Error',
      message: 'same',
      stack: expect.any(String),
      cause: { message: 'other' },
    })
  })

  it('a serializer that calls defaultSerialize on a non-Error is fine; a primitive result is a failure', () => {
    const entries = _captureEntries()
    createLogger({
      service: 'svc',
      serializeError: (err, defaultSerialize) =>
        err.message === 'text'
          ? (err.message as unknown as Record<string, unknown>)
          : { cause: defaultSerialize(err.cause as Error) },
    }).error(new Error('outer', { cause: 'not an error' }), 'm', new Error('text'))
    expect(entries[0].err).toEqual({ cause: 'not an error' })
    expect(entries[0].errors).toEqual([
      {
        type: 'Error',
        message: 'text',
        stack: expect.any(String),
        serializeErrorFailed: 'serializeError returned a string',
      },
    ])
  })

  it('a serializer that throws: the default shape with serializeErrorFailed, and the log call does not throw', () => {
    const entries = _captureEntries()
    const logger = createLogger({
      service: 'svc',
      serializeError: (err) => {
        if (err.message === 'bad') throw new TypeError('serializer broke')
        return { message: err.message }
      },
    })
    expect(() => logger.error(new Error('bad', { cause: new Error('fine') }), 'm')).not.toThrow()
    expect(entries[0]).toMatchObject({
      message: 'm',
      err: {
        type: 'Error',
        message: 'bad',
        stack: expect.any(String),
        serializeErrorFailed: 'TypeError: serializer broke',
        cause: { message: 'fine' },
      },
    })
    expect(entries[0].err).not.toHaveProperty('cause.stack')
  })

  it('a result that can not be read (a revoked Proxy) is a failure too', () => {
    const entries = _captureEntries()
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    createLogger({ service: 'svc', serializeError: () => proxy }).error(new Error('x'))
    expect(entries[0].err).toMatchObject({
      message: 'x',
      serializeErrorFailed: expect.stringMatching(/revoked/),
    })
  })

  it('its result goes through the walk: "[Circular]" and the Re-write Budget apply', () => {
    const entries = _captureEntries()
    const big = { text: 'y'.repeat(25_000) } // the 65,536-character budget holds two repeats
    const logger = createLogger({
      service: 'svc',
      serializeError: (err) => {
        const out: Record<string, unknown> = { message: err.message, big }
        out.self = out
        return out
      },
    })
    logger.error('m', new Error('a'), new Error('b'), new Error('c'))
    const [first, second, third] = [entries[0].err, ...(entries[0].errors as unknown[])] as Record<
      string,
      unknown
    >[]
    // The result is copied, so its `self` is the original: one level down, then a loop.
    expect(first).toMatchObject({ message: 'a', big, self: { message: 'a', self: '[Circular]' } })
    expect(second).toMatchObject({ message: 'b', big }) // within the budget
    expect(third).toMatchObject({ message: 'c', big: '[Repeated]' }) // past it
  })

  it('a serializer that logs does not call itself again', () => {
    const entries = _captureEntries()
    let calls = 0
    const logger = createLogger({
      service: 'svc',
      serializeError: (err) => {
        calls++
        logger.warn(err, 'serializing')
        return { message: err.message, by: 'custom' }
      },
    })
    logger.error(new Error('x'))
    expect(calls).toBe(1)
    expect(entries.map((e) => e.message)).toEqual(['serializing', 'x'])
    // The line logged from inside writes only `type` and `message`, marked.
    expect(entries[0].err).toEqual({
      type: 'Error',
      message: 'x',
      serializeErrorFailed: 'logged from inside serializeError',
    })
    expect(entries[1].err).toEqual({ message: 'x', by: 'custom' })
  })

  it('a line logged from inside it never writes the keys omitErrorKeys leaves out', () => {
    const entries = _captureEntries()
    const secret = new APICallError('api')
    let logger: ReturnType<typeof createLogger> | undefined
    const other = createLogger({ service: 'other' }) // a logger without serializeError
    const user: ErrorSerializer = (err, defaultSerialize) => {
      logger!.warn({ seen: err }, 'unexpected error shape')
      other.warn(err, 'through another logger')
      getLogger().warn({ nested: { err } }, 'through getLogger')
      return defaultSerialize(err)
    }
    logger = createLogger({
      service: 'svc',
      serializeError: omitErrorKeys(['requestBodyValues', 'responseBody'], user),
    })
    runWithLogger({ logger }, () => logger!.error(secret, 'outer'))
    expect(entries.map((e) => e.message)).toEqual([
      'unexpected error shape',
      'through another logger',
      'through getLogger',
      'outer',
    ])
    expect(JSON.stringify(entries)).not.toContain('user secret prompt')
    const minimal = {
      type: 'APICallError',
      message: 'api',
      serializeErrorFailed: 'logged from inside serializeError',
    }
    expect(entries[0].seen).toEqual(minimal)
    expect(entries[1].err).toEqual(minimal)
    expect(entries[2].nested).toEqual({ err: minimal })
    expect(entries[3].err).toMatchObject({ omitted: ['requestBodyValues', 'responseBody'] })
  })

  it.each([
    ['undefined', () => undefined, 'serializeError returned undefined'],
    ['null', () => null, 'serializeError returned null'],
    ['a number', () => 42, 'serializeError returned a number'],
    ['a boolean', () => false, 'serializeError returned a boolean'],
    ['a function', () => () => 1, 'serializeError returned a function'],
    [
      'a Promise (an async serializer)',
      async () => ({ a: 1 }),
      'serializeError returned a Promise',
    ],
    // oxlint-disable-next-line unicorn/no-thenable
    ['a thenable', () => ({ then: () => 1 }), 'serializeError returned a thenable'],
  ])(
    'a serializer that returns %s: the default shape with serializeErrorFailed',
    (_, fn, failed) => {
      const entries = _captureEntries()
      const serializeError = fn as unknown as ErrorSerializer
      createLogger({ service: 'svc', serializeError }).error(new Error('x'), 'm', {
        nested: new Error('y'),
      })
      expect(entries[0].err).toEqual({
        type: 'Error',
        message: 'x',
        stack: expect.any(String),
        serializeErrorFailed: failed,
      })
      expect(entries[0].nested).toMatchObject({ message: 'y', serializeErrorFailed: failed })
    },
  )

  it('a rejecting async serializer leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const entries = _captureEntries()
      const serializeError = (async () => {
        throw new Error('serializer failed')
      }) as unknown as ErrorSerializer
      createLogger({ service: 'svc', serializeError }).error(
        new Error('x', { cause: new Error('y') }),
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(entries[0].err).toMatchObject({
        serializeErrorFailed: 'serializeError returned a Promise',
      })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('a non-function serializeError throws at createLogger', () => {
    expect(() => createLogger({ service: 'svc', serializeError: 'no' as never })).toThrow(
      'serializeError must be a function',
    )
  })

  it('without it, Errors are written exactly as before', () => {
    const entries = _captureEntries()
    const e = new APICallError()
    createLogger({ service: 'svc' }).error(e)
    expect(entries[0].err).toMatchObject({
      type: 'APICallError',
      requestBodyValues: { prompt: 'user secret prompt' },
      responseBody: 'x'.repeat(50),
    })
    expect(entries[0].err).not.toHaveProperty('omitted')
  })
})

describe('omitErrorKeys', () => {
  beforeEach(() => _reset())

  it('leaves the given own keys out and lists them as omitted', () => {
    const entries = _captureEntries()
    createLogger({
      service: 'svc',
      serializeError: omitErrorKeys(['requestBodyValues', 'responseBody']),
    }).error(new APICallError(), 'llm failed')
    expect(entries[0].err).toEqual({
      type: 'APICallError',
      message: 'rate limited',
      stack: expect.any(String),
      statusCode: 429,
      omitted: ['requestBodyValues', 'responseBody'],
    })
    expect(JSON.stringify(entries[0])).not.toContain('user secret prompt')
  })

  it('lists only the keys the Error has, and never a key it does not own (type)', () => {
    const entries = _captureEntries()
    const logger = createLogger({
      service: 'svc',
      serializeError: omitErrorKeys(['responseBody', 'missing', 'type']),
    })
    logger.error(new APICallError(), 'm', new Error('plain'))
    expect(entries[0].err).toMatchObject({ type: 'APICallError', omitted: ['responseBody'] })
    expect(entries[0].errors).toEqual([
      { type: 'Error', message: 'plain', stack: expect.any(String) },
    ])
  })

  it('applies to nested Errors, at any depth', () => {
    const entries = _captureEntries()
    const inner = new APICallError('inner')
    const outer = Object.assign(new Error('outer', { cause: inner }), {
      attempts: [new APICallError('attempt')],
    })
    createLogger({ service: 'svc', serializeError: omitErrorKeys(['requestBodyValues']) }).error(
      'm',
      { ctx: { failure: outer } },
    )
    const line = JSON.stringify(entries[0])
    expect(line).not.toContain('user secret prompt')
    expect(entries[0].ctx).toMatchObject({
      failure: {
        message: 'outer',
        attempts: [{ message: 'attempt', omitted: ['requestBodyValues'] }],
        cause: { message: 'inner', omitted: ['requestBodyValues'] },
      },
    })
    expect(entries[0].ctx).not.toHaveProperty('failure.omitted')
  })

  it("can leave out an Error's own message, stack or cause", () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc', serializeError: omitErrorKeys(['stack', 'cause']) }).error(
      new Error('x', { cause: new Error('y') }),
    )
    expect(entries[0].err).toEqual({ type: 'Error', message: 'x', omitted: ['stack', 'cause'] })
  })

  it('composes with a custom serializer, whose defaultSerialize leaves the keys out too', () => {
    const entries = _captureEntries()
    createLogger({
      service: 'svc',
      serializeError: omitErrorKeys(['requestBodyValues', 'responseBody'], wrapping),
    }).error(new APICallError('outer', { cause: new APICallError('inner') }))
    expect(JSON.stringify(entries[0])).not.toContain('user secret prompt')
    expect(entries[0].err).toMatchObject({
      message: 'outer',
      kind: 'wrapped',
      omitted: ['requestBodyValues', 'responseBody'],
      first: { message: 'inner', omitted: ['requestBodyValues', 'responseBody'] },
      cause: { message: 'inner', kind: 'wrapped' },
    })
  })

  it('a custom serializer that throws: the default shape, still without the keys', () => {
    const entries = _captureEntries()
    createLogger({
      service: 'svc',
      serializeError: omitErrorKeys(['requestBodyValues'], () => {
        throw new Error('nope')
      }),
    }).error(new APICallError())
    expect(entries[0].err).toMatchObject({
      type: 'APICallError',
      omitted: ['requestBodyValues'],
      serializeErrorFailed: 'Error: nope',
    })
    expect(JSON.stringify(entries[0])).not.toContain('user secret prompt')
  })

  it('a custom serializer that returns the raw Error: its default shape, without the keys', () => {
    const entries = _captureEntries()
    createLogger({
      service: 'svc',
      serializeError: omitErrorKeys(['requestBodyValues'], (err) => err as never),
    }).error(new APICallError())
    expect(entries[0].err).toMatchObject({ type: 'APICallError', omitted: ['requestBodyValues'] })
  })

  it("never leaves out type: 'type' writes the class name in place of an own type property", () => {
    const entries = _captureEntries()
    const typed = Object.assign(new Error('t'), { type: 'OWN_TYPE', code: 'E1' })
    createLogger({ service: 'svc', serializeError: omitErrorKeys(['type', 'code']) }).error(typed)
    expect(entries[0].err).toEqual({
      type: 'Error',
      message: 't',
      stack: expect.any(String),
      omitted: ['type', 'code'],
    })
  })

  it('never leaves out type, even when the wrapped serializer writes the own type property', () => {
    const entries = _captureEntries()
    class Typed extends Error {
      type = 'OWN_TYPE'
    }
    createLogger({
      service: 'svc',
      serializeError: omitErrorKeys(['type'], (err) => ({
        type: (err as Typed).type,
        message: err.message,
      })),
    }).error(new Typed('t'), 'm', new Error('plain'))
    expect(entries[0].err).toEqual({ type: 'Typed', message: 't', omitted: ['type'] })
    // No own `type`: nothing is left out, and the serializer's `type: undefined` is not written.
    expect(entries[0].errors).toEqual([{ message: 'plain' }])
  })

  it.each([
    ['undefined', () => undefined, 'serializeError returned undefined'],
    ['a Promise', async () => ({}), 'serializeError returned a Promise'],
  ])(
    'a wrapped serializer that returns %s: the default shape, still without the keys',
    (_, fn, failed) => {
      const entries = _captureEntries()
      createLogger({
        service: 'svc',
        serializeError: omitErrorKeys(['requestBodyValues'], fn as unknown as ErrorSerializer),
      }).error(new APICallError())
      expect(entries[0].err).toMatchObject({
        type: 'APICallError',
        omitted: ['requestBodyValues'],
        serializeErrorFailed: failed,
      })
      expect(JSON.stringify(entries[0])).not.toContain('user secret prompt')
    },
  )

  it('without a serializer, the same keys give the same function, in any order and with repeats', () => {
    const serializeError = omitErrorKeys(['requestBodyValues', 'responseBody'])
    expect(omitErrorKeys(['requestBodyValues', 'responseBody'])).toBe(serializeError)
    expect(omitErrorKeys(['responseBody', 'requestBodyValues', 'responseBody'])).toBe(
      serializeError,
    )
    expect(omitErrorKeys(['responseBody'])).not.toBe(serializeError)
    expect(omitErrorKeys(['responseBody'], passThrough)).not.toBe(
      omitErrorKeys(['responseBody'], passThrough),
    )
  })

  it('rejects keys that are not an array of strings, and a serializer that is not a function', () => {
    expect(() => omitErrorKeys('responseBody' as never)).toThrow(TypeError)
    expect(() => omitErrorKeys([1] as never)).toThrow(TypeError)
    expect(() => omitErrorKeys(['a'], 'no' as never)).toThrow(TypeError)
  })

  it('copies the keys when it is created', () => {
    const entries = _captureEntries()
    const keys = ['responseBody']
    const serializeError = omitErrorKeys(keys)
    keys.push('requestBodyValues')
    createLogger({ service: 'svc', serializeError }).error(new APICallError())
    expect(entries[0].err).toMatchObject({ omitted: ['responseBody'] })
  })
})

describe('setLoggerContext with an Error and serializeError', () => {
  beforeEach(() => _reset())

  it('a Context Field set later is written by the serializer too', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc', serializeError: omitErrorKeys(['responseBody']) })
    runWithLogger({ logger }, () => {
      setLoggerContext({ lastError: new APICallError() })
      getLogger().info('later')
    })
    expect(entries[0].lastError).toMatchObject({ omitted: ['responseBody'] })
  })
})
