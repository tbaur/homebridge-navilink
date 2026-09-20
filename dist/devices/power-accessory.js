"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PowerAccessory = void 0;
const utils_1 = require("../utils");
const base_accessory_1 = require("./base-accessory");
/** Appliance power, as a HomeKit switch. */
class PowerAccessory extends base_accessory_1.BaseAccessory {
    service;
    hasExplainedGuard = false;
    constructor(init) {
        super(init);
        const { Characteristic, Service: HapService } = this.host.hap;
        this.service = this.requireService(HapService.Switch);
        this.service.setCharacteristic(Characteristic.Name, this.displayName);
        this.service
            .getCharacteristic(Characteristic.On)
            .onGet(() => this.requireObservedState().power)
            .onSet(async (value) => this.writeOn(value));
    }
    async writeOn(value) {
        const wantOn = value === true;
        if (this.declineIfReadOnly()) {
            this.restore();
            return;
        }
        const observation = this.host.observationFor(this.deviceId);
        if (observation !== undefined && observation.power === wantOn) {
            this.host.log.debug(`${(0, utils_1.forLog)(this.displayName)}: already ${wantOn ? 'on' : 'off'}; nothing sent`);
            return;
        }
        await this.completeWithinBudget('power change', async () => {
            try {
                await this.host.control(this.deviceId).setPower(wantOn);
                this.host.noteOptimisticWrite(this.deviceId, { power: wantOn });
                this.logAction(wantOn ? 'POWER ON' : 'POWER OFF');
            }
            catch (error) {
                if (error instanceof utils_1.ControlRejectedError) {
                    this.explainGuard(error);
                }
                else {
                    this.host.log.warn(`${(0, utils_1.forLog)(this.displayName)}: power failed: ${(0, utils_1.describeError)(error)}`);
                }
                this.restore();
            }
        });
    }
    updateFromObservation(observation, _reason) {
        this.publish(this.service, this.host.hap.Characteristic.On, observation.power);
    }
    restore() {
        const observation = this.host.observationFor(this.deviceId);
        if (observation === undefined) {
            return;
        }
        this.service.updateCharacteristic(this.host.hap.Characteristic.On, observation.power);
    }
    explainGuard(error) {
        if (this.hasExplainedGuard) {
            this.host.log.debug(`${(0, utils_1.forLog)(this.displayName)}: ${error.message}`);
            return;
        }
        this.hasExplainedGuard = true;
        this.host.log.info(`${(0, utils_1.forLog)(this.displayName)}: ${error.message}`);
    }
}
exports.PowerAccessory = PowerAccessory;
