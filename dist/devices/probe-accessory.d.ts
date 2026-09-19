/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One of the appliance's temperature probes, as a HomeKit sensor.
 *
 * Five of them share this implementation, differing only in which field they
 * read: the hot water inlet and outlet, the heating flow and return, and the
 * outdoor sensor where one is fitted. They are read-only, and useful mainly
 * for graphs and for automations that want to know whether the appliance is
 * doing anything.
 *
 * The flow and return pair is the interesting one. The difference between them
 * is what the appliance is putting into the house, so a HomeKit automation can
 * notice heating running when nobody asked it to.
 *
 * ## Probes that are not fitted
 *
 * Whether a probe exists is only knowable from a live status frame, and the
 * frames arrive after accessories are registered. So a sensor can be created
 * for something that does not exist. When that turns out to be the case it
 * says so once and reports No Response. It does not publish the zero the
 * appliance sends for an absent probe, which would be -17.8 °C on the tile
 * and could be acted on by an automation.
 */
import type { ChannelObservation, ProbeKind, RefreshReason } from '../types';
import { BaseAccessory } from './base-accessory';
import type { AccessoryInit } from './host';
/** What an appliance probe is created with. */
export interface ProbeAccessoryInit extends AccessoryInit {
    kind: ProbeKind;
}
/** One appliance temperature probe, as a HomeKit sensor. */
export declare class ProbeAccessory extends BaseAccessory {
    private readonly service;
    private readonly kind;
    private hasWarnedAbsent;
    constructor(init: ProbeAccessoryInit);
    private readNative;
    private readCelsius;
    protected updateFromObservation(observation: ChannelObservation, _reason: RefreshReason): void;
    private warnAbsent;
}
