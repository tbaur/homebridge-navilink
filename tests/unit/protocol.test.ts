/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * These frames are sent to a gas appliance, so they are asserted field by
 * field against the shapes the gateway accepts, not checked for plausibility.
 */

import {
  appDisconnectWill,
  channelInfoRequest,
  channelStatusRequest,
  Command,
  ControlMode,
  dhwSetpointControl,
  heatingEnableControl,
  heatingSetpointControl,
  onDemandControl,
  OnOff,
  powerControl,
  PROTOCOL_VERSION,
  type RequestContext,
} from '../../src/api/protocol'
import { buildTopics, responseTopic } from '../../src/api/topics'

const context: RequestContext = {
  macAddress: 'a1b2c3d4e5f6',
  deviceType: 1,
  homeSeq: '200000',
  userSeq: '100000',
  clientId: 'client-1',
  additionalValue: '5089',
}
const topics = buildTopics(context)
const control = {
  context,
  topics,
  responseTopic: responseTopic(context, 'channelstatus'),
  channelNumber: 1,
}

function parse(payload: string) {
  return JSON.parse(payload) as {
    clientID: string
    protocolVersion: number
    sessionID: string
    requestTopic: string
    responseTopic: string
    request: {
      command: number
      deviceType: number
      macAddress: string
      additionalValue: string
      control?: { channelNumber: number; mode: string; param: number[] }
      status?: { channelNumber: number; unitNumberStart: number; unitNumberEnd: number }
    }
  }
}

describe('command codes', () => {
  it('splits reads and writes by the high byte', () => {
    expect(Command.CHANNEL_INFO).toBe(16_777_217)
    expect(Command.CHANNEL_STATUS).toBe(16_777_220)
    expect(Command.POWER).toBe(33_554_433)
    expect(Command.HEAT).toBe(33_554_434)
    expect(Command.DHW_TEMPERATURE).toBe(33_554_435)
    expect(Command.HEAT_TEMPERATURE).toBe(33_554_436)
    expect(Command.ON_DEMAND).toBe(33_554_437)
    expect(Command.RECIRCULATION_TEMPERATURE).toBe(33_554_439)
  })

  it('uses 1 and 2 for on and off, not 1 and 0', () => {
    // Zero means "unknown" throughout this protocol, so a command carrying
    // it asks for nothing at all.
    expect(OnOff.ON).toBe(1)
    expect(OnOff.OFF).toBe(2)
  })
})

describe('the request envelope', () => {
  const frame = parse(channelInfoRequest({
    context,
    topics,
    responseTopic: responseTopic(context, 'channelinfo'),
  }).payload)

  it('carries the client, version and both topics', () => {
    expect(frame.clientID).toBe('client-1')
    expect(frame.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(frame.requestTopic).toBe('cmd/1/navilink-a1b2c3d4e5f6/status/start')
    expect(frame.responseTopic).toBe('cmd/1/200000/100000/client-1/res/channelinfo')
  })

  it('addresses the gateway in every request', () => {
    expect(frame.request.macAddress).toBe('a1b2c3d4e5f6')
    expect(frame.request.deviceType).toBe(1)
    expect(frame.request.additionalValue).toBe('5089')
  })

  it('sends a sessionID the cloud will mangle but nothing depends on', () => {
    // The cloud echoes it truncated from milliseconds to seconds, so
    // correlating on it silently never matches. Responses are matched by
    // topic instead; this only has to be present and plausible.
    expect(frame.sessionID).toMatch(/^\d{13}$/)
  })
})

describe('channelStatusRequest', () => {
  it('asks for an inclusive, one-based unit range', () => {
    const frame = parse(channelStatusRequest({
      ...control,
      unitCount: 3,
    }).payload)

    expect(frame.request.command).toBe(Command.CHANNEL_STATUS)
    expect(frame.request.status).toEqual({
      channelNumber: 1,
      unitNumberStart: 1,
      unitNumberEnd: 3,
    })
  })

  it('never asks for fewer than one unit', () => {
    const frame = parse(channelStatusRequest({ ...control, unitCount: 0 }).payload)

    expect(frame.request.status?.unitNumberEnd).toBe(1)
  })
})

describe('control frames', () => {
  it('all go to the one control topic', () => {
    // There is no per-function control topic.
    for (const frame of [
      powerControl({ ...control, on: true }),
      heatingEnableControl({ ...control, on: true }),
      dhwSetpointControl({ ...control, native: 120, scale: 'fahrenheit' }),
      onDemandControl({ ...control, on: true }),
    ]) {
      expect(frame.topic).toBe('cmd/1/navilink-a1b2c3d4e5f6/control')
    }
  })

  it('answer to the channel-status response topic', () => {
    // A control is answered with a status frame, not an acknowledgement.
    const frame = parse(powerControl({ ...control, on: true }).payload)

    expect(frame.responseTopic).toBe('cmd/1/200000/100000/client-1/res/channelstatus')
  })

  it('builds a power command', () => {
    expect(parse(powerControl({ ...control, on: true }).payload).request).toMatchObject({
      command: 33_554_433,
      control: { channelNumber: 1, mode: 'power', param: [1] },
    })
    expect(parse(powerControl({ ...control, on: false }).payload).request.control?.param)
      .toEqual([2])
  })

  it('builds a space-heating enable command', () => {
    expect(parse(heatingEnableControl({ ...control, on: true }).payload).request).toMatchObject({
      command: 33_554_434,
      control: { channelNumber: 1, mode: 'heat', param: [1] },
    })
  })

  it('builds a hot water setpoint command', () => {
    expect(parse(dhwSetpointControl({
      ...control,
      native: 120,
      scale: 'fahrenheit',
    }).payload).request).toMatchObject({
      command: 33_554_435,
      control: { channelNumber: 1, mode: 'DHWTemperature', param: [120] },
    })
  })

  it('builds a space-heating setpoint command on its own code', () => {
    // Own command code and own mode string, not the DHW pair.
    const frame = parse(heatingSetpointControl({
      ...control,
      native: 110,
      scale: 'fahrenheit',
    }).payload)

    expect(frame.request.command).toBe(33_554_436)
    expect(frame.request.command).not.toBe(Command.DHW_TEMPERATURE)
    expect(frame.request.control?.mode).toBe('heatTemperature')
  })

  it('builds a recirculation command', () => {
    expect(parse(onDemandControl({ ...control, on: true }).payload).request).toMatchObject({
      command: 33_554_437,
      control: { mode: 'onDemand', param: [1] },
    })
  })

  it('encodes a Celsius setpoint in half-degree ticks', () => {
    // The same encoding as the read side. If the two ever disagree, a
    // setpoint written as 120 reads back as 60 and the thermostat appears to
    // halve itself on every write.
    const frame = parse(dhwSetpointControl({
      ...control,
      native: 47.5,
      scale: 'celsius',
    }).payload)

    expect(frame.request.control?.param).toEqual([95])
  })

  it('always sends param as an array', () => {
    // The gateway parses it as a list; a bare number is rejected.
    const frame = parse(powerControl({ ...control, on: true }).payload)

    expect(Array.isArray(frame.request.control?.param)).toBe(true)
  })

  it('keeps the mode strings exactly as the vendor app spells them', () => {
    // The capitalisation is not consistent between them, and the gateway
    // dispatches on the string.
    expect(ControlMode.POWER).toBe('power')
    expect(ControlMode.DHW_TEMPERATURE).toBe('DHWTemperature')
    expect(ControlMode.HEAT).toBe('heat')
    expect(ControlMode.HEAT_TEMPERATURE).toBe('heatTemperature')
    expect(ControlMode.ON_DEMAND).toBe('onDemand')
  })
})

describe('appDisconnectWill', () => {
  it('announces a disconnect on the app-connection topic', () => {
    const will = JSON.parse(appDisconnectWill(context, topics.appConnection)) as {
      event: { connection: { os: string; status: number } }
      sessionID: string
    }

    expect(will.event.connection).toEqual({ os: 'A', status: 0 })
    expect(will.sessionID).toBe('')
  })
})
