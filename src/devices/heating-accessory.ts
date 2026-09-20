/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The space-heating thermostat.
 *
 * ## This is a boiler control, not a room thermostat
 *
 * The number on this tile is the temperature of the **water** the appliance
 * sends to the radiators or the underfloor loop, not the temperature of a
 * room. Setting it to 60 °C does not make the house 60 °C; it makes the flow
 * hotter, so the house reaches whatever the room thermostat is asking for
 * sooner and less efficiently.
 *
 * HomeKit has no accessory type for "boiler flow temperature", and a
 * Thermostat is the closest thing it offers. Anyone building an automation on
 * this tile should know which quantity they are automating, which is why the
 * README says so and why this accessory is opt-in rather than created by
 * default.
 *
 * ## Off means off
 *
 * Unlike the hot water tile, this one's off is wired to the appliance's
 * space-heating enable, which is exactly the thing being asked about. Turning
 * it off stops the radiators and leaves the hot water alone, so there is no
 * reason to hesitate over it.
 */

import type { ChannelObservation, RefreshReason } from '../types'
import { ControlRejectedError, describeError, forLog } from '../utils'
import { ThermostatAccessory, type SetpointLimits } from './thermostat-accessory'

/** Space-heating flow temperature, as a HomeKit thermostat. */
export class SpaceHeatingAccessory extends ThermostatAccessory {
  private hasWarnedNoLoop = false

  protected override readSetpoint(observation: ChannelObservation): number | undefined {
    // Nothing to report on an appliance with no loop. The fields are present
    // on a water heater too, filled with placeholders, so returning them
    // would put a working-looking thermostat on hardware that has no
    // radiators attached to it.
    return observation.heatingSupported ? observation.heatSetpoint : undefined
  }

  /**
   * Say once when this appliance turns out to have no heating loop.
   *
   * Only knowable from a live `channelinfo` frame, which arrives after the
   * accessory is registered, so it can be configured on hardware that cannot
   * do it.
   */
  protected override updateFromObservation(
    observation: ChannelObservation,
    reason: RefreshReason,
  ): void {
    if (!observation.heatingSupported) {
      this.warnNoLoop()
      this.markUnavailable()
      return
    }
    super.updateFromObservation(observation, reason)
  }

  private warnNoLoop(): void {
    if (this.hasWarnedNoLoop) {
      return
    }
    this.hasWarnedNoLoop = true
    this.host.log.warn(`${forLog(this.displayName)}: no heating loop`)
  }

  /** The flow probe: the water going out to the loop. */
  protected override readTemperature(observation: ChannelObservation): number | undefined {
    return observation.heatSupply
  }

  protected override readLimits(observation: ChannelObservation): SetpointLimits | undefined {
    if (!observation.heatingSupported) {
      return undefined
    }
    const { heatMin, heatMax } = observation
    return heatMin === undefined || heatMax === undefined
      ? undefined
      : { min: heatMin, max: heatMax }
  }

  protected override readEnabled(observation: ChannelObservation): boolean {
    return observation.heatingSupported && observation.heating
  }

  protected override isCommandable(observation: ChannelObservation): boolean {
    return observation.heatingSupported
  }

  protected override async sendSetpoint(native: number): Promise<void> {
    this.requireHeatingLoop()
    await this.host.control(this.deviceId).setHeatingSetpoint(native)
  }

  protected override async sendEnabled(on: boolean): Promise<boolean> {
    if (!this.hasHeatingLoop()) {
      this.warnNoLoop()
      return false
    }
    try {
      await this.host.control(this.deviceId).setHeating(on)
      return true
    } catch (error) {
      this.host.log.warn(
        `${forLog(this.displayName)}: heating ${on ? 'on' : 'off'} failed: ${describeError(error)}`,
      )
      return false
    }
  }

  /**
   * True when this appliance has a loop worth commanding.
   *
   * Reads and writes both go through this: a water heater answers the same
   * frames as a combi and fills the heating fields with placeholders, so a
   * HomeKit write that reached the cloud would be a command to hardware that
   * has no radiators attached to it.
   */
  private hasHeatingLoop(): boolean {
    return this.host.observationFor(this.deviceId)?.heatingSupported === true
  }

  private requireHeatingLoop(): void {
    if (!this.hasHeatingLoop()) {
      this.warnNoLoop()
      throw new ControlRejectedError('no heating loop')
    }
  }

  protected override optimisticSetpointPatch(native: number): Partial<ChannelObservation> {
    return { heatSetpoint: native }
  }
}
