import { describe, it, expect, beforeEach } from 'vitest'
import { loggerOptionsFromEnv } from './env'
import { _captureEntries, _reset, createLogger } from './logger'

describe('loggerOptionsFromEnv', () => {
  beforeEach(() => {
    _reset()
  })

  it('reads NAME, LOG_LEVEL, ENVIRONMENT and VERSION by default', () => {
    expect(
      loggerOptionsFromEnv({
        NAME: 'api',
        LOG_LEVEL: 'debug',
        ENVIRONMENT: 'production',
        VERSION: '1.2.3',
      }),
    ).toStrictEqual({
      service: 'api',
      level: 'debug',
      environment: 'production',
      version: '1.2.3',
    })
  })

  it('omits absent environment and version; service falls back to unknown', () => {
    expect(loggerOptionsFromEnv({})).toStrictEqual({ service: 'unknown', level: 'info' })
  })

  it('treats empty strings and non-string values as absent', () => {
    expect(
      loggerOptionsFromEnv({ NAME: '', LOG_LEVEL: '', ENVIRONMENT: { stage: 'x' }, VERSION: null }),
    ).toStrictEqual({ service: 'unknown', level: 'info' })
  })

  it('uses a numeric var as its string form', () => {
    expect(loggerOptionsFromEnv({ NAME: 'api', VERSION: 2 })).toStrictEqual({
      service: 'api',
      level: 'info',
      version: '2',
    })
  })

  it('omits absent fields from every log line', () => {
    const entries = _captureEntries()
    createLogger(loggerOptionsFromEnv({ NAME: 'api' })).info('hello')

    expect(entries[0]).toMatchObject({ service: 'api' })
    expect(entries[0]).not.toHaveProperty('environment')
    expect(entries[0]).not.toHaveProperty('version')
  })

  it('reads a field from another var name', () => {
    expect(
      loggerOptionsFromEnv({ NAME: 'api', RELEASE: 'abc123' }, { version: 'RELEASE' }),
    ).toStrictEqual({ service: 'api', level: 'info', version: 'abc123' })
  })

  it('does not fall back to the default var when a field is mapped', () => {
    expect(loggerOptionsFromEnv({ VERSION: '1.0.0' }, { version: 'RELEASE' })).not.toHaveProperty(
      'version',
    )
  })

  it('derives a field with a function', () => {
    const env = {
      SERVICE_NAME: 'billing',
      CF_VERSION_METADATA: { id: 'v-1', tag: 'release-7', timestamp: '' },
    }

    expect(
      loggerOptionsFromEnv(env, {
        service: 'SERVICE_NAME',
        version: (e) => e.CF_VERSION_METADATA.tag || e.CF_VERSION_METADATA.id,
        environment: () => 'staging',
        level: () => 'warn',
      }),
    ).toStrictEqual({
      service: 'billing',
      level: 'warn',
      environment: 'staging',
      version: 'release-7',
    })
  })

  it('treats a function returning undefined as absent', () => {
    expect(
      loggerOptionsFromEnv({ NAME: 'api' }, { service: () => undefined, version: () => undefined }),
    ).toStrictEqual({ service: 'unknown', level: 'info' })
  })

  describe('LOG_LEVEL validation', () => {
    it('falls back to info for an invalid level and warns with the invalid and valid values', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({ NAME: 'api', LOG_LEVEL: 'verbose' }).level).toBe('info')

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        level: 'WARN',
        service: 'api',
        invalidLevel: 'verbose',
        validLevels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'],
      })
      expect(entries[0].message).toContain('LOG_LEVEL')
    })

    it('warns once per isolate, however often options are built', () => {
      const entries = _captureEntries()

      loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' })
      loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' })
      loggerOptionsFromEnv({ LOG_LEVEL: 'loud' })

      expect(entries).toHaveLength(1)
    })

    it('names the mapped var in the warning', () => {
      const entries = _captureEntries()

      loggerOptionsFromEnv({ LEVEL: 'verbose' }, { level: 'LEVEL' })

      expect(entries[0].message).toContain('LEVEL')
      expect(entries[0].message).not.toContain('LOG_LEVEL')
    })

    it('validates a level returned by a function', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({}, { level: () => 'loud' }).level).toBe('info')
      expect(entries).toHaveLength(1)
    })

    it('does not warn for valid or absent levels', () => {
      const entries = _captureEntries()

      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
        expect(loggerOptionsFromEnv({ LOG_LEVEL: level }).level).toBe(level)
      }
      loggerOptionsFromEnv({})

      expect(entries).toHaveLength(0)
    })

    it('rejects uppercase levels', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({ LOG_LEVEL: 'DEBUG' }).level).toBe('info')
      expect(entries).toHaveLength(1)
    })

    it('accepts "silent", as 0.0.1 did: the logger writes nothing, at any level, and no WARN', () => {
      const entries = _captureEntries()

      const options = loggerOptionsFromEnv({ NAME: 'api', LOG_LEVEL: 'silent' })
      expect(options).toStrictEqual({ service: 'api', level: 'silent' })
      const logger = createLogger(options)
      for (const log of [logger, logger.child({ part: 'x' })]) {
        log.trace('t')
        log.debug('d')
        log.info('i')
        log.warn('w')
        log.error(new Error('e'))
        log.fatal({ code: 1 }, 'f')
      }

      expect(entries).toHaveLength(0)
    })

    it('accepts "silent" from a mapped var or a function', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({ LEVEL: 'silent' }, { level: 'LEVEL' }).level).toBe('silent')
      expect(loggerOptionsFromEnv({}, { level: () => 'silent' }).level).toBe('silent')
      expect(entries).toHaveLength(0)
    })

    it('rejects uppercase "SILENT", like the other levels', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({ LOG_LEVEL: 'SILENT' }).level).toBe('info')
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ level: 'WARN', invalidLevel: 'SILENT' })
    })

    it('_reset() re-arms the warning', () => {
      const entries = _captureEntries()

      loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' })
      _reset()
      loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' })

      expect(entries).toHaveLength(2)
    })
  })

  describe('Span Defaults: LOG_SPAN_LEVEL and LOG_SPAN_SLOW_MS', () => {
    it('reads them as spans.level and spans.slowMs', () => {
      expect(
        loggerOptionsFromEnv({ NAME: 'api', LOG_SPAN_LEVEL: 'debug', LOG_SPAN_SLOW_MS: '250' }),
      ).toStrictEqual({ service: 'api', level: 'info', spans: { level: 'debug', slowMs: 250 } })
    })

    it('leaves spans out when neither is set, and each out when absent', () => {
      expect(loggerOptionsFromEnv({ LOG_SPAN_LEVEL: '' })).toStrictEqual({
        service: 'unknown',
        level: 'info',
      })
      expect(loggerOptionsFromEnv({ LOG_SPAN_SLOW_MS: 0 }).spans).toStrictEqual({ slowMs: 0 })
      expect(loggerOptionsFromEnv({ LOG_SPAN_LEVEL: 'trace' }).spans).toStrictEqual({
        level: 'trace',
      })
    })

    it('reads a numeric var, a fraction and Infinity as the threshold', () => {
      expect(loggerOptionsFromEnv({ LOG_SPAN_SLOW_MS: 500 }).spans).toStrictEqual({ slowMs: 500 })
      expect(loggerOptionsFromEnv({ LOG_SPAN_SLOW_MS: '12.5' }).spans).toStrictEqual({
        slowMs: 12.5,
      })
      expect(loggerOptionsFromEnv({ LOG_SPAN_SLOW_MS: 'Infinity' }).spans).toStrictEqual({
        slowMs: Infinity,
      })
    })

    it('reads them from mapped vars or functions', () => {
      const env = { SPAN_LVL: 'warn', SLOW: '75' }
      expect(
        loggerOptionsFromEnv(env, { spanLevel: 'SPAN_LVL', spanSlowMs: (e) => e.SLOW }).spans,
      ).toStrictEqual({ level: 'warn', slowMs: 75 })
      // A mapped field never falls back to the default var.
      expect(
        loggerOptionsFromEnv({ LOG_SPAN_LEVEL: 'debug' }, { spanLevel: 'OTHER' }).spans,
      ).toBeUndefined()
    })

    it.each([['loud'], ['silent'], ['DEBUG']])(
      'leaves out an invalid LOG_SPAN_LEVEL (%s) and warns once per isolate',
      (value) => {
        const entries = _captureEntries()
        const env = { NAME: 'api', LOG_SPAN_LEVEL: value, LOG_SPAN_SLOW_MS: '10' }
        expect(loggerOptionsFromEnv(env).spans).toStrictEqual({ slowMs: 10 })
        loggerOptionsFromEnv(env)
        expect(entries).toEqual([
          expect.objectContaining({
            level: 'WARN',
            service: 'api',
            message: `LOG_SPAN_LEVEL "${value}" is not a valid span level; using "info"`,
            invalidLevel: value,
            validLevels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
          }),
        ])
      },
    )

    it.each([['-1'], ['abc'], [' '], ['1e'], [-5]])(
      'leaves out an invalid LOG_SPAN_SLOW_MS (%s) and warns once per isolate',
      (value) => {
        const entries = _captureEntries()
        const env = { LOG_SPAN_SLOW_MS: value }
        expect(loggerOptionsFromEnv(env).spans).toBeUndefined()
        loggerOptionsFromEnv(env)
        expect(entries).toEqual([
          expect.objectContaining({
            level: 'WARN',
            message: `LOG_SPAN_SLOW_MS "${value}" is not a number of milliseconds >= 0; no slow threshold`,
            invalidSlowMs: String(value),
          }),
        ])
      },
    )

    it('names the mapped var, or the field for a function, in the warnings', () => {
      const entries = _captureEntries()
      loggerOptionsFromEnv({ L: 'nope' }, { spanLevel: 'L', spanSlowMs: () => 'x' })
      expect(entries.map((e) => e.message)).toEqual([
        'L "nope" is not a valid span level; using "info"',
        'spanSlowMs "x" is not a number of milliseconds >= 0; no slow threshold',
      ])
    })

    it('each field warns on its own: an invalid LOG_LEVEL does not silence the span warnings', () => {
      const entries = _captureEntries()
      loggerOptionsFromEnv({ LOG_LEVEL: 'x', LOG_SPAN_LEVEL: 'y', LOG_SPAN_SLOW_MS: 'z' })
      loggerOptionsFromEnv({ LOG_LEVEL: 'x', LOG_SPAN_LEVEL: 'y', LOG_SPAN_SLOW_MS: 'z' })
      expect(entries).toHaveLength(3)
    })
  })
})

describe('loggerOptionsFromEnv: limits from LOG_MAX_STRING_LENGTH and LOG_MAX_RECORD_BYTES', () => {
  beforeEach(() => _reset())

  it('reads them as limits.maxStringLength and limits.maxRecordBytes', () => {
    expect(
      loggerOptionsFromEnv({ LOG_MAX_STRING_LENGTH: '8192', LOG_MAX_RECORD_BYTES: 200_000 }).limits,
    ).toStrictEqual({ maxStringLength: 8192, maxRecordBytes: 200_000 })
    expect(loggerOptionsFromEnv({ LOG_MAX_RECORD_BYTES: '4096' }).limits).toStrictEqual({
      maxRecordBytes: 4096,
    })
  })

  it('leaves limits out when neither is set, so the options are as before', () => {
    expect(loggerOptionsFromEnv({ NAME: 'api' })).toStrictEqual({ service: 'api', level: 'info' })
  })

  it('reads mapped vars, or derives them', () => {
    expect(
      loggerOptionsFromEnv(
        { CHARS: '100', PROD: true },
        { maxStringLength: 'CHARS', maxRecordBytes: (e) => (e.PROD ? '100000' : undefined) },
      ).limits,
    ).toStrictEqual({ maxStringLength: 100, maxRecordBytes: 100_000 })
  })

  it.each([['0'], ['1.5'], ['abc'], [' '], [-3]])(
    'leaves out an invalid LOG_MAX_STRING_LENGTH (%s) and warns once per isolate',
    (value) => {
      const entries = _captureEntries()
      const env = { LOG_MAX_STRING_LENGTH: value }
      expect(loggerOptionsFromEnv(env).limits).toBeUndefined()
      loggerOptionsFromEnv(env)
      expect(entries).toEqual([
        expect.objectContaining({
          level: 'WARN',
          message: `LOG_MAX_STRING_LENGTH "${value}" is not an integer >= 1; strings are not cut`,
          invalidMaxStringLength: String(value),
        }),
      ])
    },
  )

  it.each([['1023'], ['2048.5'], ['big']])(
    'leaves out an invalid LOG_MAX_RECORD_BYTES (%s) and warns once per isolate',
    (value) => {
      const entries = _captureEntries()
      const env = { LOG_MAX_RECORD_BYTES: value }
      expect(loggerOptionsFromEnv(env).limits).toBeUndefined()
      loggerOptionsFromEnv(env)
      expect(entries).toEqual([
        expect.objectContaining({
          level: 'WARN',
          message: `LOG_MAX_RECORD_BYTES "${value}" is not an integer >= 1024; lines are not trimmed`,
          invalidMaxRecordBytes: value,
        }),
      ])
    },
  )

  it('the options it gives build a logger that applies the limits', () => {
    const entries = _captureEntries()
    createLogger(loggerOptionsFromEnv({ NAME: 'api', LOG_MAX_STRING_LENGTH: '4' })).info({
      s: 'abcdefgh',
    })
    expect(entries[0].s).toBe('abcd…[truncated from 8 chars]')
  })
})
