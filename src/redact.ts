import type { Redactor, RedactKeysOptions } from './types'

/** What `redactKeys()` writes in place of a value when no `censor` is given. */
const DEFAULT_CENSOR = '[REDACTED]'

/**
 * The redactors `redactKeys()` built, by their censor and their keys, lower-cased,
 * sorted and without repeats (see `listKey()`). So a call made again with the same
 * keys, in any case or order, gives the same `Redactor`, and a Workers helper the
 * same Root Logger for it.
 */
const byKeys = new Map<string, Redactor>()

/** `byKeys` stops growing at this many key lists; past it, each call builds a new `Redactor`. */
const MAX_KEY_LISTS = 64

/** How many path keys each redactor remembers the answer for (see `matcher()`). */
const MAX_KNOWN_KEYS = 4096

/**
 * The `byKeys` key for a censor and a key list.
 *
 * @param {string} censor - The censor.
 * @param {readonly string[]} keys - The keys, lower-cased.
 * @returns {string} The key.
 */
function listKey(censor: string, keys: readonly string[]): string {
  const unique = [...new Set(keys)]
  unique.sort()
  return JSON.stringify([censor, unique])
}

/**
 * A `Redactor` that writes `censor` in place of the whole value under any key in
 * `keys`, at any depth: a field, a Context Field, a binding, an `args` item's
 * key, a key of an `Error`'s serialized shape (`err`, `errors`, a `cause`, an
 * `Error` nested anywhere), an object inside any of them. Keys match whatever
 * their case (`Authorization`, `authorization`), and only whole keys
 * (`password` does not match `passwordHint`). The value is replaced whole,
 * whatever it is: an object under a matching key is not written at all.
 *
 * It has no list of its own: which keys are sensitive is the application's
 * call. It matches keys, never text: a secret inside `message`, or inside any
 * other string (a `%j` placeholder prints an object into the message), is not
 * found, and neither is one in a `Map` (written as `[key, value]` pairs). The
 * top-level `time`, `level` and trace IDs are never redacted.
 *
 * The same keys (in any case or order, repeats ignored) and `censor` give the
 * same `Redactor`, so `redactKeys([...])` written inline in a Workers helper's
 * options still gives that helper one Root Logger.
 *
 * @param {readonly string[]} keys - The keys whose values to hide.
 * @param {RedactKeysOptions} [options] - `censor`: what to write instead. Default `'[REDACTED]'`.
 * @returns {Redactor} The redactor, for `redact` in Logger Options.
 * @throws {TypeError} When `keys` is not an array of strings, or `censor` is not a string.
 *
 * @example
 * ```ts
 * createLogger({ service, redact: redactKeys(['authorization', 'cookie', 'password']) })
 * // logger.info({ headers: { Authorization: 'Bearer abc' } }) → "headers":{"Authorization":"[REDACTED]"}
 * ```
 */
export function redactKeys(keys: readonly string[], options: RedactKeysOptions = {}): Redactor {
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string'))
    throw new TypeError('redactKeys: keys must be an array of strings')
  const { censor = DEFAULT_CENSOR } = options ?? {}
  if (typeof censor !== 'string') throw new TypeError('redactKeys: censor must be a string')
  const lower = keys.map((key) => key.toLowerCase())
  const key = listKey(censor, lower)
  let cached = byKeys.get(key)
  if (!cached) {
    cached = keyRedactor(new Set(lower), censor)
    if (byKeys.size < MAX_KEY_LISTS) byKeys.set(key, cached)
  }
  return cached
}

/**
 * `redactKeys()`, once its arguments are checked: a new, frozen `Redactor`.
 *
 * @param {ReadonlySet<string>} keys - The keys, lower-cased.
 * @param {string} censor - What to write instead.
 * @returns {Redactor} The redactor.
 */
function keyRedactor(keys: ReadonlySet<string>, censor: string): Redactor {
  const matches = matcher(keys)
  return Object.freeze({
    value(value: unknown, path: readonly string[]): unknown {
      return path.length > 0 && matches(path[path.length - 1]!) ? censor : value
    },
  })
}

/**
 * Whether a path key is one of `keys`, whatever its case. The answer for each
 * key is remembered (up to `MAX_KNOWN_KEYS` of them), so a line's keys are
 * lower-cased once per isolate, not once per line.
 *
 * @param {ReadonlySet<string>} keys - The keys, lower-cased.
 * @returns {(key: string) => boolean} The test.
 */
function matcher(keys: ReadonlySet<string>): (key: string) => boolean {
  const known = new Map<string, boolean>()
  return (key) => {
    let match = known.get(key)
    if (match === undefined) {
      match = keys.has(key.toLowerCase())
      if (known.size < MAX_KNOWN_KEYS) known.set(key, match)
    }
    return match
  }
}
