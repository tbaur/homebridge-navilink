/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The platform: accessory lifecycle, and the rules that govern
 * every write.
 *
 * It owns three things and delegates everything else.
 *
 * **Which accessories exist.** Configuration is validated once, expanded into
 * a list of accessories, and reconciled against what Homebridge restored from
 * its cache. Adopting a restored accessory rather than recreating it is what
 * keeps a tile attached to its room, its scenes and its automations.
 *
 * **What happens when configuration is unusable.** The platform disables
 * itself and leaves cached accessories registered, so HomeKit shows No
 * Response instead of losing the rooms built on them. Unregistering would be
 * tidier and is the wrong trade: a typo in a password should not cost
 * somebody their automations.
 *
 * **The rules that govern writes.** Read-only mode and the power-off guard
 * are enforced here, in {@link control}, rather than in each accessory that
 * might forget. An accessory can only express an intent; whether it is
 * carried out is decided in one place. Setpoint coalescing is thermostat-only
 * and lives on the thermostat accessory.
 */
import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { type AccessoryHost, type ControlIntent } from './devices';
import type { ChannelObservation, ResolvedDevice } from './types';
import { describeError } from './utils';
/** Homebridge's dynamic platform for NaviLink appliances. */
export declare class NaviLinkPlatform implements DynamicPlatformPlugin, AccessoryHost {
    readonly api: API;
    readonly log: Logging;
    readonly pluginVersion: string;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    /** Accessories Homebridge restored, by UUID, before configuration is read. */
    private readonly restored;
    /** Live accessory handlers, by UUID. */
    private readonly handlers;
    private readonly devices;
    private options;
    private session;
    private readonly platformConfig;
    private readonly diagnostics;
    private diagnosticsTimer;
    private lastDiagnosticsHealth;
    /** True when configuration was unusable and nothing should be attempted. */
    private disabled;
    /** True between the cloud going quiet and the next observation. */
    private cloudOffline;
    private lastOutageWarnAt;
    constructor(log: Logging, config: PlatformConfig, api: API);
    get hap(): API['hap'];
    get isReadOnly(): boolean;
    /** Homebridge hands back every accessory it restored from its cache. */
    configureAccessory(accessory: PlatformAccessory): void;
    private start;
    private stop;
    /** Keep cached accessories registered when configuration is unusable. */
    private keepRestoredRegistered;
    /**
     * Bind GET handlers on a restored tile so HomeKit shows No Response.
     *
     * Without handlers, HAP keeps serving the last persisted value. The
     * platform is disabled, so every read must fail as a communication error.
     */
    private reviveAsUnavailable;
    /**
     * Bring the registered accessory set in line with configuration.
     *
     * Adopting a restored accessory rather than recreating it is the whole point
     * of this method. An accessory that is removed and re-added is a *different*
     * accessory to HomeKit, and takes its room, scenes and automations with it.
     */
    private syncAccessories;
    private adopt;
    private createHandler;
    /**
     * The UUID for an accessory.
     *
     * Seeded from the identity key alone. Nothing about the account, the
     * address or the display name is in it, so none of those can change a UUID
     * and orphan somebody's tile.
     */
    private uuidFor;
    private modelFor;
    private distribute;
    /**
     * The cloud has stopped answering.
     *
     * Logged here rather than in each accessory, unlike the LAN plugins in this
     * family. There is one connection for the whole account, so an outage is
     * one event: a warning per accessory would turn a single dropped socket
     * into eight identical lines saying the same thing.
     */
    private markAllUnreachable;
    /** One appliance has gone quiet while the broker is still connected. */
    private markDeviceUnreachable;
    /**
     * The cloud is answering again.
     *
     * Every outage warns on its way in, so it gets a matching line on its way
     * out. Without one, a log shows the cloud failing and never recovering, and
     * an outage that healed reads exactly like one still in progress.
     */
    private noteCloudReachable;
    deviceFor(deviceId: string): ResolvedDevice | undefined;
    observationFor(deviceId: string): ChannelObservation | undefined;
    noteOptimisticWrite(deviceId: string, patch: Partial<ChannelObservation>): void;
    /**
     * The commands an accessory may issue, with this plugin's rules applied.
     *
     * `readOnly` and the power-off guard live here. An accessory expresses an
     * intent and this decides whether it happens. Setpoint coalescing is
     * thermostat-only and is not enforced here.
     */
    control(deviceId: string): ControlIntent;
    private diagnosticsIntervalMs;
    private startDiagnostics;
    private stopDiagnostics;
    private diagnosticsHeartbeat;
    private buildDiagnosticsReaders;
    private emitDiagnostic;
}
/** Describe an error for the log, re-exported so the entry point can use it. */
export { describeError };
