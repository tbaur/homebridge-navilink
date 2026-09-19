"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Stable appliance identity.
 *
 * Accessory identity has to survive everything that legitimately changes about
 * an installation: a new router, a re-paired gateway, a firmware update, a
 * renamed device, a changed account email. What is left is the gateway's MAC
 * address and the channel the appliance sits on, so that is what identity is.
 *
 * The MAC never leaves this layer in the clear. It is the appliance's address
 * in every MQTT topic, so it is a capability as much as an identifier: it goes
 * into a device id and into topic construction, and everywhere else (logs,
 * HomeKit serial numbers, bug reports) it is masked.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeMac = normalizeMac;
exports.makeDeviceId = makeDeviceId;
exports.parseDeviceId = parseDeviceId;
exports.accessoryIdentityKey = accessoryIdentityKey;
exports.hasAccessoryIdentity = hasAccessoryIdentity;
const settings_1 = require("../settings");
/** Twelve hex digits, which is how the cloud spells a MAC. */
const BARE_MAC = /^[0-9a-f]{12}$/;
/**
 * Normalise a MAC to the cloud's own spelling: lower-case hex, no separators.
 *
 * Accepts the colon-separated form as well, because a hand-edited
 * configuration is likely to use it and rejecting that would be a puzzle
 * rather than a help. Returns undefined rather than guessing, so a caller can
 * skip the entry instead of building an unstable identity from a bad value.
 */
function normalizeMac(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const cleaned = value.trim().toLowerCase().replaceAll(/[:-]/g, '');
    return BARE_MAC.test(cleaned) ? cleaned : undefined;
}
/** Build a device id from a gateway MAC and a channel number. */
function makeDeviceId(mac, channel) {
    return `${mac.toLowerCase()}:${channel}`;
}
/** The MAC and channel inside a device id, or undefined when it is malformed. */
function parseDeviceId(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const separator = value.lastIndexOf(':');
    if (separator <= 0) {
        return undefined;
    }
    const mac = normalizeMac(value.slice(0, separator));
    const channel = Number(value.slice(separator + 1));
    if (mac === undefined || !Number.isInteger(channel)) {
        return undefined;
    }
    if (channel < settings_1.MIN_CHANNEL || channel > settings_1.MAX_CHANNEL) {
        return undefined;
    }
    return { mac, channel };
}
/**
 * The identity of an accessory: what it does, for which appliance.
 *
 * Two accessories with the same key are the same accessory, and one whose key
 * changes is a different accessory that takes the old one's rooms, scenes and
 * automations with it when the old one goes.
 */
function accessoryIdentityKey(accessory) {
    return `${accessory.deviceId}:${accessory.kind}`;
}
/** True when a cached context describes the same accessory as a resolved one. */
function hasAccessoryIdentity(context, accessory) {
    return context.kind === accessory.kind && context.deviceId === accessory.deviceId;
}
