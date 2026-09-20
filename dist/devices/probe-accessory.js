"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One of the appliance's temperature probes, as a HomeKit sensor.
 *
 * Five of them share this implementation, differing only in which field they
 * read: the hot water inlet and outlet, the heating flow and return, and the
 * outdoor sensor where one is fitted. They are read-only, and useful mainly
 * for graphs and for automations that want to know whether the appliance is
 * doing anything.
 *
 * The flow and return pair is the interesting one. The difference between them
 * is what the appliance is putting into the house, so a HomeKit automation can
 * notice heating running when nobody asked it to.
 *
 * ## Probes that are not fitted
 *
 * Whether a probe exists is only knowable from a live status frame, and the
 * frames arrive after accessories are registered. So a sensor can be created
 * for something that does not exist. When that turns out to be the case it
 * says so once and reports No Response. It does not publish the zero the
 * appliance sends for an absent probe, which would be -17.8 °C on the tile
 * and could be acted on by an automation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProbeAccessory = void 0;
const utils_1 = require("../utils");
const base_accessory_1 = require("./base-accessory");
/** Which observation field each probe accessory reports. */
const FIELD_BY_KIND = {
    dhwOutlet: 'dhwOutlet',
    dhwInlet: 'dhwInlet',
    heatSupply: 'heatSupply',
    heatReturn: 'heatReturn',
    outdoor: 'outdoor',
};
/** What to say when a probe turns out not to exist. */
const ABSENCE_HINT = {
    dhwOutlet: 'no outlet temp',
    dhwInlet: 'no inlet temp',
    heatSupply: 'no flow temp',
    heatReturn: 'no return temp',
    outdoor: 'no outdoor sensor',
};
/** One appliance temperature probe, as a HomeKit sensor. */
class ProbeAccessory extends base_accessory_1.BaseAccessory {
    service;
    kind;
    hasWarnedAbsent = false;
    constructor(init) {
        super(init);
        this.kind = init.kind;
        const { Characteristic, Service: HapService } = this.host.hap;
        this.service = this.requireService(HapService.TemperatureSensor);
        this.service.setCharacteristic(Characteristic.Name, this.displayName);
        this.service
            .getCharacteristic(Characteristic.CurrentTemperature)
            .onGet(() => this.readCelsius());
        // Published so a controller that honours it can grey the sensor out
        // rather than showing a stale reading for a probe that has gone away.
        this.service
            .getCharacteristic(Characteristic.StatusActive)
            .onGet(() => this.readNative() !== undefined);
    }
    readNative() {
        const observation = this.host.observationFor(this.deviceId);
        if (observation === undefined) {
            return undefined;
        }
        const value = observation[FIELD_BY_KIND[this.kind]];
        return typeof value === 'number' ? value : undefined;
    }
    readCelsius() {
        const observation = this.requireObservedState();
        const native = this.readNative();
        if (native === undefined) {
            throw this.communicationFailure();
        }
        return (0, utils_1.nativeToCelsius)(native, observation.scale);
    }
    updateFromObservation(observation, _reason) {
        const { Characteristic } = this.host.hap;
        const value = observation[FIELD_BY_KIND[this.kind]];
        const native = typeof value === 'number' ? value : undefined;
        this.publish(this.service, Characteristic.StatusActive, native !== undefined);
        if (native === undefined) {
            this.warnAbsent();
            this.markUnavailable();
            // StatusActive is the honest "nothing here" flag; keep it after the
            // temperature characteristic has been greyed.
            this.publish(this.service, Characteristic.StatusActive, false);
            return;
        }
        this.publish(this.service, Characteristic.CurrentTemperature, (0, utils_1.nativeToCelsius)(native, observation.scale));
    }
    warnAbsent() {
        if (this.hasWarnedAbsent) {
            return;
        }
        this.hasWarnedAbsent = true;
        this.host.log.warn(`${(0, utils_1.forLog)(this.displayName)}: ${ABSENCE_HINT[this.kind]}`);
    }
}
exports.ProbeAccessory = ProbeAccessory;
