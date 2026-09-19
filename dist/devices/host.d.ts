/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The contract between an accessory and the platform.
 *
 * An explicit interface rather than a reference to the platform class, for two
 * reasons. It breaks the import cycle that would otherwise exist between the
 * platform and the accessories it creates. And it is the whole surface an
 * accessory is allowed to reach, so a test can supply a dozen-line stand-in
 * instead of standing up a platform, a cloud session and a socket.
 *
 * Note what an accessory cannot do through this interface: it cannot reach the
 * MQTT connection, build a frame, or see the account. Every write goes through
 * one of the named intents below, so the rules that govern writes (read-only
 * mode, the power-off guard, rate limiting) are enforced in one place, not in
 * each accessory that might forget. Setpoint coalescing is thermostat-only
 * and lives on {@link ThermostatAccessory}.
 */
import type { API, HAP, PlatformAccessory } from 'homebridge';
import type { ChannelObservation, PluginLogger, ResolvedDevice } from '../types';
/** What an accessory may ask the appliance to do. */
export interface ControlIntent {
    /** Switch the appliance on or off. Subject to the power-off guard. */
    setPower(on: boolean): Promise<void>;
    /** Enable or disable space heating. */
    setHeating(on: boolean): Promise<void>;
    /** Set the domestic hot water setpoint, in the appliance's native scale. */
    setDomesticHotWaterSetpoint(native: number): Promise<void>;
    /** Set the space-heating water setpoint, in the appliance's native scale. */
    setHeatingSetpoint(native: number): Promise<void>;
    /** Start or stop the recirculation pump. */
    setRecirculation(on: boolean): Promise<void>;
}
/** Everything an accessory needs from the platform that owns it. */
export interface AccessoryHost {
    readonly api: API;
    readonly hap: HAP;
    readonly log: PluginLogger;
    /** This plugin's version, published as FirmwareRevision. */
    readonly pluginVersion: string;
    /** True when configuration forbids every write. */
    readonly isReadOnly: boolean;
    /** The configured device an accessory belongs to, or undefined if removed. */
    deviceFor(deviceId: string): ResolvedDevice | undefined;
    /**
     * The most recent observation for a device.
     *
     * Undefined before the first status frame, and undefined again once the
     * session has been failing long enough that the last reading should no
     * longer be presented as current. Accessories treat both the same way: they
     * report No Response rather than inventing a value.
     */
    observationFor(deviceId: string): ChannelObservation | undefined;
    /** Send a command to an appliance. */
    control(deviceId: string): ControlIntent;
    /**
     * Adopt the result of a write immediately.
     *
     * A control command is acknowledged long before a status frame reflects it,
     * and a tile that springs back to its old value for a second looks like a
     * write that failed. This lets an accessory publish what it just asked for,
     * which the next real observation then confirms or corrects.
     */
    noteOptimisticWrite(deviceId: string, patch: Partial<ChannelObservation>): void;
}
/** What an accessory is handed when it is constructed. */
export interface AccessoryInit {
    host: AccessoryHost;
    accessory: PlatformAccessory;
    deviceId: string;
    displayName: string;
    model: string;
    serialNumber: string;
}
