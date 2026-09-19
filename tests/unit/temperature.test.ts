/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Temperature is where a quiet bug does the most damage: a scale read wrong
 * puts a setpoint out by a factor of two, and a round trip that does not
 * close makes a thermostat drift every time it is touched.
 */

import {
  celsiusToNative,
  decodeWireTemperature,
  encodeWireTemperature,
  formatNative,
  isUsableRange,
  nativeToCelsius,
  resolveSetpoint,
  round1,
  scaleFromTemperatureType,
  TEMPERATURE_TYPE_CELSIUS,
  TEMPERATURE_TYPE_FAHRENHEIT,
} from '../../src/utils/temperature'

describe('scaleFromTemperatureType', () => {
  it('reads the two documented values', () => {
    expect(scaleFromTemperatureType(TEMPERATURE_TYPE_CELSIUS)).toBe('celsius')
    expect(scaleFromTemperatureType(TEMPERATURE_TYPE_FAHRENHEIT)).toBe('fahrenheit')
  })

  it('treats anything else as unknown rather than guessing', () => {
    // `0` is what a gateway sends before the appliance has answered.
    // Defaulting it would scale every later reading wrongly.
    expect(scaleFromTemperatureType(0)).toBeUndefined()
    expect(scaleFromTemperatureType(undefined)).toBeUndefined()
    expect(scaleFromTemperatureType('2')).toBeUndefined()
  })
})

describe('the wire encoding', () => {
  it('reads a Celsius appliance in half-degree ticks', () => {
    expect(decodeWireTemperature(95, 'celsius')).toBe(47.5)
    expect(decodeWireTemperature(120, 'celsius')).toBe(60)
  })

  it('reads a Fahrenheit appliance in whole degrees', () => {
    expect(decodeWireTemperature(120, 'fahrenheit')).toBe(120)
  })

  it('returns zero as a reading, since zero is a temperature', () => {
    // Fields that use 0 to mean "no probe" are filtered where they are read,
    // by a caller that knows which of its fields are optional.
    expect(decodeWireTemperature(0, 'fahrenheit')).toBe(0)
  })

  it('rejects anything that is not a finite number', () => {
    expect(decodeWireTemperature(undefined, 'celsius')).toBeUndefined()
    expect(decodeWireTemperature('120', 'celsius')).toBeUndefined()
    expect(decodeWireTemperature(Number.NaN, 'celsius')).toBeUndefined()
  })

  it('round-trips through the wire encoding', () => {
    for (const native of [30, 47.5, 60]) {
      expect(decodeWireTemperature(encodeWireTemperature(native, 'celsius'), 'celsius'))
        .toBe(native)
    }
    for (const native of [86, 120, 140]) {
      expect(decodeWireTemperature(encodeWireTemperature(native, 'fahrenheit'), 'fahrenheit'))
        .toBe(native)
    }
  })
})

describe('conversion to and from Celsius', () => {
  it('leaves a Celsius appliance alone', () => {
    expect(nativeToCelsius(47.5, 'celsius')).toBe(47.5)
    expect(celsiusToNative(47.5, 'celsius')).toBe(47.5)
  })

  it('converts a Fahrenheit appliance', () => {
    expect(nativeToCelsius(120, 'fahrenheit')).toBe(48.9)
    expect(nativeToCelsius(32, 'fahrenheit')).toBe(0)
    expect(celsiusToNative(100, 'fahrenheit')).toBe(212)
  })
})

describe('resolveSetpoint', () => {
  const dhw = { scale: 'fahrenheit' as const, min: 86, max: 140 }

  it('snaps a Celsius request to the appliance grid', () => {
    // 48.9 °C is 120.02 °F, which the appliance holds as 120.
    expect(resolveSetpoint({ celsius: 48.9, ...dhw })).toBe(120)
  })

  it('clamps above the installer maximum', () => {
    // The installer's limit, not ours. Sending 160 to an appliance capped at
    // 140 is a command it will refuse, or worse, obey.
    expect(resolveSetpoint({ celsius: 71, ...dhw })).toBe(140)
  })

  it('clamps below the installer minimum', () => {
    expect(resolveSetpoint({ celsius: 10, ...dhw })).toBe(86)
  })

  it('clamps after snapping, not before', () => {
    // A value just inside the range must not be rounded back out of it.
    // 59.94 °C is 139.9 °F: snapping first gives 140, which is allowed.
    // Clamping a rounded-up 140.0 against a floor of 140 is also 140, but
    // the order matters at the other end, where ceil() would push past.
    expect(resolveSetpoint({ celsius: 59.94, ...dhw })).toBe(140)
    expect(resolveSetpoint({ celsius: 30.0, ...dhw })).toBe(86)
  })

  it('handles a Celsius appliance on whole degrees', () => {
    expect(resolveSetpoint({ celsius: 47.5, scale: 'celsius', min: 30, max: 60 })).toBe(48)
  })

  it('never returns a value outside the limits, for any input', () => {
    for (let celsius = -50; celsius <= 150; celsius += 0.5) {
      const result = resolveSetpoint({ celsius, ...dhw })
      expect(result).toBeGreaterThanOrEqual(86)
      expect(result).toBeLessThanOrEqual(140)
    }
  })
})

describe('isUsableRange', () => {
  it('accepts a range HAP will take', () => {
    expect(isUsableRange(30, 60)).toBe(true)
  })

  it('rejects a degenerate or absent range', () => {
    // HAP rejects a characteristic whose minimum is not below its maximum,
    // and a frame read mid-commissioning can report both as zero.
    expect(isUsableRange(60, 60)).toBe(false)
    expect(isUsableRange(60, 30)).toBe(false)
    expect(isUsableRange(undefined, 60)).toBe(false)
  })
})

describe('presentation helpers', () => {
  it('rounds to the resolution HomeKit displays', () => {
    expect(round1(48.888_9)).toBe(48.9)
  })

  it('formats in the appliance own scale', () => {
    expect(formatNative(120, 'fahrenheit')).toBe('120\u00B0F')
    expect(formatNative(47.5, 'celsius')).toBe('47.5\u00B0C')
  })
})
