/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import {
  diagnosticLabel,
  formatDiagnosticLine,
  formatHealthTransitionLine,
  formatMqttTransportState,
  formatReasons,
} from '../../../src/diagnostics/format'
import type { DiagnosticsSnapshot } from '../../../src/types'

function report(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    msg: 'health',
    lifecycle: {
      health: 'healthy',
      reasons: [],
      uptimeSec: 12,
      pluginVersion: '0.1.1',
    },
    devices: { total: 1, online: 1 },
    transport: { mqttState: 'running' },
    polling: { cadenceSec: 120, lastDurationMs: 40, ok: 1, failed: 0 },
    token: { expiresInSec: 3000, lastRefreshAt: 1, refreshes: 0 },
    api: { p50Ms: 80, p95Ms: 120, requests: 3, errors: 0 },
    activity: { reconnects: 0, commands: 1, pushes: 2 },
    circuitBreaker: { state: 'CLOSED', lastTripAt: null, trips: 0 },
    ...overrides,
  }
}

describe('formatMqttTransportState', () => {
  it('maps running to live and leaves the others as themselves', () => {
    expect(formatMqttTransportState('running')).toBe('live')
    expect(formatMqttTransportState('connecting')).toBe('connecting')
    expect(formatMqttTransportState('stopped')).toBe('stopped')
    expect(formatMqttTransportState('auth-failed')).toBe('auth-failed')
  })
})

describe('diagnosticLabel', () => {
  it('title-cases the known channels and leaves unknown ones alone', () => {
    expect(diagnosticLabel('health')).toBe('Health')
    expect(diagnosticLabel('diagnostics.start')).toBe('Diagnostics start')
    expect(diagnosticLabel('health.degraded')).toBe('Health degraded')
    expect(diagnosticLabel('other')).toBe('other')
  })
})

describe('formatDiagnosticLine', () => {
  it('matches the sibling-plugin shape', () => {
    expect(formatDiagnosticLine(report())).toBe(
      'Health: healthy | devices 1/1 | mqtt live | api p50 80ms p95 120ms (req 3, err 0)',
    )
  })

  it('keeps the short mqtt token and a space before a zero p95', () => {
    expect(formatDiagnosticLine(report({
      msg: 'diagnostics.start',
      devices: { total: 1, online: 0 },
      transport: { mqttState: 'connecting' },
      api: { p50Ms: 0, p95Ms: 0, requests: 0, errors: 0 },
    }))).toBe(
      'Diagnostics start: healthy | devices 0/1 | mqtt connecting | api p50 0ms p95 0ms (req 0, err 0)',
    )
  })

  it('lists reasons after the health state', () => {
    const line = formatDiagnosticLine(report({
      lifecycle: {
        health: 'degraded',
        reasons: ['mqttDown'],
        uptimeSec: 90,
        pluginVersion: '0.1.1',
      },
      transport: { mqttState: 'connecting' },
    }))
    expect(line).toContain('Health: degraded [mqttDown]')
    expect(line).toContain('mqtt connecting')
  })

  it('adds a breaker token only when the circuit is not closed', () => {
    expect(formatDiagnosticLine(report({
      lifecycle: {
        health: 'degraded',
        reasons: ['circuitBreakerOpen'],
        uptimeSec: 90,
        pluginVersion: '0.1.1',
      },
      circuitBreaker: { state: 'OPEN', lastTripAt: 1, trips: 1 },
    }))).toBe(
      'Health: degraded [circuitBreakerOpen] | devices 1/1 | breaker OPEN | mqtt live | api p50 80ms p95 120ms (req 3, err 0)',
    )
  })
})

describe('formatHealthTransitionLine', () => {
  it('is state and reasons only', () => {
    expect(formatHealthTransitionLine(report({
      msg: 'health.recovered',
    }))).toBe('Health recovered: healthy')
    expect(formatReasons(['authFailed', 'mqttDown'])).toBe(' [authFailed, mqttDown]')
  })
})
