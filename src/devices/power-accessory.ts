/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The appliance's power switch.
 *
 * Deliberately a separate, opt-in accessory rather than something folded into
 * a thermostat. Powering a combi appliance down stops the hot water *and* the
 * central heating, so it deserves a tile that says what it is instead of
 * hiding behind "off" on a tile labelled Hot Water.
 *
 * Turning it off still requires `options.allowPowerOff`. Asking for the switch
 * is asking to see the state and to be able to switch the appliance back on;
 * it is not, on its own, a decision that a scene should be able to shut the
 * heating down. The two are separated because one of them is recoverable from
 * a phone and the other is recoverable from a cold house.
 */

import type { CharacteristicValue, Service } from 'homebridge'

import type { ChannelObservation, RefreshReason } from '../types'
import { ControlRejectedError, describeError, forLog } from '../utils'
import { BaseAccessory } from './base-accessory'
import type { AccessoryInit } from './host'

/** Appliance power, as a HomeKit switch. */
export class PowerAccessory extends BaseAccessory {
  private readonly service: Service

  private hasExplainedGuard = false

  constructor(init: AccessoryInit) {
    super(init)
    const { Characteristic, Service: HapService } = this.host.hap
    this.service = this.requireService(HapService.Switch)
    this.service.setCharacteristic(Characteristic.Name, this.displayName)
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.requireObservedState().power)
      .onSet(async (value) => this.writeOn(value))
  }

  private async writeOn(value: CharacteristicValue): Promise<void> {
    const wantOn = value === true
    if (this.declineIfReadOnly()) {
      this.restore()
      return
    }
    const observation = this.host.observationFor(this.deviceId)
    if (observation !== undefined && observation.power === wantOn) {
      this.host.log.debug(
        `${forLog(this.displayName)}: already ${wantOn ? 'on' : 'off'}; nothing sent`,
      )
      return
    }
    await this.completeWithinBudget('power change', async () => {
      try {
        await this.host.control(this.deviceId).setPower(wantOn)
        this.host.noteOptimisticWrite(this.deviceId, { power: wantOn })
        this.logAction(wantOn ? 'POWER ON' : 'POWER OFF')
      } catch (error) {
        if (error instanceof ControlRejectedError) {
          this.explainGuard(error)
        } else {
          this.host.log.warn(
            `${forLog(this.displayName)}: power failed: ${describeError(error)}`,
          )
        }
        this.restore()
      }
    })
  }

  protected override updateFromObservation(
    observation: ChannelObservation,
    _reason: RefreshReason,
  ): void {
    this.publish(this.service, this.host.hap.Characteristic.On, observation.power)
  }

  private restore(): void {
    const observation = this.host.observationFor(this.deviceId)
    if (observation === undefined) {
      return
    }
    this.service.updateCharacteristic(this.host.hap.Characteristic.On, observation.power)
  }

  private explainGuard(error: ControlRejectedError): void {
    if (this.hasExplainedGuard) {
      this.host.log.debug(`${forLog(this.displayName)}: ${error.message}`)
      return
    }
    this.hasExplainedGuard = true
    this.host.log.info(`${forLog(this.displayName)}: ${error.message}`)
  }
}
