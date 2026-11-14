// The Logger Options' `limits`: `maxStringLength` and `maxRecordBytes`.
// Internal: `output.ts` applies them when it writes a line.

/**
 * Whether `n` is a `maxStringLength`: an integer, 1 or more.
 *
 * @param {unknown} n - Any value.
 * @returns {boolean} `true` for a valid limit.
 */
export function isMaxStringLength(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1
}

/** The smallest `maxRecordBytes`: room for the last-resort line, whatever is trimmed. */
export const MIN_RECORD_BYTES = 1024

/**
 * Whether `n` is a `maxRecordBytes`: an integer, `MIN_RECORD_BYTES` or more.
 *
 * @param {unknown} n - Any value.
 * @returns {boolean} `true` for a valid limit.
 */
export function isMaxRecordBytes(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= MIN_RECORD_BYTES
}

/** A record, as `fitLine()` reads it back from its line. */
type Tree = Record<string, unknown>

/**
 * What a string cut by `maxStringLength`, or trimmed by `maxRecordBytes`, ends with:
 * its original length, in characters (UTF-16 code units, as `.length` counts).
 *
 * @param {number} length - The original length.
 * @returns {string} The marker.
 */
const cutMarker = (length: number): string => `…[truncated from ${length} chars]`

/**
 * What a value `maxRecordBytes` takes out of a line is replaced with: how
 * many bytes it took in the line.
 *
 * @param {number} bytes - Its size in the line.
 * @returns {string} The marker.
 */
const trimmedMarker = (bytes: number): string => `[Trimmed: ${bytes} bytes]`

/**
 * The end of a prefix of `text`, so a cut never splits a surrogate pair.
 *
 * @param {string} text - The text.
 * @param {number} end - Where to cut.
 * @returns {number} `end`, or one less when that would split a pair.
 */
function safeEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1)
  return end > 0 && code >= 0xd800 && code <= 0xdbff ? end - 1 : end
}

/**
 * `text` cut to its first `max` characters, followed by `cutMarker()`. A cut
 * never splits a surrogate pair, so it may keep one character fewer.
 *
 * @param {string} text - A string longer than `max`.
 * @param {number} max - `maxStringLength`.
 * @returns {string} The cut string.
 */
export function cutString(text: string, max: number): string {
  return text.slice(0, safeEnd(text, max)) + cutMarker(text.length)
}

/**
 * The UTF-8 size of one character of a JSON string, as `JSON.stringify`
 * writes it: `"` and `\` are escaped, control characters are `\n`-style or
 * `\u00XX`, a lone surrogate is `\uXXXX`. A surrogate pair is counted on its
 * first half (4 bytes), and its second half as `0`.
 *
 * @param {string} text - The string.
 * @param {number} i - The index of the character.
 * @returns {number} Its bytes.
 */
function charBytes(text: string, i: number): number {
  const code = text.charCodeAt(i)
  if (code < 0x80) {
    if (code === 0x22 || code === 0x5c) return 2
    if (code >= 0x20) return 1
    return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6
  }
  if (code < 0x800) return 2
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(i + 1)
    return next >= 0xdc00 && next <= 0xdfff ? 4 : 6
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = text.charCodeAt(i - 1)
    return previous >= 0xd800 && previous <= 0xdbff ? 0 : 6
  }
  return 3
}

/**
 * The UTF-8 size of `text` as a JSON string, quotes included.
 *
 * @param {string} text - The string.
 * @returns {number} Its bytes.
 */
function stringBytes(text: string): number {
  // Most text is printable ASCII that JSON does not escape: one byte each.
  if (!NEEDS_COUNTING.test(text)) return text.length + 2
  let bytes = 2
  for (let i = 0; i < text.length; i++) bytes += charBytes(text, i)
  return bytes
}

/** A character a JSON string writes in other than one byte: escaped, or not ASCII. */
const NEEDS_COUNTING = /[^\x20\x21\x23-\x5b\x5d-\x7f]/

/** A character that is not ASCII. */
const NOT_ASCII = /[\u0080-\uffff]/

/**
 * The UTF-8 size of a line: of each code unit, 1 to 3 bytes, a surrogate
 * pair 4.
 *
 * @param {string} line - A JSON line.
 * @returns {number} Its bytes.
 */
export function utf8Bytes(line: string): number {
  if (!NOT_ASCII.test(line)) return line.length
  let bytes = 0
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = line.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** A string this long or longer has its size kept in `Sizes`: measuring it again would cost. */
const LONG_TEXT = 4096

/** A container with this many items or keys or more has its `Entries` kept in `Sizes`. */
const WIDE = 256

/** What `sizeOf()` keeps of a wide container: its keys, and the bytes of each value. */
interface Entries {
  /** An object's keys, in order; `undefined` for an array. */
  keys: string[] | undefined
  /** The bytes of each item, or of each key's value, as measured before any is trimmed. */
  values: number[]
}

/** What `sizeOf()` measured so far, so nothing is measured twice. */
interface Sizes {
  /** The bytes of each container larger than `MIN_TRIMMABLE`, and of each long string (see `LONG_TEXT`). */
  bytes: Map<unknown, number>
  /** The `Entries` of each wide container (see `WIDE`): reading the keys of a wide object again would cost. */
  entries: Map<object, Entries>
}

/**
 * Nothing measured yet.
 *
 * @returns {Sizes} An empty `Sizes`.
 */
const newSizes = (): Sizes => ({ bytes: new Map(), entries: new Map() })

/**
 * The UTF-8 size of a JSON value as `JSON.stringify` writes it. A container's
 * is kept in `sizes`, so each one is measured once (one of `MIN_TRIMMABLE`
 * bytes or less is cheap to measure again, and is never trimmed), and so is a
 * long string's (see `LONG_TEXT`) and a wide container's `Entries`. A number
 * JSON can't write (`NaN`, `Infinity`) is `null`, as `JSON.stringify` writes it.
 *
 * @param {unknown} value - A value from `JSON.parse`, or a JSON-ready copy (see `fitValue()`).
 * @param {Sizes} sizes - What is measured so far.
 * @returns {number} Its bytes.
 */
function sizeOf(value: unknown, sizes: Sizes): number {
  if (typeof value === 'string') {
    if (value.length < LONG_TEXT) return stringBytes(value)
    let bytes = sizes.bytes.get(value)
    if (bytes === undefined) {
      bytes = stringBytes(value)
      sizes.bytes.set(value, bytes)
    }
    return bytes
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4
  if (typeof value !== 'object' || value === null) return String(value).length
  const known = sizes.bytes.get(value)
  if (known !== undefined) return known
  let bytes = 2
  let keys: string[] | undefined
  let values: number[] | undefined
  if (Array.isArray(value)) {
    if (value.length >= WIDE) values = []
    for (const item of value) {
      const size = sizeOf(item, sizes)
      values?.push(size)
      bytes += size + 1
    }
    if (value.length > 0) bytes--
  } else {
    keys = Object.keys(value)
    if (keys.length >= WIDE) values = []
    for (const key of keys) {
      const size = sizeOf((value as Tree)[key], sizes)
      values?.push(size)
      bytes += stringBytes(key) + 1 + size + 1
    }
    if (keys.length > 0) bytes--
  }
  if (values) sizes.entries.set(value, { keys, values })
  if (bytes > MIN_TRIMMABLE) sizes.bytes.set(value, bytes)
  return bytes
}

/**
 * The bytes of the value at `i` in a container: kept in its `Entries` when it
 * is wide and the value is of `MIN_TRIMMABLE` bytes or less (it is never
 * trimmed, so that never changes), else measured (see `sizeOf()`).
 *
 * @param {unknown} value - The value.
 * @param {number} i - Its index in its container's items or keys.
 * @param {Entries | undefined} entries - What `sizeOf()` kept of the container.
 * @param {Sizes} sizes - What is measured so far.
 * @returns {number} Its bytes.
 */
function entrySize(value: unknown, i: number, entries: Entries | undefined, sizes: Sizes): number {
  const kept = entries?.values[i]
  return kept !== undefined && kept <= MIN_TRIMMABLE ? kept : sizeOf(value, sizes)
}

/**
 * The keys of an object, from its `Entries` when `sizeOf()` kept them.
 *
 * @param {Tree} node - The object.
 * @param {Sizes} sizes - What is measured so far.
 * @returns {string[]} Its keys, in order.
 */
const keysOf = (node: Tree, sizes: Sizes): string[] =>
  sizes.entries.get(node)?.keys ?? Object.keys(node)

/** A `cutMarker()` at the end of a string, with the length it holds. */
const ENDS_WITH_CUT = /…\[truncated from (\d+) chars\]$/

/** How a `cutMarker()` starts. */
const CUT_MARKER_START = '…[truncated from '

/** How a `cutMarker()` ends. */
const CUT_MARKER_END = ' chars]'

/**
 * `text` trimmed to the longest prefix that, with `cutMarker()`, is a JSON
 * string of at most `bytes` bytes. Just the marker when no prefix fits. A
 * `text` that `maxStringLength` already cut keeps its one marker, with the
 * original length: the marker is taken off, and the rest is trimmed.
 *
 * @param {string} text - The string.
 * @param {number} bytes - The size to fit.
 * @returns {string} The trimmed string.
 */
function cutToBytes(text: string, bytes: number): string {
  // Only the last marker start can match (digits never hold one): a search of the whole of a
  // long string would cost.
  const start = text.endsWith(CUT_MARKER_END) ? text.lastIndexOf(CUT_MARKER_START) : -1
  const found = start < 0 ? null : ENDS_WITH_CUT.exec(text.slice(start))
  const index = found ? start : -1
  // A real earlier cut kept fewer characters than it says the string had; a
  // string that only ends like a marker is cut as it is.
  const already = found && Number(found[1]) > index ? found : null
  const kept = already ? text.slice(0, index) : text
  const marker = cutMarker(already ? Number(already[1]) : text.length)
  let room = bytes - stringBytes(marker)
  let end = 0
  while (end < kept.length) {
    const cost = charBytes(kept, end)
    if (cost > room) break
    room -= cost
    end++
  }
  return kept.slice(0, safeEnd(kept, end)) + marker
}

/**
 * The longest prefix of `text` that is a JSON string of at most `bytes`
 * bytes, quotes included; empty when none fits.
 *
 * @param {string} text - The string.
 * @param {number} bytes - The size to fit.
 * @returns {string} The prefix.
 */
function prefixToBytes(text: string, bytes: number): string {
  let room = bytes - 2
  let end = 0
  while (end < text.length) {
    const cost = charBytes(text, end)
    if (cost > room) break
    room -= cost
    end++
  }
  return text.slice(0, safeEnd(text, end))
}

/**
 * The top-level Protected Fields: the keys `maxRecordBytes` trims last, after
 * everything else (see `PROTECTED`). `maxStringLength` never cuts them
 * either, but `message` (see `keepsLength()` in `output.ts`).
 */
export const PROTECTED_KEYS: readonly string[] = [
  'time',
  'level',
  'message',
  'traceId',
  'spanId',
  'parentSpanId',
  'service',
  'environment',
  'version',
]

/** `PROTECTED_KEYS`, for lookups. */
const PROTECTED: ReadonlySet<string> = new Set(PROTECTED_KEYS)

/** `err`'s keys that `maxRecordBytes` keeps whole while anything else can go. */
const PROTECTED_ERR_KEYS: ReadonlySet<string> = new Set(['type', 'message'])

/** Below this size, replacing a value with a marker saves nothing worth having. */
const SMALL = 32

/**
 * A value of this many bytes or less is never trimmed on its own: it saves too
 * little for what it loses. The tail of its container is dropped instead (see
 * `dropTail()` and `dropTailKeys()`), so the leading values stay whole.
 */
const MIN_TRIMMABLE = 128

/** The key `dropTailKeys()` writes its marker under. */
const TRIMMED_KEY = '[Trimmed]'

/** `TRIMMED_KEY`, and the keys made from it by adding `_`. */
const TRIMMED_KEYS = /^\[Trimmed\]_*$/

/** What an object is to `shrink()`: the record itself, its `err`, or any other value. */
type NodeKind = 'root' | 'err' | 'value'

/**
 * Whether `key` of an object of `kind` is a Protected Field that `shrink()`
 * leaves alone: at the root the top-level ones, in `err` its `type` and `message`.
 *
 * @param {NodeKind} kind - What the object is.
 * @param {string} key - One of its keys.
 * @returns {boolean} `true` when `key` is protected.
 */
const isProtected = (kind: NodeKind, key: string): boolean =>
  kind === 'root' ? PROTECTED.has(key) : kind === 'err' && PROTECTED_ERR_KEYS.has(key)

/**
 * Whether `key` stays in an object of `kind` when its tail is dropped: a
 * Protected Field, and at the root `err` too, which `shrink()` trims inside.
 *
 * @param {NodeKind} kind - What the object is.
 * @param {string} key - One of its keys.
 * @returns {boolean} `true` when `key` stays.
 */
const staysInTail = (kind: NodeKind, key: string): boolean =>
  isProtected(kind, key) || (kind === 'root' && key === 'err')

/**
 * The entries at the end of a container that a tail pass takes, to put one
 * marker in their place.
 *
 * @param {number} count - How many entries the container has.
 * @param {(i: number) => number | undefined} take - Takes the entry at `i` and returns its bytes in the line (its separator excluded), or `undefined` when it stays.
 * @param {(taken: number, bytes: number) => number} marker - The bytes of the marker entry, for that many entries taken.
 * @param {number} need - How many bytes to take out.
 * @returns {{ taken: number[]; bytes: number; saved: number }} The indexes taken, last first, their bytes, and what the container loses by it.
 */
function tailToDrop(
  count: number,
  take: (i: number) => number | undefined,
  marker: (taken: number, bytes: number) => number,
  need: number,
): { taken: number[]; bytes: number; saved: number } {
  const taken: number[] = []
  let bytes = 0
  let saved = 0
  // Without `k` entries and with the marker, the container is `bytes + (k - 1) - marker` bytes smaller.
  for (let i = count - 1; i >= 0; i--) {
    const entry = take(i)
    if (entry === undefined) continue
    bytes += entry
    taken.push(i)
    saved = bytes + (taken.length - 1) - marker(taken.length, bytes)
    if (saved >= need) break
  }
  return { taken, bytes, saved }
}

/**
 * What the items `dropTail()` takes off an array are replaced with.
 *
 * @param {number} items - How many.
 * @param {number} bytes - How many bytes they took in the line.
 * @returns {string} The marker.
 */
const droppedItemsMarker = (items: number, bytes: number): string =>
  `[Trimmed: ${items} items, ${bytes} bytes]`

/**
 * Take at least `need` bytes off the end of an array of values too small to
 * trim one by one: its last items are replaced with one `droppedItemsMarker()`.
 *
 * @param {unknown[]} list - The array. Mutated.
 * @param {number} need - How many bytes to take out.
 * @param {Sizes} sizes - The sizes measured so far.
 * @returns {number} How many bytes it took out; `0` when that would save nothing.
 */
function dropTail(list: unknown[], need: number, sizes: Sizes): number {
  const entries = sizes.entries.get(list)
  const { taken, bytes, saved } = tailToDrop(
    list.length,
    (i) => entrySize(list[i], i, entries, sizes),
    (items, removed) => droppedItemsMarker(items, removed).length + 2,
    need,
  )
  if (saved <= 0) return 0
  list.splice(list.length - taken.length, taken.length, droppedItemsMarker(taken.length, bytes))
  sizes.entries.delete(list)
  return saved
}

/**
 * What the keys `dropTailKeys()` takes off an object are replaced with.
 *
 * @param {number} keys - How many.
 * @param {number} bytes - How many bytes they took in the line.
 * @returns {string} The marker.
 */
const droppedKeysMarker = (keys: number, bytes: number): string =>
  `[Trimmed: ${keys} keys, ${bytes} bytes]`

/**
 * Take at least `need` bytes off the end of an object of values too small to
 * trim one by one: its last keys, in key order, are replaced with one entry,
 * `"[Trimmed]": droppedKeysMarker()`. Protected Fields stay. The leading keys
 * stay whole. The entry's key is `[Trimmed]`, or that with `_` added until it
 * is a key the object doesn't keep (one it drops is free).
 *
 * @param {Tree} node - The object. Mutated.
 * @param {number} need - How many bytes to take out.
 * @param {Sizes} sizes - The sizes measured so far.
 * @param {NodeKind} kind - What the object is (see `shrink()`).
 * @returns {number} How many bytes it took out; `0` when that would save nothing.
 */
function dropTailKeys(node: Tree, need: number, sizes: Sizes, kind: NodeKind): number {
  const entries = sizes.entries.get(node)
  const keys = entries?.keys ?? Object.keys(node)
  // The shortest of the marker keys that is free, or about to be dropped.
  let markerKey = TRIMMED_KEY
  while (Object.hasOwn(node, markerKey)) markerKey += '_'
  const { taken, bytes, saved } = tailToDrop(
    keys.length,
    (i) => {
      const key = keys[i]
      if (staysInTail(kind, key)) return undefined
      if (key.length < markerKey.length && key.startsWith('[') && TRIMMED_KEYS.test(key))
        markerKey = key
      return stringBytes(key) + 1 + entrySize(node[key], i, entries, sizes)
    },
    (count, removed) => stringBytes(markerKey) + 1 + droppedKeysMarker(count, removed).length + 2,
    need,
  )
  if (saved <= 0) return 0
  for (const i of taken) delete node[keys[i]]
  node[markerKey] = droppedKeysMarker(taken.length, bytes)
  sizes.entries.delete(node)
  return saved
}

/**
 * Whether `value` is an object `JSON.parse` made: an array or a plain object.
 *
 * @param {unknown} value - A value from `JSON.parse`.
 * @returns {boolean} `true` for a container.
 */
const isContainer = (value: unknown): value is Tree | unknown[] =>
  typeof value === 'object' && value !== null

/**
 * The least a value is left with when `shrink()` takes it out: the string
 * trimmed down to its marker, or `trimmedMarker()`.
 *
 * @param {unknown} value - A value from `JSON.parse`.
 * @param {number} size - Its bytes in the line.
 * @returns {number} The bytes of what replaces it.
 */
const replacementBytes = (value: unknown, size: number): number =>
  typeof value === 'string' ? stringBytes(cutMarker(value.length)) : trimmedMarker(size).length + 2

/**
 * Take at least `need` bytes out of `node`, largest value first, and return
 * how many it took. A string larger than what is still needed is trimmed (see
 * `cutToBytes()`), and a container larger than that is trimmed the same way
 * inside, or replaced with `trimmedMarker()` when that can't take enough. A
 * smaller value is replaced with `trimmedMarker()` only when replacing every
 * value above `MIN_TRIMMABLE` could take out `need` by itself; otherwise those
 * values would all end as markers, so they stay and the tail of `node` goes
 * instead. The tail also goes for what is left after the values above
 * `MIN_TRIMMABLE` (see `dropTail()` and `dropTailKeys()`), so the leading
 * values stay whole. Each container is sorted once, and only along one path
 * (the value larger than what is needed), so the work is about linear in the
 * line.
 *
 * @param {Tree | unknown[]} node - A container. Mutated.
 * @param {number} need - How many bytes to take out.
 * @param {Sizes} sizes - The sizes measured so far (see `sizeOf()`).
 * @param {NodeKind} kind - What `node` is: what is protected in it.
 * @returns {number} How many bytes it took out.
 */
function shrink(node: Tree | unknown[], need: number, sizes: Sizes, kind: NodeKind): number {
  const keys = Array.isArray(node) ? node.map((_, i) => String(i)) : keysOf(node, sizes)
  const kept = sizes.entries.get(node)
  const entries: [string, number][] = []
  // What replacing every value above `MIN_TRIMMABLE` could take out.
  let reachable = 0
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (isProtected(kind, key)) continue
    const value = (node as Tree)[key]
    const size = entrySize(value, i, kept, sizes)
    // A smaller one is never trimmed on its own: the loop below stops at the first.
    if (size <= MIN_TRIMMABLE) continue
    entries.push([key, size])
    reachable += size - replacementBytes(value, size)
  }
  entries.sort((a, b) => b[1] - a[1])
  const wholesale = reachable >= need
  let saved = 0
  for (const [key, size] of entries) {
    const left = need - saved
    if (left <= 0 || size <= MIN_TRIMMABLE) break
    // They can't all be replaced to reach `need`: keep the ones smaller than what is left, and drop the tail.
    if (!wholesale && size <= left) break
    const value = (node as Tree)[key]
    if (kind === 'root' && key === 'err' && isContainer(value) && !Array.isArray(value)) {
      const inside = shrink(value, left, sizes, 'err')
      sizes.bytes.set(value, size - inside)
      saved += inside
      continue
    }
    if (typeof value === 'string') {
      const cut = cutToBytes(value, size - left)
      const cutSize = stringBytes(cut)
      if (cutSize < size) {
        ;(node as Tree)[key] = cut
        saved += size - cutSize
      }
      continue
    }
    if (!isContainer(value)) continue
    if (size > left + SMALL) {
      const inside = shrink(value, left, sizes, 'value')
      sizes.bytes.set(value, size - inside)
      if (inside >= left) {
        saved += inside
        continue
      }
    }
    const marker = trimmedMarker(size)
    const markerSize = marker.length + 2
    if (markerSize < size) {
      ;(node as Tree)[key] = marker
      saved += size - markerSize
    }
  }
  // Many small items or fields keep the ones that fit, from the start.
  if (saved < need)
    saved += Array.isArray(node)
      ? dropTail(node, need - saved, sizes)
      : dropTailKeys(node, need - saved, sizes, kind)
  return saved
}

/**
 * The record with only its Protected Fields, and `logError` saying why.
 *
 * @param {Tree} root - The record.
 * @param {number} bytes - The size of the line it came from.
 * @param {number} max - `maxRecordBytes`.
 * @returns {Tree} The smaller record.
 */
function protectedOnly(root: Tree, bytes: number, max: number): Tree {
  const out: Tree = {}
  for (const key of Object.keys(root)) {
    if (PROTECTED.has(key)) out[key] = root[key]
    else if (key === 'err' && isContainer(root.err) && !Array.isArray(root.err)) {
      const err: Tree = {}
      for (const errKey of PROTECTED_ERR_KEYS)
        if (errKey in root.err) err[errKey] = root.err[errKey]
      out.err = err
    }
  }
  out.logError = `line of ${bytes} bytes over maxRecordBytes (${max}): only the Protected Fields are kept`
  return out
}

/**
 * `protectedOnly()`, with `message` and `err.message` trimmed too, largest first,
 * to take out `need` bytes.
 *
 * @param {Tree} root - A record from `protectedOnly()`. Mutated.
 * @param {number} need - How many bytes to take out.
 */
function cutMessages(root: Tree, need: number): void {
  const err = isContainer(root.err) && !Array.isArray(root.err) ? root.err : undefined
  const holders: [Tree, number][] = []
  if (typeof root.message === 'string') holders.push([root, stringBytes(root.message)])
  if (typeof err?.message === 'string') holders.push([err, stringBytes(err.message)])
  holders.sort((a, b) => b[1] - a[1])
  for (const [holder, size] of holders) {
    if (need <= 0) break
    const cut = cutToBytes(holder.message as string, size - need)
    need -= size - stringBytes(cut)
    holder.message = cut
  }
}

/** The trace IDs the last-resort line keeps: short and fixed in size. */
const TRACE_KEYS: readonly string[] = ['traceId', 'spanId', 'parentSpanId']

/** The longest trace ID the last-resort line keeps; a real one is 32 characters at most. */
const MAX_TRACE_ID = 64

/** The longest `time` the last-resort line keeps. */
const MAX_TIME = 64

/** The longest `level` the last-resort line keeps. */
const MAX_LEVEL = 16

/** A text field of the last-resort line, and how to write it in and take it out. */
interface TextField {
  text: string
  put(text: string): void
  remove(): void
}

/**
 * The first `max` characters of `value` when it is a string, never splitting a surrogate pair.
 *
 * @param {unknown} value - Any value.
 * @param {number} max - The most characters.
 * @returns {string | undefined} The prefix; `undefined` for anything but a string.
 */
const clip = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? value.slice(0, safeEnd(value, max)) : undefined

/**
 * The last resort: `time`, `level`, the trace IDs and `logError`, which fit
 * unless a character that JSON escapes fills them, and then `service`,
 * `environment`, `version`, `message` and `err.type`. Each of those is kept
 * whole when it fits, else trimmed with `cutMarker()` to its share of what is
 * left (the shortest first, so a short one gives its room to the rest), and
 * dropped only when even the trimmed one doesn't fit. When the first part
 * alone is over `max`, the trace IDs go, and if that is not enough `time` and
 * `level` are trimmed to fit.
 *
 * @param {Tree} source - The record the line was written from, or its line read back.
 * @param {number} max - `maxRecordBytes`.
 * @returns {string} The line.
 */
function minimalLine(source: Tree, max: number): string {
  const time = clip(source.time, MAX_TIME)
  const level = clip(source.level, MAX_LEVEL)
  const logError = `line over maxRecordBytes (${max})`
  const size = (record: Tree) => utf8Bytes(JSON.stringify(record))
  const out: Tree = {}
  const build = (traces: boolean) => {
    for (const key of Object.keys(out)) delete out[key]
    if (time !== undefined) out.time = time
    if (level !== undefined) out.level = level
    if (traces)
      for (const key of TRACE_KEYS) {
        const id = clip(source[key], MAX_TRACE_ID)
        if (id !== undefined) out[key] = id
      }
    out.logError = logError
  }
  build(true)
  if (size(out) > max) build(false)
  if (size(out) > max) {
    // Only `time` and `level` are left to trim: each gets half of what the rest leaves.
    const trims: [string, string][] = []
    if (time !== undefined) trims.push(['time', time])
    if (level !== undefined) trims.push(['level', level])
    for (const [key] of trims) out[key] = ''
    const each = Math.floor((max - size(out)) / trims.length)
    for (const [key, text] of trims) out[key] = prefixToBytes(text, each + 2)
  }
  const fields: TextField[] = []
  for (const key of ['service', 'environment', 'version', 'message']) {
    const text = source[key]
    if (typeof text === 'string')
      fields.push({
        text,
        put: (value) => {
          out[key] = value
        },
        remove: () => {
          delete out[key]
        },
      })
  }
  const err = source.err
  if (isContainer(err) && !Array.isArray(err) && typeof err.type === 'string')
    fields.push({
      text: err.type,
      put: (value) => {
        out.err = { type: value }
      },
      remove: () => {
        delete out.err
      },
    })
  fields.sort((a, b) => a.text.length - b.text.length)
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const used = size(out)
    // Its share of what is left, the shortest fields first.
    const allowance = used + Math.floor((max - used) / (fields.length - i))
    field.put(field.text)
    if (size(out) <= allowance) continue
    field.put('')
    const room = allowance - size(out) + 2
    if (room > 0) field.put(cutToBytes(field.text, room))
    else field.remove()
    if (size(out) > allowance) field.remove()
  }
  return JSON.stringify(out)
}

/**
 * The line, made to fit `maxRecordBytes` (in UTF-8 bytes). A line that
 * already fits is returned as is. A larger one is read back and trimmed (see
 * `fitValue()`). Never throws.
 *
 * @param {string} line - The JSON line.
 * @param {Record<string, unknown>} record - The record it was written from, for the last resort.
 * @param {number} max - `maxRecordBytes`: 1,024 or more.
 * @returns {string} A line of at most `max` bytes.
 */
export function fitLine(line: string, record: Record<string, unknown>, max: number): string {
  if (fits(line, max)) return line
  let root: Tree
  try {
    root = JSON.parse(line) as Tree
  } catch {
    return lastResort(record, record, max)
  }
  return fitValue(root, record, max, line)
}

/**
 * Whether a line is at most `max` bytes, without counting them when its
 * length alone tells.
 *
 * @param {string} line - The JSON line.
 * @param {number} max - `maxRecordBytes`.
 * @returns {boolean} `true` when it fits.
 */
function fits(line: string, max: number): boolean {
  // A code unit is at most 3 bytes, and at least 1.
  if (line.length * 3 <= max) return true
  return line.length <= max && utf8Bytes(line) <= max
}

/**
 * The line of a JSON-ready copy of a record (plain objects and arrays,
 * strings, numbers, booleans and `null`, no object in two places, as the
 * walk of `output.ts` builds it, or `JSON.parse` does), made to fit
 * `maxRecordBytes`: the same line as `fitLine(JSON.stringify(copy), ...)`, but
 * a line over the limit is trimmed from the copy, never read back. Without
 * `line`, the copy is measured first and written only when it fits, so a
 * large line is never written whole; with it, `line` is returned when it fits.
 *
 * @param {Record<string, unknown>} copy - The copy. Mutated when its line is too large.
 * @param {Record<string, unknown>} record - The record it was made from, for the last resort.
 * @param {number} max - `maxRecordBytes`: 1,024 or more.
 * @param {string} [line] - The copy's line, when it is already written.
 * @returns {string} A line of at most `max` bytes.
 * @throws Only what `JSON.stringify` of the copy throws: a `RangeError` for a copy nested too deep for the stack, or a line too long for a string.
 */
export function fitValue(
  copy: Record<string, unknown>,
  record: Record<string, unknown>,
  max: number,
  line?: string,
): string {
  if (line !== undefined && fits(line, max)) return line
  // Measured as a tree, not as a line: what `shrink()` measures is then measured once.
  const sizes = newSizes()
  let bytes: number
  try {
    bytes = sizeOf(copy, sizes)
  } catch {
    return line === undefined
      ? fitLine(JSON.stringify(copy), record, max)
      : lastResort(copy, record, max)
  }
  // A `line` that does not fit is never written again as it is: `fitTree()` writes the copy.
  if (line === undefined && bytes <= max) return JSON.stringify(copy)
  return fitTree(copy, bytes, sizes, record, max)
}

/**
 * A record read back from its line, or its JSON-ready copy, trimmed to fit
 * `maxRecordBytes`:
 *
 * 1. its largest values first, but the Protected Fields (`time`, `level`,
 *    `message`, the trace IDs, `service`, `environment`, `version`, and
 *    `err`'s `type` and `message`), see `shrink()`;
 * 2. if that is not enough, only the Protected Fields are kept, with a
 *    `logError` that says so;
 * 3. then `message` and `err.message` are trimmed too;
 * 4. and if even that does not fit, the line is `time`, `level`, the trace IDs
 *    and `logError`, with `service`, `environment`, `version`, `message` and
 *    `err.type` trimmed to fit, or left out when even the trimmed one doesn't
 *    (see `minimalLine()`).
 *
 * Each step measures the line once and writes it once, so the work is about
 * linear in its size. Never throws.
 *
 * @param {Tree} root - The record. Mutated.
 * @param {number} bytes - The size of its line, over `max`.
 * @param {Sizes} sizes - What is measured of it so far (see `sizeOf()`).
 * @param {Record<string, unknown>} record - The record it was written from, for the last resort.
 * @param {number} max - `maxRecordBytes`: 1,024 or more.
 * @returns {string} A line of at most `max` bytes.
 */
function fitTree(
  root: Tree,
  bytes: number,
  sizes: Sizes,
  record: Record<string, unknown>,
  max: number,
): string {
  try {
    shrink(root, bytes - max, sizes, 'root')
    let out = JSON.stringify(root)
    if (utf8Bytes(out) <= max) return out
    const kept = protectedOnly(root, bytes, max)
    out = JSON.stringify(kept)
    const size = utf8Bytes(out)
    if (size <= max) return out
    cutMessages(kept, size - max)
    out = JSON.stringify(kept)
    if (utf8Bytes(out) <= max) return out
  } catch {
    // Fall through to the last resort.
  }
  return lastResort(root, record, max)
}

/**
 * `minimalLine()` from `source`, or from only the `time` and `level` of
 * `record` when `source` can't be read. Never throws.
 *
 * @param {Tree} source - The record read back from its line, or the record itself.
 * @param {Record<string, unknown>} record - The record the line was written from.
 * @param {number} max - `maxRecordBytes`.
 * @returns {string} The line.
 */
function lastResort(source: Tree, record: Record<string, unknown>, max: number): string {
  try {
    return minimalLine(source, max)
  } catch {
    return minimalLine({ time: record.time, level: record.level }, max)
  }
}
