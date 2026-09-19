/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The domestic hot water thermostat.
 *
 * The accessory most people install this plugin for: the temperature of the
 * water at the taps, as a tile, a scene value and a Siri phrase.
 *
 * ## Why "off" does not normally turn anything off
 *
 * A combi appliance has no separate switch for hot water. There is one power
 * state, and it governs the space-heating loop as well. So the only thing
 * `TargetHeatingCoolingState.OFF` could be wired to is the appliance's power,
 * and that makes "Hey Siri, turn off the hot water", or a bedtime scene that
 * sweeps every switch off, or a HomeKit "turn everything off", into a command
 * that also stops the central heating. In a house that is empty in February,
 * that is a burst pipe.
 *
 * So by default this tile declines an off. It says why, once, and springs
 * back. Someone who genuinely wants HomeKit to be able to shut the appliance
 * down turns on `options.allowPowerOff`, and at that point off means off.
 *
 * This is a departure from the usual rule that an accessory does what HomeKit
 * asks. It is made deliberately and in one direction only: the plugin will
 * always heat when asked, and hesitates only about stopping.
 */
import type { ChannelObservation } from '../types';
import type { AccessoryInit } from './host';
import { ThermostatAccessory, type SetpointLimits } from './thermostat-accessory';
/** Hot water temperature, as a HomeKit thermostat. */
export declare class DomesticHotWaterAccessory extends ThermostatAccessory {
    /** Said once per session rather than once per press. */
    private hasExplainedPowerGuard;
    constructor(init: AccessoryInit);
    protected readSetpoint(observation: ChannelObservation): number | undefined;
    /**
     * The outlet probe: the water actually leaving the appliance.
     *
     * Not the setpoint, and not the inlet. Between draws this reads well below
     * the setpoint, which is correct and occasionally surprising. The
     * appliance is not keeping a tank hot, it heats on demand. Reporting the
     * setpoint here instead would make the tile look tidy and mean nothing.
     */
    protected readTemperature(observation: ChannelObservation): number | undefined;
    protected readLimits(observation: ChannelObservation): SetpointLimits | undefined;
    /**
     * Hot water is available whenever the appliance is on.
     *
     * There is no per-demand enable for hot water on the families this plugin
     * supports, so the honest answer is that it is on when the appliance is on.
     * The base class already requires `power`, so this is unconditional rather
     * than reading a flag that does not exist.
     */
    protected readEnabled(_observation: ChannelObservation): boolean;
    protected sendSetpoint(native: number): Promise<void>;
    protected sendEnabled(on: boolean): Promise<boolean>;
    protected optimisticSetpointPatch(native: number): Partial<ChannelObservation>;
    private explainPowerGuard;
}
