/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Fault and sign-in signals. A fault is named from the
 * appliance in config, and a name that has left the configuration is cleared
 * from the store.
 */

import {
  faultSignalName,
  faultSummary,
  NaviLinkSignals,
  SIGNAL_AUTH_FAILED,
} from '../../src/navilink-signals'
import type { ListedSignal } from '../../src/navilink-signals'
import type { SignalState } from '../../src/pagerduty-signals'

const AUTH_SUMMARY =
  'NaviLink rejected the account email or password. Sign-in has stopped until it is corrected in Homebridge.'

const BOILER_ID = 'a1b2c3d4e5f6:1'
const HEATER_ID = 'a1b2c3d4e5f6:2'
const OTHER_GATEWAY_ID = 'b1b2c3d4e5f6:1'

class MemoryWriter {
  readonly writes: { signal: string; state: SignalState }[] = []

  readonly known = new Map<string, ListedSignal>()

  closed = false

  failList = false

  write(signal: string, state: SignalState): void {
    this.known.set(signal, { signal, active: state.active, summary: state.summary })
    this.writes.push({ signal, state: { ...state } })
  }

  list(): readonly ListedSignal[] {
    if (this.failList) {
      throw new Error('store locked')
    }
    return [...this.known.values()]
  }

  close(): void {
    this.closed = true
  }
}

describe('fault signal names and summaries', () => {
  it('names a fault from the appliance name, in lowercase', () => {
    expect(faultSignalName('Boiler')).toBe('fault.boiler')
    expect(faultSignalName('NCB-240E')).toBe('fault.ncb-240e')
    expect(faultSignalName('Downstairs Boiler')).toBe('fault.downstairs-boiler')
  })

  it('drops characters the store rejects, and refuses a name with none left', () => {
    expect(faultSignalName('  Boiler!! ')).toBe('fault.boiler')
    expect(faultSignalName('!!!')).toBeUndefined()
    expect(faultSignalName('')).toBeUndefined()
  })

  it('stops at the store limit of 64 characters', () => {
    expect(faultSignalName('A'.repeat(70))).toBe(`fault.${'a'.repeat(58)}`)
  })

  it('uses the appliance name, and a fixed sentence when the name is blank', () => {
    expect(faultSummary('Boiler')).toBe('Navien Boiler is reporting a fault')
    expect(faultSummary('  ')).toBe('Navien appliance is reporting a fault')
    expect(faultSummary('Boiler\nroom')).toBe('Navien Boiler room is reporting a fault')
  })
})

describe('NaviLinkSignals', () => {
  let writer: MemoryWriter
  let warn: jest.Mock
  let signals: NaviLinkSignals

  beforeEach(() => {
    writer = new MemoryWriter()
    warn = jest.fn()
    signals = new NaviLinkSignals(writer, { warn })
  })

  it('writes a fault for an appliance whether or not a tile exists', () => {
    signals.setFault(BOILER_ID, 'Boiler', true)

    expect(writer.writes).toEqual([{
      signal: 'fault.boiler',
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

  it('does not write the current appliances at startup', () => {
    signals.syncDevices([{ id: BOILER_ID, name: 'Boiler' }])

    expect(writer.writes).toEqual([])
  })

  it('leaves auth-failed alone when it syncs appliances', () => {
    signals.setAuthenticationRejected(true)
    writer.writes.length = 0

    signals.syncDevices([{ id: BOILER_ID, name: 'Boiler' }])

    expect(writer.writes).toEqual([])
    expect(writer.known.get(SIGNAL_AUTH_FAILED)?.active).toBe(true)
  })

  it('clears a fault signal for an appliance that left the configuration', () => {
    signals.syncDevices([
      { id: BOILER_ID, name: 'Boiler' },
      { id: HEATER_ID, name: 'Heater' },
    ])
    signals.setFault(HEATER_ID, 'Heater', true)
    writer.writes.length = 0

    signals.syncDevices([{ id: BOILER_ID, name: 'Boiler' }])

    expect(writer.writes).toEqual([{
      signal: 'fault.heater',
      state: {
        active: false,
        severity: 'critical',
        summary: 'Navien Heater is reporting a fault',
      },
    }])
  })

  it('appends the channel when two appliances slug to the same name', () => {
    signals.syncDevices([
      { id: BOILER_ID, name: 'Boiler' },
      { id: HEATER_ID, name: 'boiler!' },
    ])
    signals.setFault(BOILER_ID, 'Boiler', true)
    signals.setFault(HEATER_ID, 'boiler!', true)

    expect(writer.writes.map((write) => write.signal)).toEqual([
      'fault.boiler.1',
      'fault.boiler.2',
    ])
  })

  it('keeps a collision suffix inside the 64 character limit', () => {
    const name = 'A'.repeat(70)
    signals.syncDevices([
      { id: BOILER_ID, name },
      { id: HEATER_ID, name },
    ])
    signals.setFault(BOILER_ID, name, true)
    signals.setFault(HEATER_ID, name, true)

    const written = writer.writes.map((write) => write.signal)
    expect(new Set(written).size).toBe(2)
    for (const signal of written) {
      expect(signal.length).toBeLessThanOrEqual(64)
      expect(signal).toMatch(/^fault\.[a-z0-9][a-z0-9._-]*$/)
    }
  })

  it('keeps two appliances on channel 1 from sharing a signal', () => {
    signals.syncDevices([
      { id: BOILER_ID, name: 'Boiler' },
      { id: OTHER_GATEWAY_ID, name: 'Boiler' },
    ])
    signals.setFault(BOILER_ID, 'Boiler', true)
    signals.setFault(OTHER_GATEWAY_ID, 'Boiler', true)

    expect(writer.writes.map((write) => write.signal)).toEqual([
      'fault.boiler.1',
      'fault.boiler.1.2',
    ])
  })

  it('warns once when the store cannot be read, and does not clear from it', () => {
    writer.failList = true
    writer.write('fault.heater', {
      active: true,
      severity: 'critical',
      summary: 'Navien Heater is reporting a fault',
    })
    writer.writes.length = 0

    signals.syncDevices([{ id: BOILER_ID, name: 'Boiler' }])
    signals.syncDevices([{ id: BOILER_ID, name: 'Boiler' }])

    expect(writer.writes).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'))
  })

  it('warns once when an appliance name cannot be a signal', () => {
    signals.syncDevices([{ id: BOILER_ID, name: '!!!' }])
    signals.setFault(BOILER_ID, '!!!', true)

    expect(writer.writes).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable characters'))
  })

  it('close does not clear a signal', () => {
    signals.setFault(BOILER_ID, 'Boiler', true)
    signals.close()

    expect(writer.closed).toBe(true)
    expect(writer.writes).toHaveLength(1)
    expect(writer.writes[0]?.state.active).toBe(true)
  })
})
