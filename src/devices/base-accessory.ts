/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview What every accessory in this plugin has in common.
 *
 * Three rules are enforced here rather than trusted to each subclass, because
 * each of them is the kind of thing that is obvious in review and forgotten in
 * code.
 *
 * **Never invent a reading.** If the appliance has not been heard from, a read
 * throws `SERVICE_COMMUNICATION_FAILURE` and the tile shows No Response. It is
 * tempting to return the last value, or a plausible default, so the Home app
 * looks tidy. Both are worse than a grey tile: an automation cannot tell a
 * remembered 49 °C from a current one, and this plugin drives a gas appliance.
 * {@link requireObservedState} is the only way a subclass gets state, and it
 * is the only place that decision is made.
 *
 * **Answer HomeKit inside its budget.** HAP abandons a write after nine
 * seconds and warns at three. A cloud round trip can legitimately take longer
 * than either, so {@link completeWithinBudget} answers on time and lets the
 * work finish behind it. Without that, a slow cloud turns every setpoint
 * change into an error in the Home app even when it worked.
 *
 * **Keep identity stable.** Accessory information is written once here, from
 * values the platform resolved, so no subclass can key an accessory on
 * something that changes and silently take a user's rooms and automations with
 * it.
 */

import type {
  Characteristic,
  CharacteristicValue,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge'

import {
  HOMEKIT_WRITE_BUDGET_MS,
  MANUFACTURER,
} from '../settings'
import type { AccessoryContext, ChannelObservation, RefreshReason } from '../types'
import { describeError, forLog, raceTimeout, TIMED_OUT } from '../utils'
import type { AccessoryHost, AccessoryInit } from './host'

/** A concrete HAP service class, such as `Service.Thermostat`. */
export type ServiceConstructor = {
  UUID: string
  new (displayName?: string, subtype?: string): Service
}

/** A concrete HAP characteristic class, such as `Characteristic.On`. */
export type CharacteristicConstructor = WithUUID<new () => Characteristic>

/** Shared behaviour for every accessory this plugin exposes. */
export abstract class BaseAccessory {
  protected readonly host: AccessoryHost

  protected readonly accessory: PlatformAccessory

  readonly deviceId: string

  readonly displayName: string

  /** True once the platform has torn this accessory down. */
  private stopped = false

  /** Said once rather than on every write, so a scene cannot flood the log. */
  private hasExplainedReadOnly = false

  constructor(init: AccessoryInit) {
    this.host = init.host
    this.accessory = init.accessory
    this.deviceId = init.deviceId
    this.displayName = init.displayName
    this.configureAccessoryInformation(init)
  }

  /** Apply a fresh observation. Called by the platform, never by a subclass. */
  applyObservation(observation: ChannelObservation, reason: RefreshReason): void {
    if (this.stopped) {
      return
    }
    this.persistScale(observation.scale)
    try {
      this.updateFromObservation(observation, reason)
    } catch (error) {
      // A subclass fault must not stop the other accessories being updated
      // from the same frame.
      this.host.log.debug(
        `${forLog(this.displayName)}: apply failed: ${describeError(error)}`,
      )
    }
  }

  /** Report that the appliance can no longer be heard from. */
  noteUnreachable(error: unknown): void {
    if (this.stopped) {
      return
    }
    this.host.log.debug(`${forLog(this.displayName)}: unreachable: ${describeError(error)}`)
    this.markUnavailable()
  }

  /** Release anything held. After this the accessory ignores every update. */
  stop(): void {
    this.stopped = true
  }

  /**
   * The current observation, or a HAP communication failure.
   *
   * The single place an accessory is allowed to obtain state, so the decision
   * to report No Response rather than a remembered value is made once. See the
   * file header.
   */
  protected requireObservedState(): ChannelObservation {
    const observation = this.host.observationFor(this.deviceId)
    if (observation === undefined) {
      throw this.communicationFailure()
    }
    return observation
  }

  /** The HAP error that makes a tile show No Response. */
  protected communicationFailure(): Error {
    return new this.host.api.hap.HapStatusError(
      this.host.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    )
  }

  /**
   * Run a write, answering HomeKit within its budget.
   *
   * On time, the caller's promise decides the outcome. Over budget, HomeKit is
   * told the write succeeded and the work carries on; the next observation is
   * what corrects the tile if it did not. That is the honest trade: HAP has
   * already stopped listening by then, so the alternative is not a truthful
   * error but a `OPERATION_TIMED_OUT` for a command that is still in flight
   * and will probably land.
   */
  protected async completeWithinBudget(
    label: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const started = work()
    // Attached before the race so a later rejection cannot become an unhandled
    // rejection once the race has moved on without it.
    const settled = started.catch((error: unknown) => {
      this.host.log.warn(
        `${forLog(this.displayName)}: ${label} failed: ${describeError(error)}`,
      )
    })
    const outcome = await raceTimeout(started, HOMEKIT_WRITE_BUDGET_MS)
    if (outcome === TIMED_OUT) {
      this.host.log.debug(
        `${forLog(this.displayName)}: ${label} still in flight after ${HOMEKIT_WRITE_BUDGET_MS}ms`,
      )
      void settled
    }
  }

  /**
   * Fetch or create a service, so a restart reuses the cached one.
   *
   * Matched by UUID against the restored service list rather than through
   * `getService`, whose generic signature does not admit a concrete service
   * subclass without a cast. Reusing the restored service is what preserves
   * the user's room assignment, custom name and automations across a restart.
   */
  protected requireService(type: ServiceConstructor): Service {
    const existing = this.accessory.services.find((service) => service.UUID === type.UUID)
    return existing ?? this.accessory.addService(new type(this.displayName))
  }

  /** Remove a service this accessory no longer exposes. */
  protected dropService(type: ServiceConstructor): void {
    const stale = this.accessory.services.find((service) => service.UUID === type.UUID)
    if (stale !== undefined) {
      this.accessory.removeService(stale)
    }
  }

  /** Publish a characteristic only when the value has actually changed. */
  protected publish(
    service: Service,
    characteristic: CharacteristicConstructor,
    value: CharacteristicValue,
  ): void {
    const current = service.getCharacteristic(characteristic).value
    if (current === value) {
      return
    }
    service.updateCharacteristic(characteristic, value)
  }

  /** One line per accepted command, at info level, with no secrets in it. */
  protected logAction(action: string, detail?: string): void {
    this.host.log.info(
      `${forLog(this.displayName)}: ${action}${detail === undefined ? '' : ` ${detail}`}`,
    )
  }

  /**
   * True when the write must not happen, having said so at most once.
   *
   * Shared so a thermostat, a power switch and recirculation all use the same
   * line when `options.readOnly` is on.
   */
  protected declineIfReadOnly(): boolean {
    if (!this.host.isReadOnly) {
      return false
    }
    if (!this.hasExplainedReadOnly) {
      this.hasExplainedReadOnly = true
      this.host.log.info(`${forLog(this.displayName)}: readOnly; write ignored`)
    }
    return true
  }

  /** Update Accessory Information once the appliance has named itself. */
  updateIdentity(input: { model: string; firmware?: string }): void {
    const { Characteristic, Service: HapService } = this.host.hap
    const service = this.accessory.getService(HapService.AccessoryInformation)
    if (service === undefined) {
      return
    }
    this.publish(service, Characteristic.Model, input.model)
    if (input.firmware !== undefined && Characteristic.HardwareRevision !== undefined) {
      this.publish(service, Characteristic.HardwareRevision, input.firmware)
    }
    const context = this.accessory.context as AccessoryContext
    context.model = input.model
  }

  /**
   * Write the Accessory Information service.
   *
   * SerialNumber is the opaque generated value, never the gateway MAC: the
   * Home app shows it, so it ends up in screenshots and bug reports, and the
   * MAC is the appliance's address in every MQTT topic.
   */
  private configureAccessoryInformation(init: AccessoryInit): void {
    const { Characteristic, Service: HapService } = this.host.hap
    const service = this.accessory.getService(HapService.AccessoryInformation)
      ?? this.accessory.addService(HapService.AccessoryInformation)
    service
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, init.model)
      .setCharacteristic(Characteristic.SerialNumber, init.serialNumber)
      .setCharacteristic(Characteristic.FirmwareRevision, this.host.pluginVersion)
      .setCharacteristic(Characteristic.Name, this.displayName)
  }

  /** Apply an observation to this accessory's characteristics. */
  protected abstract updateFromObservation(
    observation: ChannelObservation,
    reason: RefreshReason,
  ): void

  /**
   * Report No Response immediately.
   *
   * HAP only greys a tile when a read throws or a characteristic is updated
   * with {@link HapStatusError}. The session has already dropped the
   * observation, so the next GET would fail; this makes the tile follow now.
   */
  protected markUnavailable(): void {
    const { HapStatusError, HAPStatus } = this.host.api.hap
    const error = new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    const infoUuid = this.host.hap.Service.AccessoryInformation.UUID
    for (const service of this.accessory.services) {
      if (service.UUID === infoUuid) {
        continue
      }
      for (const characteristic of service.characteristics) {
        characteristic.updateValue(error)
      }
    }
  }

  /** Keep the last observed scale so a restart can honour display units. */
  private persistScale(scale: ChannelObservation['scale']): void {
    const context = this.accessory.context as AccessoryContext
    if (context.scale === scale) {
      return
    }
    context.scale = scale
  }
}
