/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import { DiagnosticsCollector, type DiagnosticsReaders } from '../../../src/diagnostics/collector'
import type { MqttTransportState, NaviLinkPlatformConfig } from '../../../src/types'

const CONFIG: NaviLinkPlatformConfig = {
  platform: 'NaviLink',
  options: {
    diagnosticsInterval: 60,
    statusIntervalSec: 120,
    structuredLogs: true,
  },
  devices: [{ id: 'a1b2c3d4e5f6:1', name: 'Boiler' }],
  email: 'someone@example.com',
  password: 'hunter2',
}

function readers(overrides: Partial<{
  mqttState: MqttTransportState
  lastMqttEventAgeSec: number | null
  online: number
  breakerState: string
}> = {}): DiagnosticsReaders {
  return {
    devices: () => ({ total: 1, online: overrides.online ?? 1 }),
    mqttState: () => overrides.mqttState ?? 'running',
    lastMqttEventAgeSec: () => (
      overrides.lastMqttEventAgeSec === undefined ? 5 : overrides.lastMqttEventAgeSec
    ),
    tokenExpiresInSec: () => 3000,
    tokenLastRefreshAt: () => 1_700_000_000_000,
    pollingCadenceSec: () => 120,
    circuitBreaker: () => ({ state: overrides.breakerState ?? 'CLOSED' }),
  }
}

function collector(now = 1_700_000_000_000): DiagnosticsCollector {
  return new DiagnosticsCollector({
    pluginVersion: '0.1.1',
    config: CONFIG,
    now: () => now,
  })
}

describe('DiagnosticsCollector', () => {
  it('starts healthy when MQTT is live', () => {
    const rollup = collector().rollup(readers())
    expect(rollup).toEqual({ health: 'healthy', reasons: [] })
  })

  it('does not call MQTT down during the first minute of connecting', () => {
    const rollup = collector().rollup(readers({
      mqttState: 'connecting',
      lastMqttEventAgeSec: null,
    }))
    expect(rollup.health).toBe('healthy')
  })

  it('marks mqttDown after the grace window', () => {
    const started = 1_700_000_000_000
    let now = started
    const later = new DiagnosticsCollector({
      pluginVersion: '0.1.1',
      config: CONFIG,
      now: () => now,
    })
    now = started + 61_000
    expect(later.rollup(readers({
      mqttState: 'connecting',
      lastMqttEventAgeSec: null,
    })).reasons).toContain('mqttDown')
  })

  it('marks authFailed when the session has given up', () => {
    expect(collector().rollup(readers({ mqttState: 'auth-failed' })).reasons)
      .toEqual(['authFailed'])
  })

  it('marks apiErrorRateHigh once enough recent calls have failed', () => {
    const built = collector()
    for (let index = 0; index < 10; index += 1) {
      built.apiRequest(20, false)
    }
    expect(built.rollup(readers()).reasons).toContain('apiErrorRateHigh')
  })

  it('marks circuitBreakerOpen while the breaker is open or probing', () => {
    expect(collector().rollup(readers({ breakerState: 'OPEN' })).reasons)
      .toContain('circuitBreakerOpen')
    expect(collector().rollup(readers({ breakerState: 'HALF_OPEN' })).reasons)
      .toContain('circuitBreakerOpen')
    expect(collector().rollup(readers({ breakerState: 'CLOSED' })).reasons)
      .not.toContain('circuitBreakerOpen')
  })

  it('counts breaker trips on the heartbeat then resets the delta', () => {
    const built = collector()
    built.breakerTrip()
    const heartbeat = built.buildHeartbeat(readers({ breakerState: 'OPEN' }))
    expect(heartbeat.circuitBreaker).toEqual({
      state: 'OPEN',
      lastTripAt: 1_700_000_000_000,
      trips: 1,
    })
    expect(built.buildHeartbeat(readers({ breakerState: 'OPEN' })).circuitBreaker.trips).toBe(0)
  })

  it('reports heartbeat counters as deltas and snapshots as totals', () => {
    const built = collector()
    built.apiRequest(80, true)
    built.apiRequest(120, false)
    built.command()
    built.push()
    built.mqttReconnect()
    built.pollCycle(1, 0, 40)
    built.sessionRefresh()

    const heartbeat = built.buildHeartbeat(readers())
    expect(heartbeat.api).toEqual({ p50Ms: 80, p95Ms: 120, requests: 2, errors: 1 })
    expect(heartbeat.activity).toEqual({ reconnects: 1, commands: 1, pushes: 1 })
    expect(heartbeat.polling.ok).toBe(1)
    expect(heartbeat.token.refreshes).toBe(1)

    built.command()
    const next = built.buildHeartbeat(readers())
    expect(next.activity.commands).toBe(1)
    expect(next.api.requests).toBe(0)

    const snap = built.snapshot('diagnostics.start', readers())
    expect(snap.activity.commands).toBe(2)
    expect(snap.config).toEqual({
      diagnosticsInterval: 60,
      statusIntervalSec: 120,
      structuredLogs: true,
      readOnly: false,
      allowPowerOff: false,
      accessoryPrefix: false,
      devices: 1,
    })
    expect(JSON.stringify(snap)).not.toContain('someone@example.com')
    expect(JSON.stringify(snap)).not.toContain('hunter2')
    expect(JSON.stringify(snap)).not.toContain('Boiler')
  })

  it('echoes a set prefix as a boolean, never the string', () => {
    const withPrefix = new DiagnosticsCollector({
      pluginVersion: '0.1.1',
      config: {
        ...CONFIG,
        options: { ...CONFIG.options, accessoryPrefix: 'Zone One' },
      },
    })
    const snap = withPrefix.snapshot('diagnostics.start', readers())

    expect(snap.config).toEqual(expect.objectContaining({ accessoryPrefix: true }))
    expect(JSON.stringify(snap)).not.toContain('Zone One')
  })

  it('returns 0 percentiles before any samples', () => {
    expect(collector().percentile(50)).toBe(0)
    expect(collector().percentile(95)).toBe(0)
  })
})
