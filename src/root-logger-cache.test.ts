import { describe, it, expect, beforeEach } from 'vitest'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { _captureEntries, _reset } from './logger'
import { omitErrorKeys } from './omit'
import type { ErrorSerializer, Logger, LoggerOptions } from './types'
import { _resetRootLoggers, cachedRootLogger, envRootLogger } from './workers-shared'

const OPTIONS: LoggerOptions = { service: 'svc', environment: 'prod', version: '1' }

/** A serializer that writes the default shape. */
const passThrough: ErrorSerializer = (err, d) => d(err)

const WARNING = 'serializeError is a new function each call; define it once at module scope'

/**
 * Node's `gc()`, turned on at runtime; `undefined` where the flag can't be set.
 *
 * @returns {(() => void) | undefined} A full garbage collection.
 */
function exposeGc(): (() => void) | undefined {
  try {
    setFlagsFromString('--expose-gc')
    return runInNewContext('gc') as () => void
  } catch {
    return undefined
  }
}

const gc = exposeGc()

describe('the Root Logger cache and serializeError', () => {
  beforeEach(() => {
    _reset()
    _resetRootLoggers()
  })

  it('an inline omitErrorKeys gives one Root Logger, however many times it is called', () => {
    const roots = new Set<Logger>()
    for (let i = 0; i < 1_000; i++) {
      roots.add(cachedRootLogger({ ...OPTIONS, serializeError: omitErrorKeys(['body', 'prompt']) }))
      // The same keys in another order, or repeated, are the same serializer.
      roots.add(
        cachedRootLogger({ ...OPTIONS, serializeError: omitErrorKeys(['prompt', 'body', 'body']) }),
      )
    }
    expect(roots.size).toBe(1)
  })

  it('so does an inline omitErrorKeys in a helper call (withQueueMessage in the message loop)', () => {
    const roots = new Set<Logger>()
    for (let i = 0; i < 1_000; i++)
      roots.add(envRootLogger({ NAME: 'svc' }, { serializeError: omitErrorKeys(['body']) }))
    expect(roots.size).toBe(1)
  })

  it('another key list, or a wrapped serializer, is another Root Logger', () => {
    const plain = cachedRootLogger(OPTIONS)
    const body = cachedRootLogger({ ...OPTIONS, serializeError: omitErrorKeys(['body']) })
    const prompt = cachedRootLogger({ ...OPTIONS, serializeError: omitErrorKeys(['prompt']) })
    expect(new Set([plain, body, prompt]).size).toBe(3)
    expect(omitErrorKeys(['body'], passThrough)).not.toBe(omitErrorKeys(['body'], passThrough))
    expect(cachedRootLogger(OPTIONS)).toBe(plain)
  })

  it('the same function with the same other options is the same Root Logger; other options are not', () => {
    const serializeError = passThrough
    const a = cachedRootLogger({ ...OPTIONS, serializeError })
    expect(cachedRootLogger({ ...OPTIONS, serializeError })).toBe(a)
    expect(cachedRootLogger({ ...OPTIONS, serializeError, level: 'debug' })).not.toBe(a)
    expect(cachedRootLogger({ ...OPTIONS, serializeError, level: 'debug' })).toBe(
      cachedRootLogger({ ...OPTIONS, serializeError, level: 'debug' }),
    )
  })

  it('a new serializer function on each call writes one WARN per isolate, past 16 of them', () => {
    const entries = _captureEntries()
    for (let i = 0; i < 16; i++)
      cachedRootLogger({ ...OPTIONS, serializeError: (err, d) => d(err) })
    expect(entries).toEqual([])
    for (let i = 0; i < 100; i++)
      cachedRootLogger({ ...OPTIONS, serializeError: (err, d) => d(err) })
    expect(entries).toEqual([
      expect.objectContaining({
        level: 'WARN',
        service: 'svc',
        message: WARNING,
        serializeErrorFunctions: 17,
      }),
    ])
  })

  it('an inline omitErrorKeys never writes it', () => {
    const entries = _captureEntries()
    for (let i = 0; i < 100; i++)
      cachedRootLogger({ ...OPTIONS, serializeError: omitErrorKeys(['body']) })
    expect(entries).toEqual([])
  })

  // `gc()` is turned on at runtime with `--expose-gc`. Where it can't be, this test is skipped.
  it.skipIf(!gc)(
    'the Root Loggers built for a serializer nothing else holds are garbage-collected',
    async () => {
      _captureEntries() // the WARN past 16 functions
      let collected = 0
      const registry = new FinalizationRegistry(() => collected++)
      // In a function of its own, so nothing on this stack holds the closures or loggers.
      const build = () => {
        for (let i = 0; i < 20; i++) {
          const logger = cachedRootLogger({ ...OPTIONS, serializeError: (err, d) => d(err) })
          registry.register(logger, i)
        }
      }
      build()
      for (let round = 0; round < 50; round++) {
        if (collected === 20) break
        gc!()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(collected).toBe(20)
    },
  )
})
