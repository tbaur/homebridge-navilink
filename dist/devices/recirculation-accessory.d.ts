/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The hot water recirculation switch.
 *
 * On an installation with a recirculation pump (Navien's "HotButton" or
 * on-demand feature) this starts it, so the water at a distant tap is hot by
 * the time someone gets there. It is the one accessory here with an obvious
 * and genuinely useful Siri phrase: "turn on the hot water" before walking to
 * the shower.
 *
 * ## It switches itself off, and that is correct
 *
 * The appliance runs the pump for a fixed period and then stops. The tile
 * follows, because it reports what the appliance says, not what was asked
 * for. A user who has not met this feature before will read the tile
 * turning itself off as a bug, which is why the README explains it.
 *
 * ## It disables itself on hardware that has no pump
 *
 * Whether a pump is fitted is only knowable from a live `channelinfo` frame,
 * which arrives after accessories are registered. So the accessory can be
 * configured on an appliance that cannot do it, and when that turns out to be
 * the case it says so once and reports No Response from then on. Silently
 * accepting presses that do nothing would be worse.
 */
import type { ChannelObservation, RefreshReason } from '../types';
import { BaseAccessory } from './base-accessory';
import type { AccessoryInit } from './host';
/** Hot water recirculation, as a HomeKit switch. */
export declare class RecirculationAccessory extends BaseAccessory {
    private readonly service;
    /** Undefined until the first frame says whether a pump is fitted. */
    private isEquipped;
    private hasWarnedNotEquipped;
    constructor(init: AccessoryInit);
    private readOn;
    private writeOn;
    protected updateFromObservation(observation: ChannelObservation, _reason: RefreshReason): void;
    /** Fitted state from a live frame, or from the last observation if none yet. */
    private equippedState;
    private restore;
    private warnNotEquipped;
}
