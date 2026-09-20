"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FaultAccessory = void 0;
const utils_1 = require("../utils");
const base_accessory_1 = require("./base-accessory");
/** Appliance fault state, as a HomeKit contact sensor. */
class FaultAccessory extends base_accessory_1.BaseAccessory {
    service;
    /** The code last logged, so a standing fault is reported once, not hourly. */
    lastLoggedCode;
    constructor(init) {
        super(init);
        const { Characteristic, Service: HapService } = this.host.hap;
        this.service = this.requireService(HapService.ContactSensor);
        this.service.setCharacteristic(Characteristic.Name, this.displayName);
        this.service
            .getCharacteristic(Characteristic.ContactSensorState)
            .onGet(() => this.readState());
    }
    readState() {
        const { ContactSensorState } = this.host.hap.Characteristic;
        const observation = this.requireObservedState();
        // "Detected" is HomeKit's word for a closed contact, which is the resting
        // state. A fault opens it, which is what raises a notification.
        return observation.readings.errorCode === 0
            ? ContactSensorState.CONTACT_DETECTED
            : ContactSensorState.CONTACT_NOT_DETECTED;
    }
    updateFromObservation(observation, _reason) {
        const { ContactSensorState } = this.host.hap.Characteristic;
        const { errorCode, subErrorCode } = observation.readings;
        this.publish(this.service, this.host.hap.Characteristic.ContactSensorState, errorCode === 0
            ? ContactSensorState.CONTACT_DETECTED
            : ContactSensorState.CONTACT_NOT_DETECTED);
        this.logCodeChange(errorCode, subErrorCode);
    }
    logCodeChange(errorCode, subErrorCode) {
        if (errorCode === this.lastLoggedCode) {
            return;
        }
        const previous = this.lastLoggedCode;
        this.lastLoggedCode = errorCode;
        if (errorCode === 0) {
            // First healthy frame is the resting state, not a transition.
            if (previous !== undefined) {
                this.host.log.info(`${(0, utils_1.forLog)(this.displayName)}: fault cleared`);
            }
            return;
        }
        this.host.log.warn(`${(0, utils_1.forLog)(this.displayName)}: error ${errorCode}`
            + `${subErrorCode === 0 ? '' : `.${subErrorCode}`}`);
    }
}
exports.FaultAccessory = FaultAccessory;
