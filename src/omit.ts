import type { ErrorSerializer } from './types'
import {
  describeFailure,
  errorTypeName,
  invalidResult,
  isError,
  isPlainObject,
  readEntries,
} from './output'

/**
 * Whether `error` has an own property `key`, never throwing: one that can't
 * be told (a `Proxy` whose traps throw) counts as present, so it is left out.
 *
 * @param {Error} error - The `Error`.
 * @param {string} key - The key.
 * @returns {boolean} `true` when it is, or may be, an own property.
 */
function hasOwn(error: Error, key: string): boolean {
  try {
    return Object.hasOwn(error, key)
  } catch {
    return true
  }
}

/**
 * The serializers `omitErrorKeys(keys)` built without a `serializer`, by their
 * keys, sorted and without repeats (see `keysKey()`). So a call made again with
 * the same keys, in any order, gives the same function, and a Workers helper
 * the same Root Logger for it.
 */
const byKeys = new Map<string, ErrorSerializer>()

/** `byKeys` stops growing at this many key lists; past it, each call builds a new function. */
const MAX_KEY_LISTS = 64

/**
 * The `byKeys` key for a key list: its keys, sorted and without repeats, as
 * they don't change what is left out.
 *
 * @param {readonly string[]} keys - The keys.
 * @returns {string} The key.
 */
function keysKey(keys: readonly string[]): string {
  const unique = [...new Set(keys)]
  unique.sort()
  return JSON.stringify(unique)
}

/**
 * An `ErrorSerializer` that leaves the given own keys of every `Error` out of
 * the line, at any depth, and lists the ones it left out as `omitted`, so a
 * reader knows they were there. A key the `Error` doesn't have as an own
 * property (or one `serializer` added) is never left out. loggercf has no
 * list of its own: which keys hold user data or large payloads is the
 * application's call.
 *
 * `type` is a Protected Field, so it is never left out: for an `Error` with an
 * own `type` property, `'type'` in `keys` writes the class name as `type` (as
 * the default shape does), whatever `serializer` put there, and lists `type`
 * in `omitted`.
 *
 * Without `serializer`, the same keys (in any order, repeats ignored) give the
 * same function, so `omitErrorKeys([...])` written inline in a hook or a call
 * still gives a Workers helper one Root Logger.
 *
 * With `serializer`, its result is what the keys are left out of, and the
 * `defaultSerialize` it is given leaves them out too, for any other `Error`
 * it serializes that way. When it throws, or returns anything but an object
 * (or a Promise), the `Error` is written in its default shape, without the
 * keys, and with `serializeErrorFailed`. Each call with a `serializer` gives
 * a new function: make it once, at module scope.
 *
 * @param {readonly string[]} keys - The own keys to leave out.
 * @param {ErrorSerializer} [serializer] - A serializer to wrap.
 * @returns {ErrorSerializer} The serializer, for `serializeError` in Logger Options.
 * @throws {TypeError} When `keys` is not an array of strings, or `serializer` is not a function.
 *
 * @example
 * ```ts
 * createLogger({ service, serializeError: omitErrorKeys(['requestBodyValues', 'responseBody']) })
 * // "err":{"type":"APICallError","message":"rate limited","stack":"…","omitted":["requestBodyValues","responseBody"]}
 * ```
 */
export function omitErrorKeys(
  keys: readonly string[],
  serializer?: ErrorSerializer,
): ErrorSerializer {
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string'))
    throw new TypeError('omitErrorKeys: keys must be an array of strings')
  if (serializer !== undefined && typeof serializer !== 'function')
    throw new TypeError('omitErrorKeys: serializer must be a function')
  if (serializer) return omitting(keys, serializer)
  const key = keysKey(keys)
  let cached = byKeys.get(key)
  if (!cached) {
    cached = omitting(keys)
    if (byKeys.size < MAX_KEY_LISTS) byKeys.set(key, cached)
  }
  return cached
}

/**
 * `omitErrorKeys()`, once its arguments are checked: a new function.
 *
 * @param {readonly string[]} keys - The own keys to leave out.
 * @param {ErrorSerializer} [serializer] - A serializer to wrap.
 * @returns {ErrorSerializer} The serializer.
 */
function omitting(keys: readonly string[], serializer?: ErrorSerializer): ErrorSerializer {
  const omit = new Set(keys)

  /**
   * `out` without `error`'s own keys in `omit`.
   *
   * @param {Error} error - The `Error` `out` was written for.
   * @param {unknown} out - What it was written as.
   * @param {(e: Error) => Record<string, unknown>} defaultSerialize - The default shape, for an `Error` result.
   * @param {string} [failed] - Why `serializer`'s result can't be written, if it can't.
   * @returns {Record<string, unknown>} The copy, with `omitted` (and `serializeErrorFailed`).
   */
  const without = (
    error: Error,
    out: unknown,
    defaultSerialize: (e: Error) => Record<string, unknown>,
    failed?: string,
  ): Record<string, unknown> => {
    if (isError(out)) {
      error = out
      out = defaultSerialize(out)
    }
    if (!isPlainObject(out)) return out as Record<string, unknown>
    const copy: Record<string, unknown> = Object.create(null) // `out` may have an own `__proto__` key
    const omitted: string[] = []
    for (const [key, value] of readEntries(out)) {
      if (!omit.has(key) || !hasOwn(error, key)) copy[key] = value
      else {
        omitted.push(key)
        // A Protected Field: the class name stands in for the own `type`.
        if (key === 'type') copy.type = errorTypeName(error)
      }
    }
    if (omitted.length > 0) copy.omitted = omitted
    if (failed !== undefined) copy.serializeErrorFailed = failed
    return copy
  }

  return (err, defaultSerialize) => {
    if (!serializer) return without(err, defaultSerialize(err), defaultSerialize)
    // `err` itself is left out of afterwards, so its `omitted` lists what this call removed.
    const omittingDefault = (e: Error) =>
      e === err ? defaultSerialize(e) : without(e, defaultSerialize(e), defaultSerialize)
    let failed: string | undefined
    try {
      const result = serializer(err, omittingDefault)
      failed = invalidResult(result)
      if (failed === undefined) return without(err, result, defaultSerialize)
    } catch (thrown) {
      failed = describeFailure(thrown)
    }
    return without(err, defaultSerialize(err), defaultSerialize, failed)
  }
}
