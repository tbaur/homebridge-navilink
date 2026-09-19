"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Turning NaviLink status frames into observations.
 *
 * Two frame types carry everything the plugin knows. `channelinfo` is the
 * appliance's description of itself: what family it is, which scale it
 * speaks, what the installer set the setpoint limits to, whether a
 * recirculation pump is fitted. It changes only at commissioning.
 * `channelstatus` is what it is doing now, and arrives continuously.
 *
 * They must be combined, not read separately: a setpoint from `channelstatus`
 * is meaningless without the `temperatureType` from `channelinfo`, because the
 * same integer is 47.5 °C on one appliance and 95 °F on another.
 *
 * Every field name here was read off a live NCB-240E. Where a field's meaning
 * is inferred rather than observed, it says so, and the plugin does not make a
 * decision on it. Where the appliance contradicts the obvious reading of a
 * field, the contradiction is recorded, not resolved. See
 * {@link hasDomesticHotWater} for `DHWUse`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFlagOn = isFlagOn;
exports.parseChannelInfo = parseChannelInfo;
exports.parseChannelStatus = parseChannelStatus;
exports.scaleOf = scaleOf;
exports.familyOf = familyOf;
exports.formatFamily = formatFamily;
exports.hasDomesticHotWater = hasDomesticHotWater;
exports.hasSpaceHeating = hasSpaceHeating;
exports.hasUsableHeatingLoop = hasUsableHeatingLoop;
exports.decodeChannel = decodeChannel;
const settings_1 = require("../settings");
const temperature_1 = require("../utils/temperature");
/**
 * `unitType` to family.
 *
 * The same table the NaviLink app uses. `CAS_` is a
 * cascade: several appliances presented as one channel.
 */
const FAMILY_BY_UNIT_TYPE = {
    1: 'NPE',
    2: 'NCB',
    3: 'NHB',
    4: 'CAS_NPE',
    5: 'CAS_NHB',
    6: 'NFB',
    7: 'CAS_NFB',
    8: 'NFC',
    9: 'NPN',
    10: 'CAS_NPN',
    11: 'NPE2',
    12: 'CAS_NPE2',
    13: 'NCB_H',
    14: 'NVW',
    15: 'CAS_NVW',
};
/** Families that heat domestic hot water. */
const DHW_FAMILIES = new Set([
    'NPE', 'NPN', 'NPE2', 'NCB', 'NFC', 'NCB_H', 'NFB', 'NVW',
    'CAS_NPE', 'CAS_NPN', 'CAS_NPE2', 'CAS_NFB', 'CAS_NVW',
]);
/** Families that heat a space-heating loop. */
const SPACE_HEAT_FAMILIES = new Set([
    'NHB', 'CAS_NHB', 'NFB', 'CAS_NFB', 'NCB', 'NFC', 'NCB_H',
]);
/**
 * The value meaning "on" or "fitted" in the appliance's flag fields.
 *
 * Confirmed across several unrelated fields on one appliance: `heatControl`,
 * `powerStatus` and `heatStatus` all read `1` while the appliance was on and
 * heating, and `wwsd`, `commercialLock`, `weeklyControl`, `onDemandUse` and
 * `recirculationUse` all read `2` on an installation where none of those
 * features is fitted or enabled. So `1` is on, `2` is off.
 */
const FLAG_ON = 1;
/** True for a flag field the appliance set to its "on" value. */
function isFlagOn(value) {
    return value === FLAG_ON;
}
/**
 * True for a probe reading the appliance is not actually making.
 *
 * Exactly zero is how this firmware reports "no probe fitted": the NCB-240E
 * measured here has no outdoor sensor and sends `outdoorTemperature: 0`, and
 * sends `0` for the recirculation probe it also does not have, while sending
 * real values for the four probes it does have.
 *
 * This does mean a genuine reading of exactly 0 °F or 0 °C is discarded. That
 * is the right trade: these are probes inside a boiler and on its flow and
 * return, so zero is not an operating value, and the alternative is
 * publishing -17.8 °C to HomeKit for a sensor that does not exist. That
 * looks like a fault, and an automation could act on it.
 */
function isAbsentProbe(raw) {
    return raw === 0;
}
/** Read the channel descriptions out of a `channelinfo` frame. */
function parseChannelInfo(frame) {
    const list = asRecord(asRecord(asRecord(frame)?.response)?.channelInfo)?.channelList;
    if (!Array.isArray(list)) {
        return [];
    }
    const found = new Map();
    for (const entry of list) {
        const wrapper = asRecord(entry);
        const channel = asRecord(wrapper?.channel) ?? wrapper;
        if (channel === undefined) {
            continue;
        }
        const channelNumber = readInteger(wrapper?.channelNumber ?? channel.channelNumber);
        if (channelNumber === undefined) {
            continue;
        }
        // A Map rather than an array: a gateway can repeat a channel across
        // frames, and two entries for one channel would produce two accessories.
        found.set(channelNumber, { channelNumber, raw: channel });
    }
    return [...found.values()];
}
/** Read the channel state out of a `channelstatus` frame. */
function parseChannelStatus(frame) {
    const wrapper = asRecord(asRecord(asRecord(frame)?.response)?.channelStatus);
    if (wrapper === undefined) {
        return undefined;
    }
    const channel = asRecord(wrapper.channel) ?? wrapper;
    const channelNumber = readInteger(wrapper.channelNumber);
    if (channelNumber === undefined) {
        return undefined;
    }
    return {
        channelNumber,
        raw: channel,
    };
}
/** The scale an appliance speaks, from its `channelinfo`. */
function scaleOf(info) {
    return (0, temperature_1.scaleFromTemperatureType)(info.raw.temperatureType);
}
/** The family an appliance belongs to, from either frame. */
function familyOf(raw) {
    const unitType = readInteger(raw.unitType);
    return (unitType === undefined ? undefined : FAMILY_BY_UNIT_TYPE[unitType]) ?? 'UNKNOWN';
}
/**
 * Spell a family the way HomeKit and the settings page show it.
 *
 * Underscores become hyphens so `NCB_H` is `NCB-H` in both places.
 */
function formatFamily(family) {
    return family.replaceAll('_', '-');
}
/**
 * True when this family heats domestic hot water.
 *
 * Decided from the family table, not from `DHWUse`. The verified NCB-240E
 * reports `DHWUse: 2` while it is a working combi with a usable DHW setpoint
 * range. Reading that flag as "DHW absent" would hide the accessory this
 * plugin exists to offer. Family membership is the only signal that has
 * matched the hardware so far.
 */
function hasDomesticHotWater(family) {
    return DHW_FAMILIES.has(family);
}
/** True when this family heats a space-heating loop. */
function hasSpaceHeating(family) {
    return SPACE_HEAT_FAMILIES.has(family);
}
/**
 * True when this particular appliance has a space-heating loop worth
 * exposing.
 *
 * The family is necessary but not sufficient. A tankless water heater answers
 * exactly the same frames as a combi and fills the heating fields with
 * placeholders rather than omitting them: an NPE-2 has been observed
 * reporting `setupHeatTempMin` and `setupHeatTempMax` both as 32, which is
 * not a one-degree range, it is "there is nothing here".
 *
 * So three things have to agree. The family must be one that can heat a
 * loop, the commissioning flag must say heating is configured, and the
 * installer's bounds must describe a real range. Any one of them alone would
 * put a heating thermostat on a water heater.
 */
function hasUsableHeatingLoop(description) {
    if (!hasSpaceHeating(familyOf(description))) {
        return false;
    }
    if (!isFlagOn(description.heatControl)) {
        return false;
    }
    const min = readInteger(description.setupHeatTempMin);
    const max = readInteger(description.setupHeatTempMax);
    return min !== undefined && max !== undefined && max > min;
}
/**
 * Combine a description and a state into one observation.
 *
 * Returns undefined when the pair cannot be read as a coherent appliance,
 * which in practice means `channelinfo` has not arrived yet or reported
 * `temperatureType: 0`. Every temperature in a status frame is unreadable
 * without the scale, so producing a partial observation would mean publishing
 * numbers that are wrong by a factor of two.
 */
function decodeChannel(input) {
    const { info, status, now = Date.now() } = input;
    const scale = scaleOf(info);
    if (scale === undefined) {
        return undefined;
    }
    const description = info.raw;
    const state = status.raw;
    const unit = firstUnitStatus(state);
    const faulted = firstFaultedUnit(state);
    const temperature = (raw) => ((0, temperature_1.decodeWireTemperature)(raw, scale));
    const probe = (raw) => (isAbsentProbe(raw) ? undefined : (0, temperature_1.decodeWireTemperature)(raw, scale));
    const observation = {
        channelNumber: status.channelNumber,
        family: familyOf(description),
        scale,
        unitCount: clampUnitCount(readInteger(description.unitCount) ?? readInteger(state.unitCount)),
        power: isFlagOn(state.powerStatus),
        heating: isFlagOn(state.heatStatus),
        // The enable flag, not the burner. No field in this frame distinguishes
        // "heating is switched on" from "the burner is firing right now":
        // `operationMode` read 0 on an appliance that was on and warm, so
        // nothing is decided on it. HomeKit is
        // therefore told the appliance is heating whenever heating is enabled,
        // which is the honest reading of what we can see.
        heatingActive: isFlagOn(state.heatStatus),
        heatingSupported: hasUsableHeatingLoop(description),
        recirculationEquipped: isFlagOn(description.onDemandUse)
            || isFlagOn(description.recirculationUse),
        recirculationOn: isFlagOn(state.onDemandUseFlag),
        readings: readUnitReadings(unit, faulted),
        observedAt: now,
    };
    assignDefined(observation, {
        dhwSetpoint: temperature(state.DHWSettingTemp),
        dhwMin: temperature(description.setupDHWTempMin),
        dhwMax: temperature(description.setupDHWTempMax),
        heatSetpoint: temperature(state.heatSettingTemp),
        heatMin: temperature(description.setupHeatTempMin),
        heatMax: temperature(description.setupHeatTempMax),
        // The averages rather than the per-unit readings. On a single appliance
        // they are the same number; on a cascade the average is the one that
        // describes what the installation is doing, which is what a tile should
        // show.
        dhwOutlet: probe(state.avgOutletTemp ?? unit?.currentOutletTemp),
        dhwInlet: probe(state.avgInletTemp ?? unit?.currentInletTemp),
        heatSupply: probe(state.avgSupplyTemp ?? unit?.currentSupplyTemp),
        heatReturn: probe(state.avgReturnTemp ?? unit?.currentReturnTemp),
        outdoor: probe(state.outdoorTemperature),
    });
    return observation;
}
/** Every unit status the frame named, skipping entries that are not objects. */
function unitStatusList(state) {
    const list = asRecord(state.unitInfo)?.unitStatusList;
    if (!Array.isArray(list)) {
        return [];
    }
    return list.flatMap((entry) => {
        const record = asRecord(entry);
        return record === undefined ? [] : [record];
    });
}
/**
 * The first unit's non-fault readings.
 *
 * A cascade reports one entry per appliance. Controller firmware is taken
 * from the first unit; the error code is taken from the first unit that is
 * actually faulted, so a later burner opening a lockout still opens the
 * contact sensor.
 */
function firstUnitStatus(state) {
    return unitStatusList(state)[0];
}
/** The first unit reporting a non-zero error, or the first unit if none is. */
function firstFaultedUnit(state) {
    const units = unitStatusList(state);
    return units.find((unit) => (readInteger(unit.errorCode) ?? 0) !== 0) ?? units[0];
}
function readUnitReadings(unit, faulted = unit) {
    const readings = {
        errorCode: readInteger(faulted?.errorCode) ?? 0,
        subErrorCode: readInteger(faulted?.subErrorCode) ?? 0,
    };
    const controllerVersion = readInteger(unit?.controllerVersion);
    if (controllerVersion !== undefined) {
        readings.controllerVersion = controllerVersion;
    }
    return readings;
}
/**
 * Bound the reported unit count.
 *
 * It decides how many units a status request asks for, so a malformed or
 * hostile frame must not be able to turn one request into an enormous one.
 */
function clampUnitCount(value) {
    if (value === undefined || value < 1) {
        return 1;
    }
    return Math.min(value, settings_1.MAX_UNITS);
}
/**
 * Copy only the defined entries.
 *
 * `exactOptionalPropertyTypes` is not on, but the distinction still matters at
 * runtime: an explicit `dhwSetpoint: undefined` and an absent `dhwSetpoint`
 * behave identically to a reader using `?.`, and differently to one using
 * `in`. Assigning only what is present keeps the observation honest about
 * what the appliance actually reported.
 */
function assignDefined(target, values) {
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) {
            target[key] = value;
        }
    }
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function readInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}
