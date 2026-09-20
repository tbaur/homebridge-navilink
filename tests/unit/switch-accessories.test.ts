/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The switches, the fault sensor and the probes. Three of these can be
 * configured on hardware that cannot do the thing they name, because whether
 * a pump or a probe exists is only knowable from a live frame that arrives
 * after the accessory is registered. What they do in that case is the point
 * of most of what follows: a tile that silently accepts presses that do
 * nothing is worse than one that says it cannot.
 */

import { FaultAccessory } from '../../src/devices/fault-accessory'
import { PowerAccessory } from '../../src/devices/power-accessory'
import { ProbeAccessory } from '../../src/devices/probe-accessory'
import { RecirculationAccessory } from '../../src/devices/recirculation-accessory'
import { ControlRejectedError } from '../../src/utils'
import {
  characteristics,
  FakeHapStatusError,
  harness,
  initFrom,
  observation,
  type Harness,
} from '../helpers/hap'

/** Let a write's budget race and its inner promise settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('the power switch', () => {
  function build(overrides: Parameters<typeof harness>[0] = {}): {
    built: Harness
    accessory: PowerAccessory
  } {
    const built = harness({
      kind: 'power',
      displayName: 'Boiler Power',
      observation: observation(),
      ...overrides,
    })
    return { built, accessory: new PowerAccessory(initFrom(built)) }
  }

  it('reports the appliance power state', () => {
    const { built } = build()
    expect(built.service('Switch').getCharacteristic(characteristics.On).read()).toBe(true)
  })

  it('shows No Response before the appliance has said anything', () => {
    const { built } = build({ observation: undefined })
    expect(() => built.service('Switch').getCharacteristic(characteristics.On).read())
      .toThrow(FakeHapStatusError)
  })

  it('switches the appliance on', async () => {
    const { built } = build({ observation: observation({ power: false }) })
    await built.service('Switch').getCharacteristic(characteristics.On).write(true)
    await settle()
    expect(built.control.power).toEqual([true])
    expect(built.log.calls).toContain('info Boiler Power: POWER ON')
  })

  it('adopts the new state at once, so the tile does not flick back', async () => {
    const { built } = build({ observation: observation({ power: false }) })
    await built.service('Switch').getCharacteristic(characteristics.On).write(true)
    await settle()
    expect(built.optimistic).toEqual([{ power: true }])
  })

  it('springs back and explains once when the power-off guard refuses', async () => {
    const { built } = build()
    const guard = new ControlRejectedError(
      'switching the appliance off from HomeKit is disabled',
    )
    const on = built.service('Switch').getCharacteristic(characteristics.On)

    built.failNextControl(guard)
    await on.write(false)
    await settle()
    built.failNextControl(guard)
    await on.write(false)
    await settle()

    expect(built.control.power).toEqual([])
    expect(on.value).toBe(true)
    // A scene that sweeps everything off would otherwise write this line on
    // every press, for a decision the user already read about.
    const explained = built.log.calls.filter((line) => line.startsWith('info Boiler Power:'))
    expect(explained).toHaveLength(1)
  })

  it('warns rather than explains when the appliance itself failed', async () => {
    const { built } = build()
    built.failNextControl(new Error('the appliance is not connected'))
    await built.service('Switch').getCharacteristic(characteristics.On).write(false)
    await settle()
    expect(built.log.calls.some((line) => line.includes('warn Boiler Power: power failed')))
      .toBe(true)
  })

  it('does not send a power command the appliance is already in', async () => {
    const { built } = build()
    await built.service('Switch').getCharacteristic(characteristics.On).write(true)
    await settle()
    expect(built.control.power).toEqual([])
  })

  it('declines a write in read-only with the same sentence as the thermostats', async () => {
    const { built } = build({ readOnly: true, observation: observation({ power: false }) })
    await built.service('Switch').getCharacteristic(characteristics.On).write(true)
    await settle()
    expect(built.control.power).toEqual([])
    expect(built.log.calls.some((line) => line.includes('readOnly; write ignored'))).toBe(true)
  })

  it('publishes a changed state and stays quiet about an unchanged one', () => {
    const { built, accessory } = build()
    const on = built.service('Switch').getCharacteristic(characteristics.On)
    accessory.applyObservation(observation({ power: false }), 'push')
    const after = on.updates.length
    accessory.applyObservation(observation({ power: false }), 'push')
    expect(on.updates).toHaveLength(after)
  })
})

describe('the recirculation switch', () => {
  function build(overrides: Parameters<typeof harness>[0] = {}): {
    built: Harness
    accessory: RecirculationAccessory
  } {
    const built = harness({
      kind: 'recirculation',
      displayName: 'Boiler Recirculation',
      observation: observation(),
      ...overrides,
    })
    return { built, accessory: new RecirculationAccessory(initFrom(built)) }
  }

  it('starts the pump', async () => {
    const { built } = build()
    await built.service('Switch').getCharacteristic(characteristics.On).write(true)
    await settle()
    expect(built.control.recirculation).toEqual([true])
    expect(built.log.calls).toContain('info Boiler Recirculation: RECIRCULATE')
  })

  it('follows the appliance when the pump stops itself, which it will', () => {
    const { built, accessory } = build()
    accessory.applyObservation(observation({ recirculationOn: true }), 'push')
    accessory.applyObservation(observation({ recirculationOn: false }), 'push')
    expect(built.service('Switch').lastValue(characteristics.On)).toBe(false)
  })

  it('reports No Response on an appliance with no pump, rather than a made-up false', () => {
    const { built } = build({ observation: observation({ recirculationEquipped: false }) })
    expect(() => built.service('Switch').getCharacteristic(characteristics.On).read())
      .toThrow(FakeHapStatusError)
  })

  it('says once that no pump is fitted, however many frames arrive', () => {
    const { built, accessory } = build({
      observation: observation({ recirculationEquipped: false }),
    })
    accessory.applyObservation(observation({ recirculationEquipped: false }), 'startup')
    accessory.applyObservation(observation({ recirculationEquipped: false }), 'push')
    const warned = built.log.calls.filter((line) => line.includes('no recirculation pump'))
    expect(warned).toHaveLength(1)
  })

  it('refuses a write before the appliance has said whether a pump is fitted', async () => {
    const { built } = build({ observation: undefined })
    await expect(built.service('Switch').getCharacteristic(characteristics.On).write(true))
      .rejects.toBeInstanceOf(FakeHapStatusError)
    expect(built.control.recirculation).toEqual([])
  })

  it('sends nothing once a frame has shown there is no pump to start', async () => {
    const { built, accessory } = build({
      observation: observation({ recirculationEquipped: false }),
    })
    accessory.applyObservation(observation({ recirculationEquipped: false }), 'startup')
    await built.service('Switch').getCharacteristic(characteristics.On).write(true)
    await settle()
    expect(built.control.recirculation).toEqual([])
    expect(built.service('Switch').lastValue(characteristics.On)).toBe(false)
  })

  it('puts the tile back when the appliance refuses', async () => {
    const { built } = build()
    built.failNextControl(new Error('the appliance is not connected'))
    await built.service('Switch').getCharacteristic(characteristics.On).write(true)
    await settle()
    expect(built.service('Switch').lastValue(characteristics.On)).toBe(false)
  })
})

describe('the fault sensor', () => {
  function build(overrides: Parameters<typeof harness>[0] = {}): {
    built: Harness
    accessory: FaultAccessory
  } {
    const built = harness({
      kind: 'fault',
      displayName: 'Boiler Fault',
      observation: observation(),
      ...overrides,
    })
    return { built, accessory: new FaultAccessory(initFrom(built)) }
  }

  it('rests closed, which is what stops it notifying when nothing is wrong', () => {
    const { built } = build()
    expect(built.service('ContactSensor')
      .getCharacteristic(characteristics.ContactSensorState).read())
      .toBe(characteristics.ContactSensorState.CONTACT_DETECTED)
  })

  it('opens on an error code, which is what raises the HomeKit notification', () => {
    const { built } = build({
      observation: observation({ readings: { errorCode: 12, subErrorCode: 3 } }),
    })
    expect(built.service('ContactSensor')
      .getCharacteristic(characteristics.ContactSensorState).read())
      .toBe(characteristics.ContactSensorState.CONTACT_NOT_DETECTED)
  })

  it('logs the code and its sub-code, so the log says what to look up', () => {
    const { built, accessory } = build()
    accessory.applyObservation(
      observation({ readings: { errorCode: 12, subErrorCode: 3 } }),
      'push',
    )
    expect(built.log.calls.some((line) => line.includes('error 12.3'))).toBe(true)
  })

  it('omits a sub-code of zero rather than printing a bare full stop', () => {
    const { built, accessory } = build()
    accessory.applyObservation(
      observation({ readings: { errorCode: 12, subErrorCode: 0 } }),
      'push',
    )
    expect(built.log.calls.some((line) => line.includes('error 12'))).toBe(true)
  })

  it('reports a standing fault once rather than on every frame', () => {
    const { built, accessory } = build()
    const faulted = observation({ readings: { errorCode: 12, subErrorCode: 0 } })
    accessory.applyObservation(faulted, 'startup')
    accessory.applyObservation(faulted, 'poll')
    accessory.applyObservation(faulted, 'poll')
    expect(built.log.calls.filter((line) => line.includes(': error '))).toHaveLength(1)
  })

  it('says when the fault clears, so the log is not left showing a dead boiler', () => {
    const { built, accessory } = build()
    accessory.applyObservation(
      observation({ readings: { errorCode: 12, subErrorCode: 0 } }),
      'push',
    )
    accessory.applyObservation(observation(), 'push')
    expect(built.log.calls).toContain('info Boiler Fault: fault cleared')
  })

  it('does not say the fault has cleared on the first healthy frame', () => {
    const { built, accessory } = build()
    accessory.applyObservation(observation({ readings: { errorCode: 0, subErrorCode: 0 } }), 'startup')
    expect(built.log.calls.some((line) => line.includes('fault cleared'))).toBe(false)
  })
})

describe('a temperature probe', () => {
  function build(
    kind: 'dhwOutlet' | 'heatSupply' | 'outdoor',
    overrides: Parameters<typeof harness>[0] = {},
  ): { built: Harness; accessory: ProbeAccessory } {
    const built = harness({
      kind,
      displayName: 'Boiler Outdoor',
      observation: observation(),
      ...overrides,
    })
    return { built, accessory: new ProbeAccessory({ ...initFrom(built), kind }) }
  }

  it('reports its own field and not another probe', () => {
    const { built } = build('heatSupply')
    expect(built.service('TemperatureSensor')
      .getCharacteristic(characteristics.CurrentTemperature).read())
      .toBe(35)
  })

  it('reports No Response rather than the -17.8 °C that an absent probe would publish', () => {
    const { built } = build('outdoor')
    expect(() => built.service('TemperatureSensor')
      .getCharacteristic(characteristics.CurrentTemperature).read())
      .toThrow(FakeHapStatusError)
  })

  it('marks itself inactive when there is nothing behind it', () => {
    const { built, accessory } = build('outdoor')
    accessory.applyObservation(observation(), 'startup')
    expect(built.service('TemperatureSensor').lastValue(characteristics.StatusActive)).toBe(false)
  })

  it('names the missing probe once, so the reason is in the log exactly once', () => {
    const { built, accessory } = build('outdoor')
    accessory.applyObservation(observation(), 'startup')
    accessory.applyObservation(observation(), 'poll')
    const warned = built.log.calls.filter((line) => line.includes('no outdoor sensor'))
    expect(warned).toHaveLength(1)
  })

  it('comes back to life if the probe starts reporting', () => {
    const { built, accessory } = build('outdoor')
    accessory.applyObservation(observation(), 'startup')
    accessory.applyObservation(observation({ outdoor: 41 }), 'push')
    const service = built.service('TemperatureSensor')
    expect(service.lastValue(characteristics.StatusActive)).toBe(true)
    expect(service.lastValue(characteristics.CurrentTemperature)).toBe(5)
  })
})

describe('accessory information', () => {
  it('publishes the generated serial number, never the gateway MAC', () => {
    const built = harness({ kind: 'power', observation: observation() })
    new PowerAccessory(initFrom(built))
    const info = built.service('AccessoryInformation')
    expect(info.lastValue(characteristics.SerialNumber)).toBe(built.context.serialNumber)
    expect(String(info.lastValue(characteristics.SerialNumber))).not.toContain('a1b2c3d4e5f6')
  })

  it('publishes the plugin version as the firmware revision', () => {
    const built = harness({ kind: 'power', observation: observation() })
    const accessory = new PowerAccessory(initFrom(built))
    expect(built.service('AccessoryInformation')
      .lastValue(characteristics.FirmwareRevision)).toBe('0.1.0')
    accessory.updateIdentity({ model: 'Navien NCB', firmware: '4352' })
    expect(built.service('AccessoryInformation').lastValue(characteristics.Model))
      .toBe('Navien NCB')
    expect(built.service('AccessoryInformation').lastValue(characteristics.HardwareRevision))
      .toBe('4352')
  })

  it('reuses a restored service rather than adding a second one', () => {
    const built = harness({ kind: 'power', observation: observation() })
    new PowerAccessory(initFrom(built))
    new PowerAccessory(initFrom(built))
    const switches = (built.accessory as unknown as { services: { UUID: string }[] })
      .services.filter((service) => service.UUID === 'Switch')
    // A second service would be unbound to any handler, and the user's room
    // assignment lives on the first.
    expect(switches).toHaveLength(1)
  })
})
