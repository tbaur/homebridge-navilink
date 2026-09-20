"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Human labels for log lines.
 *
 * A Homebridge log gets pasted into issues. The gateway MAC identifies the
 * hardware in every MQTT topic, so it must not be the thing a line leads
 * with. Use the name the user gave the appliance. Fall back to a masked
 * gateway only when there is no name, and say that it is a gateway.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.labelAppliance = labelAppliance;
const validators_1 = require("./validators");
const redact_1 = require("./redact");
/** The appliance name, or `gateway …ABCD` when none is known. */
function labelAppliance(input) {
    const name = input.name?.trim();
    if (name !== undefined && name.length > 0) {
        return (0, validators_1.forLog)(name);
    }
    return `gateway ${(0, redact_1.maskMac)(input.mac)}`;
}
