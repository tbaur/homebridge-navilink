/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The platform decides what exists and what is allowed. Two of its rules are
 * worth more than the rest, and both are about not destroying something the
 * user built: a restored accessory must be adopted rather than recreated, or
 * the tile loses its room and its automations; and bad configuration must
 * disable the plugin without unregistering anything, for the same reason.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Sqlite from 'node:sqlite'
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge'

import { PagerDutySignals } from '../../src/pagerduty-signals'
import { PLUGIN_NAME } from '../../src/settings'
import { NaviLinkSession } from '../../src/session'
import { ControlRejectedError } from '../../src/utils'
import { DEVICE_ID, MAC } from '../helpers/cloud'
import { FakeAccessory, fakeHap, observation } from '../helpers/hap'

jest.mock('../../src/session')

const SessionMock = NaviLinkSession as jest.MockedClass<typeof NaviLinkSession>

/** The last session the platform constructed, with its callbacks captured. */
interface SessionSpy {
  start: jest.Mock
  stop: jest.Mock
  publishControl: jest.Mock
  observationFor: jest.Mock
  firmwareFor: jest.Mock
  health: jest.Mock
  circuitBreakerState: jest.Mock
  applyOptimisticWrite: jest.Mock
  emitObservation(deviceId: string, value: ReturnType<typeof observation>): void
  emitUnreachable(error: unknown): void
  options: ConstructorParameters<typeof NaviLinkSession>[0]
  /** Log lines already written when start() ran, so order can be asserted. */
  logAtStart: string[]
}

/** The log from the platform under test, so the session mock can snapshot it. */
let activeLog: { calls: string[] } | undefined

let sessions: SessionSpy[] = []

beforeEach(() => {
  sessions = []
  activeLog = undefined
  SessionMock.mockClear()
  SessionMock.mockImplementation((options) => {
    let onObservation: ((...args: never[]) => void) | undefined
    let onUnreachable: ((error: unknown) => void) | undefined
    const spy: SessionSpy = {
      start: jest.fn(),
      stop: jest.fn().mockResolvedValue(undefined),
      publishControl: jest.fn().mockResolvedValue(undefined),
      observationFor: jest.fn().mockReturnValue(undefined),
      firmwareFor: jest.fn().mockReturnValue(undefined),
      health: jest.fn().mockReturnValue({
        mqttState: 'running',
        lastMqttEventAt: Date.now(),
        expiresAt: Date.now() + 3_000_000,
        lastRefreshAt: Date.now(),
        onlineDeviceIds: [DEVICE_ID],
      }),
      circuitBreakerState: jest.fn().mockReturnValue('CLOSED'),
      applyOptimisticWrite: jest.fn(),
      emitObservation: (deviceId, value) => {
        ;(onObservation as unknown as (
          id: string,
          value: ReturnType<typeof observation>,
          reason: string,
        ) => void)?.(deviceId, value, 'push')
      },
      emitUnreachable: (error) => onUnreachable?.(error),
      options,
      logAtStart: [],
    }
    spy.start.mockImplementation(() => {
      spy.logAtStart = [...(activeLog?.calls ?? [])]
    })
    sessions.push(spy)
    return {
      ...spy,
      onObservation: (handler: (...args: never[]) => void) => {
        onObservation = handler
      },
      onUnreachable: (handler: (error: unknown) => void) => {
        onUnreachable = handler
      },
      onStale: jest.fn(),
    } as unknown as NaviLinkSession
  })
})

/** A Homebridge API stand-in that records registration. */
interface FakeApi {
  api: API
  registered: PlatformAccessory[]
  unregistered: PlatformAccessory[]
  launch(): void
  shutdown(): Promise<void>
}

function fakeApi(storagePath?: string): FakeApi {
  const registered: PlatformAccessory[] = []
  const unregistered: PlatformAccessory[] = []
  const handlers = new Map<string, (() => void)[]>()

  const api = {
    hap: fakeHap(),
    platformAccessory: FakeAccessory,
    on: (event: string, handler: () => void) => {
      const existing = handlers.get(event) ?? []
      existing.push(handler)
      handlers.set(event, existing)
    },
    registerPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => {
      registered.push(...accessories)
    },
    unregisterPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => {
      unregistered.push(...accessories)
    },
    registerPlatform: jest.fn(),
    user: {
      storagePath: () => {
        if (storagePath === undefined || storagePath.length === 0) {
          throw new Error('storagePath was not set')
        }
        return storagePath
      },
    },
  } as unknown as API

  return {
    api,
    registered,
    unregistered,
    launch: () => {
      for (const handler of handlers.get('didFinishLaunching') ?? []) {
        handler()
      }
    },
    shutdown: async () => {
      for (const handler of handlers.get('shutdown') ?? []) {
        handler()
      }
      await Promise.resolve()
    },
  }
}

function fakeLog(): Logging & { calls: string[] } {
  const calls: string[] = []
  const record = (level: string) => (message: unknown, ...rest: unknown[]) => {
    calls.push(`${level} ${String(message)} ${rest.map(String).join(' ')}`.trim())
  }
  const log = record('info') as unknown as Logging & { calls: string[] }
  log.info = record('info')
  log.warn = record('warn')
  log.error = record('error')
  log.debug = record('debug')
  log.log = record('log')
  log.success = record('info')
  log.prefix = 'NaviLink'
  log.calls = calls
  activeLog = log
  return log
}

function config(overrides: Record<string, unknown> = {}): PlatformConfig {
  return {
    platform: 'NaviLink',
    name: 'NaviLink',
    email: 'someone@example.com',
    password: 'hunter2',
    devices: [{ id: DEVICE_ID, name: 'Boiler', dhw: true, power: true }],
    ...overrides,
  } as PlatformConfig
}

interface Built {
  platform: import('../../src/platform').NaviLinkPlatform
  api: FakeApi
  log: Logging & { calls: string[] }
  session(): SessionSpy
}

function build(overrides: {
  config?: PlatformConfig
  restored?: PlatformAccessory[]
  storagePath?: string
} = {}): Built {
  // Required lazily so the session mock is installed before the module graph
  // that imports it is evaluated.
  const { NaviLinkPlatform } = require('../../src/platform') as
    typeof import('../../src/platform')

  const api = fakeApi(overrides.storagePath)
  const log = fakeLog()
  const platform = new NaviLinkPlatform(log, overrides.config ?? config(), api.api)
  for (const accessory of overrides.restored ?? []) {
    platform.configureAccessory(accessory)
  }
  api.launch()

  return {
    platform,
    api,
    log,
    session: () => {
      const last = sessions.at(-1)
      if (last === undefined) {
        throw new Error('the platform did not create a session')
      }
      return last
    },
  }
}

describe('bringing accessories up', () => {
  it('registers one accessory per enabled capability', () => {
    const built = build()
    expect(built.api.registered).toHaveLength(2)
  })

  it('starts a session for the configured appliances', () => {
    const built = build()
    expect(built.session().start).toHaveBeenCalledTimes(1)
    expect(built.session().options.devices).toHaveLength(1)
  })

  it('says how much it is watching, so the log shows the plugin came up', () => {
    const built = build()
    expect(built.log.calls.some((line) => line.includes('1 appliance(s), 2 accessory(ies)')))
      .toBe(true)
  })

  it('names each accessory it adds, the same way the other plugins in this family do', () => {
    const built = build()
    expect(built.log.calls.some((line) => line.includes('adding Boiler Hot Water'))).toBe(true)
    expect(built.log.calls.some((line) => line.includes('adding Boiler Power'))).toBe(true)
  })

  it('uses the accessory prefix as the stem when one is set', () => {
    const built = build({
      config: config({ options: { accessoryPrefix: 'Zone One' } }),
    })
    expect(built.log.calls.some((line) => line.includes('adding Zone One Hot Water'))).toBe(true)
    expect(built.log.calls.some((line) => line.includes('adding Zone One Power'))).toBe(true)
    expect(built.log.calls.some((line) => line.includes('Boiler Hot Water'))).toBe(false)
  })

  it('adopts a restored accessory rather than registering a second one', () => {
    const api = fakeApi()
    const log = fakeLog()
    const { NaviLinkPlatform } = require('../../src/platform') as
      typeof import('../../src/platform')
    const platform = new NaviLinkPlatform(log, config({
      devices: [{ id: DEVICE_ID, name: 'Boiler', dhw: true }],
    }), api.api)

    const uuid = api.api.hap.uuid.generate(`homebridge-navilink:${DEVICE_ID}:dhw`)
    const existing = new FakeAccessory('Boiler Hot Water', uuid)
    platform.configureAccessory(existing as unknown as PlatformAccessory)
    api.launch()

    // Re-registering would hand HomeKit a different accessory with the same
    // name, and the room, scenes and automations stay with the old one.
    expect(api.registered).toHaveLength(0)
    expect(api.unregistered).toHaveLength(0)
    expect(existing.displayNameUpdates).toEqual([])
  })

  it('removes an accessory whose capability was switched off', () => {
    const api = fakeApi()
    const log = fakeLog()
    const { NaviLinkPlatform } = require('../../src/platform') as
      typeof import('../../src/platform')
    const platform = new NaviLinkPlatform(log, config({
      devices: [{ id: DEVICE_ID, name: 'Boiler', dhw: true }],
    }), api.api)

    const orphan = new FakeAccessory(
      'Boiler Recirculation',
      api.api.hap.uuid.generate('homebridge-navilink:some-old-thing'),
    ) as unknown as PlatformAccessory
    platform.configureAccessory(orphan)
    api.launch()

    expect(api.unregistered).toHaveLength(1)
    expect(log.calls.some((line) => (
      line.includes('removing Boiler Recirculation')
    ))).toBe(true)
  })

  it('keys a tile on identity alone, so renaming an appliance keeps its room', () => {
    const api = fakeApi()
    const log = fakeLog()
    const { NaviLinkPlatform } = require('../../src/platform') as
      typeof import('../../src/platform')
    const platform = new NaviLinkPlatform(log, config({
      devices: [{ id: DEVICE_ID, name: 'Downstairs Boiler', dhw: true }],
    }), api.api)

    const uuid = api.api.hap.uuid.generate(`homebridge-navilink:${DEVICE_ID}:dhw`)
    const existing = new FakeAccessory('Boiler Hot Water', uuid)
    platform.configureAccessory(existing as unknown as PlatformAccessory)
    api.launch()

    expect(api.registered).toHaveLength(0)
    expect(log.calls.some((line) => (
      line.includes('Boiler Hot Water is now named Downstairs Boiler Hot Water')
    ))).toBe(true)
    // The wrapper field is not what Homebridge restores. The persisted name
    // has to move too, or the tile comes back under the old name.
    expect(existing.displayNameUpdates).toEqual(['Downstairs Boiler Hot Water'])
    expect(existing.hapDisplayName).toBe('Downstairs Boiler Hot Water')
    expect(existing.displayName).toBe('Downstairs Boiler Hot Water')
  })
})

describe('unusable configuration', () => {
  it('disables itself rather than starting a session with no password', () => {
    build({ config: config({ password: '' }) })
    expect(sessions).toHaveLength(0)
  })

  it('loads and stays up when the config has only the platform name', () => {
    const built = build({
      config: { platform: 'NaviLink' } as PlatformConfig,
    })
    expect(sessions).toHaveLength(0)
    expect(built.log.calls.some((line) => line.includes('platform disabled')))
      .toBe(true)
  })

  it('loads and stays up when the config has only the required name', () => {
    const built = build({
      config: {
        platform: 'NaviLink',
        name: 'NaviLink',
      } as PlatformConfig,
    })
    expect(sessions).toHaveLength(0)
    expect(built.log.calls.some((line) => line.includes('platform disabled')))
      .toBe(true)
  })

  it('leaves cached accessories registered, so nobody loses their rooms', () => {
    const api = fakeApi()
    const log = fakeLog()
    const { NaviLinkPlatform } = require('../../src/platform') as
      typeof import('../../src/platform')
    const platform = new NaviLinkPlatform(log, config({ email: '' }), api.api)
    platform.configureAccessory(
      new FakeAccessory('Boiler Hot Water', 'uuid-1') as unknown as PlatformAccessory,
    )
    api.launch()

    // Unregistering would be tidier and would cost the user every automation
    // built on the tile, for what is usually a typo.
    expect(api.unregistered).toHaveLength(0)
    expect(log.calls.some((line) => line.includes('1 cached accessory(ies) inactive')))
      .toBe(true)
  })

  it('says what is wrong and that it has stopped', () => {
    const built = build({ config: config({ email: '' }) })
    const errors = built.log.calls.filter((line) => line.startsWith('error '))
    expect(errors.some((line) => line.includes('email'))).toBe(true)
    expect(errors.some((line) => line.includes('platform disabled'))).toBe(true)
  })

  it('reports no state at all while disabled', () => {
    const built = build({ config: config({ email: '' }) })
    expect(built.platform.observationFor(DEVICE_ID)).toBeUndefined()
  })

  it('does not unregister cached tiles when devices is an empty list', () => {
    const api = fakeApi()
    const log = fakeLog()
    const { NaviLinkPlatform } = require('../../src/platform') as
      typeof import('../../src/platform')
    const platform = new NaviLinkPlatform(log, config({ devices: [] }), api.api)
    platform.configureAccessory(
      new FakeAccessory('Boiler Hot Water', 'uuid-1', {
        kind: 'dhw',
        deviceId: DEVICE_ID,
        model: 'Navien NCB',
        serialNumber: 'already-issued',
        adoptedLegacyUuid: false,
      }) as unknown as PlatformAccessory,
    )
    api.launch()

    expect(sessions).toHaveLength(0)
    expect(api.unregistered).toHaveLength(0)
  })

  it('makes a restored CurrentTemperature read fail while the platform is disabled', () => {
    const api = fakeApi()
    const log = fakeLog()
    const { NaviLinkPlatform } = require('../../src/platform') as
      typeof import('../../src/platform')
    const accessory = new FakeAccessory('Boiler Hot Water', 'uuid-1', {
      kind: 'dhw',
      deviceId: DEVICE_ID,
      model: 'Navien NCB',
      serialNumber: 'already-issued',
      adoptedLegacyUuid: false,
    })
    const platform = new NaviLinkPlatform(log, config({ email: '' }), api.api)
    platform.configureAccessory(accessory as unknown as PlatformAccessory)
    api.launch()

    expect(() => accessory.getService(api.api.hap.Service.Thermostat)
      ?.getCharacteristic(api.api.hap.Characteristic.CurrentTemperature)
      .read()).toThrow()
  })
})

describe('schema-complete config', () => {
  it('starts a session rather than throwing when every schema field is present', () => {
    const built = build({
      config: {
        platform: 'NaviLink',
        name: 'NaviLink',
        email: 'test@example.com',
        password: 'testpassword',
        options: {
          statusIntervalSec: 120,
          readOnly: false,
          allowPowerOff: false,
        },
        devices: [{
          id: 'a1b2c3d4e5f6:1',
          name: 'Zone One',
          channel: 1,
          dhw: true,
          heating: false,
          power: false,
          recirculation: false,
          fault: false,
          temperatureSensors: false,
          outdoorSensor: false,
        }],
      } as PlatformConfig,
    })
    expect(built.session().start).toHaveBeenCalledTimes(1)
  })
})

describe('diagnostics', () => {
  it('emits nothing when diagnosticsInterval is 0', () => {
    const built = build()
    expect(built.log.calls.join('\n')).not.toContain('Diagnostics start')
    expect(built.log.calls.join('\n')).not.toContain('Health:')
  })

  it('emits a start snapshot and a heartbeat when diagnostics are on', () => {
    jest.useFakeTimers()
    try {
      const built = build({
        config: config({
          options: { diagnosticsInterval: 30, structuredLogs: true },
        }),
      })
      expect(built.log.calls.some((line) => line.includes('Diagnostics start'))).toBe(true)
      expect(built.log.calls.some((line) => line.includes('"msg":"diagnostics.start"'))).toBe(true)
      built.log.calls.length = 0
      jest.advanceTimersByTime(30_000)
      expect(built.log.calls.some((line) => line.includes('Health:'))).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('the rules on writes', () => {
  it('refuses everything in read-only mode', async () => {
    const built = build({ config: config({ options: { readOnly: true } }) })
    await expect(built.platform.control(DEVICE_ID).setPower(true))
      .rejects.toThrow(ControlRejectedError)
    expect(built.session().publishControl).not.toHaveBeenCalled()
  })

  it('names the setting that refused, so the log says how to change it', async () => {
    const built = build({ config: config({ options: { readOnly: true } }) })
    await expect(built.platform.control(DEVICE_ID).setPower(true))
      .rejects.toThrow(/readOnly/)
  })

  it('refuses a power-off by default, because it stops the heating too', async () => {
    const built = build()
    await expect(built.platform.control(DEVICE_ID).setPower(false))
      .rejects.toThrow(/power-off disabled/)
    expect(built.session().publishControl).not.toHaveBeenCalled()
  })

  it('allows a power-on regardless, which cannot leave anyone cold', async () => {
    const built = build()
    await built.platform.control(DEVICE_ID).setPower(true)
    expect(built.session().publishControl).toHaveBeenCalledTimes(1)
  })

  it('allows a power-off once the user has opted in', async () => {
    const built = build({ config: config({ options: { allowPowerOff: true } }) })
    await built.platform.control(DEVICE_ID).setPower(false)
    expect(built.session().publishControl).toHaveBeenCalledTimes(1)
  })

  it('will not guess a temperature scale before the appliance has stated one', async () => {
    const built = build()
    built.session().observationFor.mockReturnValue(undefined)
    // Guessing would send a Celsius appliance a setpoint out by a factor of
    // two, which is a scald risk rather than a display glitch.
    await expect(built.platform.control(DEVICE_ID).setDomesticHotWaterSetpoint(49))
      .rejects.toThrow(ControlRejectedError)
  })

  it('sends a setpoint once the scale is known', async () => {
    const built = build()
    built.session().observationFor.mockReturnValue(observation())
    await built.platform.control(DEVICE_ID).setDomesticHotWaterSetpoint(120)
    expect(built.session().publishControl).toHaveBeenCalledTimes(1)
  })

  it('refuses when the session is not running at all', async () => {
    const built = build()
    await built.api.shutdown()
    await expect(built.platform.control(DEVICE_ID).setPower(true))
      .rejects.toThrow(/session not running/)
  })
})

describe('a cloud outage', () => {
  it('warns once for the account, not once for every accessory', () => {
    const built = build()
    built.session().emitUnreachable(new Error('socket hang up'))
    const warned = built.log.calls.filter((line) => line.includes('not answering:'))
    // One connection serves every accessory, so an outage is one event. Eight
    // identical lines would say nothing eight times.
    expect(warned).toHaveLength(1)
  })

  it('stays quiet on repeats, so an outage does not fill the log', () => {
    const built = build()
    built.session().emitUnreachable(new Error('socket hang up'))
    built.session().emitUnreachable(new Error('socket hang up'))
    built.session().emitUnreachable(new Error('socket hang up'))
    const warned = built.log.calls.filter((line) => line.includes('not answering:'))
    expect(warned).toHaveLength(1)
  })

  it('says when it recovers, so a healed outage does not read like a dead one', () => {
    const built = build()
    built.session().emitUnreachable(new Error('socket hang up'))
    built.session().emitObservation(DEVICE_ID, observation())
    expect(built.log.calls).toContain('info Publish-subscribe (mqtt) recovered')
  })

  it('stays quiet about recovery when nothing was wrong', () => {
    const built = build()
    built.session().emitObservation(DEVICE_ID, observation())
    expect(built.log.calls.some((line) => line.includes('Publish-subscribe (mqtt) recovered'))).toBe(false)
  })

  it('does not name the gateway MAC in the outage line', () => {
    const built = build()
    built.session().emitUnreachable(new Error(`connect ECONNREFUSED to ${MAC}`))
    const warned = built.log.calls.find((line) => line.includes('not answering:'))
    expect(warned).toBeDefined()
  })

  it('logs a broker close as itself, not as not answering', () => {
    const built = build()
    built.session().emitUnreachable(
      new Error('NaviLink broker closed the connection (code 1006)'),
    )
    expect(built.log.calls).toContain('warn NaviLink broker closed the connection (code 1006)')
    expect(built.log.calls.some((line) => line.includes('not answering'))).toBe(false)
  })
})

describe('shutting down', () => {
  it('stops the session', async () => {
    const built = build()
    const session = built.session()
    await built.api.shutdown()
    expect(session.stop).toHaveBeenCalledTimes(1)
  })
})

describe('PagerDuty signals', () => {
  const startupLine = 'homebridge-pagerduty support is enabled (fault.<name>, auth-failed)'
  let storagePath: string

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'navilink-platform-signals-'))
  })

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true })
  })

  function withSignals(overrides: Record<string, unknown> = {}): ReturnType<typeof build> {
    return build({
      storagePath,
      config: config({
        options: { pagerdutySignals: true },
        ...overrides,
      }),
    })
  }

  it('does not log or create the store when the setting is off', () => {
    const built = build({ storagePath })
    built.session().options.onAuthentication?.('rejected')
    built.session().emitObservation(DEVICE_ID, observation({
      readings: { errorCode: 12, subErrorCode: 0 },
    }))

    expect(built.log.calls.some((line) => line.includes('homebridge-pagerduty'))).toBe(false)
    expect(existsSync(join(storagePath, 'homebridge-pagerduty'))).toBe(false)
    expect(existsSync(join(storagePath, 'homebridge-navilink'))).toBe(false)
  })

  it('logs support once, before the session starts, and not again on a second start', () => {
    const built = withSignals()
    const lines = built.log.calls.filter((line) => line.includes(startupLine))

    expect(lines).toEqual([`info ${startupLine}`])
    expect(built.session().logAtStart.some((line) => line.includes(startupLine))).toBe(true)
    built.api.launch()
    expect(built.log.calls.filter((line) => line.includes(startupLine))).toHaveLength(1)
  })

  it('does not log or write when configuration is unusable', () => {
    const built = build({
      storagePath,
      config: config({ password: '', options: { pagerdutySignals: true } }),
    })

    expect(built.log.calls.some((line) => line.includes('homebridge-pagerduty'))).toBe(false)
    expect(existsSync(join(storagePath, 'homebridge-pagerduty'))).toBe(false)
    expect(sessions).toHaveLength(0)
  })
})

const platformSqlite = typeof process.getBuiltinModule === 'function'
  ? process.getBuiltinModule('node:sqlite') as typeof Sqlite | undefined
  : undefined
const describePlatformRows = platformSqlite === undefined ? describe.skip : describe

describePlatformRows('PagerDuty signal rows', () => {
  let storagePath: string

  const storeFile = (): string => join(
    storagePath,
    'homebridge-pagerduty',
    'signals-2026-10-24',
    'signals.sqlite',
  )

  const readRows = (): { signal: string; active: number; severity: string; summary: string }[] => {
    const db = new platformSqlite!.DatabaseSync(storeFile())
    try {
      return db.prepare(
        'SELECT signal, active, severity, summary FROM signals ORDER BY signal',
      ).all() as { signal: string; active: number; severity: string; summary: string }[]
    } finally {
      db.close()
    }
  }

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'navilink-platform-rows-'))
  })

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true })
  })

  function started(): ReturnType<typeof build> {
    return build({
      storagePath,
      config: config({ options: { pagerdutySignals: true } }),
    })
  }

  it('writes a fault from a status frame when the HomeKit fault tile is off', () => {
    const built = started()
    expect(existsSync(storeFile())).toBe(false)

    built.session().emitObservation(DEVICE_ID, observation({
      readings: { errorCode: 12, subErrorCode: 3 },
    }))

    expect(readRows()).toEqual([{
      signal: 'fault.boiler',
      active: 1,
      severity: 'critical',
      summary: 'Navien Boiler is reporting a fault',
    }])
    expect(built.log.calls.some((line) => line.includes('adding Boiler Fault'))).toBe(false)
  })

  it('clears the fault when a later frame has no error code', () => {
    const built = started()
    built.session().emitObservation(DEVICE_ID, observation({
      readings: { errorCode: 12, subErrorCode: 0 },
    }))
    built.session().emitObservation(DEVICE_ID, observation())

    expect(readRows()).toEqual([{
      signal: 'fault.boiler',
      active: 0,
      severity: 'critical',
      summary: 'Navien Boiler is reporting a fault',
    }])
  })

  it('writes auth-failed only when sign-in is rejected, and clears it when sign-in is accepted', () => {
    const built = started()
    built.session().emitUnreachable(new Error('socket hang up'))
    expect(existsSync(storeFile())).toBe(false)

    built.session().options.onAuthentication?.('rejected')
    expect(readRows()).toEqual([{
      signal: 'auth-failed',
      active: 1,
      severity: 'error',
      summary: 'NaviLink rejected the account email or password. Sign-in has stopped until it is corrected in Homebridge.',
    }])

    built.session().options.onAuthentication?.('accepted')
    expect(readRows()[0]?.active).toBe(0)
  })

  it('clears a fault for an appliance that left the configuration and leaves it on shutdown', async () => {
    const seeder = new PagerDutySignals({
      plugin: PLUGIN_NAME,
      storagePath,
      log: { warn: () => undefined },
    })
    seeder.write('fault.heater', {
      active: true,
      severity: 'critical',
      summary: 'Navien Heater is reporting a fault',
    })
    seeder.close()
    const close = jest.spyOn(PagerDutySignals.prototype, 'close')
    try {
      const built = started()

      expect(readRows()).toEqual([{
        signal: 'fault.heater',
        active: 0,
        severity: 'critical',
        summary: 'Navien Heater is reporting a fault',
      }])

      built.session().emitObservation(DEVICE_ID, observation({
        readings: { errorCode: 4, subErrorCode: 0 },
      }))
      await built.api.shutdown()

      expect(close).toHaveBeenCalledTimes(1)
      expect(readRows()).toEqual([
        {
          signal: 'fault.boiler',
          active: 1,
          severity: 'critical',
          summary: 'Navien Boiler is reporting a fault',
        },
        {
          signal: 'fault.heater',
          active: 0,
          severity: 'critical',
          summary: 'Navien Heater is reporting a fault',
        },
      ])
    } finally {
      close.mockRestore()
    }
  })
})
