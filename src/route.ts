import {
  functionName,
  functionText,
  inlinePrinter,
  isPlainObject,
  newBudget,
  OPTION_KEYS,
  RECORD_KEYS,
  readEntries,
  TRACE_KEYS,
  unserializable,
  type Budget,
  type LogRecord,
  type RoutedArgs,
} from './output'

/**
 * The Moved Keys: the keys a log call's object arguments cannot set, namely
 * the Record Keys, the Logger Options keys, the trace IDs and `err`. Their
 * values for these keys move to `args` instead, so a call can never
 * overwrite what loggercf writes and nothing is dropped. `err` and `message` are the exceptions while
 * they are unset (see `routeArgs()`): `logger.error({ err }, 'msg')` is how a
 * structured call passes an error.
 */
export const MOVED_KEYS: ReadonlySet<string> = new Set([
  ...RECORD_KEYS,
  ...OPTION_KEYS,
  ...TRACE_KEYS,
  'err',
])

/**
 * Whether `value` is one `console.log('a', 'b', 3)` would print as a word.
 *
 * @param {unknown} value - Any value.
 * @returns {boolean} `true` for a string, number, boolean, `BigInt`, `null` or `undefined`.
 */
function isPrimitive(
  value: unknown,
): value is string | number | boolean | bigint | null | undefined {
  return (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'symbol')
  )
}

/** Sentinel: the placeholder could not render its argument. */
const UNRENDERED = Symbol('unrendered')

/**
 * The number `%d %i %f` print for `value`, or `undefined` when printing it
 * would lose the value: `null`, `undefined`, a symbol, an object, an array
 * or a function (`NaN` or nothing), and a string that is not a number
 * (`'abc'` would print `NaN`). The number `NaN` itself prints as `NaN`.
 *
 * @param {unknown} value - The placeholder's argument.
 * @returns {number | undefined} `Number(value)`, or `undefined`.
 */
function numberFor(value: unknown): number | undefined {
  const type = typeof value
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'bigint')
    return undefined
  const number = Number(value)
  return Number.isNaN(number) && type !== 'number' ? undefined : number
}

/**
 * Render one argument for placeholder `code`. `%s %d %i %f` never render an
 * object or an array (`[object Object]`, `NaN` would hide its fields).
 * `%d %i %f` never render a function or a non-numeric string (`NaN`); `%d`
 * and `%i` write a `BigInt` exactly. `%j %o %O` never render an `Error`
 * (`{}` would hide its stack) or a value `print` cannot print (a
 * `BigInt`, a cycle, a getter that throws...), so it is routed like a
 * trailing argument instead.
 *
 * @param {string} code - The character after `%`.
 * @param {unknown} value - The placeholder's argument.
 * @param {(value: unknown) => string | undefined} print - The message's `inlinePrinter()`.
 * @returns {string | typeof UNRENDERED} The text, or `UNRENDERED` when the placeholder does not print `value`.
 * @throws When `value` cannot be read (a function whose `name` getter throws).
 */
function render(
  code: string,
  value: unknown,
  print: (value: unknown) => string | undefined,
): string | typeof UNRENDERED {
  switch (code) {
    case 'd':
    case 'i':
    case 'f': {
      if (code !== 'f' && typeof value === 'bigint') return String(value)
      const number = numberFor(value)
      if (number === undefined) return UNRENDERED
      return String(code === 'i' ? Math.floor(number) : number)
    }
    case 'j':
    case 'o':
    case 'O':
      if (value === undefined || value instanceof Error) return UNRENDERED
      if (typeof value === 'string') return `'${value}'`
      if (typeof value === 'function') return functionName(value) || functionText(value)
      return print(value) ?? UNRENDERED
    case 's':
      if (typeof value === 'object' && value !== null) return UNRENDERED
      return String(value)
    default:
      return UNRENDERED // not a placeholder (`50% off`, `%c`)
  }
}

/**
 * Format `template` with `printf` placeholders (`%s %d %i %f %j %o %O %%`).
 *
 * Each `%` sequence takes the next argument in order. When it cannot print
 * that argument (`%d` with `null` or `'abc'`, `%j` with `undefined`,
 * `%s %d %i %f` with an object or array, `%d %i %f` with a function,
 * `%j %o %O` with an `Error` or a value JSON cannot write as it is, such as a
 * cycle or a `BigInt`, an unknown sequence such as `% ` or `%c`), the
 * sequence stays in the text and the argument is returned in `unprinted`
 * instead. Never throws. `%%` becomes `%` only when there are
 * arguments, like `console.log`. `%j`, `%o` and `%O` spend from the line's
 * re-write budget, all of them together.
 *
 * @param {string} template - The message template.
 * @param {readonly unknown[]} args - The arguments after the template.
 * @param {Budget} [budget] - The line's re-write budget.
 * @returns {{ message: string, unprinted: unknown[] }} The formatted message, and every argument it did not print, in call order.
 */
export function formatMessage(
  template: string,
  args: readonly unknown[],
  budget: Budget = newBudget(),
): { message: string; unprinted: unknown[] } {
  if (args.length === 0 || !template.includes('%'))
    return { message: template, unprinted: [...args] }

  let printer: ((value: unknown) => string | undefined) | undefined
  const print = (value: unknown) => (printer ??= inlinePrinter(budget))(value)
  const unprinted: unknown[] = []
  let message = ''
  let last = 0
  let next = 0
  for (let i = 0; i < template.length - 1; i++) {
    if (template[i] !== '%') continue
    const code = template[i + 1]
    if (code === '%') {
      message += template.slice(last, i) + '%'
      last = i + 2
      i++
      continue
    }
    if (next >= args.length) continue
    const value = args[next++]
    let text: string | typeof UNRENDERED
    try {
      text = render(code, value, print)
    } catch {
      text = UNRENDERED // e.g. `%s` with a function whose toString throws
    }
    if (text === UNRENDERED) {
      unprinted.push(value)
      continue
    }
    message += template.slice(last, i) + text
    last = i + 2
    i++
  }
  message += template.slice(last)
  unprinted.push(...args.slice(next))
  return { message, unprinted }
}

/**
 * Route the arguments of one log call to their place in the record, so that
 * no argument is ever dropped. Pure: never mutates its input.
 *
 * 1. Leading argument: a `string` is the message template. An `Error` becomes
 *    `err`, and the message defaults to `err.message`. A plain object is
 *    merged (see below). An `undefined` or `null` followed by a `string`
 *    (an `Error | undefined` that is unset) writes nothing, and the string is
 *    the template. Any other primitive, `undefined` and `null` included, goes
 *    to `args` and is the message as `String(value)`; the arguments after it
 *    are routed as usual (step 3), so `[undefined, { a: 1 }]` merges `a` and
 *    `[null, 42]` is the message `null 42`. Anything else (array,
 *    class instance...) goes to `args`. After an `Error`, a plain object, an
 *    array or a class instance, a `string` second argument is the template,
 *    and an `undefined` or `null` one goes to `args`.
 * 2. `printf` placeholders in the template take arguments in order
 *    (see `formatMessage()`).
 * 3. Every remaining argument, in order: the first `Error` becomes `err` if
 *    unset, later ones go to `errors`. A plain object is merged. A primitive
 *    is appended to the message after a space. Anything else (arrays, class
 *    instances, functions, symbols) goes to `args`.
 *
 * Merging a plain object, leading or not: its keys go to the top level, later
 * objects winning. `err` is set only when still unset. The other
 * `MOVED_KEYS`, an `err` that is already set, an own `__proto__` key (from
 * `JSON.parse`) and a function-valued `toJSON` (as text, so it cannot replace
 * the line) move to `args` as one object per argument, so a call can never
 * overwrite what loggercf writes.
 * The exception is `message`: when the call gives no other message, the first
 * object's string `message` becomes the message (`logger.info({ message })`).
 *
 * Never throws: a property whose getter throws is merged as
 * `unserializable()`, and an argument that cannot be inspected at all (a
 * `Proxy` whose traps throw) goes to `args` as `unserializable()`. Pure but
 * for `budget`, which the placeholders spend from.
 *
 * @param {readonly unknown[]} input - The arguments the log method received.
 * @param {Budget} [budget] - The line's re-write budget.
 * @returns {RoutedArgs} Where each argument goes.
 */
export function routeArgs(input: readonly unknown[], budget: Budget = newBudget()): RoutedArgs {
  // No prototype: an `err` or `__proto__` key can only ever be an own key.
  const fields: LogRecord = Object.create(null)
  const errors: Error[] = []
  const overflow: unknown[] = []
  const words: string[] = []
  let message: string | undefined
  let template: string | undefined
  let remaining = input.slice(1)

  if (input.length === 0) return { fields }

  /** An object's string `message`, used only if the call ends up with no other message. */
  let objectMessage: { value: string; holder: Record<string, unknown> } | undefined

  /** Set `err` if it is still unset. Returns whether it was set. */
  const setErr = (value: unknown) => {
    if (fields.err !== undefined) return false
    fields.err = value
    return true
  }
  const merge = (object: Record<string, unknown>) => {
    let moved: Record<string, unknown> | undefined
    for (const [key, value] of readEntries(object)) {
      if (key === 'err' && setErr(value)) continue
      const isToJSON = key === 'toJSON' && typeof value === 'function'
      if (!MOVED_KEYS.has(key) && key !== '__proto__' && !isToJSON) {
        fields[key] = value
        continue
      }
      moved ??= Object.create(null) as Record<string, unknown>
      moved[key] = isToJSON ? functionText(value) : value
      if (key === 'message' && typeof value === 'string') objectMessage ??= { value, holder: moved }
    }
    if (moved) overflow.push(moved)
  }
  /** After a leading value that is not a message: a string is the template, `undefined` / `null` goes to `args`. */
  const takeTemplate = () => {
    if (typeof remaining[0] === 'string') template = remaining.shift() as string
    else if (remaining.length > 0 && remaining[0] == null) overflow.push(remaining.shift())
  }

  const first = input[0]
  try {
    if (typeof first === 'string') {
      template = first
    } else if (first instanceof Error) {
      setErr(first)
      takeTemplate()
      if (template === undefined) {
        try {
          message = first.message
        } catch (thrown) {
          message = unserializable(thrown)
        }
      }
    } else if (isPlainObject(first)) {
      merge(first)
      takeTemplate()
    } else if (first == null && typeof remaining[0] === 'string') {
      // An `Error | undefined` that is unset, then the message: nothing to write for it.
      template = remaining.shift() as string
    } else if (isPrimitive(first)) {
      overflow.push(first)
      message = String(first)
    } else {
      overflow.push(first)
      takeTemplate()
    }
  } catch (thrown) {
    // Only a `Proxy` can throw here, before anything was routed.
    overflow.push(unserializable(thrown))
    takeTemplate()
  }

  if (template !== undefined) {
    const formatted = formatMessage(template, remaining, budget)
    message = formatted.message
    remaining = formatted.unprinted
  }

  for (const value of remaining) {
    try {
      if (value instanceof Error) {
        if (!setErr(value)) errors.push(value)
      } else if (isPlainObject(value)) {
        merge(value)
      } else if (isPrimitive(value)) {
        words.push(String(value))
      } else {
        overflow.push(value)
      }
    } catch (thrown) {
      overflow.push(unserializable(thrown)) // a `Proxy`, before anything was routed
    }
  }

  if (words.length > 0)
    message = message === undefined ? words.join(' ') : [message, ...words].join(' ')

  if (message === undefined && objectMessage) {
    const { value, holder } = objectMessage
    message = value
    delete holder.message
    if (Object.keys(holder).length === 0) overflow.splice(overflow.indexOf(holder), 1)
  }

  const routed: RoutedArgs = { fields }
  if (message !== undefined) routed.message = message
  if (errors.length > 0) routed.errors = errors
  if (overflow.length > 0) routed.args = overflow
  return routed
}
