/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A contact sensor that opens when the appliance reports a fault.
 *
 * A contact sensor rather than anything cleverer, because HomeKit will send a
 * push notification when one opens and will trigger an automation from it.
 * That is the entire point: a combi appliance that has locked out in January
 * is worth knowing about before the shower is cold, and the NaviLink app's own
 * notifications are easy to miss.
 *
 * The error code is not published as a value. HomeKit has nowhere to show a
 * number. It is logged, with its sub-code, so the log says what to look
 * up in the manual, not only that something is wrong.
 */
import type { ChannelObservation, RefreshReason } from '../types';
import { BaseAccessory } from './base-accessory';
import type { AccessoryInit } from './host';
/** Appliance fault state, as a HomeKit contact sensor. */
export declare class FaultAccessory extends BaseAccessory {
    private readonly service;
    /** The code last logged, so a standing fault is reported once, not hourly. */
    private lastLoggedCode;
    constructor(init: AccessoryInit);
    private readState;
    protected updateFromObservation(observation: ChannelObservation, _reason: RefreshReason): void;
    private logCodeChange;
}
