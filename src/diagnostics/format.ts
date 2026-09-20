/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Human-readable formatting for diagnostics reports.
 */

import type { DiagnosticsSnapshot, MqttTransportState } from '../types'

/** Short operator-facing label for the MQTT session lifecycle. */
export function formatMqttTransportState(state: MqttTransportState): string {
  switch (state) {
    case 'running':
      return 'live'
    case 'auth-failed':
      return 'auth-failed'
    case 'connecting':
    case 'stopped':
      return state
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

/** Human-readable label for a diagnostics channel (structured JSON keeps `msg`). */
export function diagnosticLabel(msg: string): string {
  switch (msg) {
    case 'health':
      return 'Health'
    case 'diagnostics.start':
      return 'Diagnostics start'
    case 'diagnostics.stop':
      return 'Diagnostics stop'
    case 'health.degraded':
      return 'Health degraded'
    case 'health.recovered':
      return 'Health recovered'
    default:
      return msg
  }
}

/** Render the bracketed reason list shown after the health state. */
export function formatReasons(reasons: string[]): string {
  return reasons.length > 0 ? ` [${reasons.join(', ')}]` : ''
}

/**
 * Concise summary matching the sibling plugins:
 * `Health: healthy | devices 1/1 | mqtt live | api p50 12ms p95 40ms (req 3, err 0)`.
 *
 * A non-CLOSED REST breaker inserts `breaker OPEN` (or `HALF_OPEN`) after
 * devices, matching the sibling plugins. The heartbeat uses the short `mqtt`
 * token. Standalone lifecycle lines keep `Publish-subscribe (mqtt)` so a
 * lone `up` / `recovered` still names the channel.
 */
export function formatDiagnosticLine(report: DiagnosticsSnapshot): string {
  const { lifecycle, devices, circuitBreaker, transport, api } = report
  const parts = [
    `${diagnosticLabel(report.msg)}: ${lifecycle.health}${formatReasons(lifecycle.reasons)}`,
    `devices ${devices.online}/${devices.total}`,
  ]
  if (circuitBreaker.state !== 'CLOSED') {
    parts.push(`breaker ${circuitBreaker.state}`)
  }
  parts.push(
    `mqtt ${formatMqttTransportState(transport.mqttState)}`,
    `api p50 ${api.p50Ms}ms p95 ${api.p95Ms}ms (req ${api.requests}, err ${api.errors})`,
  )
  return parts.join(' | ')
}

/** State-only line for a healthy/degraded flip. The heartbeat already has the body. */
export function formatHealthTransitionLine(report: DiagnosticsSnapshot): string {
  return `${diagnosticLabel(report.msg)}: ${report.lifecycle.health}`
    + formatReasons(report.lifecycle.reasons)
}
