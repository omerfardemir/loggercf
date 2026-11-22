import { describe, it, expect, beforeEach, expectTypeOf } from 'vitest'
import { adaptLogger, type LineTarget, type LogLine } from './adapt'
import {
  currentContextFields,
  getLogger,
  runWithLogger,
  setLoggerContext,
  withSpan,
  _captureEntries,
  _reset,
} from './logger'
import * as core from './index'
import type { Logger } from './types'

/** A target that keeps every line it is given. */
function recordingTarget(): LineTarget & { lines: LogLine[] } {
  const lines: LogLine[] = []
  return { lines, write: (line) => void lines.push(line) }
}

describe('adaptLogger', () => {
  beforeEach(() => {
    _reset()
    _captureEntries()
  })

  it('is exported from the package entry', () => {
    expect(core.adaptLogger).toBe(adaptLogger)
  })

  it('is a Logger', () => {
    expectTypeOf(adaptLogger(recordingTarget())).toEqualTypeOf<Logger>()
  })

  it('writes one line per call, at the level called', () => {
    const target = recordingTarget()
    const logger = adaptLogger(target)
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      logger[level]('hello')
    }
    expect(target.lines.map((l) => l.level)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ])
    expect(target.lines.every((l) => l.message === 'hello')).toBe(true)
  })

  it('routes a structured call: fields, then a printf message', () => {
    const target = recordingTarget()
    adaptLogger(target).info({ userId: 42 }, 'user %s signed in', 'ada')
    expect(target.lines).toEqual([
      { level: 'info', message: 'user ada signed in', fields: { userId: 42 } },
    ])
  })

  it('routes a console-style call: the message, then fields', () => {
    const target = recordingTarget()
    adaptLogger(target).warn('slow', { ms: 900 })
    expect(target.lines).toEqual([{ level: 'warn', message: 'slow', fields: { ms: 900 } }])
  })

  it('keeps an Error as it is, under err, with its message as the message', () => {
    const target = recordingTarget()
    const err = new TypeError('boom')
    adaptLogger(target).error(err)
    expect(target.lines[0]!.message).toBe('boom')
    expect(target.lines[0]!.fields.err).toBe(err)
  })

  it('puts a second Error in errors, and values with no better place in args', () => {
    const target = recordingTarget()
    const first = new Error('one')
    const second = new Error('two')
    adaptLogger(target).error('failed', first, second, [1, 2])
    expect(target.lines[0]!.fields).toEqual({ err: first, errors: [second], args: [[1, 2]] })
  })

  it('leaves message out when the call gives none', () => {
    const target = recordingTarget()
    adaptLogger(target).info({ a: 1 })
    expect(target.lines[0]).toEqual({ level: 'info', fields: { a: 1 } })
    expect(target.lines[0]).not.toHaveProperty('message')
  })

  it('moves a key a call cannot set to args, as Argument Routing does', () => {
    const target = recordingTarget()
    adaptLogger(target).info({ level: 'fatal', a: 1 }, 'm')
    expect(target.lines[0]).toEqual({
      level: 'info',
      message: 'm',
      fields: { a: 1, args: [{ level: 'fatal' }] },
    })
  })

  it('gives the target plain objects', () => {
    const target = recordingTarget()
    adaptLogger(target).child({ b: 1 }).info({ a: 1 }, 'm')
    expect(Object.getPrototypeOf(target.lines[0]!.fields)).toBe(Object.prototype)
  })

  describe('child', () => {
    it('without target.child, writes the bindings before the call fields, which win', () => {
      const target = recordingTarget()
      adaptLogger(target).child({ a: 1, shared: 'binding' }).info({ shared: 'call', b: 2 }, 'm')
      expect(target.lines[0]!.fields).toEqual({ a: 1, shared: 'call', b: 2 })
      expect(Object.keys(target.lines[0]!.fields)).toEqual(['a', 'shared', 'b'])
    })

    it('moves a binding for a Record Key to args, as the built-in logger does', () => {
      const target = recordingTarget()
      adaptLogger(target).child({ args: 'x', level: 'fatal', a: 1 }).info('m', [2])
      expect(target.lines[0]!.fields).toEqual({
        a: 1,
        args: [{ level: 'fatal', args: 'x' }, [2]],
      })
    })

    it('merges the bindings of nested children, the nearest winning', () => {
      const target = recordingTarget()
      adaptLogger(target).child({ a: 1, b: 1 }).child({ b: 2 }).info('m')
      expect(target.lines[0]!.fields).toEqual({ a: 1, b: 2 })
    })

    it('reads the bindings once, when the child is made', () => {
      const target = recordingTarget()
      const bindings = { a: 1 }
      const child = adaptLogger(target).child(bindings)
      bindings.a = 2
      child.info('m')
      expect(target.lines[0]!.fields).toEqual({ a: 1 })
    })

    it('leaves the parent unchanged', () => {
      const target = recordingTarget()
      const parent = adaptLogger(target)
      parent.child({ a: 1 })
      parent.info('m')
      expect(target.lines[0]!.fields).toEqual({})
    })

    it("with target.child, hands the bindings to the target's child and writes through it", () => {
      const root = recordingTarget()
      const childTarget = recordingTarget()
      const given: Record<string, unknown>[] = []
      const logger = adaptLogger({
        ...root,
        child(bindings) {
          given.push(bindings)
          return childTarget
        },
      })
      logger.child({ a: 1 }).info({ b: 2 }, 'm')
      expect(given).toEqual([{ a: 1 }])
      expect(root.lines).toEqual([])
      expect(childTarget.lines).toEqual([{ level: 'info', message: 'm', fields: { b: 2 } }])
    })

    it("when target.child throws, writes the bindings itself, through the parent's target", () => {
      const target = recordingTarget()
      const logger = adaptLogger({
        ...target,
        child: () => {
          throw new Error('no child')
        },
      })
      logger.child({ a: 1 }).info('m')
      expect(target.lines[0]!.fields).toEqual({ a: 1 })
    })
  })

  it('a log call never throws, whatever the target does', () => {
    const logger = adaptLogger({
      write: () => {
        throw new Error('target broke')
      },
    })
    expect(() => logger.info('m')).not.toThrow()
  })

  describe('as a Root Logger', () => {
    it("carries loggercf's own lines: a Span's span.end", () => {
      const target = recordingTarget()
      runWithLogger({ logger: adaptLogger(target) }, () => {
        withSpan('db.query', () => 1, { fields: { table: 'users' } })
      })
      expect(target.lines).toHaveLength(1)
      expect(target.lines[0]).toMatchObject({
        level: 'info',
        message: 'span.end db.query',
        fields: { span: { operation: 'db.query', status: 'OK' }, table: 'users' },
      })
    })

    it("and a failed Span's line, with the thrown value under err", () => {
      const target = recordingTarget()
      const err = new Error('down')
      runWithLogger({ logger: adaptLogger(target) }, () => {
        expect(() =>
          withSpan('db.query', () => {
            throw err
          }),
        ).toThrow(err)
      })
      expect(target.lines[0]).toMatchObject({ level: 'error', message: 'span.end db.query' })
      expect(target.lines[0]!.fields.err).toBe(err)
    })

    it('getLogger() inside the Logging Context writes through it; a write may add currentContextFields()', () => {
      const lines: LogLine[] = []
      const logger = adaptLogger({
        write: (line) =>
          void lines.push({ ...line, fields: { ...currentContextFields(), ...line.fields } }),
      })
      runWithLogger({ logger, fields: { requestId: 'r-1' } }, () => {
        setLoggerContext({ userId: 7 })
        getLogger().info({ a: 1 }, 'inside')
      })
      expect(lines[0]).toMatchObject({
        message: 'inside',
        fields: { requestId: 'r-1', userId: 7, a: 1, traceId: expect.any(String) },
      })
    })
  })
})
