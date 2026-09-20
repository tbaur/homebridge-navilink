/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One-shot sign-in, for the settings page and the scripts.
 *
 * The LAN plugins in this family discover over mDNS and can describe a device
 * from the first reply. Here the account is the directory: signing in lists
 * the gateways, and only a gateway itself can say what is attached to it. So
 * this does the whole round trip (sign in, list, connect, ask each gateway
 * to describe its channels) and then puts everything down again.
 *
 * It is deliberately not the session. The session is a long-lived thing with
 * reconnects, backoff and a credential clock; this runs inside a settings
 * page that the user may close at any moment, so every part of it is bounded
 * and nothing is retried. If it cannot answer within the budget, the page
 * says so and the user presses the button again.
 *
 * Two views of the same round trip. {@link NaviLinkDiscovery.discover}
 * returns capabilities, which is what the settings page needs to offer a
 * recirculation switch only where a pump is fitted.
 * {@link NaviLinkDiscovery.capture} returns the raw frames, which is what a
 * fixture and a bug report need. They are one class because they are one
 * conversation with the cloud, and keeping them apart would mean two
 * implementations of a handshake that is fiddly enough once.
 */

import { randomUUID } from 'node:crypto'

import {
  familyOf,
  formatFamily,
  hasDomesticHotWater,
  hasUsableHeatingLoop,
  isFlagOn,
  parseChannelInfo,
  type ChannelInfo,
} from './api/channel'
import { makeDeviceId } from './api/identity'
import { MqttConnection, type MqttConnectionOptions } from './api/mqtt'
import {
  channelInfoRequest,
  channelStatusRequest,
  type RequestContext,
} from './api/protocol'
import { NaviLinkRest, type ListedDevice } from './api/rest'
import { buildTopics, classifyTopic, responseTopic, type FrameKind } from './api/topics'
import { DEFAULT_MODEL, DISCOVERY_BUDGET_MS, STATUS_RESPONSE_TIMEOUT_MS } from './settings'
import type { DiscoveredDevice, PluginLogger } from './types'
import {
  describeError,
  forDisplay,
  labelAppliance,
  maskMac,
  maskMacsIn,
  raceTimeout,
  redactObject,
  TIMED_OUT,
} from './utils'

/** Collaborators, injectable so the tests need no network. */
export interface DiscoveryOptions {
  log: PluginLogger
  rest?: NaviLinkRest
  createConnection?: (options: MqttConnectionOptions) => MqttConnection
}

/** One raw frame, as the gateway sent it. */
export interface CapturedFrame {
  kind: FrameKind
  /** Gateway MAC this frame came from, unmasked: a capture is a local file. */
  macAddress: string
  channelNumber: number | undefined
  frame: unknown
}

/** An open, subscribed conversation with one gateway. */
interface GatewayConversation {
  entry: ListedDevice
  context: RequestContext
  topics: ReturnType<typeof buildTopics>
}

/** Signs in once and reports what the account owns. */
export class NaviLinkDiscovery {
  private readonly log: PluginLogger

  private readonly rest: NaviLinkRest

  private readonly options: DiscoveryOptions

  constructor(options: DiscoveryOptions) {
    this.options = options
    this.log = options.log
    this.rest = options.rest ?? new NaviLinkRest({ log: options.log })
  }

  /** Sign in and describe every appliance on the account. */
  async discover(email: string, password: string): Promise<DiscoveredDevice[]> {
    const found: DiscoveredDevice[] = []

    await this.withConnection(email, password, async (session) => {
      const firmware = await this.readFirmware(email, session.accessToken, session.gateways)
      for (const gateway of session.gateways) {
        const { channels } = await session.describe(gateway)
        const extra = firmware.has(gateway.entry.macAddress)
          ? { firmware: firmware.get(gateway.entry.macAddress) }
          : {}
        if (channels.length > 0) {
          found.push(...channels.map((channel) => describeChannel({
            entry: gateway.entry,
            channel,
            ...extra,
          })))
          continue
        }
        // The cloud said this gateway is offline and it did not describe
        // itself. Still list it, so the settings card can say so.
        if (gateway.entry.connected !== 2) {
          found.push(describeListedGateway({
            entry: gateway.entry,
            ...extra,
          }))
        }
      }
    })
    return found
  }

  /**
   * Sign in and record the raw frames every channel answers with.
   *
   * For fixtures and bug reports. `redact` removes the account, the tokens
   * and the MAC addresses; it is the default for anything a user will paste
   * somewhere public, and it is off only when recording a fixture that
   * `scripts/pseudonymise.js` will rewrite deliberately.
   */
  async capture(input: {
    email: string
    password: string
    redact?: boolean
  }): Promise<CapturedFrame[]> {
    const captured: CapturedFrame[] = []

    await this.withConnection(input.email, input.password, async (session) => {
      for (const gateway of session.gateways) {
        const { channels, frame } = await session.describe(gateway)
        for (const channel of channels) {
          captured.push({
            kind: 'channelinfo',
            macAddress: gateway.entry.macAddress,
            channelNumber: channel.channelNumber,
            frame,
          })
          const status = await session.readStatus(gateway, channel)
          if (status !== undefined) {
            captured.push({
              kind: 'channelstatus',
              macAddress: gateway.entry.macAddress,
              channelNumber: channel.channelNumber,
              frame: status,
            })
          }
        }
      }
    })

    if (input.redact !== true) {
      return captured
    }
    // Every MAC in the capture, not just this frame's: a cascade's frames
    // name their siblings, and a capture is only safe to paste if all of
    // them are gone.
    const macAddresses = [...new Set(captured.map((entry) => entry.macAddress))]
    return captured.map((entry) => ({
      ...entry,
      macAddress: maskMac(entry.macAddress),
      frame: maskMacsIn(redactObject(entry.frame), macAddresses),
    }))
  }

  /**
   * Sign in, connect, run the caller's work, and always hang up.
   *
   * The connection is closed on every path, including the timeout. A leaked
   * MQTT connection in a UI process is worse than it sounds: that process
   * outlives the request and would hold a client id the real session then
   * competes with.
   */
  private async withConnection(
    email: string,
    password: string,
    work: (session: DiscoverySession) => Promise<void>,
  ): Promise<void> {
    const tokens = await this.rest.signIn(email, password)
    const listed = await this.rest.listDevices({ email, accessToken: tokens.accessToken })
    if (listed.length === 0) {
      this.log.warn('no gateways on account')
      return
    }

    for (const entry of listed) {
      if (entry.connected !== 2) {
        // Cloud labels are often rooms. The settings page can show them; the log cannot.
        this.log.warn(`${labelAppliance({ mac: entry.macAddress })}: cloud reports offline`)
      }
    }

    const clientId = randomUUID()
    await this.withMqttSession({
      tokens,
      listed,
      clientId,
      work,
    })
  }

  /**
   * Open MQTT, trying both Host header signatures, then run the work.
   *
   * The connection is closed on every path, including the timeout.
   */
  private async withMqttSession(input: {
    tokens: Awaited<ReturnType<NaviLinkRest['signIn']>>
    listed: readonly ListedDevice[]
    clientId: string
    work: (session: DiscoverySession) => Promise<void>
  }): Promise<void> {
    let lastError: unknown
    for (const signHostWithPort of [false, true]) {
      const opened = await this.tryMqttSession({ ...input, signHostWithPort })
      if (opened === true) {
        return
      }
      lastError = opened
    }
    throw lastError instanceof Error ? lastError : new Error('could not open the MQTT connection')
  }

  /**
   * One signature attempt. Returns true on success, or the connect error.
   *
   * An error after the connection is up is thrown, not returned: that is the
   * caller's work failing, not a reason to try `:443`.
   */
  private async tryMqttSession(input: {
    tokens: Awaited<ReturnType<NaviLinkRest['signIn']>>
    listed: readonly ListedDevice[]
    clientId: string
    signHostWithPort: boolean
    work: (session: DiscoverySession) => Promise<void>
  }): Promise<true | unknown> {
    const connectionOptions: MqttConnectionOptions = {
      log: this.log,
      credentials: input.tokens.credentials,
      clientId: input.clientId,
      signHostWithPort: input.signHostWithPort,
    }
    const connection = this.options.createConnection?.(connectionOptions)
      ?? new MqttConnection(connectionOptions)
    let opened = false
    try {
      const session = new DiscoverySession({
        log: this.log,
        connection,
        listed: input.listed,
        userSeq: input.tokens.userSeq,
        clientId: input.clientId,
        accessToken: input.tokens.accessToken,
      })
      await session.open()
      opened = true
      const outcome = await raceTimeout(input.work(session), DISCOVERY_BUDGET_MS)
      if (outcome === TIMED_OUT) {
        this.log.warn(
          `discovery timeout ${Math.round(DISCOVERY_BUDGET_MS / 1_000)}s; incomplete`,
        )
      }
      return true
    } catch (error) {
      if (opened) {
        throw error
      }
      this.log.debug(
        `MQTT connect failed with host${input.signHostWithPort ? ':443' : ''} signature: `
        + describeError(error),
      )
      return error
    } finally {
      connection.close()
    }
  }

  /**
   * Read each gateway's firmware, for the card.
   *
   * Cosmetic, so a failure is not one: this endpoint answers 403 on some
   * accounts whose device list works perfectly well. The same endpoint also
   * carries the installation's street address and coordinates, which is why
   * it is read through a method that returns only the version.
   */
  private async readFirmware(
    email: string,
    accessToken: string,
    gateways: readonly GatewayConversation[],
  ): Promise<Map<string, string>> {
    const byMac = new Map<string, string>()
    for (const gateway of gateways) {
      try {
        const version = await this.rest.readFirmware({
          email,
          accessToken,
          macAddress: gateway.entry.macAddress,
          additionalValue: gateway.entry.additionalValue,
        })
        if (version !== undefined) {
          byMac.set(gateway.entry.macAddress, version)
        }
      } catch (error) {
        this.log.debug(`could not read gateway firmware: ${describeError(error)}`)
      }
    }
    return byMac
  }
}

/**
 * The live half of a discovery: a connection, and the gateways on it.
 *
 * Separated from {@link NaviLinkDiscovery} so that the request-and-wait
 * bookkeeping is in one place and the two public views above read as what
 * they ask for rather than as topic plumbing.
 */
class DiscoverySession {
  readonly gateways: GatewayConversation[]

  readonly accessToken: string

  private readonly log: PluginLogger

  private readonly connection: MqttConnection

  private waiting: {
    kind: FrameKind
    mac: string
    sessionPrefix: string
    resolve: (frame: unknown) => void
  } | undefined

  constructor(input: {
    log: PluginLogger
    connection: MqttConnection
    listed: readonly ListedDevice[]
    userSeq: string
    clientId: string
    accessToken: string
  }) {
    this.log = input.log
    this.connection = input.connection
    this.accessToken = input.accessToken
    this.gateways = input.listed.map((entry) => {
      const context: RequestContext = {
        macAddress: entry.macAddress,
        deviceType: entry.deviceType,
        homeSeq: entry.homeSeq,
        additionalValue: entry.additionalValue,
        userSeq: input.userSeq,
        clientId: input.clientId,
      }
      return { entry, context, topics: buildTopics(context) }
    })
  }

  /** Connect and subscribe to every gateway's answers. */
  async open(): Promise<void> {
    this.connection.onMessage((message) => this.receive(message.topic, message.payload))
    await this.connection.connect()
    for (const gateway of this.gateways) {
      await this.connection.subscribe(
        gateway.topics.subscriptions.map((topic) => ({ topic, qos: 1 as const })),
      )
    }
  }

  /**
   * Ask a gateway to describe its channels.
   *
   * The raw frame is returned alongside the parsed channels because a
   * fixture capture needs the bytes and re-reading them from a cache keyed
   * by kind would attribute one gateway's frame to another.
   */
  async describe(
    gateway: GatewayConversation,
  ): Promise<{ channels: ChannelInfo[]; frame: unknown }> {
    const frame = await this.exchange(gateway, 'channelinfo', channelInfoRequest({
      context: gateway.context,
      topics: gateway.topics,
      responseTopic: responseTopic(gateway.context, 'channelinfo'),
    }))
    if (frame === undefined) {
      this.log.warn(`${labelAppliance({ mac: gateway.entry.macAddress })}: no channelinfo`)
      return { channels: [], frame: undefined }
    }
    return { channels: parseChannelInfo(frame), frame }
  }

  /** Ask one channel for its current state. */
  async readStatus(
    gateway: GatewayConversation,
    channel: ChannelInfo,
  ): Promise<unknown | undefined> {
    const unitCount = typeof channel.raw.unitCount === 'number' && channel.raw.unitCount >= 1
      ? Math.trunc(channel.raw.unitCount)
      : 1
    return this.exchange(gateway, 'channelstatus', channelStatusRequest({
      context: gateway.context,
      topics: gateway.topics,
      responseTopic: responseTopic(gateway.context, 'channelstatus'),
      channelNumber: channel.channelNumber,
      unitCount,
    }))
  }

  /** Publish a request and wait for the matching answer, or give up. */
  private async exchange(
    gateway: GatewayConversation,
    kind: FrameKind,
    request: { topic: string; payload: string },
  ): Promise<unknown | undefined> {
    const sessionTopic = responseTopic(gateway.context, kind)
    const sessionPrefix = sessionTopic.slice(0, sessionTopic.lastIndexOf('/') + 1)
    const answered = new Promise<unknown>((resolve) => {
      this.waiting = {
        kind,
        mac: gateway.entry.macAddress,
        sessionPrefix,
        resolve,
      }
    })
    await this.connection.publish(request.topic, request.payload, STATUS_RESPONSE_TIMEOUT_MS)
    const frame = await raceTimeout(answered, STATUS_RESPONSE_TIMEOUT_MS)
    this.waiting = undefined
    return frame === TIMED_OUT ? undefined : frame
  }

  private receive(topic: string, payload: string): void {
    const kind = classifyTopic(topic)
    let frame: unknown
    try {
      frame = JSON.parse(payload)
    } catch {
      return
    }
    if (this.waiting?.kind === kind && this.topicBelongsToWaiter(topic, this.waiting)) {
      const resolve = this.waiting.resolve
      this.waiting = undefined
      resolve(frame)
    }
  }

  /**
   * True when this frame is an answer for the gateway we just asked.
   *
   * Two gateways are subscribed at once and described one after another. A
   * match on kind alone would hand gateway B's `channelinfo` to A. The
   * gateway prefix carries the MAC; the session prefix is unique per
   * `homeSeq`.
   */
  private topicBelongsToWaiter(
    topic: string,
    waiting: { mac: string; sessionPrefix: string },
  ): boolean {
    const mac = waiting.mac.toLowerCase()
    return topic.toLowerCase().includes(`navilink-${mac}`)
      || topic.startsWith(waiting.sessionPrefix)
  }
}

/**
 * Turn one channel description into something the settings page can offer.
 *
 * The capability flags are the whole point. Offering a recirculation switch
 * for a pump that is not fitted produces an accessory that is permanently No
 * Response, which reads as a broken plugin rather than as an appliance
 * without that feature.
 */
function describeChannel(input: {
  entry: ListedDevice
  channel: ChannelInfo
  firmware?: string | undefined
}): DiscoveredDevice {
  const { entry, channel, firmware } = input
  const family = familyOf(channel.raw)
  const channelNumber = channel.channelNumber
  const base = forDisplay(entry.deviceName) ?? 'NaviLink'
  return {
    ...(firmware === undefined ? {} : { firmware }),
    id: makeDeviceId(entry.macAddress, channelNumber),
    // A cascade has several channels behind one gateway name, so the channel
    // is only in the name when it disambiguates something.
    name: channelNumber > 1 ? `${base} ${channelNumber}` : base,
    mac: entry.macAddress,
    channel: channelNumber,
    family,
    model: family === 'UNKNOWN' ? DEFAULT_MODEL : formatFamily(family),
    online: entry.connected === 2,
    described: true,
    capabilities: {
      dhw: hasDomesticHotWater(family),
      heating: hasUsableHeatingLoop(channel.raw),
      // Either flag on its own is enough. `onDemandUse` is the button and
      // `recirculationUse` is a pump on a timer; both are driven by the same
      // command, and an installation can have one without the other.
      recirculation: isFlagOn(channel.raw.onDemandUse) || isFlagOn(channel.raw.recirculationUse),
      outdoorSensor: isFlagOn(channel.raw.outdoorTempSensorUse),
    },
  }
}

/**
 * A gateway the cloud listed that never described its channels.
 *
 * Used only when the cloud already said it is offline. Channel 1 is a guess
 * so the card has a stable id; a later successful sign-in replaces it.
 */
function describeListedGateway(input: {
  entry: ListedDevice
  firmware?: string | undefined
}): DiscoveredDevice {
  const { entry, firmware } = input
  return {
    ...(firmware === undefined ? {} : { firmware }),
    id: makeDeviceId(entry.macAddress, 1),
    name: forDisplay(entry.deviceName) ?? 'NaviLink',
    mac: entry.macAddress,
    channel: 1,
    family: 'UNKNOWN',
    model: DEFAULT_MODEL,
    online: false,
    described: false,
    capabilities: {
      dhw: false,
      heating: false,
      recirculation: false,
      outdoorSensor: false,
    },
  }
}
