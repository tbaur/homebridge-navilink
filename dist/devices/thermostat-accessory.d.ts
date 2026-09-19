/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The shared behaviour of both thermostats.
 *
 * A combi appliance has two independent heat demands, domestic hot water and
 * the space-heating loop, with their own setpoints, their own installer
 * limits and their own probes. They are two HomeKit thermostats, not one with
 * modes, because they are two things a person thinks about separately:
 * "make the taps hotter" and "make the radiators hotter" are not two
 * positions of the same dial.
 *
 * Everything that differs between them is a hook. Everything that is the same,
 * and that is most of it, is here.
 *
 * ## Why these thermostats are heat-only
 *
 * `TargetHeatingCoolingState` is published with just `OFF` and `HEAT` as valid
 * values. Nothing here can cool, and offering `COOL` or `AUTO` would let a
 * scene or a Siri phrase put the tile into a state the appliance cannot enter,
 * which HomeKit would then show as the current state until the next frame
 * contradicted it.
 *
 * ## The Celsius problem
 *
 * HAP is Celsius. A North American appliance's setpoint grid is whole degrees
 * Fahrenheit, and no Celsius step lands on it. Rather than advertise a step
 * the appliance cannot hit, the range is published in Celsius with a half-
 * degree step anchored at the true minimum, which puts HomeKit's steps within
 * a tenth of a degree of the appliance's own. A write is then snapped to the
 * real grid and the appliance's answer is what gets reported back. See
 * `utils/temperature.ts`.
 *
 * ## Why a write is delayed
 *
 * Dragging the dial in the Home app emits a write per step. Each one would be
 * a separate control command at a vendor's cloud, and the appliance would
 * chase every intermediate value on the way to the one the user meant. Writes
 * are therefore coalesced over a short window so the last one wins.
 */
import type { ChannelObservation, RefreshReason } from '../types';
import { BaseAccessory } from './base-accessory';
import type { AccessoryInit } from './host';
/** The installer-set bounds on a setpoint, in the appliance's native scale. */
export interface SetpointLimits {
    min: number;
    max: number;
}
/** Shared implementation of a heat-only HomeKit thermostat. */
export declare abstract class ThermostatAccessory extends BaseAccessory {
    private readonly service;
    /** The pending coalesced write, if the dial is still moving. */
    private pendingSetpointCelsius;
    private coalesceTimer;
    /** True from the start of a send until it settles, so a stale frame cannot undo it. */
    private writeInFlight;
    /**
     * What HomeKit was last told the target is.
     *
     * Held so a read during the coalescing window answers with what the user
     * just chose rather than with the value the appliance still has. Without it
     * the dial visibly springs back mid-drag.
     */
    private optimisticTargetCelsius;
    /** The bounds last published, so props are not rewritten on every frame. */
    private publishedLimits;
    constructor(init: AccessoryInit);
    stop(): void;
    /** The setpoint this thermostat governs, in the appliance's native scale. */
    protected abstract readSetpoint(observation: ChannelObservation): number | undefined;
    /** The temperature this thermostat reports as current, native scale. */
    protected abstract readTemperature(observation: ChannelObservation): number | undefined;
    /** The installer-set bounds on this setpoint, native scale. */
    protected abstract readLimits(observation: ChannelObservation): SetpointLimits | undefined;
    /** True when this demand is enabled on the appliance. */
    protected abstract readEnabled(observation: ChannelObservation): boolean;
    /** False when this accessory has no hardware behind it. */
    protected isCommandable(_observation: ChannelObservation): boolean;
    /** Ask the appliance for a new setpoint, in its native scale. */
    protected abstract sendSetpoint(native: number): Promise<void>;
    /**
     * Ask the appliance to enable or disable this demand.
     *
     * Returns false when the request was declined rather than sent, so the
     * caller can put the characteristic back where it was instead of leaving
     * HomeKit showing a state the appliance is not in.
     */
    protected abstract sendEnabled(on: boolean): Promise<boolean>;
    /** A patch describing a setpoint write, so the tile can adopt it at once. */
    protected abstract optimisticSetpointPatch(native: number): Partial<ChannelObservation>;
    private readCurrentState;
    private readTargetState;
    private readCurrentTemperature;
    private readTargetTemperature;
    private readDisplayUnits;
    /** Honour the last observed scale before the first frame arrives. */
    private applyStoredDisplayUnits;
    private writeTargetState;
    private writeTargetTemperature;
    /**
     * Send whatever the dial finished on.
     *
     * Deliberately not awaited by the HomeKit write: the coalescing window
     * already exceeds a comfortable share of HAP's budget, so the write answers
     * immediately and this runs behind it. A failure is logged and the tile is
     * corrected by the next observation.
     */
    private flushSetpoint;
    private restoreTargetState;
    private revertTargetTemperature;
    protected updateFromObservation(observation: ChannelObservation, reason: RefreshReason): void;
    /** True while a write is in flight, so a stale frame cannot undo it. */
    private isSettling;
    /**
     * Publish the appliance's own setpoint range to HomeKit.
     *
     * Only when it changes. `setProps` on a characteristic notifies every paired
     * controller, and doing it on every status frame would be a broadcast storm
     * for a value that changes at commissioning and never again.
     *
     * The half-degree step is anchored at the true minimum rather than rounded
     * to a tidy number, which is what keeps HomeKit's steps within a tenth of a
     * degree of the appliance's whole-Fahrenheit grid.
     */
    private publishLimits;
}
