/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The two thermostats are what this plugin is for, and they are the two
 * accessories that can set fire to gas. A setpoint that arrives doubled, a
 * dial that springs back mid-drag, or an "off" that stops central heating in
 * February are all things a user would find out about the hard way.
 */

import { SETPOINT_COALESCE_MS } from '../../src/settings'
import { ControlRejectedError } from '../../src/utils'
import { DomesticHotWaterAccessory } from '../../src/devices/dhw-accessory'
import { SpaceHeatingAccessory } from '../../src/devices/heating-accessory'
import {
  characteristics,
  FakeHapStatusError,
  harness,
  initFrom,
  observation,
  SERVICE_COMMUNICATION_FAILURE,
  type Harness,
} from '../helpers/hap'

/** Let the coalescing timer fire and its async send settle. */
async function flushCoalesce(): Promise<void> {
  jest.advanceTimersByTime(SETPOINT_COALESCE_MS)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function dhw(overrides: Parameters<typeof harness>[0] = {}): {
  built: Harness
  accessory: DomesticHotWaterAccessory
} {
  const built = harness({ kind: 'dhw', observation: observation(), ...overrides })
  return { built, accessory: new DomesticHotWaterAccessory(initFrom(built)) }
}

function heating(overrides: Parameters<typeof harness>[0] = {}): {
  built: Harness
  accessory: SpaceHeatingAccessory
} {
  const built = harness({
    kind: 'heating',
    displayName: 'Boiler Heating',
    observation: observation(),
    ...overrides,
  })
  return { built, accessory: new SpaceHeatingAccessory(initFrom(built)) }
}

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('what a thermostat reports', () => {
  it('shows No Response before the appliance has said anything', () => {
    const { built } = dhw({ observation: undefined })
    expect(() => built.service('Thermostat')
      .getCharacteristic(characteristics.CurrentTemperature).read())
      .toThrow(FakeHapStatusError)
  })

  it('reports the outlet probe as current, not the setpoint', () => {
    const { built } = dhw()
    // 88 °F is well below the 120 °F setpoint, which is correct between draws:
    // a combi heats on demand rather than keeping a tank hot. A tile showing
    // 120 here would look tidy and mean nothing.
    const celsius = built.service('Thermostat')
      .getCharacteristic(characteristics.CurrentTemperature).read()
    expect(celsius).toBe(31.1)
  })

  it('reports the setpoint as the target', () => {
    const { built } = dhw()
    const celsius = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).read()
    expect(celsius).toBe(48.9)
  })

  it('offers only off and heat, because nothing here can cool', () => {
    const { built } = dhw()
    const target = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
    expect(target.props.validValues).toEqual([
      characteristics.TargetHeatingCoolingState.OFF,
      characteristics.TargetHeatingCoolingState.HEAT,
    ])
  })

  it('reads as off when the appliance is powered down', () => {
    const { built } = dhw({ observation: observation({ power: false }) })
    expect(built.service('Thermostat')
      .getCharacteristic(characteristics.CurrentHeatingCoolingState).read())
      .toBe(characteristics.CurrentHeatingCoolingState.OFF)
  })

  it('refuses to invent a current temperature when there is no probe', () => {
    const { built } = dhw({ observation: observation({ dhwOutlet: undefined }) })
    let thrown: unknown
    try {
      built.service('Thermostat')
        .getCharacteristic(characteristics.CurrentTemperature).read()
    } catch (error) {
      thrown = error
    }
    expect((thrown as FakeHapStatusError).hapStatus).toBe(SERVICE_COMMUNICATION_FAILURE)
  })

  it('publishes the installer range rather than a range of its own', () => {
    const { built, accessory } = dhw()
    accessory.applyObservation(observation(), 'startup')
    const props = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).props
    expect(props.minValue).toBeCloseTo(30, 0)
    expect(props.maxValue).toBeCloseTo(60, 0)
  })

  it('does not rewrite the range on every frame, because setProps notifies every controller', () => {
    const { built, accessory } = dhw()
    const target = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature)
    accessory.applyObservation(observation(), 'startup')
    const after = { ...target.props }
    accessory.applyObservation(observation({ dhwOutlet: 91 }), 'push')
    expect(target.props).toEqual(after)
  })

  it('follows the appliance scale for display units', () => {
    const { built } = dhw({ observation: observation({ scale: 'celsius' }) })
    expect(built.service('Thermostat')
      .getCharacteristic(characteristics.TemperatureDisplayUnits).read())
      .toBe(characteristics.TemperatureDisplayUnits.CELSIUS)
  })
})

describe('setting a temperature', () => {
  it('sends one command for a dial that was dragged, not one per step', async () => {
    const { built } = dhw()
    const target = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature)
    await target.write(45)
    await target.write(47)
    await target.write(49)
    await flushCoalesce()
    expect(built.control.dhwSetpoint).toHaveLength(1)
  })

  it('snaps a Celsius request onto the appliance whole-Fahrenheit grid', async () => {
    const { built } = dhw()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(49)
    await flushCoalesce()
    // 49 °C is 120.2 °F, and a Fahrenheit appliance only takes whole degrees.
    expect(built.control.dhwSetpoint).toEqual([120])
  })

  it('passes a Celsius appliance its own degrees straight through', async () => {
    const { built } = dhw({ observation: observation({
      scale: 'celsius',
      dhwSetpoint: 48,
      dhwMin: 35,
      dhwMax: 60,
    }) })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(50)
    await flushCoalesce()
    // Native degrees, not the half-degree wire ticks. The doubling is the
    // frame builder's job, and doing it here as well would halve the taps.
    expect(built.control.dhwSetpoint).toEqual([50])
  })

  it('clamps to the range the installer set rather than asking for more', async () => {
    const { built } = dhw()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(80)
    await flushCoalesce()
    expect(built.control.dhwSetpoint).toEqual([140])
  })

  it('answers the dial with what the user chose while the write is still pending', async () => {
    const { built } = dhw()
    const target = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature)
    await target.write(45)
    // Without this the dial visibly springs back to 48.9 mid-drag.
    expect(target.read()).toBe(45)
  })

  it('adopts what the appliance will actually hold, not what was dragged to', async () => {
    const { built } = dhw()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(49)
    await flushCoalesce()
    expect(built.optimistic).toEqual([{ dhwSetpoint: 120 }])
  })

  it('logs one line naming the value in the appliance own scale', async () => {
    const { built } = dhw()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(49)
    await flushCoalesce()
    expect(built.log.calls).toContain('info Boiler Hot Water: SET 120\u00B0F')
  })

  it('puts the dial back when the appliance refuses the setpoint', async () => {
    const { built } = dhw()
    built.failNextControl(new Error('the appliance is not connected'))
    const target = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature)
    await target.write(45)
    await flushCoalesce()
    expect(target.value).toBe(48.9)
    expect(built.log.calls.some((line) => line.includes('could not set the temperature')))
      .toBe(true)
  })

  it('does not send a setpoint before the appliance has reported its limits', async () => {
    const { built } = dhw({ observation: observation({ dhwMin: undefined, dhwMax: undefined }) })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(45)
    await flushCoalesce()
    expect(built.control.dhwSetpoint).toEqual([])
    expect(built.log.calls.some((line) => line.includes('before the appliance has reported')))
      .toBe(true)
  })

  it('ignores a value HomeKit sent that is not a number', async () => {
    const { built } = dhw()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write('warm')
    await flushCoalesce()
    expect(built.control.dhwSetpoint).toEqual([])
  })

  it('does not let a poll landing mid-drag undo what the user chose', async () => {
    const { built, accessory } = dhw()
    const target = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature)
    await target.write(45)
    accessory.applyObservation(observation({ dhwSetpoint: 120 }), 'poll')
    expect(target.read()).toBe(45)
  })
})

describe('read-only mode', () => {
  it('sends nothing and says so once, however many times a scene presses', async () => {
    const { built } = dhw({ readOnly: true })
    const target = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature)
    await target.write(45)
    await target.write(46)
    await flushCoalesce()
    expect(built.control.dhwSetpoint).toEqual([])
    const explained = built.log.calls.filter((line) => line.includes('options.readOnly is on'))
    expect(explained).toHaveLength(1)
  })

  it('refuses a mode change too', async () => {
    const { built } = dhw({ readOnly: true })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.OFF)
    expect(built.control.power).toEqual([])
  })
})

describe('the hot water power guard', () => {
  it('declines an off, because that would stop central heating too', async () => {
    const { built } = dhw()
    built.failNextControl(Object.assign(
      new Error('switching the appliance off from HomeKit is disabled'),
      { name: 'ControlRejectedError' },
    ))
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.OFF)
    expect(built.service('Thermostat')
      .lastValue(characteristics.TargetHeatingCoolingState))
      .toBe(characteristics.TargetHeatingCoolingState.HEAT)
  })

  it('always allows an on, because the plugin only ever hesitates about stopping', async () => {
    const { built } = dhw({ observation: observation({ power: false }) })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.HEAT)
    expect(built.control.power).toEqual([true])
  })
})

describe('the space-heating thermostat', () => {
  it('sets the flow setpoint on its own command, not the hot water one', async () => {
    const { built } = heating()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(45)
    await flushCoalesce()
    expect(built.control.heatSetpoint).toEqual([113])
    expect(built.control.dhwSetpoint).toEqual([])
  })

  it('wires off to the heating enable, which is the thing being asked about', async () => {
    const { built } = heating()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.OFF)
    expect(built.control.heating).toEqual([false])
    expect(built.control.power).toEqual([])
  })

  it('reports the supply probe, not the hot water outlet', () => {
    const { built } = heating()
    expect(built.service('Thermostat')
      .getCharacteristic(characteristics.CurrentTemperature).read())
      .toBe(35)
  })

  it('stays quiet on an appliance with no loop, and says why once', () => {
    const { built, accessory } = heating({
      observation: observation({ heatingSupported: false }),
    })
    accessory.applyObservation(observation({ heatingSupported: false }), 'startup')
    accessory.applyObservation(observation({ heatingSupported: false }), 'push')
    const warned = built.log.calls.filter((line) => line.includes('no space-heating loop'))
    expect(warned).toHaveLength(1)
  })

  it('reports No Response rather than a placeholder setpoint on a water heater', () => {
    const { built } = heating({
      observation: observation({ heatingSupported: false, heatSetpoint: 32 }),
    })
    expect(() => built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).read())
      .toThrow(FakeHapStatusError)
    expect(() => built.service('Thermostat')
      .getCharacteristic(characteristics.CurrentHeatingCoolingState).read())
      .toThrow(FakeHapStatusError)
  })

  it('does not send a heating enable to an appliance with no loop', async () => {
    const { built } = heating({
      observation: observation({ heatingSupported: false, heating: false }),
    })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.HEAT)
    expect(built.control.heating).toEqual([])
    expect(built.control.heatSetpoint).toEqual([])
  })

  it('does not send a heating setpoint to an appliance with no loop', async () => {
    const { built } = heating({
      observation: observation({
        heatingSupported: false,
        heatSetpoint: 32,
        heatMin: 32,
        heatMax: 32,
      }),
    })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(45)
    await flushCoalesce()
    expect(built.control.heatSetpoint).toEqual([])
    expect(built.control.heating).toEqual([])
  })

  it('leaves the tile where it was when the appliance refuses a mode change', async () => {
    const { built } = heating()
    built.failNextControl(new Error('the appliance is not connected'))
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.OFF)
    expect(built.service('Thermostat')
      .lastValue(characteristics.TargetHeatingCoolingState))
      .toBe(characteristics.TargetHeatingCoolingState.HEAT)
  })
})

describe('shutdown', () => {
  it('drops a pending setpoint rather than sending it after Homebridge stopped', async () => {
    const { built, accessory } = dhw()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(45)
    accessory.stop()
    await flushCoalesce()
    expect(built.control.dhwSetpoint).toEqual([])
  })

  it('ignores an observation that arrives after it was stopped', () => {
    const { built, accessory } = dhw()
    accessory.stop()
    const before = built.service('Thermostat')
      .getCharacteristic(characteristics.CurrentTemperature).updates.length
    accessory.applyObservation(observation({ dhwOutlet: 130 }), 'push')
    expect(built.service('Thermostat')
      .getCharacteristic(characteristics.CurrentTemperature).updates)
      .toHaveLength(before)
  })
})

describe('switching a thermostat on and off', () => {
  /** Let the mode write's async send settle. */
  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  it('powers the appliance from the hot water tile', async () => {
    const { built } = dhw({ observation: observation({ power: false }) })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.HEAT)
    await settle()
    expect(built.control.power).toEqual([true])
    expect(built.log.calls).toContain('info Boiler Hot Water: HEAT')
  })

  it('powers the appliance down from the hot water tile when the write is allowed', async () => {
    const { built } = dhw()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.OFF)
    await settle()
    expect(built.control.power).toEqual([false])
  })

  it('explains the power guard once rather than on every press', async () => {
    const { built } = dhw()
    const state = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
    const guard = new ControlRejectedError(
      'switching the appliance off from HomeKit is disabled',
    )

    built.failNextControl(guard)
    await state.write(characteristics.TargetHeatingCoolingState.OFF)
    await settle()
    built.failNextControl(guard)
    await state.write(characteristics.TargetHeatingCoolingState.OFF)
    await settle()

    // Once at info, and at debug thereafter: a scene that sweeps everything
    // off would otherwise write this line on every press.
    const explained = built.log.calls.filter((line) => line.startsWith('info '))
    expect(explained).toHaveLength(1)
  })

  it('puts the tile back to heating when the guard refuses', async () => {
    const { built } = dhw()
    built.failNextControl(new ControlRejectedError('switching off is disabled'))
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.OFF)
    await settle()
    expect(built.service('Thermostat')
      .lastValue(characteristics.TargetHeatingCoolingState))
      .toBe(characteristics.TargetHeatingCoolingState.HEAT)
  })

  it('warns rather than explains when the appliance itself failed', async () => {
    const { built } = dhw({ observation: observation({ power: false }) })
    built.failNextControl(new Error('the appliance is not connected'))
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.HEAT)
    await settle()
    expect(built.log.calls.some((line) => line.includes('could not change the power state')))
      .toBe(true)
  })

  it('enables the heating loop from the heating tile, not the whole appliance', async () => {
    const { built } = heating({ observation: observation({ heating: false }) })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.HEAT)
    await settle()
    // Powering the appliance would stop hot water as well, which is not what
    // a heating tile promises.
    expect(built.control.heating).toEqual([true])
    expect(built.control.power).toEqual([])
  })

  it('sends nothing when the tile is already in the requested state', async () => {
    const { built } = dhw()
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.HEAT)
    await settle()
    // A scene re-asserting a state costs a cloud round-trip and can spend
    // the control lockout that a real command then needs.
    expect(built.control.power).toEqual([])
  })

  it('still sends when it has no idea what state the appliance is in', async () => {
    const { built } = dhw({ observation: undefined })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.HEAT)
    await settle()
    // Silence is not evidence that the appliance is already on.
    expect(built.control.power).toEqual([true])
  })
})

describe('read-only mode', () => {
  it('refuses a setpoint and says which setting refused', async () => {
    const { built } = dhw({ readOnly: true })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(45)
    await flushCoalesce()
    expect(built.control.dhwSetpoint).toEqual([])
    expect(built.log.calls.some((line) => line.includes('options.readOnly'))).toBe(true)
  })

  it('says it once, not once per drag of the dial', async () => {
    const { built } = dhw({ readOnly: true })
    const target = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature)
    await target.write(45)
    await flushCoalesce()
    await target.write(46)
    await flushCoalesce()
    const explained = built.log.calls.filter((line) => line.includes('options.readOnly'))
    expect(explained).toHaveLength(1)
  })

  it('puts the dial back where the appliance has it', async () => {
    const { built } = dhw({ readOnly: true })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature).write(45)
    await flushCoalesce()
    expect(built.service('Thermostat')
      .lastValue(characteristics.TargetTemperature)).toBe(48.9)
  })

  it('refuses a mode change too', async () => {
    const { built } = dhw({ readOnly: true })
    await built.service('Thermostat')
      .getCharacteristic(characteristics.TargetHeatingCoolingState)
      .write(characteristics.TargetHeatingCoolingState.OFF)
    expect(built.control.power).toEqual([])
  })
})

describe('setting a temperature before the appliance has said what it accepts', () => {
  it('refuses rather than guessing a range', async () => {
    const { built } = dhw({ observation: undefined })
    const target = built.service('Thermostat')
      .getCharacteristic(characteristics.TargetTemperature)
    // The write itself must not throw: HomeKit is asking, and No Response on
    // a setpoint is less useful than a logged explanation.
    await target.write(45)
    await flushCoalesce()
    expect(built.control.dhwSetpoint).toEqual([])
    expect(built.log.calls.some((line) => line.includes('before the appliance has reported')))
      .toBe(true)
  })
})
