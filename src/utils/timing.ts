/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Waiting primitives, in one place so the reference semantics are
 * decided once.
 *
 * The distinction matters and is easy to get wrong. A timer inside an operation
 * somebody is awaiting must keep the event loop alive: an unreferenced timer
 * there lets Node decide the process has nothing left to do and exit while a
 * caller is still waiting for an answer.
 *
 * The opposite applies to a timer nothing is waiting on, such as a reconnect
 * backoff inside a loop that can be cancelled. Those are always cleared rather
 * than merely unreferenced, so shutdown is immediate instead of waiting out a
 * delay that has been rendered pointless.
 */

/**
 * Wait, keeping the process alive for the duration.
 *
 * For use inside an operation a caller is awaiting.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

/** A wait that can be abandoned before it elapses. */
export interface InterruptibleSleep {
  /** Resolves when the delay elapses or {@link interrupt} is called. */
  readonly promise: Promise<void>
  /** Resolve now and cancel the underlying timer. */
  interrupt(): void
}

/**
 * Wait, but allow the wait to be cut short.
 *
 * The timer is cleared on interruption, so nothing is left holding the event
 * loop open once the delay is no longer wanted.
 */
export function interruptibleSleep(ms: number): InterruptibleSleep {
  let cancel = (): void => {}
  const promise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    cancel = (): void => {
      clearTimeout(timer)
      resolve()
    }
  })
  return { promise, interrupt: () => cancel() }
}

/** Returned by {@link raceTimeout} when the deadline came first. */
export const TIMED_OUT: unique symbol = Symbol('timed out')

/**
 * Race work against a deadline, without leaving the timer behind.
 *
 * The work is not cancelled when the deadline wins. That is the caller's
 * decision. The timer is always cleared, so a fast result does not leave a
 * pending timer holding the process open.
 */
export async function raceTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  const deadline = interruptibleSleep(ms)
  const expired: Promise<typeof TIMED_OUT> = deadline.promise.then(() => TIMED_OUT)
  try {
    return await Promise.race<T | typeof TIMED_OUT>([work, expired])
  } finally {
    deadline.interrupt()
  }
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter rather than a fixed delay, and not only to be tidy: this plugin
 * talks to a vendor's shared cloud, so every installation that loses its
 * connection at the same moment (a regional outage, a certificate rotation)
 * would otherwise retry in lockstep and arrive as one burst the moment the
 * service came back. Randomising over the whole window, not around it,
 * is what spreads a fleet out.
 *
 * The exponent is capped before it is applied so that a long outage cannot turn
 * the shift into an overflow.
 */
export function backoffDelayMs(input: {
  attempt: number
  baseMs: number
  maxMs: number
  random?: () => number
}): number {
  const { attempt, baseMs, maxMs, random = Math.random } = input
  const exponent = Math.min(Math.max(attempt - 1, 0), 16)
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent)
  return Math.round(ceiling * random())
}
