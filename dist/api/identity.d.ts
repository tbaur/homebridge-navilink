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
import type { AccessoryKind, ResolvedAccessory } from '../types';
/**
 * Normalise a MAC to the cloud's own spelling: lower-case hex, no separators.
 *
 * Accepts the colon-separated form as well, because a hand-edited
 * configuration is likely to use it and rejecting that would be a puzzle
 * rather than a help. Returns undefined rather than guessing, so a caller can
 * skip the entry instead of building an unstable identity from a bad value.
 */
export declare function normalizeMac(value: unknown): string | undefined;
/** Build a device id from a gateway MAC and a channel number. */
export declare function makeDeviceId(mac: string, channel: number): string;
/** The MAC and channel inside a device id, or undefined when it is malformed. */
export declare function parseDeviceId(value: unknown): {
    mac: string;
    channel: number;
} | undefined;
/**
 * The identity of an accessory: what it does, for which appliance.
 *
 * Two accessories with the same key are the same accessory, and one whose key
 * changes is a different accessory that takes the old one's rooms, scenes and
 * automations with it when the old one goes.
 */
export declare function accessoryIdentityKey(accessory: {
    kind: AccessoryKind;
    deviceId: string;
}): string;
/** True when a cached context describes the same accessory as a resolved one. */
export declare function hasAccessoryIdentity(context: {
    kind?: unknown;
    deviceId?: unknown;
}, accessory: ResolvedAccessory): boolean;
