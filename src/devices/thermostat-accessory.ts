/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The shared behaviour of both thermostats.
 *
 * A combi appliance has two independent heat demands, domestic hot water and
 * the space-heating loop, with their own setpoints, their own installer
 * limits and their own probes. They are two HomeKit thermostats, not one with
 * modes, because they are two things a person thinks about separately:
 * "make the taps hotter" and "make the radiators hotter" are not two
 * positions of the same dial.
 *
 * Everything that differs between them is a hook. Everything that is the same,
 * and that is most of it, is here.
 *
 * ## Why these thermostats are heat-only
 *
 * `TargetHeatingCoolingState` is published with just `OFF` and `HEAT` as valid
 * values. Nothing here can cool, and offering `COOL` or `AUTO` would let a
 * scene or a Siri phrase put the tile into a state the appliance cannot enter,
 * which HomeKit would then show as the current state until the next frame
 * contradicted it.
 *
 * ## The Celsius problem
 *
 * HAP is Celsius. A North American appliance's setpoint grid is whole degrees
 * Fahrenheit, and no Celsius step lands on it. Rather than advertise a step
 * the appliance cannot hit, the range is published in Celsius with a half-
 * degree step anchored at the true minimum, which puts HomeKit's steps within
 * a tenth of a degree of the appliance's own. A write is then snapped to the
 * real grid and the appliance's answer is what gets reported back. See
 * `utils/temperature.ts`.
 *
 * ## Why a write is delayed
 *
 * Dragging the dial in the Home app emits a write per step. Each one would be
 * a separate control command at a vendor's cloud, and the appliance would
 * chase every intermediate value on the way to the one the user meant. Writes
 * are therefore coalesced over a short window so the last one wins.
 */

import type { CharacteristicValue, Service } from 'homebridge'

import { SETPOINT_COALESCE_MS } from '../settings'
import type { ChannelObservation, RefreshReason } from '../types'
import {
  describeError,
  forLog,
  formatNative,
  HOMEKIT_TEMPERATURE_STEP,
  isUsableRange,
  nativeToCelsius,
  resolveSetpoint,
  round1,
  type TemperatureScale,
} from '../utils'
import { BaseAccessory } from './base-accessory'
import type { AccessoryInit } from './host'

/** The installer-set bounds on a setpoint, in the appliance's native scale. */
export interface SetpointLimits {
  min: number
  max: number
}

/** Shared implementation of a heat-only HomeKit thermostat. */
export abstract class ThermostatAccessory extends BaseAccessory {
  private readonly service: Service

  /** The pending coalesced write, if the dial is still moving. */
  private pendingSetpointCelsius: number | undefined

  private coalesceTimer: ReturnType<typeof setTimeout> | undefined

  /** True from the start of a send until it settles, so a stale frame cannot undo it. */
  private writeInFlight = false

  /**
   * What HomeKit was last told the target is.
   *
   * Held so a read during the coalescing window answers with what the user
   * just chose rather than with the value the appliance still has. Without it
   * the dial visibly springs back mid-drag.
   */
  private optimisticTargetCelsius: number | undefined

  /** The bounds last published, so props are not rewritten on every frame. */
  private publishedLimits: SetpointLimits | undefined

  constructor(init: AccessoryInit) {
    super(init)
    const { Characteristic, Service: HapService } = this.host.hap
    this.service = this.requireService(HapService.Thermostat)
    this.service.setCharacteristic(Characteristic.Name, this.displayName)

    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.CurrentHeatingCoolingState.OFF,
          Characteristic.CurrentHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() => this.readCurrentState())

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() => this.readTargetState())
      .onSet(async (value) => this.writeTargetState(value))

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.readCurrentTemperature())

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .onGet(() => this.readTargetTemperature())
      // Deliberately not async. The write only schedules the coalesced send,
      // so it answers HomeKit at once; awaiting the send would spend the
      // whole write budget on a window that exists precisely to wait.
      .onSet((value) => this.writeTargetTemperature(value))

    // Display-only in HAP: the Home app converts using the phone's region and
    // ignores this. It is published to match the appliance's own scale so a
    // controller that does honour it agrees with the unit's front panel. A
    // write is accepted and discarded so such a controller is not left
    // fighting a characteristic that only has onGet.
    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.readDisplayUnits())
      .onSet(() => undefined)
    this.applyStoredDisplayUnits()
  }

  override stop(): void {
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer)
      this.coalesceTimer = undefined
    }
    this.writeInFlight = false
    super.stop()
  }

  // --- Hooks a subclass fills in ---------------------------------------------

  /** The setpoint this thermostat governs, in the appliance's native scale. */
  protected abstract readSetpoint(observation: ChannelObservation): number | undefined

  /** The temperature this thermostat reports as current, native scale. */
  protected abstract readTemperature(observation: ChannelObservation): number | undefined

  /** The installer-set bounds on this setpoint, native scale. */
  protected abstract readLimits(observation: ChannelObservation): SetpointLimits | undefined

  /** True when this demand is enabled on the appliance. */
  protected abstract readEnabled(observation: ChannelObservation): boolean

  /** False when this accessory has no hardware behind it. */
  protected isCommandable(_observation: ChannelObservation): boolean {
    return true
  }

  /** Ask the appliance for a new setpoint, in its native scale. */
  protected abstract sendSetpoint(native: number): Promise<void>

  /**
   * Ask the appliance to enable or disable this demand.
   *
   * Returns false when the request was declined rather than sent, so the
   * caller can put the characteristic back where it was instead of leaving
   * HomeKit showing a state the appliance is not in.
   */
  protected abstract sendEnabled(on: boolean): Promise<boolean>

  /** A patch describing a setpoint write, so the tile can adopt it at once. */
  protected abstract optimisticSetpointPatch(native: number): Partial<ChannelObservation>

  // --- Reads ------------------------------------------------------------------

  private readCurrentState(): CharacteristicValue {
    const { CurrentHeatingCoolingState } = this.host.hap.Characteristic
    const observation = this.requireObservedState()
    if (!this.isCommandable(observation)) {
      throw this.communicationFailure()
    }
    return observation.power && this.readEnabled(observation)
      ? CurrentHeatingCoolingState.HEAT
      : CurrentHeatingCoolingState.OFF
  }

  private readTargetState(): CharacteristicValue {
    const { TargetHeatingCoolingState } = this.host.hap.Characteristic
    const observation = this.requireObservedState()
    if (!this.isCommandable(observation)) {
      throw this.communicationFailure()
    }
    return observation.power && this.readEnabled(observation)
      ? TargetHeatingCoolingState.HEAT
      : TargetHeatingCoolingState.OFF
  }

  private readCurrentTemperature(): CharacteristicValue {
    const observation = this.requireObservedState()
    const native = this.readTemperature(observation)
    if (native === undefined) {
      // No probe, no reading. Reporting the setpoint instead would be a lie
      // that reads as a working sensor.
      throw this.communicationFailure()
    }
    return nativeToCelsius(native, observation.scale)
  }

  private readTargetTemperature(): CharacteristicValue {
    if (this.optimisticTargetCelsius !== undefined) {
      return this.optimisticTargetCelsius
    }
    const observation = this.requireObservedState()
    const native = this.readSetpoint(observation)
    if (native === undefined) {
      throw this.communicationFailure()
    }
    return nativeToCelsius(native, observation.scale)
  }

  private readDisplayUnits(): CharacteristicValue {
    const { TemperatureDisplayUnits } = this.host.hap.Characteristic
    const observation = this.host.observationFor(this.deviceId)
    if (observation !== undefined) {
      return observation.scale === 'celsius'
        ? TemperatureDisplayUnits.CELSIUS
        : TemperatureDisplayUnits.FAHRENHEIT
    }
    const stored = (this.accessory.context as { scale?: string }).scale
    return stored === 'celsius'
      ? TemperatureDisplayUnits.CELSIUS
      : TemperatureDisplayUnits.FAHRENHEIT
  }

  /** Honour the last observed scale before the first frame arrives. */
  private applyStoredDisplayUnits(): void {
    const stored = (this.accessory.context as { scale?: string }).scale
    if (stored !== 'celsius' && stored !== 'fahrenheit') {
      return
    }
    const { TemperatureDisplayUnits } = this.host.hap.Characteristic
    this.publish(
      this.service,
      TemperatureDisplayUnits,
      stored === 'celsius'
        ? TemperatureDisplayUnits.CELSIUS
        : TemperatureDisplayUnits.FAHRENHEIT,
    )
  }

  // --- Writes -----------------------------------------------------------------

  private async writeTargetState(value: CharacteristicValue): Promise<void> {
    const { TargetHeatingCoolingState } = this.host.hap.Characteristic
    const wantOn = value === TargetHeatingCoolingState.HEAT
    if (this.declineIfReadOnly('change the mode')) {
      this.restoreTargetState()
      return
    }
    // A scene that sets a room to a state it is already in re-asserts every
    // accessory in it, so redundant writes are routine rather than rare. The
    // cloud refuses control commands that arrive within its own interval, so
    // sending one anyway can spend the lockout a real command then needs.
    const observation = this.host.observationFor(this.deviceId)
    const isOn = observation !== undefined
      && observation.power
      && this.readEnabled(observation)
    if (observation !== undefined && isOn === wantOn) {
      this.host.log.debug(
        `${forLog(this.displayName)}: already ${wantOn ? 'on' : 'off'}; nothing sent`,
      )
      return
    }
    await this.completeWithinBudget('mode change', async () => {
      const accepted = await this.sendEnabled(wantOn)
      if (!accepted) {
        this.restoreTargetState()
        return
      }
      this.logAction(wantOn ? 'HEAT' : 'OFF')
    })
  }

  private writeTargetTemperature(value: CharacteristicValue): void {
    if (typeof value !== 'number') {
      return
    }
    if (this.declineIfReadOnly('change the setpoint')) {
      this.revertTargetTemperature()
      return
    }
    // Held so a read during the window answers with what the user chose, and
    // so the timer below has something to send.
    this.optimisticTargetCelsius = value
    this.pendingSetpointCelsius = value

    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer)
    }
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined
      void this.flushSetpoint()
    }, SETPOINT_COALESCE_MS)
    this.coalesceTimer.unref?.()
  }

  /**
   * Send whatever the dial finished on.
   *
   * Deliberately not awaited by the HomeKit write: the coalescing window
   * already exceeds a comfortable share of HAP's budget, so the write answers
   * immediately and this runs behind it. A failure is logged and the tile is
   * corrected by the next observation.
   */
  private async flushSetpoint(): Promise<void> {
    const celsius = this.pendingSetpointCelsius
    this.pendingSetpointCelsius = undefined
    if (celsius === undefined) {
      return
    }
    const observation = this.host.observationFor(this.deviceId)
    const limits = observation === undefined ? undefined : this.readLimits(observation)
    if (observation === undefined || limits === undefined) {
      this.host.log.warn(
        `${forLog(this.displayName)}: cannot set a temperature before the appliance has `
        + 'reported its limits',
      )
      this.optimisticTargetCelsius = undefined
      return
    }

    const native = resolveSetpoint({
      celsius,
      scale: observation.scale,
      min: limits.min,
      max: limits.max,
    })
    this.writeInFlight = true
    try {
      await this.sendSetpoint(native)
      // Adopted immediately so the tile settles on what the appliance will
      // hold, rather than on the Celsius value the user happened to drag to.
      this.host.noteOptimisticWrite(this.deviceId, this.optimisticSetpointPatch(native))
      this.optimisticTargetCelsius = nativeToCelsius(native, observation.scale)
      this.logAction('SET', formatNative(native, observation.scale))
    } catch (error) {
      this.optimisticTargetCelsius = undefined
      this.host.log.warn(
        `${forLog(this.displayName)}: could not set the temperature: ${describeError(error)}`,
      )
      this.revertTargetTemperature()
    } finally {
      this.writeInFlight = false
    }
  }

  private restoreTargetState(): void {
    const { TargetHeatingCoolingState } = this.host.hap.Characteristic
    const observation = this.host.observationFor(this.deviceId)
    if (observation === undefined) {
      return
    }
    this.service.updateCharacteristic(
      TargetHeatingCoolingState,
      observation.power && this.readEnabled(observation)
        ? TargetHeatingCoolingState.HEAT
        : TargetHeatingCoolingState.OFF,
    )
  }

  private revertTargetTemperature(): void {
    const observation = this.host.observationFor(this.deviceId)
    const native = observation === undefined ? undefined : this.readSetpoint(observation)
    if (observation === undefined || native === undefined) {
      return
    }
    this.service.updateCharacteristic(
      this.host.hap.Characteristic.TargetTemperature,
      nativeToCelsius(native, observation.scale),
    )
  }

  // --- Observation ------------------------------------------------------------

  protected override updateFromObservation(
    observation: ChannelObservation,
    reason: RefreshReason,
  ): void {
    const { Characteristic } = this.host.hap
    this.publishLimits(observation)

    const heating = observation.power && this.readEnabled(observation)
    this.publish(
      this.service,
      Characteristic.CurrentHeatingCoolingState,
      heating
        ? Characteristic.CurrentHeatingCoolingState.HEAT
        : Characteristic.CurrentHeatingCoolingState.OFF,
    )
    this.publish(
      this.service,
      Characteristic.TargetHeatingCoolingState,
      heating
        ? Characteristic.TargetHeatingCoolingState.HEAT
        : Characteristic.TargetHeatingCoolingState.OFF,
    )

    const current = this.readTemperature(observation)
    if (current !== undefined) {
      this.publish(
        this.service,
        Characteristic.CurrentTemperature,
        nativeToCelsius(current, observation.scale),
      )
    }

    const setpoint = this.readSetpoint(observation)
    if (setpoint !== undefined && !this.isSettling(reason)) {
      // Cleared here rather than on a timer: the appliance has now confirmed
      // a setpoint, so the optimistic value has served its purpose whether or
      // not it matches.
      this.optimisticTargetCelsius = undefined
      this.publish(
        this.service,
        Characteristic.TargetTemperature,
        nativeToCelsius(setpoint, observation.scale),
      )
    }

    this.publish(
      this.service,
      Characteristic.TemperatureDisplayUnits,
      observation.scale === 'celsius'
        ? Characteristic.TemperatureDisplayUnits.CELSIUS
        : Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
    )
  }

  /** True while a write is in flight, so a stale frame cannot undo it. */
  private isSettling(reason: RefreshReason): boolean {
    return reason !== 'post-set'
      && (
        this.writeInFlight
        || this.pendingSetpointCelsius !== undefined
        || this.coalesceTimer !== undefined
      )
  }

  /**
   * Publish the appliance's own setpoint range to HomeKit.
   *
   * Only when it changes. `setProps` on a characteristic notifies every paired
   * controller, and doing it on every status frame would be a broadcast storm
   * for a value that changes at commissioning and never again.
   *
   * The half-degree step is anchored at the true minimum rather than rounded
   * to a tidy number, which is what keeps HomeKit's steps within a tenth of a
   * degree of the appliance's whole-Fahrenheit grid.
   */
  private publishLimits(observation: ChannelObservation): void {
    const limits = this.readLimits(observation)
    if (limits === undefined || !isUsableRange(limits.min, limits.max)) {
      return
    }
    if (this.publishedLimits?.min === limits.min && this.publishedLimits?.max === limits.max) {
      return
    }
    this.publishedLimits = limits
    this.service.getCharacteristic(this.host.hap.Characteristic.TargetTemperature).setProps({
      minValue: toCelsiusBound(limits.min, observation.scale),
      maxValue: toCelsiusBound(limits.max, observation.scale),
      minStep: HOMEKIT_TEMPERATURE_STEP,
    })
    this.host.log.debug(
      `${forLog(this.displayName)}: range ${formatNative(limits.min, observation.scale)}`
      + ` to ${formatNative(limits.max, observation.scale)}`,
    )
  }
}

/** A native limit as the Celsius bound HAP wants, at display resolution. */
function toCelsiusBound(native: number, scale: TemperatureScale): number {
  return round1(nativeToCelsius(native, scale))
}
