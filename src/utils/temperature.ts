/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Temperature between three representations.
 *
 * There are three, and conflating any two of them produces a bug that looks
 * like a rounding error and is not one.
 *
 * 1. **Wire.** What the appliance puts in a status frame. A Celsius unit sends
 *    half-degree ticks, so `95` means 47.5 °C. A Fahrenheit unit sends whole
 *    degrees, so `120` means 120 °F. The scale is per appliance, reported once
 *    in `channelinfo` as `temperatureType`, and it is not a display preference:
 *    it decides how every number in every frame is read.
 * 2. **Native.** The scale the appliance is commissioned in, which is what the
 *    NaviLink app shows and what the installer set the limits in. Log lines use
 *    this, so that a value in the log matches the value on the front panel.
 * 3. **HomeKit.** Always Celsius, whatever the phone displays. HAP defines
 *    `CurrentTemperature` and `TargetTemperature` in Celsius; the Home app
 *    converts for display using the phone's region.
 *
 * The awkward case is a Fahrenheit appliance, which is most of them in North
 * America. Its setpoint grid is whole degrees Fahrenheit, and there is no
 * Celsius step that lands on it: 1 °F is 5/9 °C. A HomeKit write therefore
 * cannot always be honoured exactly, and the honest thing is to snap it to the
 * grid and report back what the appliance actually took, rather than echo the
 * request and let the next status frame silently contradict it.
 */

/** The scale an appliance speaks, as reported in `channelinfo`. */
export type TemperatureScale = 'celsius' | 'fahrenheit'

/**
 * `temperatureType` values seen in `channelinfo`.
 *
 * `0` means the gateway has not learned the appliance's scale yet, which
 * happens on a frame read before the appliance has answered. Treated as
 * unknown rather than defaulted, because guessing wrong scales every reading
 * by a factor of two or shifts it by 32 degrees.
 */
export const TEMPERATURE_TYPE_CELSIUS = 1

/** @see TEMPERATURE_TYPE_CELSIUS */
export const TEMPERATURE_TYPE_FAHRENHEIT = 2

/**
 * Step advertised to HomeKit for a writable setpoint.
 *
 * Half a degree Celsius, which is finer than a Fahrenheit appliance's own grid
 * (5/9 °C) and equal to a Celsius appliance's. Advertising a step the appliance
 * cannot hit is the lesser evil: the alternative is advertising 5/9, which HAP
 * would round on its way in anyway, so the write would still snap but the
 * reported range would also drift away from the true limits.
 */
export const HOMEKIT_TEMPERATURE_STEP = 0.5

/** Read `temperatureType` from a `channelinfo` frame. Undefined when unknown. */
export function scaleFromTemperatureType(value: unknown): TemperatureScale | undefined {
  if (value === TEMPERATURE_TYPE_CELSIUS) {
    return 'celsius'
  }
  if (value === TEMPERATURE_TYPE_FAHRENHEIT) {
    return 'fahrenheit'
  }
  return undefined
}

/**
 * Decode a wire temperature into the appliance's native scale.
 *
 * Returns undefined for a missing or unparseable value so a caller can leave a
 * characteristic alone instead of publishing a zero. Zero itself is a real
 * reading and is returned as one; the several fields that use `0` to mean "not
 * fitted" are filtered where they are read, not here, because only the caller
 * knows which of its fields are optional.
 */
export function decodeWireTemperature(
  raw: unknown,
  scale: TemperatureScale,
): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return undefined
  }
  return scale === 'celsius' ? round1(raw / 2) : raw
}

/**
 * Encode a native temperature for the wire.
 *
 * The inverse of {@link decodeWireTemperature}. A Celsius appliance takes
 * half-degree ticks, so the value is doubled and rounded to an integer: the
 * wire carries no fractions, and a non-integer here would be a value the
 * appliance cannot represent.
 */
export function encodeWireTemperature(native: number, scale: TemperatureScale): number {
  return scale === 'celsius' ? Math.round(native * 2) : Math.round(native)
}

/** Convert a native reading to the Celsius HomeKit expects. */
export function nativeToCelsius(native: number, scale: TemperatureScale): number {
  return scale === 'celsius' ? native : round1(((native - 32) * 5) / 9)
}

/** Convert a Celsius value from HomeKit to the appliance's native scale. */
export function celsiusToNative(celsius: number, scale: TemperatureScale): number {
  return scale === 'celsius' ? celsius : (celsius * 9) / 5 + 32
}

/**
 * Turn a HomeKit setpoint into the value the appliance will actually hold.
 *
 * Three things happen, in this order, and the order matters.
 *
 * First the Celsius request becomes a native value. Then it is snapped to the
 * appliance's own grid. Whole degrees either way, since a Celsius unit's
 * half-degree ticks are a wire encoding and its setpoints are still whole
 * degrees. Only then is it clamped, because clamping before snapping can round
 * a value at the boundary back outside the range.
 *
 * Returning the native value rather than a Celsius one is deliberate: the
 * caller sends this to the appliance and reports the same number in the log,
 * and converting back to Celsius for HomeKit is a separate step that should not
 * be hidden in here.
 */
export function resolveSetpoint(input: {
  celsius: number
  scale: TemperatureScale
  min: number
  max: number
}): number {
  const { celsius, scale, min, max } = input
  const requested = celsiusToNative(celsius, scale)
  const snapped = Math.round(requested)
  return Math.min(Math.max(snapped, Math.ceil(min)), Math.floor(max))
}

/**
 * A HomeKit-safe range for a writable setpoint.
 *
 * HAP rejects a characteristic whose `minValue` is not below its `maxValue`,
 * and an appliance that has not reported its limits yet gives us `undefined`
 * for both. Rather than publish a guess, the caller is expected to wait; this
 * only guards the case where the reported limits are present but degenerate,
 * which a frame read mid-commissioning can produce.
 */
export function isUsableRange(min: number | undefined, max: number | undefined): boolean {
  return min !== undefined && max !== undefined && Number.isFinite(min)
    && Number.isFinite(max) && max > min
}

/** Round to one decimal place, which is the resolution HomeKit displays. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** Format a temperature the way the appliance's own panel would show it. */
export function formatNative(value: number, scale: TemperatureScale): string {
  return `${round1(value)}${scale === 'celsius' ? '\u00B0C' : '\u00B0F'}`
}
