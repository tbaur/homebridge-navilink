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
import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { ChannelObservation, RefreshReason } from '../types';
import type { AccessoryHost, AccessoryInit } from './host';
/** A concrete HAP service class, such as `Service.Thermostat`. */
export type ServiceConstructor = {
    UUID: string;
    new (displayName?: string, subtype?: string): Service;
};
/** A concrete HAP characteristic class, such as `Characteristic.On`. */
export type CharacteristicConstructor = WithUUID<new () => Characteristic>;
/** Shared behaviour for every accessory this plugin exposes. */
export declare abstract class BaseAccessory {
    protected readonly host: AccessoryHost;
    protected readonly accessory: PlatformAccessory;
    readonly deviceId: string;
    readonly displayName: string;
    /** True once the platform has torn this accessory down. */
    private stopped;
    /** Said once rather than on every write, so a scene cannot flood the log. */
    private hasExplainedReadOnly;
    constructor(init: AccessoryInit);
    /** Apply a fresh observation. Called by the platform, never by a subclass. */
    applyObservation(observation: ChannelObservation, reason: RefreshReason): void;
    /** Report that the appliance can no longer be heard from. */
    noteUnreachable(error: unknown): void;
    /** Release anything held. After this the accessory ignores every update. */
    stop(): void;
    /**
     * The current observation, or a HAP communication failure.
     *
     * The single place an accessory is allowed to obtain state, so the decision
     * to report No Response rather than a remembered value is made once. See the
     * file header.
     */
    protected requireObservedState(): ChannelObservation;
    /** The HAP error that makes a tile show No Response. */
    protected communicationFailure(): Error;
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
    protected completeWithinBudget(label: string, work: () => Promise<void>): Promise<void>;
    /**
     * Fetch or create a service, so a restart reuses the cached one.
     *
     * Matched by UUID against the restored service list rather than through
     * `getService`, whose generic signature does not admit a concrete service
     * subclass without a cast. Reusing the restored service is what preserves
     * the user's room assignment, custom name and automations across a restart.
     */
    protected requireService(type: ServiceConstructor): Service;
    /** Remove a service this accessory no longer exposes. */
    protected dropService(type: ServiceConstructor): void;
    /** Publish a characteristic only when the value has actually changed. */
    protected publish(service: Service, characteristic: CharacteristicConstructor, value: CharacteristicValue): void;
    /** One line per accepted command, at info level, with no secrets in it. */
    protected logAction(action: string, detail?: string): void;
    /**
     * True when the write must not happen, having said so at most once.
     *
     * Shared so a thermostat, a power switch and recirculation all use the same
     * sentence when `options.readOnly` is on.
     */
    protected declineIfReadOnly(what: string): boolean;
    /** Update Accessory Information once the appliance has named itself. */
    updateIdentity(input: {
        model: string;
        firmware?: string;
    }): void;
    /**
     * Write the Accessory Information service.
     *
     * SerialNumber is the opaque generated value, never the gateway MAC: the
     * Home app shows it, so it ends up in screenshots and bug reports, and the
     * MAC is the appliance's address in every MQTT topic.
     */
    private configureAccessoryInformation;
    /** Apply an observation to this accessory's characteristics. */
    protected abstract updateFromObservation(observation: ChannelObservation, reason: RefreshReason): void;
    /**
     * Report No Response immediately.
     *
     * HAP only greys a tile when a read throws or a characteristic is updated
     * with {@link HapStatusError}. The session has already dropped the
     * observation, so the next GET would fail; this makes the tile follow now.
     */
    protected markUnavailable(): void;
    /** Keep the last observed scale so a restart can honour display units. */
    private persistScale;
}
