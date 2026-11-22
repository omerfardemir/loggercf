// Type tests for Span options. Not run by vitest: `pnpm typecheck` compiles this file,
// so a call that should compile and doesn't (or a `@ts-expect-error` that no longer
// errors) fails the build.
import { createLogger, withSpan } from './logger'
import type { Span, SpanOptions } from './types'
import { TracedSession } from '../workers'

export async function spanOptions(): Promise<void> {
  // A zero-argument function still works, sync or async, and the return type is kept.
  const n: number = withSpan('sync', () => 1)
  const s: Promise<string> = withSpan('async', async () => 'x')

  // The function may take the Span's handle.
  const hit: boolean = await withSpan('cache.read', async (span: Span) => {
    span.set({ hit: true, size: 3, tags: ['a'], at: new Date(), none: null })
    return true
  })

  withSpan('db', () => 1, { level: 'debug', slowMs: 500, fields: { table: 'users' } })
  withSpan('db', () => 1, {})

  // @ts-expect-error 'silent' is a logger level, not a Span level
  withSpan('db', () => 1, { level: 'silent' })
  // @ts-expect-error slowMs is a number of milliseconds
  withSpan('db', () => 1, { slowMs: '500' })
  // @ts-expect-error unknown option
  withSpan('db', () => 1, { sampled: true })
  withSpan('db', (span) => {
    // @ts-expect-error Span Fields are LogFields
    span.set('hit')
  })

  createLogger({ service: 'svc', spans: { level: 'debug', slowMs: 100 } })
  // @ts-expect-error fields are per Span, not a Span Default
  createLogger({ service: 'svc', spans: { fields: { a: 1 } } })

  const options: SpanOptions = { level: 'trace' }
  void [n, s, hit, options]
}

export class TypedSession extends TracedSession {
  zeroArg(): number {
    return this.traced(() => 1)
  }

  named(): number {
    return this.traced(() => 1, 'op')
  }

  withOptions(operation: string | undefined): Promise<string> {
    return this.traced(
      async (span) => {
        span.set({ rows: 1 })
        return 'x'
      },
      operation,
      { level: 'debug', slowMs: 100, fields: { table: 'users' } },
    )
  }
}
