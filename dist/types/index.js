"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared types for configuration, accessory identity and the
 * observations read back from an appliance.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.APPLIANCE_FAMILIES = exports.PROBE_KINDS = exports.ACCESSORY_KINDS = void 0;
exports.isAccessoryKind = isAccessoryKind;
exports.isProbeKind = isProbeKind;
/**
 * What an accessory does. Part of its identity, and therefore of its UUID.
 *
 * `dhw` and `heating` are the two thermostats, which are the point of the
 * plugin. `power` is the appliance's own power state. `recirculation` triggers
 * the on-demand hot-water pump on units that have one. `fault` is a contact
 * sensor that opens on an error code. The rest are read-only temperature
 * probes, each of which exists only when the appliance actually reports it.
 */
exports.ACCESSORY_KINDS = [
    'dhw',
    'heating',
    'power',
    'recirculation',
    'fault',
    'outdoor',
    'dhwOutlet',
    'dhwInlet',
    'heatSupply',
    'heatReturn',
];
/** Narrow an unknown value to an {@link AccessoryKind}. */
function isAccessoryKind(value) {
    return typeof value === 'string' && exports.ACCESSORY_KINDS.includes(value);
}
/** The temperature probes, which share one accessory implementation. */
exports.PROBE_KINDS = ['outdoor', 'dhwOutlet', 'dhwInlet', 'heatSupply', 'heatReturn'];
/** Narrow an {@link AccessoryKind} to one of the temperature probes. */
function isProbeKind(value) {
    return exports.PROBE_KINDS.includes(value);
}
/**
 * The appliance family, as `unitType` reports it.
 *
 * Decoded from the same table the NaviLink app uses.
 * It decides which capabilities are even plausible: an NPE is a tankless water
 * heater with no space heating at all, while an NCB is a combi that has both.
 * Kept as a named value rather than a number so that a log line and a
 * capability check both read as the family rather than as `2`.
 */
exports.APPLIANCE_FAMILIES = [
    'NPE', 'NCB', 'NHB', 'CAS_NPE', 'CAS_NHB', 'NFB', 'CAS_NFB', 'NFC',
    'NPN', 'CAS_NPN', 'NPE2', 'CAS_NPE2', 'NCB_H', 'NVW', 'CAS_NVW', 'UNKNOWN',
];
