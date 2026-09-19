/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The appliance's power switch.
 *
 * Deliberately a separate, opt-in accessory rather than something folded into
 * a thermostat. Powering a combi appliance down stops the hot water *and* the
 * central heating, so it deserves a tile that says what it is instead of
 * hiding behind "off" on a tile labelled Hot Water.
 *
 * Turning it off still requires `options.allowPowerOff`. Asking for the switch
 * is asking to see the state and to be able to switch the appliance back on;
 * it is not, on its own, a decision that a scene should be able to shut the
 * heating down. The two are separated because one of them is recoverable from
 * a phone and the other is recoverable from a cold house.
 */
import type { ChannelObservation, RefreshReason } from '../types';
import { BaseAccessory } from './base-accessory';
import type { AccessoryInit } from './host';
/** Appliance power, as a HomeKit switch. */
export declare class PowerAccessory extends BaseAccessory {
    private readonly service;
    private hasExplainedGuard;
    constructor(init: AccessoryInit);
    private writeOn;
    protected updateFromObservation(observation: ChannelObservation, _reason: RefreshReason): void;
    private restore;
    private explainGuard;
}
