/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The hot water recirculation switch.
 *
 * On an installation with a recirculation pump (Navien's "HotButton" or
 * on-demand feature) this starts it, so the water at a distant tap is hot by
 * the time someone gets there. It is the one accessory here with an obvious
 * and genuinely useful Siri phrase: "turn on the hot water" before walking to
 * the shower.
 *
 * ## It switches itself off, and that is correct
 *
 * The appliance runs the pump for a fixed period and then stops. The tile
 * follows, because it reports what the appliance says, not what was asked
 * for. A user who has not met this feature before will read the tile
 * turning itself off as a bug, which is why the README explains it.
 *
 * ## It disables itself on hardware that has no pump
 *
 * Whether a pump is fitted is only knowable from a live `channelinfo` frame,
 * which arrives after accessories are registered. So the accessory can be
 * configured on an appliance that cannot do it, and when that turns out to be
 * the case it says so once and reports No Response from then on. Silently
 * accepting presses that do nothing would be worse.
 */

import type { CharacteristicValue, Service } from 'homebridge'

import type { ChannelObservation, RefreshReason } from '../types'
import { describeError, forLog } from '../utils'
import { BaseAccessory } from './base-accessory'
import type { AccessoryInit } from './host'

/** Hot water recirculation, as a HomeKit switch. */
export class RecirculationAccessory extends BaseAccessory {
  private readonly service: Service

  /** Undefined until the first frame says whether a pump is fitted. */
  private isEquipped: boolean | undefined

  private hasWarnedNotEquipped = false

  constructor(init: AccessoryInit) {
    super(init)
    const { Characteristic, Service: HapService } = this.host.hap
    this.service = this.requireService(HapService.Switch)
    this.service.setCharacteristic(Characteristic.Name, this.displayName)
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.readOn())
      .onSet(async (value) => this.writeOn(value))
  }

  private readOn(): CharacteristicValue {
    const observation = this.requireObservedState()
    if (!observation.recirculationEquipped) {
      // No pump, so there is no honest value to report. No Response is the
      // truthful answer and the one that prompts someone to look.
      throw this.communicationFailure()
    }
    return observation.recirculationOn
  }

  private async writeOn(value: CharacteristicValue): Promise<void> {
    const wantOn = value === true
    const equipped = this.equippedState()
    if (equipped === undefined) {
      this.host.log.debug(
        `${forLog(this.displayName)}: recirculation is unknown until the appliance reports it`,
      )
      throw this.communicationFailure()
    }
    if (this.declineIfReadOnly('change recirculation')) {
      this.restore()
      return
    }
    if (equipped === false) {
      this.host.log.info(
        `${forLog(this.displayName)}: this appliance reports no recirculation pump; `
        + 'nothing was sent',
      )
      this.service.updateCharacteristic(this.host.hap.Characteristic.On, false)
      return
    }
    await this.completeWithinBudget('recirculation', async () => {
      try {
        await this.host.control(this.deviceId).setRecirculation(wantOn)
        this.host.noteOptimisticWrite(this.deviceId, { recirculationOn: wantOn })
        this.logAction(wantOn ? 'RECIRCULATE' : 'RECIRCULATE OFF')
      } catch (error) {
        this.host.log.warn(
          `${forLog(this.displayName)}: could not change recirculation: ${describeError(error)}`,
        )
        this.restore()
      }
    })
  }

  protected override updateFromObservation(
    observation: ChannelObservation,
    _reason: RefreshReason,
  ): void {
    this.isEquipped = observation.recirculationEquipped
    if (!observation.recirculationEquipped) {
      this.warnNotEquipped()
      this.markUnavailable()
      return
    }
    this.publish(this.service, this.host.hap.Characteristic.On, observation.recirculationOn)
  }

  /** Fitted state from a live frame, or from the last observation if none yet. */
  private equippedState(): boolean | undefined {
    if (this.isEquipped !== undefined) {
      return this.isEquipped
    }
    return this.host.observationFor(this.deviceId)?.recirculationEquipped
  }

  private restore(): void {
    const observation = this.host.observationFor(this.deviceId)
    if (observation === undefined) {
      return
    }
    this.service.updateCharacteristic(
      this.host.hap.Characteristic.On,
      observation.recirculationOn,
    )
  }

  private warnNotEquipped(): void {
    if (this.hasWarnedNotEquipped) {
      return
    }
    this.hasWarnedNotEquipped = true
    this.host.log.warn(
      `${forLog(this.displayName)}: the appliance reports no recirculation pump `
      + '(onDemandUse and recirculationUse are both off). Turn the recirculation accessory '
      + 'off in the plugin settings, or enable the pump in the NaviLink app if one is fitted.',
    )
  }
}
