/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Every wait in this plugin is a wait on somebody else's cloud, so these
 * primitives decide two things a user feels directly: whether Homebridge shuts
 * down at once or sits out a five-minute reconnect delay first, and whether a
 * regional outage brings every installation back in one synchronised burst.
 */

import {
  backoffDelayMs,
  interruptibleSleep,
  raceTimeout,
  sleep,
  TIMED_OUT,
} from '../../src/utils/timing'

const BACKOFF = { baseMs: 2_000, maxMs: 300_000 }

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('sleep', () => {
  it('waits the whole delay out', async () => {
    const elapsed = jest.fn()
    const waiting = sleep(5_000).then(elapsed)

    jest.advanceTimersByTime(4_999)
    await Promise.resolve()
    expect(elapsed).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    await waiting
    expect(elapsed).toHaveBeenCalled()
  })

  it('treats a negative delay as no delay rather than never resolving', async () => {
    const waiting = sleep(-1_000)

    jest.advanceTimersByTime(1)

    await expect(waiting).resolves.toBeUndefined()
  })
})

describe('interruptibleSleep', () => {
  it('resolves the moment it is interrupted, instead of sitting out the delay', async () => {
    // This is what makes shutdown immediate while a reconnect backoff is
    // partway through a five-minute wait.
    const waiting = interruptibleSleep(300_000)

    waiting.interrupt()

    await expect(waiting.promise).resolves.toBeUndefined()
  })

  it('leaves no timer behind when it is interrupted', async () => {
    // An abandoned timer holds the event loop open, so the process lingers
    // for as long as the wait it no longer cares about.
    const waiting = interruptibleSleep(300_000)
    expect(jest.getTimerCount()).toBe(1)

    waiting.interrupt()
    await waiting.promise

    expect(jest.getTimerCount()).toBe(0)
  })

  it('resolves on time when nobody interrupts it', async () => {
    const elapsed = jest.fn()
    const waiting = interruptibleSleep(2_000)
    const observed = waiting.promise.then(elapsed)

    jest.advanceTimersByTime(1_999)
    await Promise.resolve()
    expect(elapsed).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    await observed
    expect(elapsed).toHaveBeenCalled()
  })

  it('survives being interrupted twice, which a cancelled loop will do', async () => {
    const waiting = interruptibleSleep(2_000)

    waiting.interrupt()
    waiting.interrupt()

    await expect(waiting.promise).resolves.toBeUndefined()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('ignores an interruption that arrives after the delay already elapsed', async () => {
    const waiting = interruptibleSleep(2_000)

    jest.advanceTimersByTime(2_000)
    await waiting.promise
    waiting.interrupt()

    await expect(waiting.promise).resolves.toBeUndefined()
  })
})

describe('raceTimeout', () => {
  it('reports a missed deadline as a value rather than as a thrown error', async () => {
    // A status frame that never arrives is an ordinary outcome here, not an
    // exception, and the caller handles it in the same branch as an answer.
    const neverAnswers = new Promise<string>(() => {})
    const race = raceTimeout(neverAnswers, 20_000)

    jest.advanceTimersByTime(20_000)

    await expect(race).resolves.toBe(TIMED_OUT)
  })

  it('hands back the work when the work is first', async () => {
    await expect(raceTimeout(Promise.resolve('channelstatus'), 20_000))
      .resolves.toBe('channelstatus')
  })

  it('clears the deadline as soon as the work answers', async () => {
    // Otherwise a fast round trip leaves a twenty-second timer holding the
    // process open behind it.
    await raceTimeout(Promise.resolve('channelstatus'), 20_000)

    expect(jest.getTimerCount()).toBe(0)
  })

  it('lets a failure in the work reach the caller unchanged', async () => {
    await expect(raceTimeout(Promise.reject(new Error('socket closed')), 20_000))
      .rejects.toThrow('socket closed')

    expect(jest.getTimerCount()).toBe(0)
  })

  it('distinguishes a timeout from work that legitimately answered undefined', async () => {
    await expect(raceTimeout(Promise.resolve(undefined), 20_000)).resolves.toBeUndefined()
  })
})

describe('backoffDelayMs', () => {
  it('doubles the window on each attempt until it reaches the ceiling', () => {
    const window = (attempt: number): number => backoffDelayMs({
      ...BACKOFF,
      attempt,
      random: () => 1,
    })

    expect(window(1)).toBe(2_000)
    expect(window(2)).toBe(4_000)
    expect(window(3)).toBe(8_000)
    expect(window(10)).toBe(300_000)
  })

  it('stays inside the ceiling however long the outage has lasted', () => {
    // The exponent is capped before it is applied, so a week-long outage
    // cannot turn the shift into an overflow and the delay into NaN.
    for (const attempt of [1, 16, 17, 100, 1_000, Number.MAX_SAFE_INTEGER]) {
      const delay = backoffDelayMs({ ...BACKOFF, attempt, random: () => 1 })

      expect(delay).toBeLessThanOrEqual(BACKOFF.maxMs)
      expect(Number.isFinite(delay)).toBe(true)
    }
  })

  it('randomises across the whole window rather than around it', () => {
    // Every installation in a region loses its session at the same instant
    // during a cloud outage. Jitter around a fixed delay still arrives as one
    // burst; jitter across the window is what spreads a fleet out.
    const window = { ...BACKOFF, attempt: 4 }

    expect(backoffDelayMs({ ...window, random: () => 0 })).toBe(0)
    expect(backoffDelayMs({ ...window, random: () => 0.5 })).toBe(8_000)
    expect(backoffDelayMs({ ...window, random: () => 1 })).toBe(16_000)
  })

  it('gives two clients different delays for the same attempt', () => {
    const draws = [0.1, 0.4, 0.9, 0.23]
    let next = 0
    const random = (): number => draws[next++ % draws.length]

    const delays = draws.map(() => backoffDelayMs({ ...BACKOFF, attempt: 5, random }))

    expect(new Set(delays).size).toBe(draws.length)
  })

  it('treats an attempt counted from zero as the first attempt', () => {
    expect(backoffDelayMs({ ...BACKOFF, attempt: 0, random: () => 1 })).toBe(2_000)
    expect(backoffDelayMs({ ...BACKOFF, attempt: -5, random: () => 1 })).toBe(2_000)
  })

  it('reaches for real randomness when the caller injects none', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.25)

    expect(backoffDelayMs({ ...BACKOFF, attempt: 1 })).toBe(500)
  })

  it('returns whole milliseconds, because that is what a timer takes', () => {
    expect(backoffDelayMs({ ...BACKOFF, attempt: 1, random: () => 1 / 3 })).toBe(667)
  })
})
