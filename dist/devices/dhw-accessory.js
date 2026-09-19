"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomesticHotWaterAccessory = void 0;
const utils_1 = require("../utils");
const thermostat_accessory_1 = require("./thermostat-accessory");
/** Hot water temperature, as a HomeKit thermostat. */
class DomesticHotWaterAccessory extends thermostat_accessory_1.ThermostatAccessory {
    /** Said once per session rather than once per press. */
    hasExplainedPowerGuard = false;
    constructor(init) {
        super(init);
    }
    readSetpoint(observation) {
        return observation.dhwSetpoint;
    }
    /**
     * The outlet probe: the water actually leaving the appliance.
     *
     * Not the setpoint, and not the inlet. Between draws this reads well below
     * the setpoint, which is correct and occasionally surprising. The
     * appliance is not keeping a tank hot, it heats on demand. Reporting the
     * setpoint here instead would make the tile look tidy and mean nothing.
     */
    readTemperature(observation) {
        return observation.dhwOutlet;
    }
    readLimits(observation) {
        const { dhwMin, dhwMax } = observation;
        return dhwMin === undefined || dhwMax === undefined ? undefined : { min: dhwMin, max: dhwMax };
    }
    /**
     * Hot water is available whenever the appliance is on.
     *
     * There is no per-demand enable for hot water on the families this plugin
     * supports, so the honest answer is that it is on when the appliance is on.
     * The base class already requires `power`, so this is unconditional rather
     * than reading a flag that does not exist.
     */
    readEnabled(_observation) {
        return true;
    }
    async sendSetpoint(native) {
        await this.host.control(this.deviceId).setDomesticHotWaterSetpoint(native);
    }
    async sendEnabled(on) {
        try {
            await this.host.control(this.deviceId).setPower(on);
            return true;
        }
        catch (error) {
            if (error instanceof utils_1.ControlRejectedError) {
                this.explainPowerGuard(error);
                return false;
            }
            this.host.log.warn(`${(0, utils_1.forLog)(this.displayName)}: could not change the power state: ${(0, utils_1.describeError)(error)}`);
            return false;
        }
    }
    optimisticSetpointPatch(native) {
        return { dhwSetpoint: native };
    }
    explainPowerGuard(error) {
        if (this.hasExplainedPowerGuard) {
            this.host.log.debug(`${(0, utils_1.forLog)(this.displayName)}: ${error.message}`);
            return;
        }
        this.hasExplainedPowerGuard = true;
        this.host.log.info(`${(0, utils_1.forLog)(this.displayName)}: ${error.message}`);
    }
}
exports.DomesticHotWaterAccessory = DomesticHotWaterAccessory;
