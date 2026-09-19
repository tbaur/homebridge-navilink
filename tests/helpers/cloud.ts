/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A NaviLink cloud stand-in for session and discovery tests.
 *
 * Enough of the service to drive the real session code: a REST client that
 * hands back tokens and a device list, and an MQTT connection that records
 * what was published and lets a test deliver a frame back on any topic.
 *
 * Deliberately not a mock library. What these tests are about is the order of
 * operations against a cloud (sign in, list, connect, describe, then read)
 * and assertions about that order read better against a recorded transcript
 * than against `toHaveBeenNthCalledWith`.
 */

import type { MqttConnection, MqttConnectionOptions, MqttMessage } from '../../src/api/mqtt'
import { FAKE_ASIA_KEY } from './secrets'
import type { ListedDevice, NaviLinkRest, NaviLinkSessionTokens } from '../../src/api/rest'
import { buildTopics, responseTopic, type TopicIdentity } from '../../src/api/topics'
import channelInfoFrame from '../fixtures/ncb-240e.channelinfo.json'
import channelStatusFrame from '../fixtures/ncb-240e.channelstatus.json'

/** The gateway every fixture and every test in this suite is about. */
export const MAC = 'a1b2c3d4e5f6'

/** `{mac}:{channel}`, as the settings page would write it. */
export const DEVICE_ID = `${MAC}:1`

export const IDENTITY: TopicIdentity = {
  macAddress: MAC,
  deviceType: 1,
  homeSeq: '200000',
  userSeq: '100000',
  clientId: 'test-client',
}

/** One published frame, as the session sent it. */
export interface Published {
  topic: string
  payload: string
}

/** A recorded MQTT connection a test can deliver frames into. */
export class FakeConnection {
  readonly published: Published[] = []

  readonly subscribed: string[] = []

  connectCalls = 0

  closeCalls = 0

  isConnected = false

  /** Set to make `connect` reject, for the two-signature fallback path. */
  failConnect: Error | undefined

  private messageHandler: ((message: MqttMessage) => void) | undefined

  private closeHandler: ((error: Error) => void) | undefined

  constructor(readonly options: MqttConnectionOptions) {}

  onMessage(handler: (message: MqttMessage) => void): void {
    this.messageHandler = handler
  }

  onClose(handler: (error: Error) => void): void {
    this.closeHandler = handler
  }

  connect(): Promise<void> {
    this.connectCalls += 1
    if (this.failConnect !== undefined) {
      return Promise.reject(this.failConnect)
    }
    this.isConnected = true
    return Promise.resolve()
  }

  subscribe(subscriptions: readonly { topic: string }[]): Promise<void> {
    this.subscribed.push(...subscriptions.map((entry) => entry.topic))
    return Promise.resolve()
  }

  publish(topic: string, payload: string): Promise<void> {
    this.published.push({ topic, payload })
    return Promise.resolve()
  }

  close(): void {
    this.closeCalls += 1
    const wasConnected = this.isConnected
    this.isConnected = false
    if (wasConnected) {
      this.closeHandler?.(new Error('closed by this plugin'))
    }
  }

  /** Deliver a frame the way the broker would. */
  deliver(topic: string, frame: unknown): void {
    this.messageHandler?.({ topic, payload: JSON.stringify(frame) })
  }

  /** Deliver the recorded channel description for this gateway. */
  deliverChannelInfo(overrides: Record<string, unknown> = {}): void {
    this.deliver(
      `cmd/1/navilink-${MAC}/res/channelinfo`,
      mergeResponse(channelInfoFrame, overrides),
    )
  }

  /** Deliver the recorded status frame for this gateway. */
  deliverChannelStatus(overrides: Record<string, unknown> = {}): void {
    this.deliver(
      `cmd/1/navilink-${MAC}/res/channelstatus`,
      mergeResponse(channelStatusFrame, overrides),
    )
  }

  /** Deliver a control refusal. */
  deliverControlFailure(failCode: number): void {
    this.deliver(`cmd/1/navilink-${MAC}/res/controlfail`, { response: { failCode } })
  }

  /** Frames published to the control topic, decoded. */
  get controlFrames(): Record<string, unknown>[] {
    return this.published
      .filter((entry) => entry.topic === buildTopics(IDENTITY).control)
      .map((entry) => JSON.parse(entry.payload) as Record<string, unknown>)
  }

  asConnection(): MqttConnection {
    return this as unknown as MqttConnection
  }
}

/** Overlay a few fields onto a recorded frame's `response` object. */
function mergeResponse(frame: unknown, overrides: Record<string, unknown>): unknown {
  const base = frame as { response?: Record<string, unknown> }
  if (Object.keys(overrides).length === 0) {
    return frame
  }
  return { ...base, response: { ...base.response, ...overrides } }
}

/** What a fake REST client was asked to do. */
export interface RestCalls {
  signIn: { email: string; password: string }[]
  listDevices: number
  readFirmware: number
}

export interface FakeRest {
  rest: NaviLinkRest
  calls: RestCalls
  /** Make the next `signIn` reject with this, then clear it. */
  failNextSignIn(error: Error): void
  /** Make every `signIn` reject with this. */
  failSignIn(error: Error | undefined): void
}

export function tokens(overrides: Partial<NaviLinkSessionTokens> = {}): NaviLinkSessionTokens {
  return {
    userSeq: IDENTITY.userSeq,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    credentials: {
      accessKeyId: FAKE_ASIA_KEY,
      secretKey: 'secret',
      sessionToken: 'session',
      endpoint: 'example-ats.iot.us-east-1.amazonaws.com',
      region: 'us-east-1',
    },
    expiresAt: 1_700_000_000_000 + 3_600_000,
    ...overrides,
  }
}

export function listedDevice(overrides: Partial<ListedDevice> = {}): ListedDevice {
  return {
    macAddress: MAC,
    additionalValue: '5089',
    deviceType: 1,
    homeSeq: IDENTITY.homeSeq,
    deviceName: 'Boiler',
    connected: 2,
    ...overrides,
  }
}

/** A REST client that answers from memory. */
export function fakeRest(overrides: {
  tokens?: NaviLinkSessionTokens
  devices?: readonly ListedDevice[]
  firmware?: string | undefined
} = {}): FakeRest {
  const calls: RestCalls = { signIn: [], listDevices: 0, readFirmware: 0 }
  let persistentFailure: Error | undefined
  let onceFailure: Error | undefined

  const rest = {
    signIn: (email: string, password: string) => {
      calls.signIn.push({ email, password })
      if (onceFailure !== undefined) {
        const error = onceFailure
        onceFailure = undefined
        return Promise.reject(error)
      }
      if (persistentFailure !== undefined) {
        return Promise.reject(persistentFailure)
      }
      return Promise.resolve(overrides.tokens ?? tokens())
    },
    listDevices: () => {
      calls.listDevices += 1
      return Promise.resolve([...(overrides.devices ?? [listedDevice()])])
    },
    readFirmware: () => {
      calls.readFirmware += 1
      return Promise.resolve('firmware' in overrides ? overrides.firmware : '4352')
    },
  }

  return {
    rest: rest as unknown as NaviLinkRest,
    calls,
    failNextSignIn: (error) => {
      onceFailure = error
    },
    failSignIn: (error) => {
      persistentFailure = error
    },
  }
}

/** The response topic the session nominates for a kind. */
export function responseTopicFor(kind: 'channelinfo' | 'channelstatus'): string {
  return responseTopic(IDENTITY, kind)
}
