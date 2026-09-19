"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview NaviLink request frames: the envelope, and the commands inside
 * it.
 *
 * Every message to a gateway has the same outer shape. A `request` object
 * carries the command code and its arguments; the envelope around it says who
 * is asking, where the answer should go, and which protocol revision is being
 * spoken.
 *
 * ```json
 * {
 *   "clientID": "…",
 *   "protocolVersion": 1,
 *   "request": { "command": 16777217, "macAddress": "…", "…": "…" },
 *   "requestTopic": "cmd/1/navilink-…/status/start",
 *   "responseTopic": "cmd/1/…/res/channelinfo",
 *   "sessionID": "1700000000000"
 * }
 * ```
 *
 * The command codes are not arbitrary. They are a class in the high byte and
 * an index in the low: `0x01000001` is the first read, `0x01000004` the
 * fourth. They are written in hex here with the decimal alongside. The
 * decimal is what appears in a capture, and the hex is what makes the
 * pattern visible.
 *
 * Nothing in this file talks to a socket. It builds objects, so the frames
 * this plugin sends can be asserted on byte for byte in a test.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ON_DEMAND_WARMUP = exports.OnOff = exports.ControlMode = exports.Command = exports.PROTOCOL_VERSION = void 0;
exports.channelInfoRequest = channelInfoRequest;
exports.channelStatusRequest = channelStatusRequest;
exports.controlRequest = controlRequest;
exports.powerControl = powerControl;
exports.heatingEnableControl = heatingEnableControl;
exports.dhwSetpointControl = dhwSetpointControl;
exports.heatingSetpointControl = heatingSetpointControl;
exports.onDemandControl = onDemandControl;
exports.appDisconnectWill = appDisconnectWill;
exports.encodeSetpoint = encodeSetpoint;
const temperature_1 = require("../utils/temperature");
/**
 * Protocol revision sent in every envelope.
 *
 * `1` is what the gateway accepts for every frame this plugin sends.
 */
exports.PROTOCOL_VERSION = 1;
/**
 * Command codes.
 *
 * The high byte is the class: `0x01` reads, `0x02` writes. The low byte is
 * the operation index. `0x02000000 | index` is the write for that
 * operation.
 *
 * These are sent to a gas appliance, so the codes and mode strings are the
 * ones the gateway dispatches on, not a generated pair.
 */
exports.Command = {
    /** Ask what the gateway has attached. Answered on `res/channelinfo`. */
    CHANNEL_INFO: 0x0100_0001,
    /** Ask a channel what it is doing. Answered on `res/channelstatus`. */
    CHANNEL_STATUS: 0x0100_0004,
    /** Switch the appliance on or off. */
    POWER: 0x0200_0001,
    /** Enable or disable the space-heating loop. */
    HEAT: 0x0200_0002,
    /** Set the domestic hot water setpoint. */
    DHW_TEMPERATURE: 0x0200_0003,
    /** Set the space-heating water setpoint. */
    HEAT_TEMPERATURE: 0x0200_0004,
    /** Start, stop or warm up the recirculation pump. */
    ON_DEMAND: 0x0200_0005,
    /** Set the recirculation setpoint. */
    RECIRCULATION_TEMPERATURE: 0x0200_0007,
};
/**
 * The `control.mode` string that accompanies each write command.
 *
 * The command code alone is not enough: the gateway dispatches on the mode
 * string, and the capitalisation is not consistent between them:
 * `DHWTemperature` but `heatTemperature`, `power` but not `Power`. The
 * table spells each one out because the gateway matches the string as
 * written.
 */
exports.ControlMode = {
    POWER: 'power',
    HEAT: 'heat',
    DHW_TEMPERATURE: 'DHWTemperature',
    HEAT_TEMPERATURE: 'heatTemperature',
    ON_DEMAND: 'onDemand',
    RECIRCULATION_TEMPERATURE: 'recirculation',
};
/**
 * The appliance's boolean encoding.
 *
 * Not zero and one. Zero means "unknown" throughout this protocol, so a
 * command carrying it is asking for nothing. Disabled features report `2`
 * on the read side, and writes use the same pair.
 */
exports.OnOff = {
    ON: 1,
    OFF: 2,
};
/** On-demand recirculation takes a third value the other flags do not. */
exports.ON_DEMAND_WARMUP = 3;
/** The envelope, with the caller's request inside it. */
function envelope(input) {
    const { context, request, requestTopic, responseTopic } = input;
    return JSON.stringify({
        clientID: context.clientId,
        protocolVersion: exports.PROTOCOL_VERSION,
        request,
        requestTopic,
        responseTopic,
        // A correlation value the gateway echoes. Milliseconds since the epoch, as
        // a string, which is what the app sends. Not used to match responses: the
        // answers arrive on the gateway's own topic, where they are not
        // necessarily answers to anything we asked.
        sessionID: String(Date.now()),
    });
}
/** Fields every request carries, whatever the command. */
function addressing(context, command) {
    return {
        additionalValue: context.additionalValue,
        command,
        deviceType: context.deviceType,
        macAddress: context.macAddress,
    };
}
/**
 * Ask the gateway to describe itself.
 *
 * The first thing sent on a new session. Until it is answered nothing else is
 * meaningful: the reply carries `temperatureType`, without which every
 * temperature in every later frame is unreadable.
 */
function channelInfoRequest(input) {
    const { context, topics, responseTopic } = input;
    return {
        topic: topics.start,
        payload: envelope({
            context,
            request: addressing(context, exports.Command.CHANNEL_INFO),
            requestTopic: topics.start,
            responseTopic,
        }),
    };
}
/**
 * Ask one channel for its current state.
 *
 * `unitNumberStart` and `unitNumberEnd` select which appliances in a cascade
 * to report. For a single appliance both ends are 1. The range is inclusive
 * and one-based, which is why a caller passes a count rather than an index.
 */
function channelStatusRequest(input) {
    const { context, topics, responseTopic, channelNumber, unitCount } = input;
    return {
        topic: topics.statusRequest,
        payload: envelope({
            context,
            request: {
                ...addressing(context, exports.Command.CHANNEL_STATUS),
                status: {
                    channelNumber,
                    unitNumberStart: 1,
                    unitNumberEnd: Math.max(1, unitCount),
                },
            },
            requestTopic: topics.statusRequest,
            responseTopic,
        }),
    };
}
/**
 * Build a control frame.
 *
 * `param` is always an array, even for a single scalar and even when empty.
 * That is the vendor's shape, not a convenience: the gateway parses the field
 * as a list and a bare number is rejected.
 */
function controlRequest(input) {
    const { context, topics, responseTopic, channelNumber, command, mode, param } = input;
    return {
        topic: topics.control,
        payload: envelope({
            context,
            request: {
                ...addressing(context, command),
                control: { channelNumber, mode, param: [...param] },
            },
            requestTopic: topics.control,
            responseTopic,
        }),
    };
}
/** Switch the appliance on or off. */
function powerControl(input) {
    return controlRequest({
        ...input,
        command: exports.Command.POWER,
        mode: exports.ControlMode.POWER,
        param: [input.on ? exports.OnOff.ON : exports.OnOff.OFF],
    });
}
/** Enable or disable the space-heating loop. */
function heatingEnableControl(input) {
    return controlRequest({
        ...input,
        command: exports.Command.HEAT,
        mode: exports.ControlMode.HEAT,
        param: [input.on ? exports.OnOff.ON : exports.OnOff.OFF],
    });
}
/** Set the domestic hot water setpoint, in the appliance's native scale. */
function dhwSetpointControl(input) {
    return controlRequest({
        ...input,
        command: exports.Command.DHW_TEMPERATURE,
        mode: exports.ControlMode.DHW_TEMPERATURE,
        param: [encodeSetpoint(input.native, input.scale)],
    });
}
/** Set the space-heating water setpoint, in the appliance's native scale. */
function heatingSetpointControl(input) {
    return controlRequest({
        ...input,
        command: exports.Command.HEAT_TEMPERATURE,
        mode: exports.ControlMode.HEAT_TEMPERATURE,
        param: [encodeSetpoint(input.native, input.scale)],
    });
}
/** Start or stop the recirculation pump. */
function onDemandControl(input) {
    return controlRequest({
        ...input,
        command: exports.Command.ON_DEMAND,
        mode: exports.ControlMode.ON_DEMAND,
        param: [input.on ? exports.OnOff.ON : exports.OnOff.OFF],
    });
}
/**
 * The message the broker publishes if this client disappears.
 *
 * `status: 0` means an app has gone away. The gateway uses this to decide
 * whether anyone is watching, which on some firmware governs how eagerly it
 * pushes updates. `os: 'A'` is what the app sends; the gateway has not been
 * observed to treat it as meaningful.
 *
 * Registered as the MQTT will rather than sent, so it fires precisely when
 * this client stops answering. That is the one case it is for, and the one
 * case where the plugin cannot send anything itself.
 */
function appDisconnectWill(context, topic) {
    return JSON.stringify({
        clientID: context.clientId,
        event: {
            additionalValue: context.additionalValue,
            connection: { os: 'A', status: 0 },
            deviceType: context.deviceType,
            macAddress: context.macAddress,
        },
        protocolVersion: exports.PROTOCOL_VERSION,
        requestTopic: topic,
        sessionID: '',
    });
}
/**
 * Encode a setpoint for a control command.
 *
 * Kept here rather than inlined at the call site because the wire encoding of
 * a temperature has to be identical in a command and in the status frame that
 * reports it back. If the two ever disagree, a setpoint written as 120 reads
 * back as 60 and the thermostat appears to halve itself on every write.
 */
function encodeSetpoint(native, scale) {
    return (0, temperature_1.encodeWireTemperature)(native, scale);
}
