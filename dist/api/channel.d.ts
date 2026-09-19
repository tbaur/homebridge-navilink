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
import type { ApplianceFamily, ChannelObservation } from '../types';
import { type TemperatureScale } from '../utils/temperature';
/** True for a flag field the appliance set to its "on" value. */
export declare function isFlagOn(value: unknown): boolean;
/** A `channelinfo` frame's per-channel description. */
export interface ChannelInfo {
    channelNumber: number;
    raw: Readonly<Record<string, unknown>>;
}
/** A `channelstatus` frame's per-channel state. */
export interface ChannelStatus {
    channelNumber: number;
    raw: Readonly<Record<string, unknown>>;
}
/** Read the channel descriptions out of a `channelinfo` frame. */
export declare function parseChannelInfo(frame: unknown): ChannelInfo[];
/** Read the channel state out of a `channelstatus` frame. */
export declare function parseChannelStatus(frame: unknown): ChannelStatus | undefined;
/** The scale an appliance speaks, from its `channelinfo`. */
export declare function scaleOf(info: ChannelInfo): TemperatureScale | undefined;
/** The family an appliance belongs to, from either frame. */
export declare function familyOf(raw: Readonly<Record<string, unknown>>): ApplianceFamily;
/**
 * Spell a family the way HomeKit and the settings page show it.
 *
 * Underscores become hyphens so `NCB_H` is `NCB-H` in both places.
 */
export declare function formatFamily(family: ApplianceFamily): string;
/**
 * True when this family heats domestic hot water.
 *
 * Decided from the family table, not from `DHWUse`. The verified NCB-240E
 * reports `DHWUse: 2` while it is a working combi with a usable DHW setpoint
 * range. Reading that flag as "DHW absent" would hide the accessory this
 * plugin exists to offer. Family membership is the only signal that has
 * matched the hardware so far.
 */
export declare function hasDomesticHotWater(family: ApplianceFamily): boolean;
/** True when this family heats a space-heating loop. */
export declare function hasSpaceHeating(family: ApplianceFamily): boolean;
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
export declare function hasUsableHeatingLoop(description: Readonly<Record<string, unknown>>): boolean;
/**
 * Combine a description and a state into one observation.
 *
 * Returns undefined when the pair cannot be read as a coherent appliance,
 * which in practice means `channelinfo` has not arrived yet or reported
 * `temperatureType: 0`. Every temperature in a status frame is unreadable
 * without the scale, so producing a partial observation would mean publishing
 * numbers that are wrong by a factor of two.
 */
export declare function decodeChannel(input: {
    info: ChannelInfo;
    status: ChannelStatus;
    now?: number;
}): ChannelObservation | undefined;
