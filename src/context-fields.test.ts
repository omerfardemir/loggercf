import { describe, it, expect, beforeEach } from 'vitest'
import {
  createLogger,
  currentContextFields,
  runWithLogger,
  setLoggerContext,
  withSpan,
  _captureEntries,
  _reset,
} from './logger'
import * as core from './index'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

describe('currentContextFields', () => {
  beforeEach(() => {
    _reset()
    _captureEntries()
  })

  it('is exported from the package entry', () => {
    expect(core.currentContextFields).toBe(currentContextFields)
  })

  it('is {} outside a Logging Context', () => {
    expect(currentContextFields()).toEqual({})
  })

  it('holds the Context Fields and the trace IDs of the current Logging Context', () => {
    const logger = createLogger({ service: 'api' })
    runWithLogger({ logger, traceparent: TRACEPARENT, fields: { requestId: 'r-1' } }, () => {
      setLoggerContext({ userId: 42 })
      const fields = currentContextFields()
      expect(fields).toEqual({
        requestId: 'r-1',
        userId: 42,
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        parentSpanId: 'b7ad6b7169203331',
      })
    })
  })

  it('leaves parentSpanId out of a root trace', () => {
    runWithLogger({ logger: createLogger({ service: 'api' }) }, () => {
      expect(currentContextFields()).not.toHaveProperty('parentSpanId')
      expect(currentContextFields()).toHaveProperty('traceId')
    })
  })

  it('follows a Span: its own span ID, the outer one as its parent', () => {
    runWithLogger({ logger: createLogger({ service: 'api' }) }, () => {
      const outer = currentContextFields()
      withSpan('db.query', () => {
        const inner = currentContextFields()
        expect(inner.traceId).toBe(outer.traceId)
        expect(inner.parentSpanId).toBe(outer.spanId)
        expect(inner.spanId).not.toBe(outer.spanId)
      })
    })
  })

  it('writes the trace IDs over Context Fields of the same name', () => {
    runWithLogger({ logger: createLogger({ service: 'api' }), traceparent: TRACEPARENT }, () => {
      setLoggerContext({ traceId: 'spoofed', spanId: 'spoofed', parentSpanId: 'spoofed' })
      expect(currentContextFields()).toMatchObject({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        parentSpanId: 'b7ad6b7169203331',
      })
      expect(currentContextFields().spanId).not.toBe('spoofed')
    })
  })

  it('is a copy: changing it changes no Context Field', () => {
    runWithLogger(
      { logger: createLogger({ service: 'api' }), fields: { requestId: 'r-1' } },
      () => {
        const fields = currentContextFields()
        fields.requestId = 'changed'
        expect(currentContextFields().requestId).toBe('r-1')
      },
    )
  })

  it('a parentSpanId Context Field does not reach a root trace', () => {
    runWithLogger({ logger: createLogger({ service: 'api' }) }, () => {
      setLoggerContext({ parentSpanId: 'spoofed' })
      expect(currentContextFields()).not.toHaveProperty('parentSpanId')
    })
  })
})
