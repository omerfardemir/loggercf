// Type tests for the log methods. Not run by vitest: `pnpm typecheck` compiles
// this file, so a call that should compile and doesn't (or a `@ts-expect-error`
// that no longer errors) fails the build.
import type { LogFields, Logger } from './types'

interface AppFields extends LogFields {
  userId: string
  tenant?: string
}

export function callStyles(
  logger: Logger,
  typed: Logger<AppFields>,
  caught: unknown,
  // oxlint-disable-next-line no-explicit-any -- a value typed `any` must be accepted
  loose: any,
  either: string | Error,
  maybe: Error | undefined,
  maybeNull: Error | null,
): void {
  const err = new Error('boom')

  // Console style.
  logger.info('x', { a: 1 })
  logger.error('x', err)
  logger.info('a', 'b', 3)
  logger.info('user %s signed in', 'ada', { plan: 'pro' })
  logger.error('failed', caught)
  logger.warn('plain')

  // Structured style.
  logger.info({ userId: 42 }, 'user signed in')
  logger.info({ a: 1 }, 'structured with extra', { b: 2 })
  logger.error(err)
  logger.error(err, 'failed %s', 'job')
  logger.error({ err: caught }, 'x')
  logger.info({ nested: { deep: [1, 2] }, when: new Date() })

  // An object whose type is an interface (no index signature) is accepted.
  const span: { operation: string; duration: number } = { operation: 'op', duration: 1 }
  logger.info({ span }, 'span.end %s', 'op')
  interface Payload {
    id: string
  }
  const payload: Payload = { id: 'p-1' }
  logger.info(payload, 'got payload')

  // Declared fields autocomplete and are checked; others are free.
  typed.info({ userId: 'u-1', extra: true }, 'typed')
  typed.info({ tenant: 'acme' })
  // @ts-expect-error userId is declared as a string
  typed.info({ userId: 42 }, 'wrong type')

  // A value typed `unknown` or `any` (a `catch` binding).
  try {
    logger.info('work')
  } catch (e) {
    logger.error(e)
    logger.error(e, 'failed')
    logger.error(e, 'failed %s', 'job', { a: 1 })
    typed.error(e, 'typed failed')
  }
  logger.error(caught)
  logger.error(loose)
  logger.error(loose, 'loose')

  // A union first argument.
  logger.error(either)
  logger.error(either, 'failed %s', 'job')
  logger.error(maybe)
  logger.error(maybe, 'maybe failed')
  logger.error(maybe, 'failed %s', 'id1')
  logger.error(maybeNull)
  logger.error(maybeNull, 'failed %s', 'id1')
  typed.error(either, 'typed')

  // @ts-expect-error the message after an object must be a string
  logger.info({ a: 1 }, 42)
  // @ts-expect-error the message after an Error must be a string
  logger.error(err, { a: 1 })
  // @ts-expect-error a log method needs a message, an Error or fields first
  logger.info(42)
  // @ts-expect-error a log method needs a message, an Error or fields first
  logger.info(true)
  // @ts-expect-error the message after an unknown value must be a string
  logger.error(caught, { a: 1 })
  // @ts-expect-error the message after a union must be a string
  logger.error(either, { a: 1 })
  // @ts-expect-error userId is declared as a string (no fallback overload takes it)
  typed.info({ userId: 42 })
}

// A generic `Logger<T>` cannot take a structured call: `KnownFields<T>` cannot
// be checked against an unresolved `T`. Console-style calls still work.
export function generic<T extends LogFields>(logger: Logger<T>): void {
  logger.info('console style %s', 'ok', { a: 1 })
  logger.error(new Error('boom'), 'error first')
  // @ts-expect-error structured calls need a concrete T
  logger.info({ a: 1 }, 'structured')
}
