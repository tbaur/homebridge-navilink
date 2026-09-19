/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The space-heating thermostat.
 *
 * ## This is a boiler control, not a room thermostat
 *
 * The number on this tile is the temperature of the **water** the appliance
 * sends to the radiators or the underfloor loop, not the temperature of a
 * room. Setting it to 60 °C does not make the house 60 °C; it makes the flow
 * hotter, so the house reaches whatever the room thermostat is asking for
 * sooner and less efficiently.
 *
 * HomeKit has no accessory type for "boiler flow temperature", and a
 * Thermostat is the closest thing it offers. Anyone building an automation on
 * this tile should know which quantity they are automating, which is why the
 * README says so and why this accessory is opt-in rather than created by
 * default.
 *
 * ## Off means off
 *
 * Unlike the hot water tile, this one's off is wired to the appliance's
 * space-heating enable, which is exactly the thing being asked about. Turning
 * it off stops the radiators and leaves the hot water alone, so there is no
 * reason to hesitate over it.
 */
import type { ChannelObservation, RefreshReason } from '../types';
import { ThermostatAccessory, type SetpointLimits } from './thermostat-accessory';
/** Space-heating flow temperature, as a HomeKit thermostat. */
export declare class SpaceHeatingAccessory extends ThermostatAccessory {
    private hasWarnedNoLoop;
    protected readSetpoint(observation: ChannelObservation): number | undefined;
    /**
     * Say once when this appliance turns out to have no heating loop.
     *
     * Only knowable from a live `channelinfo` frame, which arrives after the
     * accessory is registered, so it can be configured on hardware that cannot
     * do it.
     */
    protected updateFromObservation(observation: ChannelObservation, reason: RefreshReason): void;
    private warnNoLoop;
    /** The flow probe: the water going out to the loop. */
    protected readTemperature(observation: ChannelObservation): number | undefined;
    protected readLimits(observation: ChannelObservation): SetpointLimits | undefined;
    protected readEnabled(observation: ChannelObservation): boolean;
    protected isCommandable(observation: ChannelObservation): boolean;
    protected sendSetpoint(native: number): Promise<void>;
    protected sendEnabled(on: boolean): Promise<boolean>;
    /**
     * True when this appliance has a loop worth commanding.
     *
     * Reads and writes both go through this: a water heater answers the same
     * frames as a combi and fills the heating fields with placeholders, so a
     * HomeKit write that reached the cloud would be a command to hardware that
     * has no radiators attached to it.
     */
    private hasHeatingLoop;
    private requireHeatingLoop;
    protected optimisticSetpointPatch(native: number): Partial<ChannelObservation>;
}
