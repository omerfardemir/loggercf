import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import {
  _captureEntries,
  _captureLines,
  _reset,
  _setSink,
  createLogger,
  runWithLogger,
  setLoggerContext,
  withSpan,
} from './logger'
import { stringifyRecord } from './output'
import { omitErrorKeys } from './omit'
import { redactKeys } from './redact'
import { useLogger } from './middleware'
import type { Logger, LoggerOptions, Redactor } from './types'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const UNSAMPLED = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00'

/** A redactor that writes nothing new, and records each path it was given. */
function recorder(): { redact: Redactor; paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    redact: {
      value(value, path) {
        paths.push(path.join('.'))
        return value
      },
    },
  }
}

/** A named function, as a value. */
function named(): void {}

/** Run `fn` in a sampled Logging Context of `logger`, with Context Fields. */
function inContext(logger: Logger, fn: () => void, fields: Record<string, unknown> = {}): void {
  runWithLogger({ logger, traceparent: TRACEPARENT, fields: fields as never }, fn)
}

/** One line of each kind the serializer has: fast path, nested Errors, repeats, limits. */
function writeAll(options: Partial<LoggerOptions>): string[] {
  const lines = _captureLines()
  const logger = createLogger({ service: 'svc', version: '1', ...options }, { region: 'eu' })
  const shared = { a: 1 }
  inContext(
    logger,
    () => {
      logger.info({ password: 'p', nested: { token: 't' } }, 'login %s', 'ada')
      logger.error(new Error('top', { cause: new Error('inner') }), 'failed')
      logger.warn({ list: [shared, shared], at: new Date(0), big: 10n }, 'repeats')
      logger.info('console %j', { k: 'v' }, [1, 2], new Map([['m', 1]]))
    },
    { requestId: 'r' },
  )
  return lines.map((line) =>
    line
      .replace(/"time":"[^"]+"/, '')
      .replace(/"spanId":"[^"]+"/, '')
      .replace(/"stack":"[^"]*"/g, ''),
  )
}

describe('redact off', () => {
  beforeEach(() => _reset())

  it('omitted, false and a Redactor with no hook write the same bytes', () => {
    const omitted = writeAll({})
    expect(writeAll({ redact: false })).toEqual(omitted)
    expect(writeAll({ redact: {} })).toEqual(omitted)
    expect(omitted.join('\n')).toContain('"password":"p"')
  })

  it('there is no default key list: without redact, nothing is hidden', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info({
      authorization: 'Bearer abc',
      password: 'p',
      cookie: 'c',
    })
    expect(entries[0]).toMatchObject({ authorization: 'Bearer abc', password: 'p', cookie: 'c' })
    // And an empty list hides nothing either.
    createLogger({ service: 'svc', redact: redactKeys([]) }).info({ password: 'p' })
    expect(entries[1]).toMatchObject({ password: 'p' })
  })

  it('an invalid redact throws when the logger is built', () => {
    for (const redact of [true, 'keys', 1, null, () => 0])
      expect(() => createLogger({ service: 's', redact: redact as never })).toThrow(
        'redact must be a Redactor',
      )
    expect(() => createLogger({ service: 's', redact: { value: 1 } as never })).toThrow(
      'redact.value must be a function',
    )
    expect(() => createLogger({ service: 's', redact: { record: 'x' } as never })).toThrow(
      'redact.record must be a function',
    )
  })
})

describe('what value() is given', () => {
  beforeEach(() => _reset())

  it('every value of the line, before what is inside it, with its path', () => {
    _captureEntries()
    const { redact, paths } = recorder()
    const logger = createLogger(
      { service: 'svc', environment: 'prod', version: '1', redact },
      { region: 'eu' },
    ).child({ shard: 2 })
    const err = Object.assign(new Error('top', { cause: new Error('inner') }), { code: 'E1' })
    inContext(
      logger,
      () => {
        setLoggerContext({ userId: 'u1' })
        logger.error(
          { err, body: { user: { email: 'a@b.c' } } },
          'failed %s',
          'ada',
          new Error('second'),
          [1, { token: 't' }],
        )
      },
      { requestId: 'r1' },
    )
    expect(paths).toEqual([
      'message',
      'requestId',
      'userId',
      'service',
      'environment',
      'version',
      'region',
      'shard',
      'err',
      'err.type',
      'err.message',
      'err.stack',
      'err.code',
      'err.cause',
      'err.cause.type',
      'err.cause.message',
      'err.cause.stack',
      'body',
      'body.user',
      'body.user.email',
      'errors',
      'errors.0',
      'errors.0.type',
      'errors.0.message',
      'errors.0.stack',
      'args',
      'args.0',
      'args.0.0',
      'args.0.1',
      'args.0.1.token',
    ])
  })

  it('never the top-level time, level or trace IDs; a nested key of those names, yes', () => {
    const entries = _captureEntries()
    const seen: unknown[] = []
    const redact: Redactor = {
      value(value, path) {
        seen.push(path.join('.'))
        return typeof value === 'string' ? 'X' : value
      },
    }
    const logger = createLogger({ service: 'svc', redact })
    runWithLogger({ logger, traceparent: TRACEPARENT }, () =>
      withSpan('op', () => logger.info({ inner: { level: 'L', time: 'T', traceId: 'I' } }, 'm')),
    )
    for (const key of ['time', 'level', 'traceId', 'spanId', 'parentSpanId'])
      expect(seen).not.toContain(key)
    expect(seen).toEqual(expect.arrayContaining(['inner.level', 'inner.time', 'inner.traceId']))
    const line = entries.find((e) => e.inner)!
    expect(line.level).toBe('INFO')
    expect(line.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(line.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(line.parentSpanId).toMatch(/^[0-9a-f]{16}$/)
    expect(line.time).toMatch(/^\d{4}-/)
    expect(line).toMatchObject({ message: 'X', service: 'X', inner: { level: 'X', time: 'X' } })
  })

  it('values as they are written: toJSON results, texts, Errors in their shape; never undefined or "[Circular]"', () => {
    _captureEntries()
    const given: [string, unknown][] = []
    const redact: Redactor = {
      value(value, path) {
        given.push([path.join('.'), value])
        return value
      },
    }
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    createLogger({ service: 's', redact }).info({
      at: new Date(0),
      big: 12n,
      fn: named,
      gone: undefined,
      loop,
      map: new Map([['authorization', 'x']]),
      nested: { e: new TypeError('deep') },
    })
    const byPath = Object.fromEntries(given)
    expect(byPath.at).toBe('1970-01-01T00:00:00.000Z')
    expect(byPath.big).toBe('12')
    expect(byPath.fn).toBe('[Function: named]')
    expect('gone' in byPath).toBe(false)
    expect('loop.self' in byPath).toBe(false)
    expect(byPath.map).toBeInstanceOf(Map)
    expect(given.map(([path]) => path)).toEqual(
      expect.arrayContaining(['map.0', 'map.0.0', 'map.0.1']),
    )
    expect(byPath['nested.e']).toMatchObject({ type: 'TypeError', message: 'deep' })
    expect(byPath['nested.e.message']).toBe('deep')
  })

  it('is not called inside a replacement it returned', () => {
    const entries = _captureEntries()
    const paths: string[] = []
    const redact: Redactor = {
      value(value, path) {
        paths.push(path.join('.'))
        // A wrapper of every value would recurse forever, were it redacted again.
        return path.at(-1) === 'user' ? { wrapped: value } : value
      },
    }
    createLogger({ service: 's', redact }).info({ user: { email: 'e' } })
    expect(entries[0]!.user).toEqual({ wrapped: { email: 'e' } })
    expect(paths.filter((p) => p.startsWith('user'))).toEqual(['user'])
  })
})

/** An Error whose own key, and whose cause's, hold secrets. */
const secrets = () =>
  Object.assign(
    new Error('boom', { cause: Object.assign(new Error('inner'), { Token: 'cause-secret' }) }),
    { password: 'err-secret' },
  )

describe('redactKeys', () => {
  beforeEach(() => _reset())

  it('hides whole values under the keys, whatever their case, at any depth', () => {
    const entries = _captureEntries()
    const logger = createLogger(
      { service: 's', redact: redactKeys(['Authorization', 'password', 'TOKEN']) },
      { token: 'binding' },
    )
    const agg = new AggregateError([Object.assign(new Error('a'), { password: 'agg' })], 'many')
    inContext(
      logger,
      () =>
        logger.error(
          {
            err: secrets(),
            headers: { AUTHORIZATION: 'Bearer abc', accept: '*/*' },
            deep: { a: { b: { c: { d: { e: { password: { nested: 'deep-secret' } } } } } } },
            passwordHint: 'kept',
          },
          'failed',
          agg,
          { list: [{ token: 'in args' }] },
          [{ Password: 'in an array' }],
        ),
      { authorization: 'context field' },
    )
    const line = JSON.stringify(entries[0])
    for (const secret of ['Bearer', 'binding', 'context field', 'in args', 'in an array', 'agg'])
      expect(line).not.toContain(secret)
    expect(line).not.toContain('-secret')
    const e = entries[0]!
    expect(e).toMatchObject({
      authorization: '[REDACTED]',
      token: '[REDACTED]',
      headers: { AUTHORIZATION: '[REDACTED]', accept: '*/*' },
      deep: { a: { b: { c: { d: { e: { password: '[REDACTED]' } } } } } },
      passwordHint: 'kept',
      err: {
        type: 'Error',
        message: 'boom',
        password: '[REDACTED]',
        cause: { Token: '[REDACTED]' },
      },
      errors: [{ type: 'AggregateError', errors: [{ password: '[REDACTED]' }] }],
      list: [{ token: '[REDACTED]' }],
      args: [[{ Password: '[REDACTED]' }]],
    })
  })

  it('hides a value that cannot be written too: its stand-in may hold the secret', () => {
    const entries = _captureEntries()
    const throwing = {
      toJSON() {
        throw new Error('token abc123 is invalid')
      },
    }
    createLogger({ service: 's', redact: redactKeys(['token']) }).info({
      token: throwing,
      other: throwing,
    })
    expect(entries[0]).toMatchObject({
      token: '[REDACTED]',
      other: '[Unserializable: Error: token abc123 is invalid]',
    })
  })

  it('takes a censor, and does not look inside text or a Map', () => {
    const entries = _captureEntries()
    createLogger({ service: 's', redact: redactKeys(['password'], { censor: '***' }) }).info(
      { password: 'p', map: new Map([['password', 'in a map']]) },
      'body %j',
      { password: 'in the message' },
    )
    expect(entries[0]).toMatchObject({ password: '***', map: [['password', 'in a map']] })
    expect(entries[0]!.message).toContain('in the message')
  })

  it('the same keys, in any case or order, give the same Redactor; other keys or censor do not', () => {
    const a = redactKeys(['password', 'Token'])
    expect(redactKeys(['token', 'PASSWORD', 'password'])).toBe(a)
    expect(redactKeys(['password'])).not.toBe(a)
    expect(redactKeys(['password', 'token'], { censor: 'x' })).not.toBe(a)
    expect(Object.isFrozen(a)).toBe(true)
  })

  it('checks its arguments', () => {
    expect(() => redactKeys('password' as never)).toThrow('keys must be an array of strings')
    expect(() => redactKeys([1] as never)).toThrow('keys must be an array of strings')
    expect(() => redactKeys(['a'], { censor: 1 as never })).toThrow('censor must be a string')
  })
})

describe('a redactor that fails', () => {
  beforeEach(() => _reset())

  it('value() that throws: that value is a marker, the line is kept, one WARN per isolate', () => {
    const entries = _captureEntries()
    const redact: Redactor = {
      value(value, path) {
        if (path.at(-1) === 'bad') throw new TypeError(`cannot redact ${String(value)}`)
        return value
      },
    }
    const logger = createLogger({ service: 'svc', environment: 'prod', redact })
    inContext(
      logger,
      () => {
        logger.info({ bad: 'secret-1', good: 'g' }, 'first')
        logger.info({ nested: { bad: 'secret-2' } }, 'second')
      },
      { requestId: 'r1' },
    )
    const lines = entries.filter((e) => e.level === 'INFO')
    expect(lines.map((e) => e.message)).toEqual(['first', 'second'])
    expect(lines[0]).toMatchObject({ bad: '[Redaction failed: TypeError]', good: 'g' })
    expect(lines[1]).toMatchObject({ nested: { bad: '[Redaction failed: TypeError]' } })
    const warnings = entries.filter((e) => e.level === 'WARN')
    expect(warnings).toEqual([
      {
        time: expect.any(String),
        level: 'WARN',
        service: 'svc',
        environment: 'prod',
        message: 'redact value() failed; the value is written as "[Redaction failed: <name>]"',
        redactHook: 'value',
        redactError: 'TypeError',
        redactPath: ['bad'],
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: expect.any(String),
        parentSpanId: 'b7ad6b7169203331',
      },
    ])
    expect(JSON.stringify(entries)).not.toContain('secret')
  })

  it('value() that returns a Promise: a marker, and its rejection is not unhandled', async () => {
    const entries = _captureEntries()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const redact: Redactor = {
        value: (value, path) => (path.at(-1) === 'x' ? Promise.reject(new Error('no')) : value),
      }
      createLogger({ service: 's', redact }).info({ x: 1 })
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(entries.find((e) => e.level === 'INFO')!.x).toBe(
      '[Redaction failed: returned a Promise]',
    )
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('record() that throws: the line as value() left it, with redactFailed', () => {
    const entries = _captureEntries()
    const redact: Redactor = {
      ...redactKeys(['password']),
      record() {
        throw new Error('record broke with the secret in it')
      },
    }
    const logger = createLogger({ service: 's', redact })
    logger.info({ password: 'p', ok: 1 }, 'one')
    logger.info({ password: 'p' }, 'two')
    const lines = entries.filter((e) => e.level === 'INFO')
    expect(lines[0]).toEqual({
      time: expect.any(String),
      level: 'INFO',
      message: 'one',
      service: 's',
      password: '[REDACTED]',
      ok: 1,
      redactFailed: 'record() threw Error',
    })
    expect(lines[1]!.redactFailed).toBe('record() threw Error')
    const warnings = entries.filter((e) => e.level === 'WARN')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ redactHook: 'record', redactError: 'record() threw Error' })
    expect(JSON.stringify(entries)).not.toContain('secret')
  })

  it('record() that returns anything but a plain object', () => {
    for (const [result, failure] of [
      [undefined, 'record() returned undefined'],
      [null, 'record() returned null'],
      [[1], 'record() returned an array'],
      [Promise.resolve({}), 'record() returned a Promise'],
      [new Map(), 'record() returned an object that is not plain'],
      ['line', 'record() returned a string'],
    ] as const) {
      _reset()
      const entries = _captureEntries()
      createLogger({ service: 's', redact: { record: () => result as never } }).info({ a: 1 }, 'm')
      expect(entries.find((e) => e.level === 'INFO')).toMatchObject({
        a: 1,
        message: 'm',
        redactFailed: failure,
      })
    }
  })

  it('never throws from a log call, nor loses the line, whatever the hooks throw', () => {
    const entries = _captureEntries()
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap')
        },
      },
    )
    const redact: Redactor = {
      value: () => {
        throw hostile
      },
      record: () => hostile as never,
    }
    expect(() => createLogger({ service: 's', redact }).info({ a: 1 }, 'm')).not.toThrow()
    expect(entries.find((e) => e.level === 'INFO')).toMatchObject({
      level: 'INFO',
      redactFailed: expect.any(String),
    })
  })
})

describe('a redactor that logs', () => {
  beforeEach(() => _reset())

  it('value(): the line it logs holds only time, level, the trace IDs and redactFailed', () => {
    const entries = _captureEntries()
    let logger: Logger | undefined
    const redact: Redactor = {
      value(value, path) {
        logger!.warn({ path: [...path], value }, 'redacting %s', value)
        return path.at(-1) === 'password' ? '[REDACTED]' : value
      },
    }
    logger = createLogger({ service: 's', redact })
    inContext(logger, () => logger!.info({ password: 'p' }, 'm'))
    const nested = entries.filter((e) => e.level === 'WARN')
    expect(nested.length).toBeGreaterThan(0)
    for (const line of nested)
      expect(line).toEqual({
        time: expect.any(String),
        level: 'WARN',
        redactFailed: 'logged from inside redact',
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: expect.any(String),
        parentSpanId: 'b7ad6b7169203331',
      })
    expect(entries.find((e) => e.level === 'INFO')).toMatchObject({ password: '[REDACTED]' })
    expect(JSON.stringify(entries)).not.toContain('"p"')
  })

  it('record(): the same, through another logger with a redactor too', () => {
    const entries = _captureEntries()
    const other = createLogger({ service: 'other', redact: redactKeys(['password']) })
    const logger = createLogger({
      service: 's',
      redact: {
        record(record) {
          other.info({ password: 'p', record }, 'seen')
          return record
        },
      },
    })
    logger.info({ a: 1 }, 'm')
    expect(entries).toEqual([
      { time: expect.any(String), level: 'INFO', redactFailed: 'logged from inside redact' },
      expect.objectContaining({ message: 'm', a: 1 }),
    ])
  })

  it('a logger without redact, logged from inside one, is written in full', () => {
    const entries = _captureEntries()
    const plain = createLogger({ service: 'plain' })
    const logger = createLogger({
      service: 's',
      redact: {
        value(value) {
          plain.debug('never written: below info')
          return value
        },
        record(record) {
          plain.info({ keys: Object.keys(record) }, 'record seen')
          return record
        },
      },
    })
    logger.info({ a: 1 }, 'm')
    expect(entries[0]).toMatchObject({ service: 'plain', message: 'record seen' })
  })
})

describe('what record() is given and returns', () => {
  beforeEach(() => _reset())

  it('the line after value(), as JSON data, without time, level or the trace IDs', () => {
    const entries = _captureEntries()
    let given: Record<string, unknown> | undefined
    const redact: Redactor = {
      ...redactKeys(['password']),
      record(record) {
        given = record
        return { ...record, added: true, level: 'FATAL', traceId: 'forged', time: 'forged' }
      },
    }
    const logger = createLogger({ service: 's', redact })
    runWithLogger({ logger, traceparent: TRACEPARENT }, () =>
      logger.info({ password: 'p', at: new Date(0), err: new Error('e') }, 'm'),
    )
    expect(Object.keys(given!)).toEqual(['message', 'service', 'password', 'at', 'err'])
    expect(given).toMatchObject({ password: '[REDACTED]', at: '1970-01-01T00:00:00.000Z' })
    expect(entries[0]).toMatchObject({
      level: 'INFO',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      added: true,
    })
    expect(entries[0]!.time).not.toBe('forged')
    expect(Object.keys(entries[0]!)).toEqual([
      'time',
      'level',
      'message',
      'service',
      'password',
      'at',
      'err',
      'added',
      'traceId',
      'spanId',
      'parentSpanId',
    ])
  })

  it('what it returns is written by the rules of any value, and is not trusted', () => {
    const entries = _captureEntries()
    const loop: Record<string, unknown> = {}
    loop.self = loop
    const shared = { s: 'x'.repeat(100) }
    createLogger({
      service: 's',
      redact: {
        record: (record) => ({
          ...record,
          big: 1n,
          at: new Date(0),
          loop,
          err: new Error('added'),
          many: Array.from({ length: 10_000 }, () => shared),
        }),
      },
    }).info('m')
    const line = entries[0]!
    expect(line).toMatchObject({
      big: '1',
      at: '1970-01-01T00:00:00.000Z',
      loop: { self: '[Circular]' },
      err: { type: 'Error', message: 'added' },
    })
    // The shared object repeats within the Re-write Budget, then is "[Repeated]".
    expect((line.many as unknown[]).at(-1)).toBe('[Repeated]')
  })
})

describe('redact and the other Logger Options', () => {
  beforeEach(() => _reset())

  it('maxStringLength measures what value() wrote: a hidden long secret is not cut, a long replacement is', () => {
    const entries = _captureEntries()
    createLogger({
      service: 's',
      limits: { maxStringLength: 10 },
      redact: {
        value: (value, path) =>
          path.at(-1) === 'secret' ? '[REDACTED]' : path.at(-1) === 'grow' ? 'y'.repeat(50) : value,
      },
    }).info({ secret: 'x'.repeat(5000), grow: 'g' }, 'm')
    expect(entries[0]).toMatchObject({
      secret: '[REDACTED]',
      grow: `${'y'.repeat(10)}…[truncated from 50 chars]`,
    })
  })

  it('maxStringLength cuts what record() wrote, once', () => {
    const entries = _captureEntries()
    createLogger({
      service: 's',
      limits: { maxStringLength: 4 },
      redact: { record: (record) => ({ ...record, added: 'abcdefgh' }) },
    }).info({ field: 'abcdef' }, 'm')
    expect(entries[0]).toMatchObject({
      field: 'abcd…[truncated from 6 chars]',
      added: 'abcd…[truncated from 8 chars]',
      service: 's',
    })
  })

  it('maxRecordBytes still holds when a redactor grows the line', () => {
    const lines = _captureLines()
    createLogger({
      service: 's',
      limits: { maxRecordBytes: 2048 },
      redact: { value: (value, path) => (path.length === 2 ? 'z'.repeat(10_000) : value) },
    }).info({ a: { b: 1, c: 2, d: 3 } }, 'kept')
    expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(2048)
    expect(JSON.parse(lines[0]!)).toMatchObject({ message: 'kept', service: 's' })
  })

  it('runs after serializeError: it sees and hides what the serializer wrote', () => {
    const entries = _captureEntries()
    const err = Object.assign(new Error('e'), { body: 'large', apiKey: 'k' })
    createLogger({
      service: 's',
      serializeError: (e, d) => ({ ...d(e), headers: { Authorization: 'Bearer x' } }),
      redact: redactKeys(['authorization', 'apiKey']),
    }).error({ err, wrapped: { e: err } }, 'm')
    expect(entries[0]!.err).toMatchObject({
      apiKey: '[REDACTED]',
      headers: { Authorization: '[REDACTED]' },
    })
    expect(JSON.stringify(entries[0])).not.toContain('Bearer')
    expect(JSON.stringify(entries[0])).not.toContain('"k"')
  })

  it('with omitErrorKeys: the keys it leaves out are gone, the ones it keeps are redacted', () => {
    const entries = _captureEntries()
    const err = Object.assign(new Error('e'), { body: 'large', token: 't' })
    createLogger({
      service: 's',
      serializeError: omitErrorKeys(['body']),
      redact: redactKeys(['token', 'omitted']),
    }).error(err, 'm')
    expect(entries[0]!.err).toMatchObject({ token: '[REDACTED]', omitted: '[REDACTED]' })
    expect(entries[0]!.err).not.toHaveProperty('body')
  })

  it('the minimal line of a log call that failed is redacted too', () => {
    const lines: string[] = []
    let calls = 0
    _setSink({
      write(record) {
        if (calls++ === 0) throw new Error('sink broke')
        lines.push(stringifyRecord(record))
      },
    })
    createLogger({ service: 's', redact: redactKeys(['password']) }, { password: 'p' }).info('m')
    expect(JSON.parse(lines[0]!)).toMatchObject({
      logError: 'log call failed: Error: sink broke',
      password: '[REDACTED]',
    })
  })
})

describe('redact on the lines loggercf writes itself', () => {
  beforeEach(() => _reset())

  const redact = redactKeys(['authorization', 'token', 'password'])

  it('Hono request.end, with fields from a hook and the error Hono caught', async () => {
    const entries = _captureEntries()
    const app = new Hono()
    app.use(
      useLogger(createLogger({ service: 'api', redact }), {
        fields: (c) => ({ authorization: c.req.header('authorization') ?? null }),
      }),
    )
    app.get('/boom', () => {
      throw Object.assign(new Error('upstream'), { token: 'err-secret' })
    })
    await app.request('/boom', {
      headers: { authorization: 'Bearer abc', traceparent: TRACEPARENT },
    })
    const end = entries.find((e) => String(e.message).startsWith('request.end'))!
    expect(end).toMatchObject({
      authorization: '[REDACTED]',
      statusCode: 500,
      err: { message: 'upstream', token: '[REDACTED]' },
      traceId: '0af7651916cd43dd8448eb211c80319c',
    })
    expect(JSON.stringify(entries)).not.toContain('Bearer')
    expect(JSON.stringify(entries)).not.toContain('err-secret')
  })

  it('span.end, its Span Fields and its err', async () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 's', redact })
    await runWithLogger({ logger, traceparent: TRACEPARENT }, async () => {
      await withSpan('ok', (span) => span.set({ password: 'p1' }), { fields: { token: 't1' } })
      await withSpan('bad', async () => {
        throw Object.assign(new Error('x'), { token: 't2' })
      }).catch(() => {})
    })
    const ends = entries.filter((e) => String(e.message).startsWith('span.end'))
    expect(ends[0]).toMatchObject({ password: '[REDACTED]', token: '[REDACTED]' })
    expect(ends[1]).toMatchObject({ level: 'ERROR', err: { token: '[REDACTED]' } })
    expect(JSON.stringify(entries)).not.toMatch(/"(p1|t1|t2)"/)
  })

  it('the unsampled <operation> failed line', async () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 's', redact })
    await runWithLogger({ logger, traceparent: UNSAMPLED }, () =>
      withSpan('op', async () => {
        throw Object.assign(new Error('x'), { authorization: 'Bearer abc' })
      }).catch(() => {}),
    )
    expect(entries).toEqual([
      expect.objectContaining({
        message: 'op failed',
        err: expect.objectContaining({ authorization: '[REDACTED]' }),
      }),
    ])
  })
})

describe('the cost of redaction stays bounded', () => {
  beforeEach(() => _reset())

  it('a large record with redactKeys: one pass, in bounded time', () => {
    const lines = _captureLines()
    const logger = createLogger({ service: 's', redact: redactKeys(['password']) })
    const wide: Record<string, unknown> = {}
    // 60,000 values, all written by the walk, as every redacted line is.
    for (let i = 0; i < 20_000; i++) wide[`k${i}`] = { password: 'p', v: i }
    const started = performance.now()
    logger.info({ wide }, 'm')
    const took = performance.now() - started
    expect(took).toBeLessThan(3_000)
    expect(lines[0]).not.toContain('"p"')
    expect(JSON.parse(lines[0]!).wide.k19999).toEqual({ password: '[REDACTED]', v: 19_999 })
  })

  it('a shared graph is still bounded by the Re-write Budget, and so is a redactor that returns one', () => {
    const lines = _captureLines()
    let node: unknown = { password: 'p', leaf: 'x' }
    for (let i = 0; i < 40; i++) node = [node, node] // 2^40 paths
    const big = Array.from({ length: 1_000 }, (_, i) => ({ i, s: 'y'.repeat(50) }))
    const logger = createLogger({
      service: 's',
      redact: { value: (value, path) => (path.at(-1) === 'grow' ? big : value) },
    })
    const started = performance.now()
    logger.info({ node, items: Array.from({ length: 200 }, () => ({ grow: 1 })) }, 'm')
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(lines[0]!.length).toBeLessThan(5_000_000)
    expect(lines[0]).toContain('[Repeated]')
  })
})
