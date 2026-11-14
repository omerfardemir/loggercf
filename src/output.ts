import type { LogFields, TraceContext } from './types'

/**
 * A finished log line, before serialization.
 */
export type LogRecord = Record<string, unknown>

/**
 * Where finished log records go. One adapter per runtime, plus an in-memory
 * one for tests. Internal: not part of the package interface.
 */
export interface Sink {
  write(record: LogRecord): void
}

/**
 * The parts of a Logging Context that appear on every log line.
 */
export interface RecordContext {
  trace: TraceContext
  fields: LogFields
}

/**
 * Whether `value` is a plain object literal (`{}`, `Object.create(null)`),
 * as opposed to an array, a class instance, a `Date`, a `Map`...
 *
 * @param {unknown} value - Any value.
 * @returns {boolean} `true` when its prototype is `Object.prototype` or `null`.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A function's `name`, or `''` when it has none or it is not a string.
 *
 * @param {{ name: unknown }} fn - The function.
 * @returns {string} Its name.
 * @throws When `name` cannot be read (a getter that throws, a revoked `Proxy`).
 */
export function functionName(fn: { name: unknown }): string {
  const name = fn.name
  return typeof name === 'string' ? name : ''
}

/**
 * How a function appears in a log line: `[Function: name]`, or
 * `[Function: anonymous]` when it has no name. Never throws: a function
 * whose `name` cannot be read is `unserializable()`.
 *
 * @param {{ name: unknown }} fn - The function.
 * @returns {string} Its text.
 */
export function functionText(fn: { name: unknown }): string {
  let name: string
  try {
    name = functionName(fn)
  } catch (thrown) {
    return unserializable(thrown)
  }
  return `[Function: ${name || 'anonymous'}]`
}

/**
 * Describe a thrown value, never throwing itself.
 *
 * @param {unknown} thrown - What a getter, a `toJSON` or the write path threw.
 * @returns {string} e.g. `TypeError: toJSON failed`, or `String(thrown)` for a non-Error.
 */
export function describeFailure(thrown: unknown): string {
  try {
    if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`
    return String(thrown)
  } catch {
    return 'unknown error'
  }
}

/**
 * What a value that cannot be read or serialized (a getter or a `toJSON`
 * that throws) is written as, in place of that one value.
 *
 * @param {unknown} thrown - What reading or serializing the value threw.
 * @returns {string} `[Unserializable: <reason>]`.
 */
export function unserializable(thrown: unknown): string {
  return `[Unserializable: ${describeFailure(thrown)}]`
}

/**
 * `object`'s own enumerable string-keyed entries, like `Object.entries()`,
 * except that a value whose getter throws is `unserializable()` instead.
 *
 * @param {object} object - Any object.
 * @returns {[string, unknown][]} Its entries, in key order.
 * @throws Only when its keys cannot be listed (a `Proxy` whose `ownKeys` trap throws).
 */
export function readEntries(object: object): [string, unknown][] {
  const entries: [string, unknown][] = []
  for (const key of Object.keys(object)) {
    let value: unknown
    try {
      value = (object as Record<string, unknown>)[key]
    } catch (thrown) {
      value = unserializable(thrown)
    }
    entries.push([key, value])
  }
  return entries
}

/**
 * A plain copy of logger bindings, never throwing: a binding whose getter
 * throws is `unserializable()`. Taken when the logger is built, so a log
 * call never runs the getters.
 *
 * @param {unknown} source - The bindings passed to `createLogger` or `.child()`.
 * @returns {LogRecord} The copy; `{}` for `undefined`, `null` or a primitive.
 */
export function copyBindings(source: unknown): LogRecord {
  if (typeof source !== 'object' || source === null) return {}
  try {
    return Object.fromEntries(readEntries(source))
  } catch (thrown) {
    // The keys cannot be listed. `buildRecord()` moves `args` to the line's `args`.
    return { args: unserializable(thrown) }
  }
}

/**
 * Whether `value` is an `Error`, never throwing: `instanceof` throws on a
 * revoked `Proxy`, or one whose `getPrototypeOf` trap throws.
 *
 * @param {unknown} value - Any value.
 * @returns {boolean} `true` for an `Error`; `false` for anything else, or when it can't be told.
 */
export function isError(value: unknown): value is Error {
  try {
    return value instanceof Error
  } catch {
    return false // the serializer writes it as `unserializable()`
  }
}

/** How many levels of `cause` (and of `Error`-valued properties) are serialized before the chain is cut off. */
const MAX_CAUSE_DEPTH = 5

/**
 * Read one property of an `Error`, never throwing.
 *
 * @param {() => unknown} get - Reads the property.
 * @returns {unknown} Its value, or `unserializable()` when the read throws.
 */
function read(get: () => unknown): unknown {
  try {
    return get()
  } catch (thrown) {
    return unserializable(thrown)
  }
}

/**
 * Whether `error` is an `AggregateError`, never throwing.
 *
 * @param {Error} error - An `Error`.
 * @returns {boolean} `true` for an `AggregateError`.
 */
function isAggregateError(error: Error): error is AggregateError {
  try {
    return typeof AggregateError === 'function' && error instanceof AggregateError
  } catch {
    return false
  }
}

/**
 * The Errors one line has already serialized, by nesting depth. A repeated
 * reference to an `Error` at the same depth is the same serialized object,
 * so `stringifyRecord()` sees a repeat and its re-write budget applies. By
 * depth, so a copy built deep (its chain cut off sooner) is never reused
 * higher up, and `MAX_CAUSE_DEPTH` still bounds the nesting.
 */
export type SerializedErrors = Map<Error, LogRecord>[]

/**
 * Serialize an `Error` into a plain, JSON-safe object. Never throws.
 *
 * Shape: `{ type, message, stack, ...own enumerable props, errors?, cause? }`.
 * `cause`, every own property that is an `Error`, and an `AggregateError`'s
 * `errors` have the same shape, nested up to `MAX_CAUSE_DEPTH` levels. An
 * `Error` nested inside itself (`e.self = e`, a `cause` loop) is
 * `"[Circular]"` there. A property whose getter throws is `unserializable()`.
 * Each `Error` is serialized once per `cache` and depth, so a graph of Errors
 * costs its size, not the number of paths through it.
 *
 * @param {Error} error - The error to serialize.
 * @param {number} [depth] - Current nesting depth.
 * @param {Set<Error>} [ancestors] - The errors `error` is nested in.
 * @param {SerializedErrors} [cache] - The Errors this line has already serialized.
 * @returns {LogRecord} The serialized error.
 */
export function serializeError(
  error: Error,
  depth = 0,
  ancestors: Set<Error> = new Set(),
  cache: SerializedErrors = [],
): LogRecord {
  const known = cache[depth]?.get(error)
  if (known) return known
  const out: LogRecord = {}
  ;(cache[depth] ??= new Map()).set(error, out)

  const nested = (value: unknown): unknown => {
    if (!isError(value)) return value
    if (ancestors.has(value)) return '[Circular]' // before the cache: a cycle is never a repeat
    if (depth >= MAX_CAUSE_DEPTH)
      return { type: 'Truncated', message: `cause chain deeper than ${MAX_CAUSE_DEPTH}` }
    return serializeError(value, depth + 1, ancestors, cache)
  }
  ancestors.add(error)
  try {
    out.type = read(() => error.constructor?.name || error.name)
    out.message = read(() => error.message)
    out.stack = read(() => error.stack)
    let entries: [string, unknown][]
    try {
      entries = readEntries(error)
    } catch (thrown) {
      entries = [['props', unserializable(thrown)]]
    }
    for (const [key, value] of entries) {
      if (key in out || key === 'cause') continue
      out[key] = nested(value)
    }
    // Not enumerable, so not among the entries.
    if (!('errors' in out) && isAggregateError(error))
      out.errors = read(() => {
        const list: unknown = error.errors
        return Array.isArray(list) ? Array.from(list, nested) : list
      })
    const cause = read(() => error.cause)
    if (cause !== undefined) out.cause = nested(cause)
    return out
  } finally {
    ancestors.delete(error)
  }
}

/**
 * Serialize `value` when it is an `Error`. Never throws.
 *
 * @param {unknown} value - Any value.
 * @param {SerializedErrors} cache - The Errors this line has already serialized.
 * @returns {unknown} `serializeError(value)` for an `Error`; anything else as is.
 */
const serializeIfError = (value: unknown, cache: SerializedErrors): unknown =>
  isError(value) ? serializeError(value, 0, new Set(), cache) : value

/**
 * `serializeIfError` on an overflow value and, one level down, on its items
 * or values. Never throws: an item that can't be inspected (a `Proxy` whose
 * traps throw) is `unserializable()`, and so is an item whose getter throws.
 *
 * @param {unknown} value - One item of `args`.
 * @param {SerializedErrors} cache - The Errors this line has already serialized.
 * @returns {unknown} The item, with Errors serialized at its top level and one level down.
 */
function serializeOverflowItem(value: unknown, cache: SerializedErrors): unknown {
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = []
      const length = value.length
      for (let i = 0; i < length; i++)
        out.push(
          serializeIfError(
            read(() => value[i]),
            cache,
          ),
        )
      return out
    }
    if (isPlainObject(value)) {
      const out: LogRecord = Object.create(null) // `value` may have an own `__proto__` key
      for (const [key, v] of readEntries(value)) out[key] = serializeIfError(v, cache)
      return out
    }
  } catch (thrown) {
    return unserializable(thrown)
  }
  return serializeIfError(value, cache)
}

/**
 * The Record Keys: loggercf writes them for every call, so logger bindings
 * and Context Fields cannot set them. `workersSink` picks the console method
 * from `level`, so a binding for it would change the line's severity.
 */
export const RECORD_KEYS = ['time', 'level', 'message', 'errors', 'args'] as const

/** The Trace Context's keys, which `applyTrace()` writes inside a Logging Context. */
export const TRACE_KEYS = ['traceId', 'spanId', 'parentSpanId'] as const

/** The Logger Options keys a Root Logger writes on every line. */
export const OPTION_KEYS = ['service', 'environment', 'version'] as const

/**
 * `source` without the Record Keys (`RECORD_KEYS`). Their defined values are pushed onto
 * `moved` as one object, so they land in `args` instead of being dropped.
 *
 * @param {LogRecord | undefined} source - Logger bindings or Context Fields. Never mutated.
 * @param {LogRecord[]} moved - Collects the values taken out, one object per source.
 * @returns {LogRecord | undefined} `source` itself when it has none of the keys, else a copy without them.
 */
export function takeRecordKeys(
  source: LogRecord | undefined,
  moved: LogRecord[],
): LogRecord | undefined {
  if (!source || !RECORD_KEYS.some((key) => Object.hasOwn(source, key))) return source
  const rest: LogRecord = { ...source }
  const taken: LogRecord = {}
  for (const key of RECORD_KEYS) {
    if (rest[key] !== undefined) taken[key] = rest[key]
    delete rest[key]
  }
  if (Object.keys(taken).length > 0) moved.push(taken)
  return rest
}

/**
 * Set the trace IDs on `record`, replacing any value already there. A
 * `parentSpanId` is removed on a root trace. Keys already in `record` keep
 * their position.
 *
 * @param {LogRecord} record - The line to stamp. Mutated.
 * @param {TraceContext} trace - The current Trace Context.
 */
export function applyTrace(record: LogRecord, trace: TraceContext): void {
  for (const key of TRACE_KEYS) {
    if (trace[key]) record[key] = trace[key]
    else delete record[key]
  }
}

/**
 * Where `routeArgs()` put the arguments of one log call. Nothing is
 * serialized yet: `buildRecord()` does that, so routed values go through the
 * same serializers as structured fields.
 */
export interface RoutedArgs {
  /** Top-level fields: `err` and the object arguments' keys, in call order. Routing has already moved their `MOVED_KEYS` to `args`. */
  fields: LogRecord
  /** The formatted message, when the call gave one. */
  message?: string
  /** Errors after the first, in call order. */
  errors?: Error[]
  /** Values with no better place (the Overflow), in call order. */
  args?: unknown[]
}

/**
 * One log call, ready to build: what the logger adds (`time`, `level`,
 * logger bindings) and where `routeArgs()` put the arguments.
 */
export interface RecordEntry extends RoutedArgs {
  /** ISO 8601 time of the call. */
  time: string
  /** The upper-case level label. */
  level: string
  /** The logger bindings (`createLogger` / `.child()`). */
  bindings: LogRecord
  /** The line's re-write budget, which the message's placeholders may have spent from. */
  budget?: Budget
}

/**
 * Build the final log record from a log call's entry and the current Logging Context.
 *
 * The Record Keys (`RECORD_KEYS`) and the trace IDs are always written by
 * loggercf. For the other keys, strongest first: fields passed at the log
 * call → logger bindings (`createLogger` / `.child()`) → Context Fields.
 * A binding or Context Field for one of the Record Keys (trace IDs
 * aside) moves to `args`, after the call's own `args`, bindings first, so it
 * is not dropped. `Error` values are serialized with `serializeError()`: at
 * the top level, in `errors`, and in `args` items (one level down, e.g.
 * `args: [{ err }]`), each `Error` once per line. Never mutates `entry`'s
 * values. `stringifyRecord()` of the result spends from `entry.budget`.
 *
 * @param {RecordEntry} entry - The call: time, level, bindings and the routed arguments.
 * @param {RecordContext} [context] - The current Logging Context, if any.
 * @returns {LogRecord} The record to hand to a `Sink`.
 */
export function buildRecord(entry: RecordEntry, context?: RecordContext): LogRecord {
  const moved: LogRecord[] = []
  const bindings = takeRecordKeys(entry.bindings, moved)
  const contextFields = takeRecordKeys(context?.fields, moved)
  const record: LogRecord = {
    time: entry.time,
    level: entry.level,
    ...contextFields,
    ...bindings,
    ...entry.fields,
  }
  if (entry.message !== undefined) record.message = entry.message
  if (entry.errors) record.errors = entry.errors
  const args = [...(entry.args ?? []), ...moved]
  if (args.length > 0) record.args = args

  const cache: SerializedErrors = []
  for (const [key, value] of Object.entries(record)) record[key] = serializeIfError(value, cache)
  if (Array.isArray(record.errors))
    record.errors = record.errors.map((error) => serializeIfError(error, cache))
  if (Array.isArray(record.args))
    record.args = record.args.map((item) => serializeOverflowItem(item, cache))

  if (context) applyTrace(record, context.trace)
  const { budget } = entry
  if (budget && (budget.values < MAX_REWRITTEN_VALUES || budget.chars < MAX_REWRITTEN_CHARS))
    lineBudgets.set(record, budget) // only when the message spent some of it
  return record
}

/**
 * How many values one line may write again inside repeats (objects it has
 * already written, a shared reference), before a repeat is `"[Repeated]"`.
 * Every value inside a repeat counts, at any depth, so the work and the line
 * stay bounded however wide or deeply shared the structure is.
 */
const MAX_REWRITTEN_VALUES = 10_000

/**
 * How many characters of keys and strings one line may write again inside
 * repeats, before a repeat is `"[Repeated]"`: a shared object holding a long
 * string costs its length, not one value. A long string (see `LONG_STRING`)
 * written again outside a repeat costs its length too.
 */
const MAX_REWRITTEN_CHARS = 64 * 1024

/**
 * From this length on, a string the line has already written is a repeat,
 * like a shared object: written again while it fits `MAX_REWRITTEN_CHARS`,
 * then `"[Repeated]"`. Shorter strings repeat freely.
 */
const LONG_STRING = 1024

/**
 * What one line may still write again inside repeats. One per line, shared
 * by its message's `%j` / `%o` / `%O` placeholders and the walk of its record.
 */
export interface Budget {
  /** Values left (see `MAX_REWRITTEN_VALUES`). */
  values: number
  /** Characters left (see `MAX_REWRITTEN_CHARS`). */
  chars: number
}

/**
 * A full budget, for one new line.
 *
 * @returns {Budget} The budget.
 */
export const newBudget = (): Budget => ({
  values: MAX_REWRITTEN_VALUES,
  chars: MAX_REWRITTEN_CHARS,
})

/** The budget each record from `buildRecord()` is written with, when its entry had one. */
const lineBudgets = new WeakMap<LogRecord, Budget>()

/** What the walks before this one wrote on the same line: `%j` placeholders earlier in the message. */
interface Written {
  /** The objects they wrote, outside repeats. */
  objects: WeakSet<object>
  /** The long strings they wrote, outside repeats. */
  strings: Set<string>
}

/** Thrown by a strict walk: the value cannot be written as JSON as it is. */
const NOT_JSON = new Error('not JSON')

/** Thrown inside a repeat when the line's re-write budget runs out. */
const BUDGET_SPENT = new Error('re-write budget spent')

/** The state of one `toJSONValue()` walk. */
interface Walk {
  /** `%j`: give up (throw `NOT_JSON`) wherever a lenient walk would write a stand-in. */
  strict: boolean
  /** The objects on the path to the current value: a real cycle. */
  ancestors: Set<object>
  /** Every object this walk wrote so far, outside repeats: a repeat. */
  seen: Set<object>
  /** Every long string this walk wrote so far, outside repeats. */
  strings: Set<string>
  /** What earlier walks of the same line wrote, which are repeats too. */
  earlier?: Written
  /** How many repeats the current value is nested in. */
  inRepeat: number
  /** The line's re-write budget. */
  budget: Budget
}

/**
 * Charge the walk's re-write budget for one value inside a repeat.
 *
 * @param {Walk} walk - The current walk, inside a repeat.
 * @param {string} key - The value's key in its parent.
 * @param {unknown} value - The value.
 * @throws `BUDGET_SPENT` when the budget runs out.
 */
function charge(walk: Walk, key: string, value: unknown): void {
  walk.budget.values--
  walk.budget.chars -= key.length + (typeof value === 'string' ? value.length : 0)
  if (walk.budget.values < 0 || walk.budget.chars < 0) throw BUDGET_SPENT
}

/**
 * Write a repeat, an object the line has already written, again, within the
 * re-write budget. A repeat is written in full or, once the budget is spent,
 * is `"[Repeated]"` as a whole: never cut part way.
 *
 * @param {() => unknown} write - Writes the repeated object (or its `toJSON` result).
 * @param {Walk} walk - The current walk.
 * @returns {unknown} Its JSON-ready value, or `"[Repeated]"`.
 * @throws `NOT_JSON` in a strict walk, instead of `"[Repeated]"`.
 */
function repeatToJSONValue(write: () => unknown, walk: Walk): unknown {
  if (walk.inRepeat > 0) return write() // the outer repeat is charged
  if (walk.budget.values <= 0 || walk.budget.chars <= 0) return standIn(walk, '[Repeated]')
  walk.inRepeat++
  try {
    return write()
  } catch (thrown) {
    if (thrown !== BUDGET_SPENT) throw thrown
    walk.budget.values = 0
    return standIn(walk, '[Repeated]')
  } finally {
    walk.inRepeat--
  }
}

/**
 * Whether the line has already written `object`, outside repeats.
 *
 * @param {object} object - Any object.
 * @param {Walk} walk - The current walk.
 * @returns {boolean} `true` for a repeat.
 */
const isRepeat = (object: object, walk: Walk): boolean =>
  walk.seen.has(object) || walk.earlier?.objects.has(object) === true

/**
 * A string, outside repeats: a long one the line has already written is a
 * repeat, written again while its length fits the budget.
 *
 * @param {string} value - The string.
 * @param {Walk} walk - The current walk, outside repeats.
 * @returns {string} `value`, or `"[Repeated]"`.
 * @throws `NOT_JSON` in a strict walk, instead of `"[Repeated]"`.
 */
function stringToJSONValue(value: string, walk: Walk): string {
  if (value.length < LONG_STRING) return value
  if (!walk.strings.has(value) && !walk.earlier?.strings.has(value)) {
    walk.strings.add(value)
    return value
  }
  if (value.length > walk.budget.chars) return standIn(walk, '[Repeated]')
  walk.budget.chars -= value.length
  return value
}

/**
 * The text a lenient walk writes for a value JSON cannot write as is.
 *
 * @param {Walk} walk - The current walk.
 * @param {string} text - The stand-in.
 * @returns {string} `text`.
 * @throws `NOT_JSON` in a strict walk.
 */
function standIn(walk: Walk, text: string): string {
  if (walk.strict) throw NOT_JSON
  return text
}

/**
 * `value` as JSON-ready data (plain objects, arrays, strings, numbers,
 * booleans, `null`), so `JSON.stringify` of the result never throws. It
 * follows `JSON.stringify`: `toJSON` is called, own enumerable string keys
 * are written, `undefined` is left out of objects and `null` in arrays, boxed
 * primitives are unwrapped. Beyond JSON: a `Map` is an array of
 * `[key, value]` pairs, a `Set` an array; a `BigInt` is its digits, a
 * function `[Function: name]`, a symbol `Symbol(description)` (boxed or
 * not); a real cycle is `"[Circular]"` (a `toJSON` result that refers back to
 * its object included); a repeated object (one with a `toJSON` included), or
 * a repeated long string, is written again within a budget per line (see `MAX_REWRITTEN_VALUES`), then
 * is `"[Repeated]"`; a getter or a `toJSON` that throws is `unserializable()`
 * for that value only.
 *
 * @param {unknown} value - The value to convert.
 * @param {string} key - Its key in its parent, passed to `toJSON`.
 * @param {Walk} walk - The state of this walk.
 * @param {boolean} [useToJSON] - Whether to call `value.toJSON` (not on a `toJSON` result).
 * @returns {unknown} The JSON-ready value; `undefined` where JSON writes nothing.
 * @throws `NOT_JSON` in a strict walk, instead of any stand-in.
 */
function toJSONValue(value: unknown, key: string, walk: Walk, useToJSON = true): unknown {
  if (walk.inRepeat > 0) charge(walk, key, value)
  else if (typeof value === 'string') return stringToJSONValue(value, walk)
  const text = nonJSONText(value)
  if (text !== undefined) return standIn(walk, text)
  if (typeof value !== 'object' || value === null) return value
  const object = value

  if (walk.ancestors.has(object)) return standIn(walk, '[Circular]')

  if (useToJSON) {
    let toJSON: unknown
    try {
      toJSON = (object as { toJSON?: unknown }).toJSON
    } catch (thrown) {
      return standIn(walk, unserializable(thrown))
    }
    if (typeof toJSON === 'function') {
      // On the path while its result is written, so a result that refers back is a cycle.
      walk.ancestors.add(object)
      try {
        let replaced: unknown
        try {
          replaced = toJSON.call(object, key)
        } catch (thrown) {
          return standIn(walk, unserializable(thrown))
        }
        if (replaced !== object) {
          const write = () => toJSONValue(replaced, key, walk, false)
          // A `toJSON` may return a new object each time, so the object itself is what repeats.
          if (typeof replaced !== 'object' || replaced === null || walk.inRepeat > 0) return write()
          if (isRepeat(object, walk)) return repeatToJSONValue(write, walk)
          walk.seen.add(object)
          return write()
        }
      } finally {
        walk.ancestors.delete(object)
      }
    }
  }

  walk.ancestors.add(object)
  try {
    if (isRepeat(object, walk))
      return repeatToJSONValue(() => objectToJSONValue(object, walk), walk)
    if (walk.inRepeat === 0) walk.seen.add(object)
    return objectToJSONValue(object, walk)
  } finally {
    walk.ancestors.delete(object)
  }
}

/**
 * The text loggercf writes for a primitive JSON cannot write: a `BigInt`'s
 * digits, `[Function: name]`, `Symbol(description)`. Shared by the fast path
 * and the walk of `stringifyRecord()`. Never throws.
 *
 * @param {unknown} value - Any value.
 * @returns {string | undefined} Its text, or `undefined` for any other value.
 */
function nonJSONText(value: unknown): string | undefined {
  switch (typeof value) {
    case 'bigint':
    case 'symbol':
      return String(value)
    case 'function':
      return functionText(value)
  }
  return undefined
}

/**
 * Each primitive JSON unwraps when boxed, plus `BigInt` (written as its
 * digits) and `Symbol` (written as `Symbol(description)`): its prototype, and
 * its `valueOf`, which throws unless its `this` really is that boxed
 * primitive, whatever its `Symbol.toStringTag` says, and never runs user code.
 */
const BOXES: readonly [object, (this: unknown) => unknown][] = [
  [Number.prototype, Number.prototype.valueOf],
  [String.prototype, String.prototype.valueOf],
  [Boolean.prototype, Boolean.prototype.valueOf],
  [BigInt.prototype, BigInt.prototype.valueOf],
  [Symbol.prototype, Symbol.prototype.valueOf],
]

/**
 * The primitive inside a boxed primitive (`new Number(1)`, `Object(1n)`),
 * told by its brand, as `JSON.stringify` tells it. Only an object that
 * inherits from that primitive's prototype is checked, since a failed check
 * throws, which is slow; a boxed primitive moved to another prototype
 * (`Object.setPrototypeOf`) is written as an object.
 *
 * @param {object} object - Any object that is not a plain object or an array.
 * @returns {{ value: unknown } | undefined} The primitive, or `undefined` when `object` is not boxed.
 * @throws When its prototype cannot be read (a `Proxy` whose `getPrototypeOf` throws).
 */
function unbox(object: object): { value: unknown } | undefined {
  for (const [prototype, valueOf] of BOXES) {
    if (!Object.prototype.isPrototypeOf.call(prototype, object)) continue
    try {
      return { value: valueOf.call(object) }
    } catch {
      return undefined // a fake: `Object.create(Number.prototype)`
    }
  }
  return undefined
}

/**
 * The object part of `toJSONValue()`: its items or entries, each converted.
 *
 * @param {object} object - An object that is not a cycle.
 * @param {Walk} walk - The state of this walk.
 * @returns {unknown} An array, a plain object or an unwrapped primitive.
 */
function objectToJSONValue(object: object, walk: Walk): unknown {
  let items: ArrayLike<unknown> | undefined
  let keys: string[] | undefined
  let length = 0
  let boxed: { value: unknown } | undefined
  try {
    if (object instanceof Map) items = Array.from(object)
    else if (object instanceof Set) items = Array.from(object)
    else if (Array.isArray(object)) items = object
    else if (!isPlainObject(object)) boxed = unbox(object) // `new Number(1)`, as JSON writes it
    if (!items && !boxed) keys = Object.keys(object)
    length = items?.length ?? 0
  } catch (thrown) {
    return standIn(walk, unserializable(thrown))
  }

  if (boxed) return toJSONValue(boxed.value, '', walk) // `Object(1n)` as its digits

  if (items) {
    const out: unknown[] = []
    for (let i = 0; i < length; i++) {
      let item: unknown
      try {
        item = items[i]
      } catch (thrown) {
        item = standIn(walk, unserializable(thrown))
      }
      out.push(toJSONValue(item, String(i), walk) ?? null)
    }
    return out
  }

  const out: LogRecord = Object.create(null) // an own `__proto__` key stays a key
  for (const key of keys!) {
    let child: unknown
    try {
      child = (object as Record<string, unknown>)[key]
    } catch (thrown) {
      child = standIn(walk, unserializable(thrown))
    }
    const converted = toJSONValue(child, key, walk)
    if (converted !== undefined) out[key] = converted
  }
  return out
}

/**
 * A new walk.
 *
 * @param {boolean} strict - Whether to give up instead of writing a stand-in.
 * @param {Budget} budget - The line's re-write budget.
 * @param {Written} [earlier] - What earlier walks of the same line wrote.
 * @returns {Walk} Its state.
 */
const newWalk = (strict: boolean, budget: Budget, earlier?: Written): Walk => ({
  strict,
  ancestors: new Set(),
  seen: new Set(),
  strings: new Set(),
  earlier,
  inRepeat: 0,
  budget,
})

/** Thrown by `stringifyRecord()`'s fast path: the line needs the full walk. */
const NEEDS_WALK = new Error('needs walk')

/**
 * How many values the fast path writes before it hands the line to the
 * walk. The fast path sees what a `toJSON` returns, not the object it was
 * called on, so it can't tell a shared object whose `toJSON` returns a new
 * object each time; the walk can, and charges it to the budget.
 */
const MAX_FAST_VALUES = 100_000

/**
 * Serialize a record to one JSON line. Never throws for a value in it: a
 * value JSON cannot write gets a stand-in (see `toJSONValue()`), and only
 * that value. The record's own `toJSON` key, if any, is written as a field,
 * never called. A record from `buildRecord()` spends from its line's
 * budget, which its message's placeholders may already have spent from.
 *
 * Most lines take a fast path: native `JSON.stringify`, which gives up on
 * the first object or long string seen twice (a repeat or a cycle), boxed
 * symbol, or getter or `toJSON` that throws, and after `MAX_FAST_VALUES`
 * values. Those lines are written again by the `toJSONValue()` walk, so a
 * getter on them runs twice.
 *
 * @param {LogRecord} record - The record to serialize.
 * @returns {string} One JSON line.
 * @throws Only a `RangeError` for a value nested too deep for the stack, or a line too long for a string.
 */
export function stringifyRecord(record: LogRecord): string {
  if (typeof record.toJSON !== 'function') {
    const seen = new WeakSet<object>()
    let strings: Set<string> | undefined
    let values = 0
    try {
      return JSON.stringify(record, (_key, value: unknown) => {
        if (++values > MAX_FAST_VALUES) throw NEEDS_WALK
        if (typeof value === 'string') {
          if (value.length >= LONG_STRING) {
            strings ??= new Set()
            if (strings.has(value)) throw NEEDS_WALK
            strings.add(value)
          }
          return value
        }
        if (typeof value !== 'object' || value === null) return nonJSONText(value) ?? value
        if (seen.has(value)) throw NEEDS_WALK
        seen.add(value)
        if (value instanceof Map || value instanceof Set) return Array.from(value)
        if (Object.getPrototypeOf(value) === Symbol.prototype) throw NEEDS_WALK // a boxed symbol: JSON writes `{}`
        return value
      })
    } catch {
      // A repeat, a cycle, or a value that throws: the walk handles each one on its own.
    }
  }
  const budget = lineBudgets.get(record) ?? newBudget()
  return JSON.stringify(toJSONValue(record, '', newWalk(false, budget), false))
}

/**
 * The printer for one message's `%j`, `%o` and `%O` placeholders. It gives
 * the JSON text a placeholder prints, or `undefined` when its value cannot be
 * printed as it is: anything that would need a stand-in in
 * `stringifyRecord()` (a `BigInt`, a function or a symbol inside, a cycle,
 * a repeat over the budget, a getter or a `toJSON` that throws), or a value
 * JSON writes nothing for. A `Map` prints as `[key, value]` pairs and a
 * `Set` as an array, as on the line. What one placeholder prints is a repeat
 * for the next ones, and all of them spend from `budget`; a placeholder that
 * gives up prints nothing, so what it saw is not a repeat.
 *
 * @param {Budget} budget - The line's re-write budget.
 * @returns {(value: unknown) => string | undefined} Gives one placeholder's text, or `undefined`.
 */
export function inlinePrinter(budget: Budget): (value: unknown) => string | undefined {
  const written: Written = { objects: new WeakSet(), strings: new Set() }
  return (value) => {
    const walk = newWalk(true, budget, written)
    let text: string | undefined
    try {
      text = JSON.stringify(toJSONValue(value, '', walk))
    } catch {
      return undefined
    }
    if (text === undefined) return undefined
    for (const object of walk.seen) written.objects.add(object)
    for (const string of walk.strings) written.strings.add(string)
    return text
  }
}

/**
 * Map level labels to `console` methods so Cloudflare assigns the right severity.
 */
const LEVEL_TO_CONSOLE: Record<string, 'debug' | 'info' | 'warn' | 'error'> = {
  TRACE: 'debug',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'error',
}

/**
 * Node.js adapter: every level to `console.log` (stdout), one JSON line each.
 */
export const nodeSink: Sink = {
  write(record) {
    console.log(stringifyRecord(record))
  },
}

/**
 * Cloudflare Workers adapter: `console.<method>` chosen by level, one JSON line each.
 */
export const workersSink: Sink = {
  write(record) {
    const method = LEVEL_TO_CONSOLE[record.level as string] ?? 'info'
    console[method](stringifyRecord(record))
  },
}
