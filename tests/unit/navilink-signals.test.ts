/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Fault and sign-in signals, including the remembered appliance
 * list used to clear a device that left the configuration.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  faultSignalName,
  faultSummary,
  NaviLinkSignals,
  rememberedDevicesPath,
  SIGNAL_AUTH_FAILED,
} from '../../src/navilink-signals'
import type { SignalState } from '../../src/pagerduty-signals'

const AUTH_SUMMARY =
  'NaviLink rejected the account email or password. Sign-in has stopped until it is corrected in Homebridge.'

class MemoryWriter {
  readonly writes: { signal: string; state: SignalState }[] = []

  closed = false

  write(signal: string, state: SignalState): void {
    this.writes.push({ signal, state: { ...state } })
  }

  close(): void {
    this.closed = true
  }
}

describe('fault signal names and summaries', () => {
  it('names a fault from the gateway and channel, without a colon', () => {
    expect(faultSignalName('a1b2c3d4e5f6:1')).toBe('fault.a1b2c3d4e5f6.1')
    expect(faultSignalName('A1B2C3D4E5F6:12')).toBe('fault.a1b2c3d4e5f6.12')
  })

  it('refuses an id that is not an appliance', () => {
    expect(faultSignalName('boiler')).toBeUndefined()
    expect(faultSignalName('')).toBeUndefined()
  })

  it('uses the appliance name, and a fixed sentence when the name is blank', () => {
    expect(faultSummary('Boiler')).toBe('Navien Boiler is reporting a fault')
    expect(faultSummary('  ')).toBe('Navien appliance is reporting a fault')
    expect(faultSummary('Boiler\nroom')).toBe('Navien Boiler room is reporting a fault')
  })
})

describe('NaviLinkSignals', () => {
  let storagePath: string
  let writer: MemoryWriter
  let warn: jest.Mock
  let signals: NaviLinkSignals

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'navilink-signal-list-'))
    writer = new MemoryWriter()
    warn = jest.fn()
    signals = new NaviLinkSignals(writer, storagePath, { warn })
  })

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true })
  })

  it('writes a fault for an appliance whether or not a tile exists', () => {
    signals.setFault('a1b2c3d4e5f6:1', 'Boiler', true)

    expect(writer.writes).toEqual([{
      signal: 'fault.a1b2c3d4e5f6.1',
      state: {
        active: true,
        severity: 'critical',
        summary: 'Navien Boiler is reporting a fault',
      },
    }])
  })

  it('writes auth-failed only as the caller reports it', () => {
    signals.setAuthenticationRejected(true)
    signals.setAuthenticationRejected(false)

    expect(writer.writes).toEqual([
      { signal: SIGNAL_AUTH_FAILED, state: { active: true, severity: 'error', summary: AUTH_SUMMARY } },
      { signal: SIGNAL_AUTH_FAILED, state: { active: false, severity: 'error', summary: AUTH_SUMMARY } },
    ])
  })

  it('does not write the current appliances when it remembers them', () => {
    signals.syncDevices([{ id: 'a1b2c3d4e5f6:1', name: 'Boiler' }])

    expect(writer.writes).toEqual([])
    expect(JSON.parse(readFileSync(rememberedDevicesPath(storagePath), 'utf8'))).toEqual({
      devices: [{ id: 'a1b2c3d4e5f6:1', name: 'Boiler' }],
    })
    expect(statSync(join(storagePath, 'homebridge-navilink')).mode & 0o777).toBe(0o700)
    expect(statSync(rememberedDevicesPath(storagePath)).mode & 0o777).toBe(0o600)
  })

  it('clears a fault signal for an appliance that left the configuration', () => {
    signals.syncDevices([
      { id: 'a1b2c3d4e5f6:1', name: 'Boiler' },
      { id: 'a1b2c3d4e5f6:2', name: 'Heater' },
    ])
    writer.writes.length = 0
    signals.syncDevices([{ id: 'a1b2c3d4e5f6:1', name: 'Boiler' }])

    expect(writer.writes).toEqual([{
      signal: 'fault.a1b2c3d4e5f6.2',
      state: {
        active: false,
        severity: 'critical',
        summary: 'Navien Heater is reporting a fault',
      },
    }])
  })

  it('warns once when the remembered list cannot be read, and does not clear from it', () => {
    mkdirSync(join(storagePath, 'homebridge-navilink'))
    writeFileSync(rememberedDevicesPath(storagePath), '{')

    signals.syncDevices([{ id: 'a1b2c3d4e5f6:1', name: 'Boiler' }])
    signals.syncDevices([{ id: 'a1b2c3d4e5f6:1', name: 'Boiler' }])

    expect(writer.writes).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'))
  })

  it('close does not clear a signal', () => {
    signals.setFault('a1b2c3d4e5f6:1', 'Boiler', true)
    signals.close()

    expect(writer.closed).toBe(true)
    expect(writer.writes).toHaveLength(1)
    expect(writer.writes[0]?.state.active).toBe(true)
  })

  it('skips a device id that is not an appliance', () => {
    signals.setFault('not-an-id', 'Boiler', true)
    expect(writer.writes).toEqual([])
  })
})

describe('a remembered list that cannot be saved', () => {
  it('warns once and still returns', () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'navilink-signal-ro-'))
    const writer = new MemoryWriter()
    const warn = jest.fn()
    const signals = new NaviLinkSignals(writer, storagePath, { warn })
    chmodSync(storagePath, 0o500)
    try {
      signals.syncDevices([{ id: 'a1b2c3d4e5f6:1', name: 'Boiler' }])
      signals.syncDevices([{ id: 'a1b2c3d4e5f6:1', name: 'Boiler' }])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be saved'))
    } finally {
      chmodSync(storagePath, 0o700)
      rmSync(storagePath, { recursive: true, force: true })
    }
  })
})
