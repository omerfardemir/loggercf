import { describe, it, expect, beforeEach } from 'vitest'
import { createLogger, _captureEntries, _reset } from './logger'

function namedFn() {}
const circular: Record<string, unknown> = { a: 1 }
circular.self = circular

/**
 * `printf` output pinned from pino 10's browser build (`quick-format-unescaped`),
 * recorded before loggercf replaced pino. Every argument here is consumed by a
 * placeholder, so nothing is left over: the message must stay byte-identical.
 * The deliberate differences, where pino printed text that lost the value,
 * are pinned in `UNPRINTED` below.
 */
const PINNED: Array<[template: string, args: unknown[], message: string]> = [
  ['plain', [], 'plain'],
  // `%%` is only collapsed when there are arguments, as with `console.log`.
  ['100%% done', [], '100%% done'],
  ['100%% done %s', ['x'], '100% done x'],
  ['%s', ['str'], 'str'],
  ['%s', [42], '42'],
  ['%s', [null], 'null'],
  ['%s', [undefined], 'undefined'],
  ['%s', [10n], '10'],
  ['%s', [true], 'true'],
  ['%d', [42], '42'],
  ['%d', ['42'], '42'],
  ['%d', [4.5], '4.5'],
  ['%d', [10n], '10'],
  ['%i', [4.9], '4'],
  ['%i', ['-4.9'], '-5'],
  ['%f', [1.5], '1.5'],
  ['%f', ['1.5'], '1.5'],
  ['%j', [{ a: 1 }], '{"a":1}'],
  ['%j', ['s'], "'s'"],
  ['%j', [namedFn], 'namedFn'],
  ['%j', [null], 'null'],
  ['%o', [{ a: [1] }], '{"a":[1]}'],
  ['%O', [{ a: 1 }], '{"a":1}'],
  ['%o', ['s'], "'s'"],
  ['a %s b %d c %j', ['x', 2, { k: 'v' }], 'a x b 2 c {"k":"v"}'],
  ['%s%s', ['a', 'b'], 'ab'],
  ['%s and %s', ['only-one'], 'only-one and %s'],
  ['%% %s', ['x'], '% x'],
  ['%%%s', ['x'], '%x'],
]

/**
 * Values pino printed as text that lost them: an object or an array under
 * `%s %d %i %f` (`[object Object]`, `1,2` or `NaN`), a non-numeric string
 * under `%d` (`NaN`), a circular object under `%j` (`"[Circular]"`). The
 * placeholder stays in the text and the value is routed like a trailing
 * argument.
 */
const UNPRINTED: Array<[template: string, value: unknown, routed: Record<string, unknown>]> = [
  ['n=%d', { a: 1 }, { message: 'n=%d', a: 1 }],
  ['n=%i', { a: 1 }, { message: 'n=%i', a: 1 }],
  ['n=%f', { a: 1 }, { message: 'n=%f', a: 1 }],
  ['n=%s', { a: 1 }, { message: 'n=%s', a: 1 }],
  ['n=%s', [1, 2], { message: 'n=%s', args: [[1, 2]] }],
  ['n=%d', [1, 2], { message: 'n=%d', args: [[1, 2]] }],
  ['GET /a%d0b', { status: 200 }, { message: 'GET /a%d0b', status: 200 }],
  ['n=%d', 'abc', { message: 'n=%d abc' }],
  ['v=%j', circular, { message: 'v=%j', a: 1, self: { a: 1, self: '[Circular]' } }],
]

describe('printf placeholders', () => {
  beforeEach(() => _reset())

  it.each(PINNED)('structured call: %j', (template, args, message) => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info({ k: 1 }, template, ...args)
    expect(entries[0].message).toBe(message)
  })

  it.each(PINNED)('console-style call: %j', (template, args, message) => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info(template, ...args)
    expect(entries[0].message).toBe(message)
  })

  it.each(UNPRINTED)('%j keeps its argument', (template, value, routed) => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info(template, value)
    expect(entries[0]).toMatchObject(routed)
  })

  it('routes an Error under %s to err and keeps printing primitives', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info('%s then %s, %d', new Error('e'), 'x', 3)
    expect(entries[0]).toMatchObject({ message: '%s then x, 3', err: { message: 'e' } })
  })

  it('formats the message after a leading Error', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).error(new Error('e'), 'failed %s after %d tries', 'job', 3)
    expect(entries[0].message).toBe('failed job after 3 tries')
  })
})
