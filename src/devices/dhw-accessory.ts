/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The domestic hot water thermostat.
 *
 * The accessory most people install this plugin for: the temperature of the
 * water at the taps, as a tile, a scene value and a Siri phrase.
 *
 * ## Why "off" does not normally turn anything off
 *
 * A combi appliance has no separate switch for hot water. There is one power
 * state, and it governs the space-heating loop as well. So the only thing
 * `TargetHeatingCoolingState.OFF` could be wired to is the appliance's power,
 * and that makes "Hey Siri, turn off the hot water", or a bedtime scene that
 * sweeps every switch off, or a HomeKit "turn everything off", into a command
 * that also stops the central heating. In a house that is empty in February,
 * that is a burst pipe.
 *
 * So by default this tile declines an off. It says why, once, and springs
 * back. Someone who genuinely wants HomeKit to be able to shut the appliance
 * down turns on `options.allowPowerOff`, and at that point off means off.
 *
 * This is a departure from the usual rule that an accessory does what HomeKit
 * asks. It is made deliberately and in one direction only: the plugin will
 * always heat when asked, and hesitates only about stopping.
 */

import type { ChannelObservation } from '../types'
import { ControlRejectedError, describeError, forLog } from '../utils'
import type { AccessoryInit } from './host'
import { ThermostatAccessory, type SetpointLimits } from './thermostat-accessory'

/** Hot water temperature, as a HomeKit thermostat. */
export class DomesticHotWaterAccessory extends ThermostatAccessory {
  /** Said once per session rather than once per press. */
  private hasExplainedPowerGuard = false

  constructor(init: AccessoryInit) {
    super(init)
  }

  protected override readSetpoint(observation: ChannelObservation): number | undefined {
    return observation.dhwSetpoint
  }

  /**
   * The outlet probe: the water actually leaving the appliance.
   *
   * Not the setpoint, and not the inlet. Between draws this reads well below
   * the setpoint, which is correct and occasionally surprising. The
   * appliance is not keeping a tank hot, it heats on demand. Reporting the
   * setpoint here instead would make the tile look tidy and mean nothing.
   */
  protected override readTemperature(observation: ChannelObservation): number | undefined {
    return observation.dhwOutlet
  }

  protected override readLimits(observation: ChannelObservation): SetpointLimits | undefined {
    const { dhwMin, dhwMax } = observation
    return dhwMin === undefined || dhwMax === undefined ? undefined : { min: dhwMin, max: dhwMax }
  }

  /**
   * Hot water is available whenever the appliance is on.
   *
   * There is no per-demand enable for hot water on the families this plugin
   * supports, so the honest answer is that it is on when the appliance is on.
   * The base class already requires `power`, so this is unconditional rather
   * than reading a flag that does not exist.
   */
  protected override readEnabled(_observation: ChannelObservation): boolean {
    return true
  }

  protected override async sendSetpoint(native: number): Promise<void> {
    await this.host.control(this.deviceId).setDomesticHotWaterSetpoint(native)
  }

  protected override async sendEnabled(on: boolean): Promise<boolean> {
    try {
      await this.host.control(this.deviceId).setPower(on)
      return true
    } catch (error) {
      if (error instanceof ControlRejectedError) {
        this.explainPowerGuard(error)
        return false
      }
      this.host.log.warn(
        `${forLog(this.displayName)}: power failed: ${describeError(error)}`,
      )
      return false
    }
  }

  protected override optimisticSetpointPatch(native: number): Partial<ChannelObservation> {
    return { dhwSetpoint: native }
  }

  private explainPowerGuard(error: ControlRejectedError): void {
    if (this.hasExplainedPowerGuard) {
      this.host.log.debug(`${forLog(this.displayName)}: ${error.message}`)
      return
    }
    this.hasExplainedPowerGuard = true
    this.host.log.info(`${forLog(this.displayName)}: ${error.message}`)
  }
}
