/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import {
  CircuitBreaker,
  CircuitState,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from '../../src/api/circuit-breaker'
import { CircuitBreakerError } from '../../src/utils/errors'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('initial state', () => {
    it('starts in CLOSED state', () => {
      const breaker = new CircuitBreaker()

      expect(breaker.state).toBe(CircuitState.CLOSED)
      expect(breaker.isOpen).toBe(false)
    })

    it('allows requests when closed', () => {
      const breaker = new CircuitBreaker()

      expect(breaker.canRequest()).toBe(true)
    })
  })

  describe('failure tracking', () => {
    it('opens after threshold failures', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 })

      breaker.recordFailure()
      breaker.recordFailure()
      expect(breaker.state).toBe(CircuitState.CLOSED)

      breaker.recordFailure()
      expect(breaker.state).toBe(CircuitState.OPEN)
      expect(breaker.isOpen).toBe(true)
    })

    it('blocks requests when open', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1 })

      breaker.recordFailure()

      expect(breaker.canRequest()).toBe(false)
    })

    it('expires old failures outside the window', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        failureWindow: 1000,
      })

      breaker.recordFailure()
      breaker.recordFailure()

      jest.advanceTimersByTime(1100)

      breaker.recordSuccess() // Triggers cleanup

      const status = breaker.getStatus()
      expect(status.failures).toBe(0)
    })
  })

  describe('half-open state', () => {
    it('transitions to half-open after reset timeout', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
      })

      breaker.recordFailure()
      expect(breaker.state).toBe(CircuitState.OPEN)

      jest.advanceTimersByTime(1100)

      expect(breaker.canRequest()).toBe(true)
      expect(breaker.state).toBe(CircuitState.HALF_OPEN)
    })

    it('limits requests in half-open', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
        halfOpenMax: 2,
      })

      breaker.recordFailure()
      jest.advanceTimersByTime(1100)

      expect(breaker.canRequest()).toBe(true)
      breaker.trackHalfOpenRequest()
      expect(breaker.canRequest()).toBe(true)
      breaker.trackHalfOpenRequest()

      expect(breaker.canRequest()).toBe(false)
    })

    it('closes after enough successes in half-open', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
        halfOpenMax: 2,
      })

      breaker.recordFailure()
      jest.advanceTimersByTime(1100)
      breaker.canRequest() // Trigger half-open

      breaker.recordSuccess()
      expect(breaker.state).toBe(CircuitState.HALF_OPEN)

      breaker.recordSuccess()
      expect(breaker.state).toBe(CircuitState.CLOSED)
    })

    it('re-opens on failure in half-open', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
      })

      breaker.recordFailure()
      jest.advanceTimersByTime(1100)
      breaker.canRequest() // Trigger half-open

      breaker.recordFailure()

      expect(breaker.state).toBe(CircuitState.OPEN)
    })
  })

  describe('execute', () => {
    it('executes the function when closed', async () => {
      const breaker = new CircuitBreaker()
      const fn = jest.fn().mockResolvedValue('result')

      const result = await breaker.execute(fn)

      expect(result).toBe('result')
      expect(fn).toHaveBeenCalled()
    })

    it('records success on success', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2 })
      const fn = jest.fn().mockResolvedValue('result')

      breaker.recordFailure()

      await breaker.execute(fn)

      const status = breaker.getStatus()
      expect(status.state).toBe(CircuitState.CLOSED)
    })

    it('records failure on error', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2 })
      const fn = jest.fn().mockRejectedValue(new Error('failed'))

      await expect(breaker.execute(fn)).rejects.toThrow('failed')
      await expect(breaker.execute(fn)).rejects.toThrow('failed')

      expect(breaker.state).toBe(CircuitState.OPEN)
    })

    it('throws CircuitBreakerError when open', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1 })
      const fn = jest.fn().mockResolvedValue('result')

      breaker.recordFailure()

      await expect(breaker.execute(fn)).rejects.toThrow(CircuitBreakerError)
      expect(fn).not.toHaveBeenCalled()
    })

    it('skips recording failures that the isFailure predicate rejects while CLOSED', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1 })
      const fn = jest.fn().mockRejectedValue(new Error('client error'))

      await expect(
        breaker.execute(fn, err => !(err instanceof Error && err.message === 'client error')),
      ).rejects.toThrow('client error')

      expect(breaker.state).toBe(CircuitState.CLOSED)
    })
  })

  describe('wrap', () => {
    it('wraps a function with circuit breaker protection', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1 })
      const fn = jest.fn().mockResolvedValue('result')
      const wrapped = breaker.wrap(fn)

      const result = await wrapped('arg1', 'arg2')

      expect(result).toBe('result')
      expect(fn).toHaveBeenCalledWith('arg1', 'arg2')
    })
  })

  describe('reset', () => {
    it('resets all state', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1 })

      breaker.recordFailure()
      expect(breaker.state).toBe(CircuitState.OPEN)

      breaker.reset()

      expect(breaker.state).toBe(CircuitState.CLOSED)
      expect(breaker.isOpen).toBe(false)
      expect(breaker.getStatus().failures).toBe(0)
    })
  })

  describe('getStatus', () => {
    it('returns complete status', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 5,
        resetTimeout: 30_000,
      })

      breaker.recordFailure()
      breaker.recordFailure()

      const status = breaker.getStatus()

      expect(status).toEqual({
        state: CircuitState.CLOSED,
        failures: 2,
        successes: 0,
        lastFailureTime: expect.any(Number),
        halfOpenRequests: 0,
        isOpen: false,
        remainingResetTime: null,
      })
    })

    it('includes remainingResetTime when open', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 30_000,
      })

      breaker.recordFailure()

      const status = breaker.getStatus()

      expect(status.remainingResetTime).toBeGreaterThan(0)
      expect(status.remainingResetTime).toBeLessThanOrEqual(30_000)
    })
  })

  describe('onStateChange callback', () => {
    it('fires on CLOSED -> OPEN and OPEN -> HALF_OPEN -> CLOSED transitions', () => {
      const transitions: Array<[CircuitState, CircuitState]> = []
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 0,
        halfOpenMax: 1,
        onStateChange: (from, to) => transitions.push([from, to]),
      })

      breaker.recordFailure()
      breaker.recordFailure() // trips open

      expect(transitions).toContainEqual([CircuitState.CLOSED, CircuitState.OPEN])

      expect(breaker.canRequest()).toBe(true)
      expect(transitions).toContainEqual([CircuitState.OPEN, CircuitState.HALF_OPEN])

      breaker.recordSuccess() // closes again (halfOpenMax = 1)
      expect(transitions).toContainEqual([CircuitState.HALF_OPEN, CircuitState.CLOSED])
    })

    it('does not fire when the state is unchanged', () => {
      const onStateChange = jest.fn()
      const breaker = new CircuitBreaker({ onStateChange })

      breaker.recordSuccess() // already CLOSED, no transition

      expect(onStateChange).not.toHaveBeenCalled()
    })
  })

  describe('CircuitBreakerError', () => {
    it('exposes retryAfterMs and a stable code', () => {
      const err = new CircuitBreakerError(5000)
      expect(err.code).toBe('CIRCUIT_OPEN')
      expect(err.isRetryable).toBe(true)
      expect(err.retryAfterMs).toBeGreaterThan(0)
      expect(err.retryAfterMs).toBeLessThanOrEqual(5000)
      expect(err.message).toContain('Circuit breaker is open')
    })
  })

  describe('open-state cooldown', () => {
    it('does not extend remainingResetTime when failures arrive while already OPEN', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 30_000,
      })

      breaker.recordFailure()
      expect(breaker.state).toBe(CircuitState.OPEN)
      const firstRemaining = breaker.getStatus().remainingResetTime
      expect(firstRemaining).toBeGreaterThan(0)

      jest.advanceTimersByTime(5_000)
      breaker.recordFailure() // must be ignored while OPEN
      const secondRemaining = breaker.getStatus().remainingResetTime

      // Cooldown continues from the original trip, not a fresh 30s window.
      expect(secondRemaining).toBeLessThanOrEqual((firstRemaining ?? 0) - 5_000 + 50)
      expect(secondRemaining).toBeGreaterThan(0)
      expect(secondRemaining).toBeLessThanOrEqual(25_000)
    })

    it('closes immediately when a success arrives while OPEN', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 30_000 })

      breaker.recordFailure()
      expect(breaker.state).toBe(CircuitState.OPEN)

      breaker.recordSuccess()
      expect(breaker.state).toBe(CircuitState.CLOSED)
      expect(breaker.getStatus().failures).toBe(0)
    })
  })

  describe('defaults', () => {
    it('uses a single half-open probe by default', () => {
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMax).toBe(1)
    })

    it('always allows at least one half-open probe', () => {
      // With a cap of 0, canRequest() would promote OPEN -> HALF_OPEN and then
      // refuse every probe (0 < 0), wedging the breaker shut with no path back
      // to CLOSED and permanently suppressing all traffic.
      jest.useFakeTimers()
      try {
        const breaker = new CircuitBreaker({
          failureThreshold: 1,
          resetTimeout: 1000,
          halfOpenMax: 0,
        })

        breaker.recordFailure()
        expect(breaker.state).toBe(CircuitState.OPEN)

        jest.advanceTimersByTime(1001)
        expect(breaker.canRequest()).toBe(true)
        expect(breaker.state).toBe(CircuitState.HALF_OPEN)

        breaker.trackHalfOpenRequest()
        breaker.recordSuccess()
        expect(breaker.state).toBe(CircuitState.CLOSED)
      } finally {
        jest.useRealTimers()
      }
    })
  })
})
