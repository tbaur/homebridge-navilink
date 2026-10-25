"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Turns appliance faults and a rejected NaviLink sign-in into
 * homebridge-pagerduty signals.
 *
 * The store writer is the copied module. This file decides which conditions
 * are worth a page, and remembers which appliances were configured so a
 * removed one can be cleared. The remembered file is this plugin's own. It
 * is not the signal store, and it is never logged.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NaviLinkSignals = exports.SIGNAL_AUTH_FAILED = exports.PAGERDUTY_STARTUP_LOG = void 0;
exports.faultSignalName = faultSignalName;
exports.faultSummary = faultSummary;
exports.rememberedDevicesPath = rememberedDevicesPath;
exports.createNaviLinkSignals = createNaviLinkSignals;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const identity_1 = require("./api/identity");
const pagerduty_signals_1 = require("./pagerduty-signals");
/** Logged once, with the pattern rather than each gateway. */
exports.PAGERDUTY_STARTUP_LOG = 'homebridge-pagerduty support is enabled (fault.<gateway>.<channel>, auth-failed)';
exports.SIGNAL_AUTH_FAILED = 'auth-failed';
const AUTH_FAILED_SUMMARY = 'NaviLink rejected the account email or password. Sign-in has stopped until it is corrected in Homebridge.';
const FAULT_SUMMARY_FALLBACK = 'Navien appliance is reporting a fault';
/** Directory under Homebridge storage for the remembered appliance list. */
const REMEMBERED_DIR = 'homebridge-navilink';
const REMEMBERED_FILE = 'pagerduty-devices.json';
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/g;
/**
 * The signal name for one appliance.
 *
 * The device id is `{mac}:{channel}`. A signal name cannot contain a colon,
 * so the separator becomes a dot. Undefined when the id is not one this
 * plugin would configure.
 */
function faultSignalName(deviceId) {
    const parsed = (0, identity_1.parseDeviceId)(deviceId);
    if (parsed === undefined) {
        return undefined;
    }
    return `fault.${parsed.mac}.${parsed.channel}`;
}
/**
 * The PagerDuty title for an appliance fault.
 *
 * The name is the one in config. The error code stays in the Homebridge log,
 * because a saved PagerDuty message is fixed text and would keep an old code.
 */
function faultSummary(name) {
    const cleaned = name.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length === 0) {
        return FAULT_SUMMARY_FALLBACK;
    }
    return `Navien ${cleaned} is reporting a fault`;
}
/** Where the remembered appliance list lives. Local storage, not the repo. */
function rememberedDevicesPath(storagePath) {
    return (0, node_path_1.join)(storagePath, REMEMBERED_DIR, REMEMBERED_FILE);
}
/**
 * Fault and sign-in signals for this plugin.
 *
 * Fault rows are written when a status frame arrives, not before: a clear
 * written at startup would resolve a lockout that is still in progress.
 * Auth is written when sign-in is accepted or refused, and left alone for
 * every failure the session will retry.
 */
class NaviLinkSignals {
    writer;
    storagePath;
    log;
    warned = new Set();
    constructor(writer, storagePath, log) {
        this.writer = writer;
        this.storagePath = storagePath;
        this.log = log;
    }
    /**
     * Clear fault signals for appliances that are no longer configured, then
     * remember the current set. Does not write the current appliances: their
     * fault state is not known until a status frame arrives.
     */
    syncDevices(devices) {
        const current = devices.map((device) => ({ id: device.id, name: device.name }));
        const currentIds = new Set(current.map((device) => device.id));
        for (const previous of this.readRemembered()) {
            if (!currentIds.has(previous.id)) {
                this.setFault(previous.id, previous.name, false);
            }
        }
        this.writeRemembered(current);
    }
    /** Record whether this appliance's latest status frame has an error code. */
    setFault(deviceId, name, isActive) {
        const signal = faultSignalName(deviceId);
        if (signal === undefined) {
            return;
        }
        this.writer.write(signal, {
            active: isActive,
            severity: 'critical',
            summary: faultSummary(name),
        });
    }
    /** Record whether NaviLink has rejected the account and stopped sign-in. */
    setAuthenticationRejected(isRejected) {
        this.writer.write(exports.SIGNAL_AUTH_FAILED, {
            active: isRejected,
            severity: 'error',
            summary: AUTH_FAILED_SUMMARY,
        });
    }
    /** Close the store. Does not clear any signal. */
    close() {
        this.writer.close();
    }
    readRemembered() {
        const file = rememberedDevicesPath(this.storagePath);
        if (!(0, node_fs_1.existsSync)(file)) {
            return [];
        }
        try {
            const parsed = JSON.parse((0, node_fs_1.readFileSync)(file, 'utf8'));
            const devices = rememberedDevices(parsed);
            if (devices === undefined) {
                this.warnOnce('PagerDuty device list could not be read; removed appliances will not be cleared this start');
                return [];
            }
            return devices;
        }
        catch {
            this.warnOnce('PagerDuty device list could not be read; removed appliances will not be cleared this start');
            return [];
        }
    }
    writeRemembered(devices) {
        const dir = (0, node_path_1.join)(this.storagePath, REMEMBERED_DIR);
        const file = rememberedDevicesPath(this.storagePath);
        const temporary = `${file}.tmp`;
        try {
            (0, node_fs_1.mkdirSync)(dir, { recursive: true, mode: 0o700 });
            (0, node_fs_1.chmodSync)(dir, 0o700);
            const payload = JSON.stringify({ devices });
            const fd = (0, node_fs_1.openSync)(temporary, 'w', 0o600);
            try {
                (0, node_fs_1.writeFileSync)(fd, payload);
            }
            finally {
                (0, node_fs_1.closeSync)(fd);
            }
            (0, node_fs_1.chmodSync)(temporary, 0o600);
            (0, node_fs_1.renameSync)(temporary, file);
            (0, node_fs_1.chmodSync)(file, 0o600);
        }
        catch {
            try {
                (0, node_fs_1.unlinkSync)(temporary);
            }
            catch {
                // The temporary file may not exist. The warning below is the outcome.
            }
            this.warnOnce('PagerDuty device list could not be saved');
        }
    }
    warnOnce(message) {
        if (this.warned.has(message)) {
            return;
        }
        this.warned.add(message);
        this.log.warn(message);
    }
}
exports.NaviLinkSignals = NaviLinkSignals;
/** Build the signals for this plugin, backed by the homebridge-pagerduty store. */
function createNaviLinkSignals(options) {
    return new NaviLinkSignals(new pagerduty_signals_1.PagerDutySignals(options), options.storagePath, options.log);
}
/**
 * The appliance list in the remembered file, or undefined when the file is
 * not that list. A bad entry fails the whole file, so a partial read cannot
 * clear the wrong appliance.
 */
function rememberedDevices(value) {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const devices = value.devices;
    if (!Array.isArray(devices)) {
        return undefined;
    }
    const parsed = [];
    for (const entry of devices) {
        if (typeof entry !== 'object' || entry === null) {
            return undefined;
        }
        const id = entry.id;
        const name = entry.name;
        if (typeof id !== 'string' || typeof name !== 'string' || (0, identity_1.parseDeviceId)(id) === undefined) {
            return undefined;
        }
        parsed.push({ id, name });
    }
    return parsed;
}
