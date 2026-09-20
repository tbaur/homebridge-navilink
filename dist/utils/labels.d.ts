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
/** Operator-facing name for the MQTT live channel. */
export declare const MQTT_CHANNEL = "Publish-subscribe (mqtt)";
/** The appliance name, or `gateway …ABCD` when none is known. */
export declare function labelAppliance(input: {
    name?: string;
    mac: string;
}): string;
