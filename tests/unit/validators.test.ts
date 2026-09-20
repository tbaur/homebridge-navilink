/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Configuration is the only input a user writes by hand, so it decides whether
 * a typo costs them one appliance or the whole installation. It is also the
 * one place the account password is handled, and these messages end up in logs
 * that get pasted into issues, so the invariant that no message ever carries
 * the password (not its text, not its length) is asserted here, not
 * trusted.
 */

import {
  DEFAULT_STATUS_INTERVAL_SEC,
  MAX_LOG_FIELD_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_STATUS_INTERVAL_SEC,
  MIN_STATUS_INTERVAL_SEC,
} from '../../src/settings'
import type { NaviLinkDeviceConfig, ResolvedDevice } from '../../src/types'
import {
  forDisplay,
  forLog,
  isValidDeviceId,
  isValidEmail,
  resolveAccessories,
  resolveAccessoryPrefix,
  resolveStatusIntervalSec,
  validateConfig,
} from '../../src/utils/validators'

const DEVICE_ID = 'a1b2c3d4e5f6:1'
const SECOND_DEVICE_ID = 'f6e5d4c3b2a1:1'

function device(overrides: Partial<NaviLinkDeviceConfig> = {}): NaviLinkDeviceConfig {
  return { id: DEVICE_ID, name: 'Boiler', ...overrides }
}

function config(overrides: Record<string, unknown> = {}): unknown {
  return {
    platform: 'NaviLink',
    email: 'someone@example.com',
    password: 'a-good-password',
    devices: [device()],
    ...overrides,
  }
}

function resolved(overrides: Partial<ResolvedDevice> = {}): ResolvedDevice {
  return {
    id: DEVICE_ID,
    name: 'Boiler',
    channel: 1,
    dhw: true,
    heating: false,
    power: false,
    recirculation: false,
    fault: false,
    temperatureSensors: false,
    outdoorSensor: false,
    ...overrides,
  }
}

describe('forLog', () => {
  it('replaces the newline a hostile name would use to forge a log entry', () => {
    const result = forLog('Boiler\n[warn] a line nobody wrote')

    expect(result).not.toContain('\n')
    expect(result).toBe('Boiler\uFFFD[warn] a line nobody wrote')
  })

  it('caps one very long name so it cannot bury the rest of the log', () => {
    const result = forLog('B'.repeat(MAX_LOG_FIELD_LENGTH + 50))

    expect(result).toHaveLength(MAX_LOG_FIELD_LENGTH + 1)
    expect(result.endsWith('\u2026')).toBe(true)
  })

  it('describes a value that is not a string rather than throwing mid-log-line', () => {
    expect(forLog(42)).toBe('42')
    expect(forLog(undefined)).toBe('undefined')
    expect(forLog(null)).toBe('null')
  })

  it('gives the same answer twice for the same input', () => {
    // The sanitiser is a global regex, which carries `lastIndex` between calls
    // when one instance is shared, and would otherwise sanitise alternate
    // calls only.
    const name = 'Boiler\u0007\u0007'

    expect(forLog(name)).toBe(forLog(name))
  })
})

describe('forDisplay', () => {
  it('removes control characters before a name reaches HomeKit', () => {
    expect(forDisplay('Boiler\u0000 Hot Water')).toBe('Boiler Hot Water')
  })

  it('leaves a blank name undefined so the caller keeps the one it already has', () => {
    expect(forDisplay('   ')).toBeUndefined()
    expect(forDisplay('\u0001\u0002')).toBeUndefined()
  })

  it('fits a long name into the HomeKit name budget', () => {
    const result = forDisplay('B'.repeat(MAX_NAME_LENGTH + 10))!

    expect(result).toHaveLength(MAX_NAME_LENGTH)
    expect(result.endsWith('\u2026')).toBe(true)
  })

  it('passes an ordinary name through untouched', () => {
    expect(forDisplay('  Boiler Hot Water  ')).toBe('Boiler Hot Water')
  })
})

describe('isValidDeviceId', () => {
  it('accepts the identity the settings page writes', () => {
    expect(isValidDeviceId(DEVICE_ID)).toBe(true)
    expect(isValidDeviceId('a1b2c3d4e5f6:32')).toBe(true)
  })

  it('accepts a hand-edited spelling that still names the same appliance', () => {
    expect(isValidDeviceId('A1B2C3D4E5F6:1')).toBe(true)
    expect(isValidDeviceId('a1:b2:c3:d4:e5:f6:1')).toBe(true)
  })

  it('rejects anything that would seed an unstable accessory UUID', () => {
    // A UUID built from a bad id is a HomeKit accessory that never matches the
    // cached one, which reads to the user as their rooms emptying.
    expect(isValidDeviceId('a1b2c3d4e5f6')).toBe(false)
    expect(isValidDeviceId('a1b2c3d4e5f6:0')).toBe(false)
    expect(isValidDeviceId('a1b2c3d4e5f6:99')).toBe(false)
    expect(isValidDeviceId('a1b2c3d4e5f6:123')).toBe(false)
    expect(isValidDeviceId(undefined)).toBe(false)
    expect(isValidDeviceId(12)).toBe(false)
  })
})

describe('isValidEmail', () => {
  it('accepts an address the cloud can be asked about', () => {
    expect(isValidEmail('someone@example.com')).toBe(true)
    expect(isValidEmail('  someone@example.com  ')).toBe(true)
  })

  it('catches the typo that would otherwise look like a wrong password', () => {
    // A failed sign-in reports the same way whatever caused it, so an obvious
    // address mistake is worth naming at startup instead.
    expect(isValidEmail('someone-at-example.com')).toBe(false)
    expect(isValidEmail('some one@example.com')).toBe(false)
    expect(isValidEmail('someone@example')).toBe(false)
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false)
    expect(isValidEmail(undefined)).toBe(false)
  })
})

describe('resolveStatusIntervalSec', () => {
  it('leaves an unconfigured interval at the unhurried default, without complaining', () => {
    const warnings: string[] = []

    expect(resolveStatusIntervalSec(undefined, warnings)).toBe(DEFAULT_STATUS_INTERVAL_SEC)
    expect(warnings).toEqual([])
  })

  it('pulls an interval that would hammer the vendor cloud up to the floor', () => {
    const warnings: string[] = []

    expect(resolveStatusIntervalSec(1, warnings)).toBe(MIN_STATUS_INTERVAL_SEC)
    expect(warnings).toHaveLength(1)
  })

  it('pulls an interval nobody could have meant down to the ceiling', () => {
    const warnings: string[] = []

    expect(resolveStatusIntervalSec(86_400, warnings)).toBe(MAX_STATUS_INTERVAL_SEC)
    expect(warnings).toHaveLength(1)
  })

  it('accepts a number that arrived from the settings page as a string', () => {
    const warnings: string[] = []

    expect(resolveStatusIntervalSec('45', warnings)).toBe(45)
    expect(warnings).toEqual([])
  })

  it('falls back to the default for something that is not a number at all', () => {
    const warnings: string[] = []

    expect(resolveStatusIntervalSec('often', warnings)).toBe(DEFAULT_STATUS_INTERVAL_SEC)
    expect(warnings[0]).toContain('not a number')
  })

  it('answers a caller that does not want the warnings', () => {
    expect(resolveStatusIntervalSec('often')).toBe(DEFAULT_STATUS_INTERVAL_SEC)
    expect(resolveStatusIntervalSec(1)).toBe(MIN_STATUS_INTERVAL_SEC)
  })
})

describe('validateConfig and the password', () => {
  it('never puts the password into a message, whatever is wrong with it', () => {
    const passwords = ['  spaced-out-secret  ', 'x'.repeat(MAX_PASSWORD_LENGTH + 1), 'trailing-newline\n']

    for (const password of passwords) {
      const result = validateConfig(config({ password }))
      const messages = [...result.errors, ...result.warnings].join(' | ')

      expect(messages).not.toContain(password)
      expect(messages).not.toContain(password.trim())
    }
  })

  it('never puts the password length into the warning about trimmed whitespace', () => {
    // A length is enough to narrow a guess, and "you typed nine characters" is
    // no more diagnosable than saying the whitespace was there.
    const result = validateConfig(config({ password: '  hunter-two  ' }))

    expect(result.warnings).toEqual([
      'password had surrounding whitespace; trimmed',
    ])
    expect(result.warnings.join(' ')).not.toMatch(/\d/)
    expect(result.account?.password).toBe('hunter-two')
  })

  it('refuses a password so long it is plainly a pasted certificate', () => {
    const result = validateConfig(config({ password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) }))

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain(String(MAX_PASSWORD_LENGTH))
    expect(result.account).toBeUndefined()
  })

  it('treats a password that is nothing but whitespace as missing', () => {
    const result = validateConfig(config({ password: '   ' }))

    expect(result.errors).toEqual(['password is blank'])
    expect(result.account).toBeUndefined()
  })

  it('asks the user to sign in when either half of the account is absent', () => {
    for (const missing of [{ email: undefined }, { password: undefined }, { password: '' }]) {
      const result = validateConfig(config(missing))

      expect(result.errors[0]).toContain('email and password required')
      expect(result.account).toBeUndefined()
    }
  })

  it('names a bad address instead of leaving it to look like a wrong password', () => {
    const result = validateConfig(config({ email: 'someone-at-example.com' }))

    expect(result.errors).toEqual(['invalid email'])
    // The rest of the file is still validated, so one round of fixing clears
    // every problem rather than uncovering the next one.
    expect(result.devices).toHaveLength(1)
  })
})

describe('validateConfig', () => {
  it('accepts a working installation without a word of complaint', () => {
    const result = validateConfig(config())

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.account).toEqual({ email: 'someone@example.com', password: 'a-good-password' })
    expect(result.devices).toHaveLength(1)
  })

  it('disables the platform when there is no configuration block at all', () => {
    for (const nothing of [undefined, null, 'NaviLink', 7]) {
      const result = validateConfig(nothing)

      expect(result.errors).toEqual(['platform configuration is missing'])
      expect(result.devices).toEqual([])
      expect(result.options.statusIntervalSec).toBe(DEFAULT_STATUS_INTERVAL_SEC)
    }
  })

  it('treats a missing or mistyped devices list as something it cannot act on', () => {
    expect(validateConfig(config({ devices: undefined })).errors[0]).toContain('no devices list')
    expect(validateConfig(config({ devices: 'a1b2c3d4e5f6:1' })).errors[0])
      .toBe('devices must be a list')
  })

  it('skips one malformed entry rather than failing the whole installation', () => {
    // Rejecting every appliance because one entry is wrong is a worse outcome
    // for the user than losing the entry they got wrong.
    const result = validateConfig(config({
      devices: [device({ id: SECOND_DEVICE_ID }), 42, device()],
    }))

    expect(result.errors).toEqual([])
    expect(result.devices.map((entry) => entry.id)).toEqual([SECOND_DEVICE_ID, DEVICE_ID])
    expect(result.warnings.join(' ')).toContain('devices[1] is not an object')
  })

  it('treats every entry being rejected as fatal, because nothing was meant to be empty', () => {
    const result = validateConfig(config({ devices: [42, { name: 'Boiler' }] }))

    expect(result.devices).toEqual([])
    expect(result.errors).toEqual(['all 2 device(s) rejected'])
  })

  it('says which appliance went missing, by name and by reason', () => {
    // A device that silently fails to appear is the hardest kind of bug for a
    // user to notice, let alone report.
    const result = validateConfig(config({
      devices: [device(), device({ id: 'nonsense', name: 'Garage Boiler' })],
    }))

    expect(result.devices).toHaveLength(1)
    expect(result.warnings.join(' ')).toContain('no usable id')
    expect(result.warnings.join(' ')).toContain('Garage Boiler')
  })

  it('skips an unnamed device, because HomeKit has nothing to call it', () => {
    const result = validateConfig(config({ devices: [device({ name: undefined }), device()] }))

    expect(result.devices).toHaveLength(1)
    expect(result.warnings.join(' ')).toContain('devices[0] is missing a name')
  })

  it('skips a name carrying control characters instead of sanitising it silently', () => {
    const result = validateConfig(config({
      devices: [device({ name: 'Boiler\n[warn] forged' }), device({ id: SECOND_DEVICE_ID })],
    }))

    expect(result.devices.map((entry) => entry.id)).toEqual([SECOND_DEVICE_ID])
    expect(result.warnings.join(' ')).toContain('control characters')
    expect(result.warnings.join(' ')).not.toContain('\n')
  })

  it('skips a name longer than HomeKit will accept', () => {
    const result = validateConfig(config({
      devices: [device({ name: 'B'.repeat(MAX_NAME_LENGTH + 1) }), device({ id: SECOND_DEVICE_ID })],
    }))

    expect(result.devices.map((entry) => entry.id)).toEqual([SECOND_DEVICE_ID])
    expect(result.warnings.join(' ')).toContain(`longer than ${MAX_NAME_LENGTH} characters`)
  })

  it('keeps the first of two entries claiming the same appliance', () => {
    // Two accessories for one appliance would fight over the same setpoint.
    const result = validateConfig(config({
      devices: [device({ name: 'Boiler' }), device({ name: 'Boiler Again' })],
    }))

    expect(result.devices.map((entry) => entry.name)).toEqual(['Boiler'])
    expect(result.warnings.join(' ')).toContain('repeats id')
  })

  it('exposes hot water unless it is turned off, and nothing else unless it is turned on', () => {
    // A plugin that invents a heating thermostat nobody asked for is a plugin
    // that can be told to stop heating a house.
    const [defaults] = validateConfig(config()).devices

    expect(defaults).toMatchObject({
      dhw: true,
      heating: false,
      power: false,
      recirculation: false,
      fault: false,
      temperatureSensors: false,
      outdoorSensor: false,
    })
  })

  it('turns hot water off only when it is asked to, not for any falsy value', () => {
    expect(validateConfig(config({ devices: [device({ dhw: false })] })).devices[0]?.dhw).toBe(false)
    expect(validateConfig(config({ devices: [{ ...device(), dhw: 0 }] })).devices[0]?.dhw).toBe(true)
  })

  it('takes every accessory the user opted into', () => {
    const [enabled] = validateConfig(config({
      devices: [device({
        heating: true,
        power: true,
        recirculation: true,
        fault: true,
        temperatureSensors: true,
        outdoorSensor: true,
      })],
    })).devices

    expect(enabled).toMatchObject({
      heating: true,
      power: true,
      recirculation: true,
      fault: true,
      temperatureSensors: true,
      outdoorSensor: true,
    })
  })

  it('keeps a device whose channel is wrong, on the first channel', () => {
    // The channel is a detail of a cascade; getting it wrong should not cost
    // the appliance its accessories.
    const result = validateConfig(config({ devices: [{ ...device(), channel: 99 }] }))

    expect(result.devices[0]?.channel).toBe(1)
    expect(result.warnings.join(' ')).toContain('channel 99 is invalid')
  })

  it('reads the channel from the id, which is what the session addresses', () => {
    expect(validateConfig(config({
      devices: [device({ id: 'a1b2c3d4e5f6:4', channel: 4 })],
    })).devices[0]?.channel).toBe(4)
    expect(validateConfig(config({
      devices: [{ ...device(), id: 'a1b2c3d4e5f6:4', channel: '4' }],
    })).devices[0]?.channel).toBe(4)
  })

  it('uses the channel in the id when the two disagree', () => {
    const result = validateConfig(config({
      devices: [{ ...device(), id: 'a1b2c3d4e5f6:2', channel: 1 }],
    }))

    expect(result.devices[0]?.id).toBe('a1b2c3d4e5f6:2')
    expect(result.devices[0]?.channel).toBe(2)
    expect(result.warnings.join(' ')).toContain('does not match id')
  })

  it('normalises a hand-edited uppercase id so the UUID stays stable', () => {
    const result = validateConfig(config({ devices: [device({ id: 'A1B2C3D4E5F6:1' })] }))

    expect(result.devices[0]?.id).toBe('a1b2c3d4e5f6:1')
  })

  it('defaults both behaviour switches to the safe answer', () => {
    // Power-off is declined by default because a combi's power state governs
    // central heating as well as hot water.
    expect(validateConfig(config()).options).toEqual({
      statusIntervalSec: DEFAULT_STATUS_INTERVAL_SEC,
      allowPowerOff: false,
      readOnly: false,
      diagnosticsInterval: 0,
      structuredLogs: false,
      accessoryPrefix: '',
    })
  })

  it('reads the options a user set', () => {
    const result = validateConfig(config({
      options: {
        statusIntervalSec: 300,
        allowPowerOff: true,
        readOnly: true,
        diagnosticsInterval: 300,
        structuredLogs: true,
        accessoryPrefix: 'Zone One',
      },
    }))

    expect(result.options).toEqual({
      statusIntervalSec: 300,
      allowPowerOff: true,
      readOnly: true,
      diagnosticsInterval: 300,
      structuredLogs: true,
      accessoryPrefix: 'Zone One',
    })
  })

  it('clamps a short diagnostics interval up to 30s and treats 0 as off', () => {
    expect(validateConfig(config({ options: { diagnosticsInterval: 0 } }))
      .options.diagnosticsInterval).toBe(0)
    const short = validateConfig(config({ options: { diagnosticsInterval: 5 } }))
    expect(short.options.diagnosticsInterval).toBe(30)
    expect(short.warnings.join(' ')).toContain('clamped to 30s')
  })

  it('spells out what read-only will feel like from the Home app', () => {
    const result = validateConfig(config({ options: { readOnly: true } }))

    expect(result.errors).toEqual([])
    expect(result.warnings.join(' ')).toContain('readOnly: writes disabled')
  })

  it('treats an empty devices list as fatal, so cached tiles are not unregistered', () => {
    const result = validateConfig(config({ devices: [] }))

    expect(result.errors).toEqual(['no devices configured'])
    expect(result.devices).toEqual([])
  })
})

describe('resolveAccessoryPrefix', () => {
  it('leaves a blank prefix blank, without complaining', () => {
    const warnings: string[] = []

    expect(resolveAccessoryPrefix(undefined, warnings)).toBe('')
    expect(resolveAccessoryPrefix('', warnings)).toBe('')
    expect(resolveAccessoryPrefix('   ', warnings)).toBe('')
    expect(warnings).toEqual([])
  })

  it('trims and strips control characters', () => {
    expect(resolveAccessoryPrefix('  Zone One\u0000  ')).toBe('Zone One')
  })

  it('clamps a prefix that would overflow a HomeKit name', () => {
    const warnings: string[] = []
    const prefix = resolveAccessoryPrefix('Z'.repeat(MAX_NAME_LENGTH + 8), warnings)

    expect(prefix).toHaveLength(MAX_NAME_LENGTH)
    expect(warnings.join(' ')).toContain(`clamped to ${MAX_NAME_LENGTH} characters`)
  })

  it('ignores a non-string value so a hand-edit cannot break naming', () => {
    const warnings: string[] = []

    expect(resolveAccessoryPrefix(12, warnings)).toBe('')
    expect(warnings.join(' ')).toContain('is not a string')
  })
})

describe('resolveAccessories', () => {
  it('exposes only the accessories the device asked for', () => {
    expect(resolveAccessories([resolved()])).toEqual([
      { kind: 'dhw', deviceId: DEVICE_ID, name: 'Boiler Hot Water' },
    ])
  })

  it('names every accessory after the appliance it belongs to', () => {
    const accessories = resolveAccessories([resolved({
      heating: true,
      power: true,
      recirculation: true,
      fault: true,
      outdoorSensor: true,
    })])

    expect(accessories.map((accessory) => `${accessory.kind}:${accessory.name}`)).toEqual([
      'dhw:Boiler Hot Water',
      'heating:Boiler Heating',
      'power:Boiler Power',
      'recirculation:Boiler Recirculation',
      'fault:Boiler Fault',
      'outdoor:Boiler Outdoor',
    ])
  })

  it('creates all four probes up front rather than letting one appear mid-session', () => {
    // Which probes exist is only knowable from a live status frame, and an
    // accessory that appears minutes into a session looks like a fault.
    const probes = resolveAccessories([resolved({ dhw: false, temperatureSensors: true })])

    expect(probes.map((probe) => probe.kind)).toEqual([
      'dhwOutlet', 'dhwInlet', 'heatSupply', 'heatReturn',
    ])
  })

  it('warns when two accessories share a name, because Siri cannot tell them apart', () => {
    const warnings: string[] = []

    resolveAccessories([resolved(), resolved({ id: SECOND_DEVICE_ID })], warnings)

    expect(warnings).toEqual(['duplicate name: Boiler Hot Water (2)'])
  })

  it('says nothing when every name is distinct', () => {
    const warnings: string[] = []

    resolveAccessories([resolved(), resolved({ id: SECOND_DEVICE_ID, name: 'Garage' })], warnings)

    expect(warnings).toEqual([])
  })

  it('answers a caller that does not collect warnings', () => {
    expect(resolveAccessories([resolved(), resolved({ id: SECOND_DEVICE_ID })])).toHaveLength(2)
  })

  it('keeps a suffixed name inside the HomeKit name budget', () => {
    const [accessory] = resolveAccessories([resolved({
      name: 'B'.repeat(MAX_NAME_LENGTH),
      temperatureSensors: true,
    })])

    expect(accessory.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH)
    // The suffix is what tells two accessories on one appliance apart, so it
    // is the device name that gives way.
    expect(accessory.name.endsWith(' Hot Water')).toBe(true)
  })

  it('leaves every suffixed name inside the budget, whichever suffix is longest', () => {
    const accessories = resolveAccessories([resolved({
      name: 'B'.repeat(MAX_NAME_LENGTH - 2),
      heating: true,
      power: true,
      recirculation: true,
      fault: true,
      temperatureSensors: true,
      outdoorSensor: true,
    })])

    for (const accessory of accessories) {
      expect(accessory.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH)
    }
  })

  it('produces nothing for a device with every accessory turned off', () => {
    expect(resolveAccessories([resolved({ dhw: false })])).toEqual([])
    expect(resolveAccessories([])).toEqual([])
  })

  it('uses the prefix as the stem when there is one appliance', () => {
    expect(resolveAccessories([resolved()], undefined, 'Zone One')).toEqual([
      { kind: 'dhw', deviceId: DEVICE_ID, name: 'Zone One Hot Water' },
    ])
  })

  it('keeps the appliance name after the prefix when two appliances would otherwise collide', () => {
    const accessories = resolveAccessories(
      [resolved(), resolved({ id: SECOND_DEVICE_ID, name: 'Garage' })],
      undefined,
      'Zone One',
    )

    expect(accessories.map((accessory) => accessory.name)).toEqual([
      'Zone One Boiler Hot Water',
      'Zone One Garage Hot Water',
    ])
  })
})
