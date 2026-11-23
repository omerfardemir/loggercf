import type { Redactor, RedactKeysOptions } from '../core/types'

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
 * The longest path key a redactor remembers the answer for: a longer one (a
 * token, or a key an attacker chose) is folded again each time, so the memo
 * holds at most `MAX_KNOWN_KEYS` short keys, not megabytes of long ones.
 */
const MAX_KNOWN_KEY_LENGTH = 64

/**
 * A key as it is compared: Unicode-normalized (NFC) and lower-cased. A simple
 * case fold, so `ß` does not match `ss`.
 *
 * @param {string} key - A key.
 * @returns {string} The key to compare.
 */
const fold = (key: string): string => key.normalize('NFC').toLowerCase()

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
 * `Error` nested anywhere), an object inside any of them, a `Map` entry whose
 * key is a string. Keys match whatever their case (`Authorization`,
 * `authorization`), and only whole keys (`password` does not match
 * `passwordHint`). Both sides are Unicode-normalized (NFC) and lower-cased:
 * a simple case fold, so `ß` does not match `ss`. The value is replaced
 * whole, whatever it is: an object under a matching key is not written at all.
 * (`censor` is a string value like any other: `maxStringLength` cuts it too, if
 * it is longer.)
 *
 * It has no list of its own: which keys are sensitive is the application's
 * call. It matches keys, never text: a secret inside `message`, or inside any
 * other string (a `%j` placeholder prints an object into the message), is not
 * found. The top-level `time`, `level` and trace IDs are never redacted.
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
  const lower = keys.map(fold)
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
 * Whether a path key is one of `keys`, whatever its case (see `fold()`). The
 * answer for a key of up to `MAX_KNOWN_KEY_LENGTH` characters is remembered
 * (for up to `MAX_KNOWN_KEYS` of them), so a line's keys are folded once per
 * isolate, not once per line; a longer key is folded each time.
 *
 * @param {ReadonlySet<string>} keys - The keys, lower-cased.
 * @returns {(key: string) => boolean} The test.
 */
function matcher(keys: ReadonlySet<string>): (key: string) => boolean {
  const known = new Map<string, boolean>()
  return (key) => {
    if (key.length > MAX_KNOWN_KEY_LENGTH) return keys.has(fold(key))
    let match = known.get(key)
    if (match === undefined) {
      match = keys.has(fold(key))
      if (known.size < MAX_KNOWN_KEYS) known.set(key, match)
    }
    return match
  }
}
