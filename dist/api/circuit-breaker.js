"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Circuit breaker for REST resilience.
 *
 * Prevents hammering the NaviLink REST cloud when it is down: after a
 * threshold of service-health failures the breaker opens, later calls fail
 * fast until a cooldown elapses, then a single half-open probe decides
 * whether to close again or stay open.
 *
 * MQTT is a separate transport and is not gated here. A dead broker is the
 * session reconnect loop and the `mqttDown` diagnostic, not this breaker.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = exports.DEFAULT_CIRCUIT_BREAKER_CONFIG = exports.CircuitState = void 0;
const errors_1 = require("../utils/errors");
/** Circuit breaker states. */
var CircuitState;
(function (CircuitState) {
    /** Normal operation — requests flow through. */
    CircuitState["CLOSED"] = "CLOSED";
    /** Circuit tripped — requests fail immediately. */
    CircuitState["OPEN"] = "OPEN";
    /** Testing whether the service recovered. */
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (exports.CircuitState = CircuitState = {}));
/**
 * Default circuit breaker configuration.
 *
 * `halfOpenMax` is 1 on purpose: establish is sequential (sign-in, then
 * list), and a single probe keeps recovery deterministic, matching the
 * sibling plugins.
 */
exports.DEFAULT_CIRCUIT_BREAKER_CONFIG = {
    failureThreshold: 5,
    resetTimeout: 30_000,
    halfOpenMax: 1,
    failureWindow: 60_000,
};
/**
 * Circuit breaker for REST resilience.
 * Prevents hammering NaviLink REST when it is returning sustained failures.
 */
class CircuitBreaker {
    failureThreshold;
    resetTimeout;
    halfOpenMax;
    failureWindow;
    onStateChange;
    _state = CircuitState.CLOSED;
    failures = 0;
    successes = 0;
    lastFailureTime = null;
    halfOpenRequests = 0;
    failureTimestamps = [];
    constructor(config = {}) {
        const merged = { ...exports.DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
        this.failureThreshold = merged.failureThreshold;
        this.resetTimeout = merged.resetTimeout;
        // At least one probe must be allowed. With a cap of 0, canRequest() would
        // promote OPEN -> HALF_OPEN and then refuse every probe (0 < 0), wedging the
        // breaker shut permanently with no path back to CLOSED.
        this.halfOpenMax = Math.max(1, merged.halfOpenMax);
        this.failureWindow = merged.failureWindow ?? 60_000;
        this.onStateChange = merged.onStateChange;
    }
    /** Current circuit state. */
    get state() {
        return this._state;
    }
    /** True when the circuit is open (requests should fail fast). */
    get isOpen() {
        return this._state === CircuitState.OPEN;
    }
    /**
     * Transition to a new state, notifying observers only on an actual change.
     */
    transitionTo(next) {
        if (this._state === next) {
            return;
        }
        const previous = this._state;
        this._state = next;
        this.onStateChange?.(previous, next);
    }
    /** Drop failure timestamps that fall outside the sliding window. */
    cleanupFailures() {
        const cutoff = Date.now() - this.failureWindow;
        this.failureTimestamps = this.failureTimestamps.filter((stamp) => stamp > cutoff);
        this.failures = this.failureTimestamps.length;
    }
    /** Whether the circuit currently allows a request through. */
    canRequest() {
        if (this._state === CircuitState.CLOSED) {
            return true;
        }
        if (this._state === CircuitState.OPEN) {
            if (this.lastFailureTime && (Date.now() - this.lastFailureTime) >= this.resetTimeout) {
                this.halfOpenRequests = 0;
                this.successes = 0;
                this.transitionTo(CircuitState.HALF_OPEN);
                return true;
            }
            return false;
        }
        if (this._state === CircuitState.HALF_OPEN) {
            return this.halfOpenRequests < this.halfOpenMax;
        }
        return false;
    }
    /** Record a successful request. */
    recordSuccess() {
        if (this._state === CircuitState.HALF_OPEN) {
            this.successes += 1;
            if (this.successes >= this.halfOpenMax) {
                this.reset();
            }
        }
        else if (this._state === CircuitState.OPEN) {
            // A request that was already in flight when the breaker re-opened still
            // proves the service is reachable — close immediately rather than waiting
            // out the full cooldown.
            this.reset();
        }
        else if (this._state === CircuitState.CLOSED) {
            this.cleanupFailures();
        }
    }
    /** Record a failed request that reflects service health. */
    recordFailure() {
        // Already open: ignore late failures from overlapping half-open probes so
        // they cannot keep pushing lastFailureTime forward and extend the cooldown.
        if (this._state === CircuitState.OPEN) {
            return;
        }
        const now = Date.now();
        this.lastFailureTime = now;
        this.failureTimestamps.push(now);
        if (this._state === CircuitState.HALF_OPEN) {
            this.halfOpenRequests = 0;
            this.successes = 0;
            this.transitionTo(CircuitState.OPEN);
        }
        else if (this._state === CircuitState.CLOSED) {
            this.cleanupFailures();
            if (this.failures >= this.failureThreshold) {
                this.transitionTo(CircuitState.OPEN);
            }
        }
    }
    /** Track a half-open probe request against the concurrency cap. */
    trackHalfOpenRequest() {
        if (this._state === CircuitState.HALF_OPEN) {
            this.halfOpenRequests += 1;
        }
    }
    /** Reset the circuit breaker to closed state. */
    reset() {
        this.failures = 0;
        this.successes = 0;
        this.lastFailureTime = null;
        this.halfOpenRequests = 0;
        this.failureTimestamps = [];
        this.transitionTo(CircuitState.CLOSED);
    }
    /** Current circuit breaker status. */
    getStatus() {
        const now = Date.now();
        let remainingResetTime = null;
        if (this._state === CircuitState.OPEN && this.lastFailureTime) {
            remainingResetTime = Math.max(0, this.resetTimeout - (now - this.lastFailureTime));
        }
        return {
            state: this._state,
            failures: this.failures,
            successes: this.successes,
            lastFailureTime: this.lastFailureTime,
            halfOpenRequests: this.halfOpenRequests,
            isOpen: this.isOpen,
            remainingResetTime,
        };
    }
    /**
     * Execute a function with circuit breaker protection.
     *
     * @param isFailure Optional predicate controlling which thrown errors count
     *   as service-health failures while CLOSED. Defaults to treating every
     *   rejection as a failure. REST uses a narrower predicate (connection and
     *   protocol errors). While HALF_OPEN, every terminal rejection still
     *   re-opens the breaker so the probe slot cannot wedge.
     */
    async execute(fn, isFailure = () => true) {
        if (!this.canRequest()) {
            const status = this.getStatus();
            throw new errors_1.CircuitBreakerError(status.remainingResetTime ?? this.resetTimeout);
        }
        if (this._state === CircuitState.HALF_OPEN) {
            this.trackHalfOpenRequest();
        }
        try {
            const result = await fn();
            this.recordSuccess();
            return result;
        }
        catch (error) {
            if (this._state === CircuitState.HALF_OPEN || isFailure(error)) {
                this.recordFailure();
            }
            throw error;
        }
    }
    /** Create a wrapped version of a function with circuit breaker protection. */
    wrap(fn, isFailure) {
        return (...args) => this.execute(() => fn(...args), isFailure);
    }
}
exports.CircuitBreaker = CircuitBreaker;
