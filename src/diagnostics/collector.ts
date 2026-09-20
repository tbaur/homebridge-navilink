/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opt-in diagnostics collector for health and activity metrics.
 *
 * One collector per platform. It accumulates counters and a bounded latency
 * window, and turns them into:
 *   - `buildHeartbeat()` — per-interval counter deltas + absolute gauges
 *   - `snapshot()`       — session cumulative totals + redacted config echo
 *   - `rollup()`         — `{ health, reasons[] }`
 *
 * NaviLink variant of the sibling collectors: REST sign-in plus an MQTT
 * session. The REST circuit breaker is included so sustained cloud outages
 * surface as `circuitBreakerOpen` in the health rollup. It only reads
 * in-memory state via `readers`; it never touches the network.
 */

import { MQTT_DOWN_GRACE_SEC } from '../settings'
import type {
  DeviceGauges,
  DiagnosticsSnapshot,
  MqttTransportState,
  NaviLinkPlatformConfig,
  SessionMetrics,
} from '../types'

/** Maximum number of recent request latencies retained for percentile math. */
const LATENCY_WINDOW = 200

/** Recent request outcomes retained for the rollup error-rate calculation. */
const OUTCOME_WINDOW = 50

/** Minimum recent requests before the API error rate can mark health degraded. */
const API_ERROR_MIN_SAMPLES = 10

/** Recent error rate (0..1) at or above which health is considered degraded. */
const API_ERROR_RATE_THRESHOLD = 0.5

/**
 * Accessors the collector calls to read live in-memory state. All are
 * synchronous and must never block on the network.
 */
export interface DiagnosticsReaders {
  devices: () => DeviceGauges
  mqttState: () => MqttTransportState
  lastMqttEventAgeSec: () => number | null
  tokenExpiresInSec: () => number | null
  tokenLastRefreshAt: () => number | null
  pollingCadenceSec: () => number
  circuitBreaker: () => { state: string }
}

interface CollectorOptions {
  pluginVersion: string
  config: NaviLinkPlatformConfig
  now?: () => number
}

interface CounterSnapshot {
  apiRequests: number
  apiErrors: number
  pollOk: number
  pollFailed: number
  sessionRefreshes: number
  mqttReconnects: number
  commands: number
  pushes: number
  breakerTrips: number
}

/** Health classification result. */
export interface HealthRollup {
  health: 'healthy' | 'degraded'
  reasons: string[]
}

/** Accumulates diagnostics counters and renders heartbeat/snapshot reports. */
export class DiagnosticsCollector implements SessionMetrics {
  private readonly now: () => number
  private readonly startedAtMs: number
  private readonly pluginVersion: string
  private readonly configEcho: Record<string, unknown>

  private apiRequests = 0
  private apiErrors = 0
  private pollOk = 0
  private pollFailed = 0
  private sessionRefreshes = 0
  private mqttReconnects = 0
  private commands = 0
  private pushes = 0
  private breakerTrips = 0
  private lastTripAt: number | null = null

  private lastPollDurationMs: number | null = null
  private readonly latencies: number[] = []
  private readonly recentOutcomes: boolean[] = []
  private marker: CounterSnapshot

  constructor(options: CollectorOptions) {
    this.now = options.now ?? Date.now
    this.startedAtMs = this.now()
    this.pluginVersion = options.pluginVersion
    this.configEcho = redactConfig(options.config)
    this.marker = this.captureCounters()
  }

  apiRequest(durationMs: number, ok: boolean): void {
    this.apiRequests += 1
    if (!ok) {
      this.apiErrors += 1
    }
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.latencies.push(durationMs)
      if (this.latencies.length > LATENCY_WINDOW) {
        this.latencies.shift()
      }
    }
    this.recentOutcomes.push(ok)
    if (this.recentOutcomes.length > OUTCOME_WINDOW) {
      this.recentOutcomes.shift()
    }
  }

  mqttReconnect(): void {
    this.mqttReconnects += 1
  }

  pollCycle(ok: number, failed: number, durationMs: number): void {
    this.pollOk += ok
    this.pollFailed += failed
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.lastPollDurationMs = durationMs
    }
  }

  command(): void {
    this.commands += 1
  }

  sessionRefresh(): void {
    this.sessionRefreshes += 1
  }

  push(): void {
    this.pushes += 1
  }

  /** Record a circuit-breaker trip (transition into the open state). */
  breakerTrip(): void {
    this.breakerTrips += 1
    this.lastTripAt = this.now()
  }

  /** Nearest-rank percentile (0..100) over the recent-latency window. */
  percentile(p: number): number {
    if (this.latencies.length === 0) {
      return 0
    }
    const sorted = [...this.latencies].sort((left, right) => left - right)
    const clamped = Math.min(100, Math.max(0, p))
    const rank = Math.ceil((clamped / 100) * sorted.length)
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
    return sorted[index] ?? 0
  }

  /**
   * Classify current health. Degraded when the MQTT session has been down
   * longer than the grace window, credentials were rejected, the REST
   * circuit breaker is open or probing, or recent REST calls are failing
   * at a high rate.
   */
  rollup(readers: DiagnosticsReaders): HealthRollup {
    const reasons: string[] = []
    const mqttState = readers.mqttState()
    if (mqttState === 'auth-failed') {
      reasons.push('authFailed')
    } else if (mqttState !== 'running') {
      const age = readers.lastMqttEventAgeSec()
      const uptime = this.uptimeSec()
      const beenDownLongEnough = age === null
        ? uptime >= MQTT_DOWN_GRACE_SEC
        : age >= MQTT_DOWN_GRACE_SEC
      if (beenDownLongEnough) {
        reasons.push('mqttDown')
      }
    }

    const breakerState = readers.circuitBreaker().state
    if (breakerState === 'OPEN' || breakerState === 'HALF_OPEN') {
      reasons.push('circuitBreakerOpen')
    }

    const total = this.recentOutcomes.length
    if (total >= API_ERROR_MIN_SAMPLES) {
      const errors = this.recentOutcomes.filter((ok) => !ok).length
      if (errors / total >= API_ERROR_RATE_THRESHOLD) {
        reasons.push('apiErrorRateHigh')
      }
    }

    return {
      health: reasons.length > 0 ? 'degraded' : 'healthy',
      reasons,
    }
  }

  buildHeartbeat(readers: DiagnosticsReaders): DiagnosticsSnapshot {
    const current = this.captureCounters()
    const report = this.buildReport('health', {
      refreshes: current.sessionRefreshes - this.marker.sessionRefreshes,
      pollOk: current.pollOk - this.marker.pollOk,
      pollFailed: current.pollFailed - this.marker.pollFailed,
      requests: current.apiRequests - this.marker.apiRequests,
      errors: current.apiErrors - this.marker.apiErrors,
      reconnects: current.mqttReconnects - this.marker.mqttReconnects,
      commands: current.commands - this.marker.commands,
      pushes: current.pushes - this.marker.pushes,
      trips: current.breakerTrips - this.marker.breakerTrips,
    }, readers)
    this.marker = current
    return report
  }

  snapshot(msg: string, readers: DiagnosticsReaders): DiagnosticsSnapshot {
    const report = this.buildReport(msg, {
      refreshes: this.sessionRefreshes,
      pollOk: this.pollOk,
      pollFailed: this.pollFailed,
      requests: this.apiRequests,
      errors: this.apiErrors,
      reconnects: this.mqttReconnects,
      commands: this.commands,
      pushes: this.pushes,
      trips: this.breakerTrips,
    }, readers)
    report.config = { ...this.configEcho }
    return report
  }

  private uptimeSec(): number {
    return Math.round((this.now() - this.startedAtMs) / 1_000)
  }

  private captureCounters(): CounterSnapshot {
    return {
      apiRequests: this.apiRequests,
      apiErrors: this.apiErrors,
      pollOk: this.pollOk,
      pollFailed: this.pollFailed,
      sessionRefreshes: this.sessionRefreshes,
      mqttReconnects: this.mqttReconnects,
      commands: this.commands,
      pushes: this.pushes,
      breakerTrips: this.breakerTrips,
    }
  }

  private buildReport(
    msg: string,
    counters: {
      refreshes: number
      pollOk: number
      pollFailed: number
      requests: number
      errors: number
      reconnects: number
      commands: number
      pushes: number
      trips: number
    },
    readers: DiagnosticsReaders,
  ): DiagnosticsSnapshot {
    const { health, reasons } = this.rollup(readers)
    return {
      msg,
      lifecycle: {
        health,
        reasons,
        uptimeSec: this.uptimeSec(),
        pluginVersion: this.pluginVersion,
      },
      devices: readers.devices(),
      transport: { mqttState: readers.mqttState() },
      polling: {
        cadenceSec: readers.pollingCadenceSec(),
        lastDurationMs: this.lastPollDurationMs,
        ok: counters.pollOk,
        failed: counters.pollFailed,
      },
      token: {
        expiresInSec: readers.tokenExpiresInSec(),
        lastRefreshAt: readers.tokenLastRefreshAt(),
        refreshes: counters.refreshes,
      },
      api: {
        p50Ms: this.percentile(50),
        p95Ms: this.percentile(95),
        requests: counters.requests,
        errors: counters.errors,
      },
      activity: {
        reconnects: counters.reconnects,
        commands: counters.commands,
        pushes: counters.pushes,
      },
      circuitBreaker: {
        state: readers.circuitBreaker().state,
        lastTripAt: this.lastTripAt,
        trips: counters.trips,
      },
    }
  }
}

/** Credentials and appliance names stay out of the snapshot echo. */
function redactConfig(config: NaviLinkPlatformConfig): Record<string, unknown> {
  const options = config.options
  return {
    diagnosticsInterval: options?.diagnosticsInterval ?? 0,
    statusIntervalSec: options?.statusIntervalSec ?? null,
    structuredLogs: options?.structuredLogs ?? false,
    readOnly: options?.readOnly === true,
    allowPowerOff: options?.allowPowerOff === true,
    accessoryPrefix: typeof options?.accessoryPrefix === 'string'
      && options.accessoryPrefix.trim().length > 0,
    devices: Array.isArray(config.devices) ? config.devices.length : 0,
  }
}
