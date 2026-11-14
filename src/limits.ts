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
 * What a string cut by `maxStringLength`, or by `maxRecordBytes`, ends with:
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

/**
 * The UTF-8 size of a JSON value as `JSON.stringify` writes it. A container's
 * is kept in `sizes`, so each one is measured once.
 *
 * @param {unknown} value - A value from `JSON.parse`.
 * @param {Map<object, number>} sizes - The containers measured so far.
 * @returns {number} Its bytes.
 */
function sizeOf(value: unknown, sizes: Map<object, number>): number {
  if (typeof value === 'string') return stringBytes(value)
  if (typeof value !== 'object' || value === null) return String(value).length
  const known = sizes.get(value)
  if (known !== undefined) return known
  let bytes = 2
  if (Array.isArray(value)) {
    for (const item of value) bytes += sizeOf(item, sizes) + 1
    if (value.length > 0) bytes--
  } else {
    const keys = Object.keys(value)
    for (const key of keys) bytes += stringBytes(key) + 1 + sizeOf((value as Tree)[key], sizes) + 1
    if (keys.length > 0) bytes--
  }
  sizes.set(value, bytes)
  return bytes
}

/**
 * The longest prefix of `text` that, with `cutMarker()`, is a JSON string of
 * at most `bytes` bytes. Just the marker when no prefix fits.
 *
 * @param {string} text - The string.
 * @param {number} bytes - The size to fit.
 * @returns {string} The cut string.
 */
function cutToBytes(text: string, bytes: number): string {
  const marker = cutMarker(text.length)
  let room = bytes - stringBytes(marker)
  let end = 0
  while (end < text.length) {
    const cost = charBytes(text, end)
    if (cost > room) break
    room -= cost
    end++
  }
  return text.slice(0, safeEnd(text, end)) + marker
}

/**
 * The top-level Protected Fields: the keys `maxRecordBytes` keeps whole while
 * anything else can go (see `PROTECTED`). `maxStringLength` never cuts them
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
 * What the items `dropTail()` takes off an array are replaced with.
 *
 * @param {number} items - How many.
 * @param {number} bytes - How many bytes they took in the line.
 * @returns {string} The marker.
 */
const droppedMarker = (items: number, bytes: number): string =>
  `[Trimmed: ${items} items, ${bytes} bytes]`

/**
 * Take at least `need` bytes off the end of an array of values too small to
 * trim one by one: its last items are replaced with one `droppedMarker()`.
 *
 * @param {unknown[]} list - The array. Mutated.
 * @param {number} need - How many bytes to take out.
 * @param {Map<object, number>} sizes - The sizes measured so far.
 * @returns {number} How many bytes it took out; `0` when that would save nothing.
 */
function dropTail(list: unknown[], need: number, sizes: Map<object, number>): number {
  let removed = 0
  let items = 0
  let saved = 0
  // Without `k` items and with the marker, the array is `removed + (k - 1) - marker` bytes smaller.
  while (items < list.length) {
    removed += sizeOf(list[list.length - 1 - items], sizes)
    items++
    saved = removed + (items - 1) - (droppedMarker(items, removed).length + 2)
    if (saved >= need) break
  }
  if (saved <= 0) return 0
  list.splice(list.length - items, items, droppedMarker(items, removed))
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
 * Take at least `need` bytes out of `node`, largest value first, and return
 * how many it took. A string larger than what is still needed is cut (see
 * `cutToBytes()`), and a container larger than that is trimmed the same way
 * inside, or replaced with `trimmedMarker()` when that can't take enough. A
 * smaller value is replaced with `trimmedMarker()`. Values of `SMALL` bytes
 * or less are left, but an array still too large loses its last items (see
 * `dropTail()`). Each container is sorted once, and only along one path (the
 * value larger than what is needed), so the work is about linear in the line.
 *
 * @param {Tree | unknown[]} node - A container. Mutated.
 * @param {number} need - How many bytes to take out.
 * @param {Map<object, number>} sizes - The sizes measured so far (see `sizeOf()`).
 * @param {'root' | 'err' | 'value'} kind - The record itself, its `err`, or any other value: what is protected in it.
 * @returns {number} How many bytes it took out.
 */
function shrink(
  node: Tree | unknown[],
  need: number,
  sizes: Map<object, number>,
  kind: 'root' | 'err' | 'value',
): number {
  const keys = Array.isArray(node) ? node.map((_, i) => String(i)) : Object.keys(node)
  const entries: [string, number][] = []
  for (const key of keys) {
    if (kind === 'root' ? PROTECTED.has(key) : kind === 'err' && PROTECTED_ERR_KEYS.has(key))
      continue
    entries.push([key, sizeOf((node as Tree)[key], sizes)])
  }
  entries.sort((a, b) => b[1] - a[1])
  let saved = 0
  for (const [key, size] of entries) {
    const left = need - saved
    if (left <= 0 || size <= SMALL) break
    const value = (node as Tree)[key]
    if (kind === 'root' && key === 'err' && isContainer(value) && !Array.isArray(value)) {
      saved += shrink(value, left, sizes, 'err')
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
  // An array of many small items keeps the ones it can, from the start.
  if (saved < need && Array.isArray(node)) saved += dropTail(node, need - saved, sizes)
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
 * `protectedOnly()`, with `message` and `err.message` cut too, largest first,
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

/**
 * The last resort: `time`, `level` and `logError`, which always fits.
 *
 * @param {Tree} record - The record the line was written from.
 * @param {number} max - `maxRecordBytes`.
 * @returns {string} The line.
 */
function minimalLine(record: Tree, max: number): string {
  const { time, level } = record
  return JSON.stringify({
    time: typeof time === 'string' ? time.slice(0, 64) : undefined,
    level: typeof level === 'string' ? level.slice(0, 16) : undefined,
    logError: `line over maxRecordBytes (${max})`,
  })
}

/**
 * The line, made to fit `maxRecordBytes` (in UTF-8 bytes). A line that
 * already fits is returned as is. A larger one is read back and trimmed:
 *
 * 1. its largest values first, but the Protected Fields (`time`, `level`,
 *    `message`, the trace IDs, `service`, `environment`, `version`, and
 *    `err`'s `type` and `message`), see `shrink()`;
 * 2. if that is not enough, only the Protected Fields are kept, with a
 *    `logError` that says so;
 * 3. then `message` and `err.message` are cut too;
 * 4. and if even that does not fit, the line is `time`, `level` and `logError`.
 *
 * Each step measures the line once and writes it once, so the work is about
 * linear in its size. Never throws.
 *
 * @param {string} line - The JSON line.
 * @param {Record<string, unknown>} record - The record it was written from, for the last resort.
 * @param {number} max - `maxRecordBytes`: 1,024 or more.
 * @returns {string} A line of at most `max` bytes.
 */
export function fitLine(line: string, record: Record<string, unknown>, max: number): string {
  // A code unit is at most 3 bytes, and at least 1.
  if (line.length * 3 <= max) return line
  let bytes: number
  if (line.length <= max) {
    bytes = utf8Bytes(line)
    if (bytes <= max) return line
  } else bytes = utf8Bytes(line)
  try {
    let root = JSON.parse(line) as Tree
    const sizes = new Map<object, number>()
    shrink(root, bytes - max, sizes, 'root')
    let out = JSON.stringify(root)
    if (utf8Bytes(out) <= max) return out
    root = protectedOnly(root, bytes, max)
    out = JSON.stringify(root)
    const size = utf8Bytes(out)
    if (size <= max) return out
    cutMessages(root, size - max)
    out = JSON.stringify(root)
    if (utf8Bytes(out) <= max) return out
  } catch {
    // Fall through to the last resort.
  }
  return minimalLine(record, max)
}
