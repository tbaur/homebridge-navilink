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

import type { TemperatureScale } from '../utils/temperature'
import { encodeWireTemperature } from '../utils/temperature'
import type { TopicIdentity } from './topics'

/**
 * Protocol revision sent in every envelope.
 *
 * `1` is what the gateway accepts for every frame this plugin sends.
 */
export const PROTOCOL_VERSION = 1

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
export const Command = {
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
} as const

/**
 * The `control.mode` string that accompanies each write command.
 *
 * The command code alone is not enough: the gateway dispatches on the mode
 * string, and the capitalisation is not consistent between them:
 * `DHWTemperature` but `heatTemperature`, `power` but not `Power`. The
 * table spells each one out because the gateway matches the string as
 * written.
 */
export const ControlMode = {
  POWER: 'power',
  HEAT: 'heat',
  DHW_TEMPERATURE: 'DHWTemperature',
  HEAT_TEMPERATURE: 'heatTemperature',
  ON_DEMAND: 'onDemand',
  RECIRCULATION_TEMPERATURE: 'recirculation',
} as const

/**
 * The appliance's boolean encoding.
 *
 * Not zero and one. Zero means "unknown" throughout this protocol, so a
 * command carrying it is asking for nothing. Disabled features report `2`
 * on the read side, and writes use the same pair.
 */
export const OnOff = {
  ON: 1,
  OFF: 2,
} as const

/** On-demand recirculation takes a third value the other flags do not. */
export const ON_DEMAND_WARMUP = 3

/** What one request needs to address a gateway. */
export interface RequestContext extends TopicIdentity {
  /** The opaque discriminator from the device list. Often an empty string. */
  additionalValue: string
}

/** A frame ready to publish: where it goes, and what it says. */
export interface OutboundFrame {
  topic: string
  payload: string
}

/** The envelope, with the caller's request inside it. */
function envelope(input: {
  context: RequestContext
  request: Record<string, unknown>
  requestTopic: string
  responseTopic: string
}): string {
  const { context, request, requestTopic, responseTopic } = input
  return JSON.stringify({
    clientID: context.clientId,
    protocolVersion: PROTOCOL_VERSION,
    request,
    requestTopic,
    responseTopic,
    // A correlation value the gateway echoes. Milliseconds since the epoch, as
    // a string, which is what the app sends. Not used to match responses: the
    // answers arrive on the gateway's own topic, where they are not
    // necessarily answers to anything we asked.
    sessionID: String(Date.now()),
  })
}

/** Fields every request carries, whatever the command. */
function addressing(context: RequestContext, command: number): Record<string, unknown> {
  return {
    additionalValue: context.additionalValue,
    command,
    deviceType: context.deviceType,
    macAddress: context.macAddress,
  }
}

/**
 * Ask the gateway to describe itself.
 *
 * The first thing sent on a new session. Until it is answered nothing else is
 * meaningful: the reply carries `temperatureType`, without which every
 * temperature in every later frame is unreadable.
 */
export function channelInfoRequest(input: {
  context: RequestContext
  topics: { start: string }
  responseTopic: string
}): OutboundFrame {
  const { context, topics, responseTopic } = input
  return {
    topic: topics.start,
    payload: envelope({
      context,
      request: addressing(context, Command.CHANNEL_INFO),
      requestTopic: topics.start,
      responseTopic,
    }),
  }
}

/**
 * Ask one channel for its current state.
 *
 * `unitNumberStart` and `unitNumberEnd` select which appliances in a cascade
 * to report. For a single appliance both ends are 1. The range is inclusive
 * and one-based, which is why a caller passes a count rather than an index.
 */
export function channelStatusRequest(input: {
  context: RequestContext
  topics: { statusRequest: string }
  responseTopic: string
  channelNumber: number
  unitCount: number
}): OutboundFrame {
  const { context, topics, responseTopic, channelNumber, unitCount } = input
  return {
    topic: topics.statusRequest,
    payload: envelope({
      context,
      request: {
        ...addressing(context, Command.CHANNEL_STATUS),
        status: {
          channelNumber,
          unitNumberStart: 1,
          unitNumberEnd: Math.max(1, unitCount),
        },
      },
      requestTopic: topics.statusRequest,
      responseTopic,
    }),
  }
}

// --- Control ----------------------------------------------------------------

/** Everything a control frame needs beyond the command itself. */
export interface ControlInput {
  context: RequestContext
  topics: { control: string }
  /**
   * Where the gateway should answer.
   *
   * The **channel-status** response topic, not a control-specific one. A
   * control is answered with a status frame, which is the appliance
   * confirming what it now holds rather than acknowledging what it was told.
   */
  responseTopic: string
  channelNumber: number
}

/**
 * Build a control frame.
 *
 * `param` is always an array, even for a single scalar and even when empty.
 * That is the vendor's shape, not a convenience: the gateway parses the field
 * as a list and a bare number is rejected.
 */
export function controlRequest(
  input: ControlInput & { command: number; mode: string; param: readonly number[] },
): OutboundFrame {
  const { context, topics, responseTopic, channelNumber, command, mode, param } = input
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
  }
}

/** Switch the appliance on or off. */
export function powerControl(input: ControlInput & { on: boolean }): OutboundFrame {
  return controlRequest({
    ...input,
    command: Command.POWER,
    mode: ControlMode.POWER,
    param: [input.on ? OnOff.ON : OnOff.OFF],
  })
}

/** Enable or disable the space-heating loop. */
export function heatingEnableControl(input: ControlInput & { on: boolean }): OutboundFrame {
  return controlRequest({
    ...input,
    command: Command.HEAT,
    mode: ControlMode.HEAT,
    param: [input.on ? OnOff.ON : OnOff.OFF],
  })
}

/** Set the domestic hot water setpoint, in the appliance's native scale. */
export function dhwSetpointControl(
  input: ControlInput & { native: number; scale: TemperatureScale },
): OutboundFrame {
  return controlRequest({
    ...input,
    command: Command.DHW_TEMPERATURE,
    mode: ControlMode.DHW_TEMPERATURE,
    param: [encodeSetpoint(input.native, input.scale)],
  })
}

/** Set the space-heating water setpoint, in the appliance's native scale. */
export function heatingSetpointControl(
  input: ControlInput & { native: number; scale: TemperatureScale },
): OutboundFrame {
  return controlRequest({
    ...input,
    command: Command.HEAT_TEMPERATURE,
    mode: ControlMode.HEAT_TEMPERATURE,
    param: [encodeSetpoint(input.native, input.scale)],
  })
}

/** Start or stop the recirculation pump. */
export function onDemandControl(input: ControlInput & { on: boolean }): OutboundFrame {
  return controlRequest({
    ...input,
    command: Command.ON_DEMAND,
    mode: ControlMode.ON_DEMAND,
    param: [input.on ? OnOff.ON : OnOff.OFF],
  })
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
export function appDisconnectWill(context: RequestContext, topic: string): string {
  return JSON.stringify({
    clientID: context.clientId,
    event: {
      additionalValue: context.additionalValue,
      connection: { os: 'A', status: 0 },
      deviceType: context.deviceType,
      macAddress: context.macAddress,
    },
    protocolVersion: PROTOCOL_VERSION,
    requestTopic: topic,
    sessionID: '',
  })
}

/**
 * Encode a setpoint for a control command.
 *
 * Kept here rather than inlined at the call site because the wire encoding of
 * a temperature has to be identical in a command and in the status frame that
 * reports it back. If the two ever disagree, a setpoint written as 120 reads
 * back as 60 and the thermostat appears to halve itself on every write.
 */
export function encodeSetpoint(native: number, scale: TemperatureScale): number {
  return encodeWireTemperature(native, scale)
}
