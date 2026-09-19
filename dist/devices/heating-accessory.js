"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpaceHeatingAccessory = void 0;
const utils_1 = require("../utils");
const thermostat_accessory_1 = require("./thermostat-accessory");
/** Space-heating flow temperature, as a HomeKit thermostat. */
class SpaceHeatingAccessory extends thermostat_accessory_1.ThermostatAccessory {
    hasWarnedNoLoop = false;
    readSetpoint(observation) {
        // Nothing to report on an appliance with no loop. The fields are present
        // on a water heater too, filled with placeholders, so returning them
        // would put a working-looking thermostat on hardware that has no
        // radiators attached to it.
        return observation.heatingSupported ? observation.heatSetpoint : undefined;
    }
    /**
     * Say once when this appliance turns out to have no heating loop.
     *
     * Only knowable from a live `channelinfo` frame, which arrives after the
     * accessory is registered, so it can be configured on hardware that cannot
     * do it.
     */
    updateFromObservation(observation, reason) {
        if (!observation.heatingSupported) {
            this.warnNoLoop();
            this.markUnavailable();
            return;
        }
        super.updateFromObservation(observation, reason);
    }
    warnNoLoop() {
        if (this.hasWarnedNoLoop) {
            return;
        }
        this.hasWarnedNoLoop = true;
        this.host.log.warn(`${(0, utils_1.forLog)(this.displayName)}: this appliance reports no space-heating loop `
            + '(heatControl is off, or the installer setpoint range is empty). Turn the heating '
            + 'accessory off in the plugin settings.');
    }
    /** The flow probe: the water going out to the loop. */
    readTemperature(observation) {
        return observation.heatSupply;
    }
    readLimits(observation) {
        if (!observation.heatingSupported) {
            return undefined;
        }
        const { heatMin, heatMax } = observation;
        return heatMin === undefined || heatMax === undefined
            ? undefined
            : { min: heatMin, max: heatMax };
    }
    readEnabled(observation) {
        return observation.heatingSupported && observation.heating;
    }
    isCommandable(observation) {
        return observation.heatingSupported;
    }
    async sendSetpoint(native) {
        this.requireHeatingLoop();
        await this.host.control(this.deviceId).setHeatingSetpoint(native);
    }
    async sendEnabled(on) {
        if (!this.hasHeatingLoop()) {
            this.warnNoLoop();
            return false;
        }
        try {
            await this.host.control(this.deviceId).setHeating(on);
            return true;
        }
        catch (error) {
            this.host.log.warn(`${(0, utils_1.forLog)(this.displayName)}: could not ${on ? 'enable' : 'disable'} heating: `
                + (0, utils_1.describeError)(error));
            return false;
        }
    }
    /**
     * True when this appliance has a loop worth commanding.
     *
     * Reads and writes both go through this: a water heater answers the same
     * frames as a combi and fills the heating fields with placeholders, so a
     * HomeKit write that reached the cloud would be a command to hardware that
     * has no radiators attached to it.
     */
    hasHeatingLoop() {
        return this.host.observationFor(this.deviceId)?.heatingSupported === true;
    }
    requireHeatingLoop() {
        if (!this.hasHeatingLoop()) {
            this.warnNoLoop();
            throw new utils_1.ControlRejectedError('this appliance reports no space-heating loop, so a heating command was not sent');
        }
    }
    optimisticSetpointPatch(native) {
        return { heatSetpoint: native };
    }
}
exports.SpaceHeatingAccessory = SpaceHeatingAccessory;
