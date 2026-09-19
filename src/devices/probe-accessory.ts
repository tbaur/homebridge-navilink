/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One of the appliance's temperature probes, as a HomeKit sensor.
 *
 * Five of them share this implementation, differing only in which field they
 * read: the hot water inlet and outlet, the heating flow and return, and the
 * outdoor sensor where one is fitted. They are read-only, and useful mainly
 * for graphs and for automations that want to know whether the appliance is
 * doing anything.
 *
 * The flow and return pair is the interesting one. The difference between them
 * is what the appliance is putting into the house, so a HomeKit automation can
 * notice heating running when nobody asked it to.
 *
 * ## Probes that are not fitted
 *
 * Whether a probe exists is only knowable from a live status frame, and the
 * frames arrive after accessories are registered. So a sensor can be created
 * for something that does not exist. When that turns out to be the case it
 * says so once and reports No Response. It does not publish the zero the
 * appliance sends for an absent probe, which would be -17.8 °C on the tile
 * and could be acted on by an automation.
 */

import type { Service } from 'homebridge'

import type { ChannelObservation, ProbeKind, RefreshReason } from '../types'
import { forLog, nativeToCelsius } from '../utils'
import { BaseAccessory } from './base-accessory'
import type { AccessoryInit } from './host'

/** Which observation field each probe accessory reports. */
const FIELD_BY_KIND: Readonly<Record<ProbeKind, keyof ChannelObservation>> = {
  dhwOutlet: 'dhwOutlet',
  dhwInlet: 'dhwInlet',
  heatSupply: 'heatSupply',
  heatReturn: 'heatReturn',
  outdoor: 'outdoor',
}

/** What to say when a probe turns out not to exist. */
const ABSENCE_HINT: Readonly<Record<ProbeKind, string>> = {
  dhwOutlet: 'the appliance is not reporting a hot water outlet temperature',
  dhwInlet: 'the appliance is not reporting a hot water inlet temperature',
  heatSupply: 'the appliance is not reporting a heating flow temperature',
  heatReturn: 'the appliance is not reporting a heating return temperature',
  outdoor: 'no outdoor sensor is fitted, so there is nothing to report',
}

/** What an appliance probe is created with. */
export interface ProbeAccessoryInit extends AccessoryInit {
  kind: ProbeKind
}

/** One appliance temperature probe, as a HomeKit sensor. */
export class ProbeAccessory extends BaseAccessory {
  private readonly service: Service

  private readonly kind: ProbeKind

  private hasWarnedAbsent = false

  constructor(init: ProbeAccessoryInit) {
    super(init)
    this.kind = init.kind
    const { Characteristic, Service: HapService } = this.host.hap
    this.service = this.requireService(HapService.TemperatureSensor)
    this.service.setCharacteristic(Characteristic.Name, this.displayName)
    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.readCelsius())
    // Published so a controller that honours it can grey the sensor out
    // rather than showing a stale reading for a probe that has gone away.
    this.service
      .getCharacteristic(Characteristic.StatusActive)
      .onGet(() => this.readNative() !== undefined)
  }

  private readNative(): number | undefined {
    const observation = this.host.observationFor(this.deviceId)
    if (observation === undefined) {
      return undefined
    }
    const value = observation[FIELD_BY_KIND[this.kind]]
    return typeof value === 'number' ? value : undefined
  }

  private readCelsius(): number {
    const observation = this.requireObservedState()
    const native = this.readNative()
    if (native === undefined) {
      throw this.communicationFailure()
    }
    return nativeToCelsius(native, observation.scale)
  }

  protected override updateFromObservation(
    observation: ChannelObservation,
    _reason: RefreshReason,
  ): void {
    const { Characteristic } = this.host.hap
    const value = observation[FIELD_BY_KIND[this.kind]]
    const native = typeof value === 'number' ? value : undefined
    this.publish(this.service, Characteristic.StatusActive, native !== undefined)
    if (native === undefined) {
      this.warnAbsent()
      this.markUnavailable()
      // StatusActive is the honest "nothing here" flag; keep it after the
      // temperature characteristic has been greyed.
      this.publish(this.service, Characteristic.StatusActive, false)
      return
    }
    this.publish(
      this.service,
      Characteristic.CurrentTemperature,
      nativeToCelsius(native, observation.scale),
    )
  }

  private warnAbsent(): void {
    if (this.hasWarnedAbsent) {
      return
    }
    this.hasWarnedAbsent = true
    this.host.log.warn(`${forLog(this.displayName)}: ${ABSENCE_HINT[this.kind]}`)
  }
}
