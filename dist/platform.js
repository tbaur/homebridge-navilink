"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeError = exports.NaviLinkPlatform = void 0;
const channel_1 = require("./api/channel");
const identity_1 = require("./api/identity");
const protocol_1 = require("./api/protocol");
const devices_1 = require("./devices");
const session_1 = require("./session");
const settings_1 = require("./settings");
const types_1 = require("./types");
const utils_1 = require("./utils");
Object.defineProperty(exports, "describeError", { enumerable: true, get: function () { return utils_1.describeError; } });
/** Homebridge's dynamic platform for NaviLink appliances. */
class NaviLinkPlatform {
    api;
    log;
    pluginVersion;
    Service;
    Characteristic;
    /** Accessories Homebridge restored, by UUID, before configuration is read. */
    restored = new Map();
    /** Live accessory handlers, by UUID. */
    handlers = new Map();
    devices = new Map();
    options = {
        statusIntervalSec: settings_1.DEFAULT_STATUS_INTERVAL_SEC,
        allowPowerOff: false,
        readOnly: false,
    };
    session;
    /** True when configuration was unusable and nothing should be attempted. */
    disabled = false;
    /** True between the cloud going quiet and the next observation. */
    cloudOffline = false;
    lastOutageWarnAt = 0;
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.pluginVersion = (0, settings_1.readPluginVersion)(log);
        const result = (0, utils_1.validateConfig)(config);
        for (const warning of result.warnings) {
            this.log.warn(warning);
        }
        this.options = result.options;
        if (result.errors.length > 0 || result.account === undefined) {
            this.disabled = true;
            for (const error of result.errors) {
                this.log.error(error);
            }
            this.log.error('the NaviLink platform is disabled. Cached accessories are left registered and will '
                + 'show as No Response, so your rooms and automations are preserved.');
            // Still registered so Homebridge does not complain about orphans, and so
            // fixing the configuration restores them rather than recreating them.
            api.on('didFinishLaunching', () => this.keepRestoredRegistered());
            return;
        }
        for (const device of result.devices) {
            this.devices.set(device.id, device);
        }
        const account = result.account;
        api.on('didFinishLaunching', () => this.start(account, result.devices));
        api.on('shutdown', () => {
            void this.stop();
        });
    }
    get hap() {
        return this.api.hap;
    }
    get isReadOnly() {
        return this.options.readOnly;
    }
    /** Homebridge hands back every accessory it restored from its cache. */
    configureAccessory(accessory) {
        this.restored.set(accessory.UUID, accessory);
    }
    // --- Lifecycle --------------------------------------------------------------
    start(account, devices) {
        const warnings = [];
        const accessories = (0, utils_1.resolveAccessories)(devices, warnings);
        for (const warning of warnings) {
            this.log.warn(warning);
        }
        this.syncAccessories(accessories);
        const session = new session_1.NaviLinkSession({
            log: this.log,
            account,
            devices,
            statusIntervalSec: this.options.statusIntervalSec,
        });
        session.onObservation((deviceId, observation, reason) => {
            this.distribute(deviceId, observation, reason);
        });
        session.onUnreachable((error) => this.markAllUnreachable(error));
        session.onStale((deviceId) => this.markDeviceUnreachable(deviceId));
        this.session = session;
        session.start();
        this.log.info(`NaviLink is watching ${devices.length} appliance(s) with ${accessories.length} accessory(ies)`);
    }
    async stop() {
        for (const handler of this.handlers.values()) {
            handler.stop();
        }
        this.handlers.clear();
        await this.session?.stop();
        this.session = undefined;
    }
    /** Keep cached accessories registered when configuration is unusable. */
    keepRestoredRegistered() {
        if (this.restored.size === 0) {
            return;
        }
        for (const accessory of this.restored.values()) {
            this.reviveAsUnavailable(accessory);
        }
        this.log.warn(`${this.restored.size} cached accessory(ies) are registered but inactive until the `
            + 'configuration is fixed');
    }
    /**
     * Bind GET handlers on a restored tile so HomeKit shows No Response.
     *
     * Without handlers, HAP keeps serving the last persisted value. The
     * platform is disabled, so every read must fail as a communication error.
     */
    reviveAsUnavailable(accessory) {
        const context = (0, utils_1.parseAccessoryContext)(accessory.context);
        if (context === undefined) {
            return;
        }
        const init = {
            host: this,
            accessory,
            deviceId: context.deviceId,
            displayName: accessory.displayName,
            model: context.model,
            serialNumber: context.serialNumber,
        };
        const handler = this.createHandler(context.kind, init);
        if (handler === undefined) {
            return;
        }
        this.handlers.set(accessory.UUID, handler);
        handler.noteUnreachable(new Error('the NaviLink platform is disabled'));
    }
    /**
     * Bring the registered accessory set in line with configuration.
     *
     * Adopting a restored accessory rather than recreating it is the whole point
     * of this method. An accessory that is removed and re-added is a *different*
     * accessory to HomeKit, and takes its room, scenes and automations with it.
     */
    syncAccessories(resolved) {
        const wanted = new Map();
        for (const accessory of resolved) {
            wanted.set(this.uuidFor(accessory), accessory);
        }
        const stale = [...this.restored.entries()]
            .filter(([uuid]) => !wanted.has(uuid))
            .map(([, accessory]) => accessory);
        if (stale.length > 0) {
            for (const accessory of stale) {
                this.log.info(`removing ${(0, utils_1.forLog)(accessory.displayName)}, no longer in the configuration`);
                this.restored.delete(accessory.UUID);
            }
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, stale);
        }
        const created = [];
        for (const [uuid, accessory] of wanted) {
            const existing = this.restored.get(uuid);
            if (existing !== undefined) {
                this.adopt(existing, accessory);
                continue;
            }
            this.log.info(`adding ${(0, utils_1.forLog)(accessory.name)}`);
            const platformAccessory = new this.api.platformAccessory(accessory.name, uuid);
            this.adopt(platformAccessory, accessory);
            created.push(platformAccessory);
        }
        if (created.length > 0) {
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, created);
        }
    }
    adopt(accessory, resolved) {
        const model = this.modelFor(resolved.deviceId);
        const context = (0, utils_1.bindAccessoryContext)({ accessory, resolved, model });
        if (!(0, identity_1.hasAccessoryIdentity)(context, resolved)) {
            // Cannot happen: the context was just written from `resolved`. Checked
            // anyway because getting it wrong silently re-keys somebody's tile.
            this.log.warn(`${(0, utils_1.forLog)(resolved.name)}: accessory identity did not bind; skipping it`);
            return;
        }
        if (accessory.displayName !== resolved.name) {
            this.log.info(`${(0, utils_1.forLog)(accessory.displayName)} is now named ${(0, utils_1.forLog)(resolved.name)}`);
        }
        accessory.displayName = resolved.name;
        const init = {
            host: this,
            accessory,
            deviceId: resolved.deviceId,
            displayName: resolved.name,
            model,
            serialNumber: context.serialNumber,
        };
        const handler = this.createHandler(resolved.kind, init);
        if (handler === undefined) {
            return;
        }
        this.handlers.set(accessory.UUID, handler);
        this.restored.set(accessory.UUID, accessory);
    }
    createHandler(kind, init) {
        if ((0, types_1.isProbeKind)(kind)) {
            return new devices_1.ProbeAccessory({ ...init, kind });
        }
        switch (kind) {
            case 'dhw':
                return new devices_1.DomesticHotWaterAccessory(init);
            case 'heating':
                return new devices_1.SpaceHeatingAccessory(init);
            case 'power':
                return new devices_1.PowerAccessory(init);
            case 'recirculation':
                return new devices_1.RecirculationAccessory(init);
            case 'fault':
                return new devices_1.FaultAccessory(init);
            default:
                this.log.warn(`${(0, utils_1.forLog)(init.displayName)}: unknown accessory kind; skipping it`);
                return undefined;
        }
    }
    /**
     * The UUID for an accessory.
     *
     * Seeded from the identity key alone. Nothing about the account, the
     * address or the display name is in it, so none of those can change a UUID
     * and orphan somebody's tile.
     */
    uuidFor(accessory) {
        return this.api.hap.uuid.generate(`${settings_1.UUID_PREFIX}${(0, identity_1.accessoryIdentityKey)(accessory)}`);
    }
    modelFor(deviceId) {
        const observation = this.session?.observationFor(deviceId);
        return observation === undefined || observation.family === 'UNKNOWN'
            ? settings_1.DEFAULT_MODEL
            : `Navien ${(0, channel_1.formatFamily)(observation.family)}`;
    }
    // --- Fan-out ----------------------------------------------------------------
    distribute(deviceId, observation, reason) {
        this.noteCloudReachable();
        const model = this.modelFor(deviceId);
        const firmware = this.session?.firmwareFor(deviceId);
        for (const handler of this.handlers.values()) {
            if (handler.deviceId === deviceId) {
                handler.updateIdentity({
                    model,
                    ...(firmware === undefined ? {} : { firmware }),
                });
                handler.applyObservation(observation, reason);
            }
        }
    }
    /**
     * The cloud has stopped answering.
     *
     * Logged here rather than in each accessory, unlike the LAN plugins in this
     * family. There is one connection for the whole account, so an outage is
     * one event: a warning per accessory would turn a single dropped socket
     * into eight identical lines saying the same thing.
     */
    markAllUnreachable(error) {
        const now = Date.now();
        const isNew = !this.cloudOffline;
        this.cloudOffline = true;
        if (isNew || now - this.lastOutageWarnAt > settings_1.UNREACHABLE_REWARN_MS) {
            this.lastOutageWarnAt = now;
            this.log.warn(`NaviLink is not answering: ${(0, utils_1.describeError)(error)}`);
        }
        else {
            this.log.debug(`NaviLink is still not answering: ${(0, utils_1.describeError)(error)}`);
        }
        for (const handler of this.handlers.values()) {
            handler.noteUnreachable(error);
        }
    }
    /** One appliance has gone quiet while the broker is still connected. */
    markDeviceUnreachable(deviceId) {
        for (const handler of this.handlers.values()) {
            if (handler.deviceId === deviceId) {
                handler.noteUnreachable(new Error('the appliance has not reported recently'));
            }
        }
    }
    /**
     * The cloud is answering again.
     *
     * Every outage warns on its way in, so it gets a matching line on its way
     * out. Without one, a log shows the cloud failing and never recovering, and
     * an outage that healed reads exactly like one still in progress.
     */
    noteCloudReachable() {
        if (!this.cloudOffline) {
            return;
        }
        this.cloudOffline = false;
        this.lastOutageWarnAt = 0;
        this.log.info('NaviLink is answering again');
    }
    // --- AccessoryHost ----------------------------------------------------------
    deviceFor(deviceId) {
        return this.devices.get(deviceId);
    }
    observationFor(deviceId) {
        return this.disabled ? undefined : this.session?.observationFor(deviceId);
    }
    noteOptimisticWrite(deviceId, patch) {
        this.session?.applyOptimisticWrite(deviceId, patch);
    }
    /**
     * The commands an accessory may issue, with this plugin's rules applied.
     *
     * `readOnly` and the power-off guard live here. An accessory expresses an
     * intent and this decides whether it happens. Setpoint coalescing is
     * thermostat-only and is not enforced here.
     */
    control(deviceId) {
        const send = (spec) => {
            if (this.options.readOnly) {
                return Promise.reject(new utils_1.ControlRejectedError(`options.readOnly is on in the plugin settings, so ${spec.what} was not sent`));
            }
            const session = this.session;
            if (session === undefined) {
                return Promise.reject(new utils_1.ControlRejectedError('the NaviLink session is not running'));
            }
            return session.publishControl(deviceId, spec);
        };
        /**
         * The scale to encode a setpoint in.
         *
         * Read from the appliance rather than assumed. A Celsius unit takes
         * half-degree ticks and a Fahrenheit one takes whole degrees, so guessing
         * wrong sends a setpoint out by a factor of two.
         */
        const requireScale = () => {
            const observation = this.observationFor(deviceId);
            if (observation === undefined) {
                throw new utils_1.ControlRejectedError('the appliance has not reported its temperature scale yet');
            }
            return observation.scale;
        };
        return {
            setPower: async (on) => {
                if (!on && !this.options.allowPowerOff) {
                    throw new utils_1.ControlRejectedError('switching the appliance off from HomeKit is disabled, because it stops central '
                        + 'heating as well as hot water. Turn on "Allow HomeKit to switch the appliance '
                        + 'off" in the plugin settings if that is what you want.');
                }
                await send({
                    command: protocol_1.Command.POWER,
                    what: 'a power change',
                    build: (input) => (0, protocol_1.powerControl)({ ...input, on }),
                });
            },
            setHeating: async (on) => {
                await send({
                    command: protocol_1.Command.HEAT,
                    what: 'a space-heating enable command',
                    build: (input) => (0, protocol_1.heatingEnableControl)({ ...input, on }),
                });
            },
            setDomesticHotWaterSetpoint: async (native) => {
                const scale = requireScale();
                await send({
                    command: protocol_1.Command.DHW_TEMPERATURE,
                    what: 'a hot water setpoint',
                    build: (input) => (0, protocol_1.dhwSetpointControl)({ ...input, native, scale }),
                });
            },
            setHeatingSetpoint: async (native) => {
                const scale = requireScale();
                await send({
                    command: protocol_1.Command.HEAT_TEMPERATURE,
                    what: 'a space-heating setpoint',
                    build: (input) => (0, protocol_1.heatingSetpointControl)({ ...input, native, scale }),
                });
            },
            setRecirculation: async (on) => {
                await send({
                    command: protocol_1.Command.ON_DEMAND,
                    what: 'a recirculation command',
                    build: (input) => (0, protocol_1.onDemandControl)({ ...input, on }),
                });
            },
        };
    }
}
exports.NaviLinkPlatform = NaviLinkPlatform;
