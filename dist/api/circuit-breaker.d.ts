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
/** Circuit breaker states. */
export declare enum CircuitState {
    /** Normal operation — requests flow through. */
    CLOSED = "CLOSED",
    /** Circuit tripped — requests fail immediately. */
    OPEN = "OPEN",
    /** Testing whether the service recovered. */
    HALF_OPEN = "HALF_OPEN"
}
/** Circuit breaker configuration. */
export interface CircuitBreakerConfig {
    /** Number of failures within the window before opening the circuit. */
    failureThreshold: number;
    /** Time in ms before trying half-open after opening. */
    resetTimeout: number;
    /** Max concurrent probe requests allowed in half-open state. */
    halfOpenMax: number;
    /** Sliding window (ms) for counting failures. */
    failureWindow?: number;
    /**
     * Invoked whenever the circuit transitions between states. Used for
     * observability so operators can see when the breaker opens or recovers.
     */
    onStateChange?: (from: CircuitState, to: CircuitState) => void;
}
/**
 * Default circuit breaker configuration.
 *
 * `halfOpenMax` is 1 on purpose: establish is sequential (sign-in, then
 * list), and a single probe keeps recovery deterministic, matching the
 * sibling plugins.
 */
export declare const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig;
/** Circuit breaker status snapshot. */
export interface CircuitBreakerStatus {
    state: CircuitState;
    failures: number;
    successes: number;
    lastFailureTime: number | null;
    halfOpenRequests: number;
    isOpen: boolean;
    remainingResetTime: number | null;
}
/**
 * Circuit breaker for REST resilience.
 * Prevents hammering NaviLink REST when it is returning sustained failures.
 */
export declare class CircuitBreaker {
    private readonly failureThreshold;
    private readonly resetTimeout;
    private readonly halfOpenMax;
    private readonly failureWindow;
    private readonly onStateChange?;
    private _state;
    private failures;
    private successes;
    private lastFailureTime;
    private halfOpenRequests;
    private failureTimestamps;
    constructor(config?: Partial<CircuitBreakerConfig>);
    /** Current circuit state. */
    get state(): CircuitState;
    /** True when the circuit is open (requests should fail fast). */
    get isOpen(): boolean;
    /**
     * Transition to a new state, notifying observers only on an actual change.
     */
    private transitionTo;
    /** Drop failure timestamps that fall outside the sliding window. */
    private cleanupFailures;
    /** Whether the circuit currently allows a request through. */
    canRequest(): boolean;
    /** Record a successful request. */
    recordSuccess(): void;
    /** Record a failed request that reflects service health. */
    recordFailure(): void;
    /** Track a half-open probe request against the concurrency cap. */
    trackHalfOpenRequest(): void;
    /** Reset the circuit breaker to closed state. */
    reset(): void;
    /** Current circuit breaker status. */
    getStatus(): CircuitBreakerStatus;
    /**
     * Execute a function with circuit breaker protection.
     *
     * @param isFailure Optional predicate controlling which thrown errors count
     *   as service-health failures while CLOSED. Defaults to treating every
     *   rejection as a failure. REST uses a narrower predicate (connection and
     *   protocol errors). While HALF_OPEN, every terminal rejection still
     *   re-opens the breaker so the probe slot cannot wedge.
     */
    execute<T>(fn: () => Promise<T>, isFailure?: (error: unknown) => boolean): Promise<T>;
    /** Create a wrapped version of a function with circuit breaker protection. */
    wrap<T extends unknown[], R>(fn: (...args: T) => Promise<R>, isFailure?: (error: unknown) => boolean): (...args: T) => Promise<R>;
}
