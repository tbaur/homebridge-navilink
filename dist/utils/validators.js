"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * The split between fatal and non-fatal is deliberate. A missing account, or a
 * `devices` value that is not a list, means the file does not describe
 * anything we can act on, so the platform disables itself while leaving cached
 * accessories registered. HomeKit then shows them as No Response rather than
 * losing the rooms and automations built on them.
 *
 * A problem with one device is different: rejecting the whole installation
 * because one entry is malformed would be a worse outcome than skipping that
 * entry. Skipped devices are warned about by name and reason, because a device
 * that silently fails to appear is the hardest kind of bug for a user to
 * report.
 *
 * One rule specific to this plugin: **nothing in here ever puts the password
 * into a message.** Not its length, not a prefix, not "you typed
 * `hunter2␣`" to explain a trailing space. Validation says whether it is
 * present and usable and stops there.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.forLog = forLog;
exports.forDisplay = forDisplay;
exports.isValidDeviceId = isValidDeviceId;
exports.isValidEmail = isValidEmail;
exports.resolveStatusIntervalSec = resolveStatusIntervalSec;
exports.resolveDiagnosticsIntervalSec = resolveDiagnosticsIntervalSec;
exports.resolveAccessoryPrefix = resolveAccessoryPrefix;
exports.validateConfig = validateConfig;
exports.resolveAccessories = resolveAccessories;
const identity_1 = require("../api/identity");
const settings_1 = require("../settings");
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
/**
 * The same class, global, for replacement.
 *
 * Kept separate because a global regex carries `lastIndex` state, which would
 * make two `test` calls on one input return alternating answers.
 */
const ALL_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;
/**
 * A deliberately loose address check.
 *
 * The authority on whether an address is an account is the cloud, which will
 * say so in one round trip. All this has to catch is the shape that is
 * certainly a mistake (no `@`, whitespace in the middle, a control character)
 * so that an obvious typo is a startup error instead of a failed sign-in
 * that looks like a wrong password.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Make an untrusted string safe to interpolate into a log line.
 *
 * Device names come from configuration and from the cloud, so they are
 * attacker-influenced in the threat model where someone can write to either. A
 * newline in a log line lets them forge entries; truncation stops one long
 * name from burying everything else.
 */
function forLog(value) {
    const text = typeof value === 'string' ? value : String(value);
    const sanitized = text.replace(ALL_CONTROL_CHARACTERS, '\uFFFD');
    return sanitized.length > settings_1.MAX_LOG_FIELD_LENGTH
        ? `${sanitized.slice(0, settings_1.MAX_LOG_FIELD_LENGTH)}\u2026`
        : sanitized;
}
/**
 * Make an untrusted string safe to publish to HomeKit.
 *
 * Same sanitising as {@link forLog} but capped at HomeKit's name budget rather
 * than the log field budget, for values that become characteristic values and
 * are written into the accessory cache. An empty result becomes undefined, so
 * a caller keeps the value it already had instead of publishing a blank.
 */
function forDisplay(value) {
    const cleaned = value.replace(ALL_CONTROL_CHARACTERS, '').trim();
    if (cleaned.length === 0) {
        return undefined;
    }
    return cleaned.length > settings_1.MAX_NAME_LENGTH
        ? `${cleaned.slice(0, settings_1.MAX_NAME_LENGTH - 1)}\u2026`
        : cleaned;
}
/** True when a value is safe to use as a device id and accessory UUID seed. */
function isValidDeviceId(value) {
    return (0, identity_1.parseDeviceId)(value) !== undefined;
}
/** True for something shaped like an email address. */
function isValidEmail(value) {
    return typeof value === 'string' && value.length <= 254 && EMAIL.test(value.trim());
}
/** Clamp the status interval into the supported range. */
function resolveStatusIntervalSec(value, warnings) {
    if (value === undefined) {
        return settings_1.DEFAULT_STATUS_INTERVAL_SEC;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        warnings?.push(`options.statusIntervalSec is not a number; using ${settings_1.DEFAULT_STATUS_INTERVAL_SEC}s`);
        return settings_1.DEFAULT_STATUS_INTERVAL_SEC;
    }
    const clamped = Math.min(settings_1.MAX_STATUS_INTERVAL_SEC, Math.max(settings_1.MIN_STATUS_INTERVAL_SEC, Math.round(numeric)));
    if (clamped !== numeric) {
        warnings?.push(`options.statusIntervalSec clamped to ${clamped}s`);
    }
    return clamped;
}
/**
 * Resolve the diagnostics heartbeat interval.
 *
 * `0` and anything not a number is off. Values between 1 and 29 clamp up to
 * 30 so a typo does not silently disable the heartbeat.
 */
function resolveDiagnosticsIntervalSec(value, warnings) {
    if (value === undefined || value === 0) {
        return 0;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        warnings?.push('options.diagnosticsInterval is not a usable number; diagnostics stay off');
        return 0;
    }
    const rounded = Math.round(numeric);
    if (rounded === 0) {
        return 0;
    }
    const clamped = Math.min(settings_1.MAX_DIAGNOSTICS_INTERVAL_SEC, Math.max(settings_1.MIN_DIAGNOSTICS_INTERVAL_SEC, rounded));
    if (clamped !== numeric) {
        warnings?.push(`options.diagnosticsInterval clamped to ${clamped}s`);
    }
    return clamped;
}
/**
 * Resolve the HomeKit accessory-name prefix.
 *
 * Blank means each appliance's own name is used. The value is trimmed and
 * stripped of control characters; it is never required.
 */
function resolveAccessoryPrefix(value, warnings) {
    if (value === undefined || value === '') {
        return '';
    }
    if (typeof value !== 'string') {
        warnings?.push('options.accessoryPrefix is not a string; using each appliance name');
        return '';
    }
    const cleaned = value.replace(ALL_CONTROL_CHARACTERS, '').trim();
    if (cleaned.length === 0) {
        return '';
    }
    if (cleaned.length > settings_1.MAX_NAME_LENGTH) {
        warnings?.push(`options.accessoryPrefix clamped to ${settings_1.MAX_NAME_LENGTH} characters`);
        return cleaned.slice(0, settings_1.MAX_NAME_LENGTH);
    }
    return cleaned;
}
function validateName(value, label, problems) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        problems.push(`${label} is missing a name`);
        return undefined;
    }
    const name = value.trim();
    if (CONTROL_CHARACTERS.test(name)) {
        problems.push(`${label} name contains control characters`);
        return undefined;
    }
    if (name.length > settings_1.MAX_NAME_LENGTH) {
        problems.push(`${label} name is longer than ${settings_1.MAX_NAME_LENGTH} characters`);
        return undefined;
    }
    return name;
}
function validateChannel(value, label, warnings) {
    if (value === undefined) {
        return settings_1.MIN_CHANNEL;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(numeric) || numeric < settings_1.MIN_CHANNEL || numeric > settings_1.MAX_CHANNEL) {
        warnings.push(`${label} channel ${forLog(value)} is invalid; using ${settings_1.MIN_CHANNEL}`);
        return settings_1.MIN_CHANNEL;
    }
    return numeric;
}
/**
 * Validate the account.
 *
 * Trimmed on the way in, because a trailing space pasted from a password
 * manager is a real and very confusing failure: the cloud rejects it and the
 * user sees "wrong password" for a password that is right. The address is
 * trimmed for the same reason. Neither value is echoed back in any message.
 */
function validateAccount(config, errors, warnings) {
    const rawEmail = typeof config.email === 'string' ? config.email.trim() : '';
    const rawPassword = typeof config.password === 'string' ? config.password : '';
    if (rawEmail.length === 0 || rawPassword.length === 0) {
        errors.push('email and password required');
        return undefined;
    }
    if (!isValidEmail(rawEmail)) {
        errors.push('invalid email');
        return undefined;
    }
    const password = rawPassword.trim();
    if (password.length === 0) {
        errors.push('password is blank');
        return undefined;
    }
    if (password !== rawPassword) {
        // Said once, without quoting anything: a pasted password often carries a
        // trailing newline, and the resulting rejection is otherwise unexplainable.
        warnings.push('password had surrounding whitespace; trimmed');
    }
    if (password.length > settings_1.MAX_PASSWORD_LENGTH) {
        errors.push(`password longer than ${settings_1.MAX_PASSWORD_LENGTH} characters`);
        return undefined;
    }
    return { email: rawEmail, password };
}
/** MAC and channel from `id`, which is what the session addresses. */
function resolveDeviceIdentity(input) {
    const parsed = (0, identity_1.parseDeviceId)(input.rawId);
    if (parsed === undefined) {
        input.problems.push(`${input.label}: no usable id`);
        return undefined;
    }
    const id = (0, identity_1.makeDeviceId)(parsed.mac, parsed.channel);
    if (input.rawChannel !== undefined) {
        const configured = validateChannel(input.rawChannel, input.label, input.warnings);
        if (configured !== parsed.channel) {
            input.warnings.push(`${input.label} channel ${forLog(input.rawChannel)} does not match id ${forLog(id)}; `
                + `using channel ${parsed.channel} from the id`);
        }
    }
    return { id, channel: parsed.channel };
}
function validateDevice(input) {
    const { entry, index, warnings } = input;
    const label = `devices[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
        warnings.push(`${label} is not an object; skipping it`);
        return undefined;
    }
    const device = entry;
    const problems = [];
    const name = validateName(device.name, label, problems);
    const identity = resolveDeviceIdentity({
        rawId: device.id,
        rawChannel: device.channel,
        label,
        problems,
        warnings,
    });
    if (name === undefined || identity === undefined || problems.length > 0) {
        warnings.push(`${problems.join('; ')}; skipping ${name === undefined ? label : forLog(name)}`);
        return undefined;
    }
    return {
        id: identity.id,
        name,
        channel: identity.channel,
        // Hot water is the reason most people install this, so it is the one
        // accessory that is on unless it is turned off. Everything else is opt-in,
        // including space heating: a plugin that invents a heating thermostat
        // nobody asked for is a plugin that can be told to stop heating a house.
        dhw: device.dhw !== false,
        heating: device.heating === true,
        power: device.power === true,
        recirculation: device.recirculation === true,
        fault: device.fault === true,
        temperatureSensors: device.temperatureSensors === true,
        outdoorSensor: device.outdoorSensor === true,
    };
}
/**
 * Validate a platform configuration block.
 *
 * Never throws: the platform needs the errors and warnings in order to report
 * them, and a configuration problem should produce a diagnosable log rather
 * than an exception during Homebridge startup.
 */
function validateConfig(config) {
    const errors = [];
    const warnings = [];
    const defaults = {
        statusIntervalSec: settings_1.DEFAULT_STATUS_INTERVAL_SEC,
        allowPowerOff: false,
        readOnly: false,
        diagnosticsInterval: 0,
        structuredLogs: false,
        accessoryPrefix: '',
    };
    if (typeof config !== 'object' || config === null) {
        return { errors: ['platform configuration is missing'], warnings, account: undefined, devices: [], options: defaults };
    }
    const platform = config;
    const account = validateAccount(platform, errors, warnings);
    const options = {
        statusIntervalSec: resolveStatusIntervalSec(platform.options?.statusIntervalSec, warnings),
        allowPowerOff: platform.options?.allowPowerOff === true,
        readOnly: platform.options?.readOnly === true,
        diagnosticsInterval: resolveDiagnosticsIntervalSec(platform.options?.diagnosticsInterval, warnings),
        structuredLogs: platform.options?.structuredLogs === true,
        accessoryPrefix: resolveAccessoryPrefix(platform.options?.accessoryPrefix, warnings),
    };
    const rawDevices = platform.devices;
    if (rawDevices === undefined) {
        errors.push('no devices list');
        return { errors, warnings, account, devices: [], options };
    }
    if (!Array.isArray(rawDevices)) {
        errors.push('devices must be a list');
        return { errors, warnings, account, devices: [], options };
    }
    const devices = [];
    const seenIds = new Set();
    rawDevices.forEach((entry, index) => {
        const device = validateDevice({ entry, index, warnings });
        if (device === undefined) {
            return;
        }
        if (seenIds.has(device.id)) {
            warnings.push(`devices[${index}] repeats id ${forLog(device.id)}; skipping the duplicate`);
            return;
        }
        seenIds.add(device.id);
        devices.push(device);
    });
    if (rawDevices.length > 0 && devices.length === 0) {
        // Every entry was rejected. The user plainly meant to configure something,
        // so this is fatal rather than an idle platform.
        errors.push(`all ${rawDevices.length} device(s) rejected`);
    }
    else if (rawDevices.length === 0) {
        // An empty list with a valid account used to start a session and then
        // unregister every cached tile. Fatal keeps the rooms.
        errors.push('no devices configured');
    }
    if (options.readOnly && devices.length > 0) {
        warnings.push('readOnly: writes disabled');
    }
    return { errors, warnings, account, devices, options };
}
/**
 * Expand validated devices into the accessories to expose.
 *
 * Names are derived here rather than at use time so that duplicates can be
 * detected once: two accessories sharing a name still work, but they make Siri
 * ambiguous, which is worth a warning.
 *
 * When `accessoryPrefix` is set it replaces the appliance name as the stem
 * (`Zone One Hot Water`). Two appliances on one prefix keep the appliance
 * name after it so the tiles stay distinct.
 *
 * The probe accessories are created unconditionally when `temperatureSensors`
 * is on, rather than only for the probes the appliance turns out to report.
 * Whether a probe exists is only knowable from a live status frame, which
 * arrives after accessories are registered, and creating them later would mean
 * an accessory appearing minutes into a session. Each one disables itself on
 * the first observation that shows nothing behind it.
 */
function resolveAccessories(devices, warnings, accessoryPrefix = '') {
    const accessories = [];
    const nameOf = (device, suffix) => (suffixName(stemFor(device, accessoryPrefix, devices.length), suffix));
    for (const device of devices) {
        if (device.dhw) {
            accessories.push({ kind: 'dhw', deviceId: device.id, name: nameOf(device, 'Hot Water') });
        }
        if (device.heating) {
            accessories.push({ kind: 'heating', deviceId: device.id, name: nameOf(device, 'Heating') });
        }
        if (device.power) {
            accessories.push({ kind: 'power', deviceId: device.id, name: nameOf(device, 'Power') });
        }
        if (device.recirculation) {
            accessories.push({
                kind: 'recirculation',
                deviceId: device.id,
                name: nameOf(device, 'Recirculation'),
            });
        }
        if (device.fault) {
            accessories.push({ kind: 'fault', deviceId: device.id, name: nameOf(device, 'Fault') });
        }
        if (device.temperatureSensors) {
            accessories.push({ kind: 'dhwOutlet', deviceId: device.id, name: nameOf(device, 'Hot Water Out') }, { kind: 'dhwInlet', deviceId: device.id, name: nameOf(device, 'Hot Water In') }, { kind: 'heatSupply', deviceId: device.id, name: nameOf(device, 'Heating Flow') }, { kind: 'heatReturn', deviceId: device.id, name: nameOf(device, 'Heating Return') });
        }
        if (device.outdoorSensor) {
            accessories.push({ kind: 'outdoor', deviceId: device.id, name: nameOf(device, 'Outdoor') });
        }
    }
    const names = new Map();
    for (const accessory of accessories) {
        names.set(accessory.name, (names.get(accessory.name) ?? 0) + 1);
    }
    for (const [name, count] of names) {
        if (count > 1) {
            warnings?.push(`duplicate name: ${forLog(name)} (${count})`);
        }
    }
    return accessories;
}
/** Stem HomeKit names from the prefix, or from the appliance when none is set. */
function stemFor(device, prefix, deviceCount) {
    if (prefix.length === 0) {
        return device.name;
    }
    // Two appliances sharing one prefix would otherwise both be "Prefix Hot Water".
    return deviceCount > 1 ? `${prefix} ${device.name}` : prefix;
}
/** Append a suffix to a device name without exceeding HomeKit's name budget. */
function suffixName(name, suffix) {
    const combined = `${name} ${suffix}`;
    if (combined.length <= settings_1.MAX_NAME_LENGTH) {
        return combined;
    }
    return `${name.slice(0, settings_1.MAX_NAME_LENGTH - suffix.length - 2)}\u2026 ${suffix}`;
}
