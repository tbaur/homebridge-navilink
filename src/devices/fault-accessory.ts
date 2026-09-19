/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A contact sensor that opens when the appliance reports a fault.
 *
 * A contact sensor rather than anything cleverer, because HomeKit will send a
 * push notification when one opens and will trigger an automation from it.
 * That is the entire point: a combi appliance that has locked out in January
 * is worth knowing about before the shower is cold, and the NaviLink app's own
 * notifications are easy to miss.
 *
 * The error code is not published as a value. HomeKit has nowhere to show a
 * number. It is logged, with its sub-code, so the log says what to look
 * up in the manual, not only that something is wrong.
 */

import type { Service } from 'homebridge'

import type { ChannelObservation, RefreshReason } from '../types'
import { forLog } from '../utils'
import { BaseAccessory } from './base-accessory'
import type { AccessoryInit } from './host'

/** Appliance fault state, as a HomeKit contact sensor. */
export class FaultAccessory extends BaseAccessory {
  private readonly service: Service

  /** The code last logged, so a standing fault is reported once, not hourly. */
  private lastLoggedCode: number | undefined

  constructor(init: AccessoryInit) {
    super(init)
    const { Characteristic, Service: HapService } = this.host.hap
    this.service = this.requireService(HapService.ContactSensor)
    this.service.setCharacteristic(Characteristic.Name, this.displayName)
    this.service
      .getCharacteristic(Characteristic.ContactSensorState)
      .onGet(() => this.readState())
  }

  private readState(): number {
    const { ContactSensorState } = this.host.hap.Characteristic
    const observation = this.requireObservedState()
    // "Detected" is HomeKit's word for a closed contact, which is the resting
    // state. A fault opens it, which is what raises a notification.
    return observation.readings.errorCode === 0
      ? ContactSensorState.CONTACT_DETECTED
      : ContactSensorState.CONTACT_NOT_DETECTED
  }

  protected override updateFromObservation(
    observation: ChannelObservation,
    _reason: RefreshReason,
  ): void {
    const { ContactSensorState } = this.host.hap.Characteristic
    const { errorCode, subErrorCode } = observation.readings
    this.publish(
      this.service,
      this.host.hap.Characteristic.ContactSensorState,
      errorCode === 0
        ? ContactSensorState.CONTACT_DETECTED
        : ContactSensorState.CONTACT_NOT_DETECTED,
    )
    this.logCodeChange(errorCode, subErrorCode)
  }

  private logCodeChange(errorCode: number, subErrorCode: number): void {
    if (errorCode === this.lastLoggedCode) {
      return
    }
    const previous = this.lastLoggedCode
    this.lastLoggedCode = errorCode
    if (errorCode === 0) {
      // First healthy frame is the resting state, not a transition.
      if (previous !== undefined) {
        this.host.log.info(`${forLog(this.displayName)}: the fault has cleared`)
      }
      return
    }
    this.host.log.warn(
      `${forLog(this.displayName)}: the appliance reports error ${errorCode}`
      + `${subErrorCode === 0 ? '' : `.${subErrorCode}`}; `
      + 'look the code up in the installation manual',
    )
  }
}
