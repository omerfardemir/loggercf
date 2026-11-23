import { describe, it, expect } from 'vitest'
import {
  generateTraceId,
  generateSpanId,
  parseTraceparent,
  buildTraceparent,
  resolveTrace,
  toCarrier,
  extractCarrier,
  injectCarrier,
} from './trace'

describe('generateTraceId', () => {
  it('returns a 32-character lowercase hex string', () => {
    const id = generateTraceId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('generateSpanId', () => {
  it('returns a 16-character lowercase hex string', () => {
    const id = generateSpanId()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('ID uniqueness', () => {
  it('generates unique trace IDs across 1000 calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateTraceId()))
    expect(ids.size).toBe(1000)
  })

  it('generates unique span IDs across 1000 calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateSpanId()))
    expect(ids.size).toBe(1000)
  })
})

describe('parseTraceparent', () => {
  it('parses a valid traceparent header', () => {
    const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    const result = parseTraceparent(header)
    expect(result).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    })
  })

  it.each([
    ['wrong version', '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'],
    ['too few segments', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331'],
    ['too many segments', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra'],
    ['invalid hex in traceId', '00-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ-b7ad6b7169203331-01'],
    ['short traceId', '00-0af7651916cd43dd-b7ad6b7169203331-01'],
    ['short spanId', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b71-01'],
    ['all-zero traceId', '00-00000000000000000000000000000000-b7ad6b7169203331-01'],
    ['all-zero spanId', '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01'],
    ['empty string', ''],
  ])('returns null for %s', (_label, header) => {
    expect(parseTraceparent(header)).toBeNull()
  })
})

describe('buildTraceparent', () => {
  it('produces a valid W3C traceparent string', () => {
    const ctx = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    }
    expect(buildTraceparent(ctx)).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
  })

  it('round-trips through parseTraceparent', () => {
    const ctx = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      traceFlags: 0,
    }
    const header = buildTraceparent(ctx)
    const parsed = parseTraceparent(header)
    expect(parsed).toEqual(ctx)
  })
})

describe('resolveTrace', () => {
  it('generates a new root trace with sampled flag when no traceparent', () => {
    const trace = resolveTrace(undefined)
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(trace.parentSpanId).toBeUndefined()
    expect(trace.traceFlags).toBe(0x01)
  })

  it('preserves sampled flag from incoming traceparent', () => {
    const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    const trace = resolveTrace(header)
    expect(trace.traceFlags).toBe(1)
    expect(trace.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
  })

  it('preserves unsampled flag from incoming traceparent', () => {
    const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00'
    const trace = resolveTrace(header)
    expect(trace.traceFlags).toBe(0)
  })

  it('keeps tracestate with a valid traceparent', () => {
    const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    expect(resolveTrace(header, 'congo=t61rcWkgMzE').tracestate).toBe('congo=t61rcWkgMzE')
  })

  it('ignores tracestate when traceparent is missing or invalid (W3C)', () => {
    expect(resolveTrace(undefined, 'congo=t61rcWkgMzE').tracestate).toBeUndefined()
    expect(resolveTrace(null, 'congo=t61rcWkgMzE')).not.toHaveProperty('tracestate')
    expect(resolveTrace('00-bad-01', 'congo=t61rcWkgMzE')).not.toHaveProperty('tracestate')
    const allZero = `00-${'0'.repeat(32)}-b7ad6b7169203331-01`
    expect(resolveTrace(allZero, 'congo=t61rcWkgMzE')).not.toHaveProperty('tracestate')
  })
})

describe('Trace Carrier', () => {
  const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

  it('toCarrier includes tracestate only when present', () => {
    const trace = resolveTrace(TP)
    expect(toCarrier(trace)).toEqual({ traceparent: buildTraceparent(trace) })
    expect(toCarrier({ ...trace, tracestate: 'v=1' })).toEqual({
      traceparent: buildTraceparent(trace),
      tracestate: 'v=1',
    })
  })

  it('extractCarrier omits absent or empty headers', () => {
    const headers = new Headers({ traceparent: TP })
    expect(extractCarrier((n) => headers.get(n))).toEqual({ traceparent: TP })
    expect(extractCarrier(() => undefined)).toEqual({})
    expect(extractCarrier(() => '')).toEqual({})
  })

  it('injectCarrier writes only present values and round-trips with extractCarrier', () => {
    const headers = new Headers()
    injectCarrier({ traceparent: TP }, (n, v) => headers.set(n, v))
    expect(headers.has('tracestate')).toBe(false)

    injectCarrier({ traceparent: TP, tracestate: 'v=1' }, (n, v) => headers.set(n, v))
    expect(extractCarrier((n) => headers.get(n))).toEqual({ traceparent: TP, tracestate: 'v=1' })
  })
})
