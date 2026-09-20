/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One cloud session for the whole account.
 *
 * The LAN plugins in this family poll each device independently, so a device
 * that goes away affects only itself. Here there is exactly one session: one
 * sign-in, one MQTT connection, one set of credentials, shared by every
 * accessory. That is not a simplification. It is what the service is.
 * Signing in twice would mean two AWS credential sets and two clients
 * competing for the same topics.
 *
 * It follows that this object owns the plugin's whole relationship with the
 * cloud, and that its failure modes are the plugin's failure modes:
 *
 * **A rejected password must not be retried.** Repeating a wrong password
 * every thirty seconds is how an account gets locked. `AuthenticationError`
 * with `credentialsRejected` stops the loop for good and says so once; every
 * other failure is transient and is retried with backoff.
 *
 * **Credentials expire on a clock, not on an error.** The AWS credentials
 * behind the MQTT connection are temporary. Waiting for the connection to
 * fail would mean a window of silence in the middle of a winter night, so the
 * session re-establishes itself a few minutes before the deadline instead.
 * That close is expected: it is not logged as an outage and the tiles stay
 * current, the same way the sibling plugins reconnect after a token refresh.
 *
 * **A connected socket does not mean a live appliance.** The broker will
 * happily hold a connection open for a gateway that has gone offline. So
 * observations carry the time they were taken, and one that has gone stale
 * stops being reported as current. The accessories go to No Response instead
 * of showing yesterday's setpoint.
 */

import { randomUUID } from 'node:crypto'

import {
  decodeChannel,
  familyOf,
  parseChannelInfo,
  parseChannelStatus,
  type ChannelInfo,
} from './api/channel'
import { makeDeviceId, parseDeviceId } from './api/identity'
import { MqttConnection, type MqttConnectionOptions } from './api/mqtt'
import {
  appDisconnectWill,
  channelInfoRequest,
  channelStatusRequest,
  type ControlInput,
  type OutboundFrame,
  type RequestContext,
} from './api/protocol'
import { NaviLinkRest, type ListedDevice, type NaviLinkSessionTokens } from './api/rest'
import { buildTopics, classifyTopic, responseTopic, type GatewayTopics } from './api/topics'
import {
  CONTROL_INTERVAL_FAIL_CODE,
  CONTROL_LOCKOUT_MS,
  CONTROL_RATE_LIMIT_MS,
  CREDENTIAL_REFRESH_MARGIN_MS,
  MIN_REFRESH_DELAY_MS,
  RECONNECT_BACKOFF_BASE_MS,
  RECONNECT_BACKOFF_MAX_MS,
  STALE_OBSERVATION_INTERVALS,
  STATUS_RESPONSE_TIMEOUT_MS,
} from './settings'
import type {
  ChannelObservation,
  PluginLogger,
  RefreshReason,
  ResolvedDevice,
  SessionHealth,
  SessionMetrics,
} from './types'
import {
  AuthenticationError,
  backoffDelayMs,
  CircuitBreakerError,
  ConnectionError,
  ControlRejectedError,
  describeError,
  forLog,
  interruptibleSleep,
  labelAppliance,
  maskEmail,
  MQTT_CHANNEL,
  sleep,
  type ResolvedAccount,
} from './utils'

/**
 * One control command, with enough about it to log and to gate.
 *
 * The command code travels alongside the builder rather than being dug out
 * of the frame, so a log line does not have to re-parse JSON this module
 * just produced.
 */
export interface ControlSpec {
  /** The numeric command. */
  command: number
  /** What this does, in words, for the log. */
  what: string
  build(input: ControlInput & { channelNumber: number }): OutboundFrame
}

/** What the session tells the platform when state arrives. */
export type ObservationListener = (
  deviceId: string,
  observation: ChannelObservation,
  reason: RefreshReason,
) => void

/** What the session tells the platform when the cloud is not answering. */
export type UnreachableListener = (error: unknown) => void

/** What the session tells the platform when one appliance has gone quiet. */
export type StaleListener = (deviceId: string) => void

/** Collaborators, all injectable so tests need no network and no real clock. */
export interface NaviLinkSessionOptions {
  log: PluginLogger
  account: ResolvedAccount
  devices: readonly ResolvedDevice[]
  statusIntervalSec: number
  rest?: NaviLinkRest
  createConnection?: (options: MqttConnectionOptions) => MqttConnection
  now?: () => number
  random?: () => number
  metrics?: SessionMetrics
  /** Fired when REST trips OPEN, so diagnostics can count a trip. */
  onCircuitOpen?: () => void
}

/** Everything the session tracks for one gateway. */
interface GatewayState {
  listed: ListedDevice
  topics: GatewayTopics
  context: RequestContext
  /** Channel descriptions, once `channelinfo` has answered. */
  infoByChannel: Map<number, ChannelInfo>
  /** When a control command was last sent, for rate limiting. */
  lastControlAt: number
  /** Set when the cloud reported a control lockout. Epoch milliseconds. */
  controlLockedUntil: number
}

/** Owns the plugin's entire relationship with the NaviLink cloud. */
export class NaviLinkSession {
  private readonly options: NaviLinkSessionOptions

  private readonly log: PluginLogger

  private readonly rest: NaviLinkRest

  private readonly now: () => number

  private readonly gateways = new Map<string, GatewayState>()

  private readonly observations = new Map<string, ChannelObservation>()

  private readonly observationListeners: ObservationListener[] = []

  private readonly unreachableListeners: UnreachableListener[] = []

  private readonly staleListeners: StaleListener[] = []

  private connection: MqttConnection | undefined

  /** Gateway firmware by MAC, read once per session for the log and bug reports. */
  private readonly firmwareByMac = new Map<string, string>()

  private clientId = randomUUID()

  private running = false

  /** Resolves when the current connection ends, so the loop can wait on it. */
  private sessionEnded: (() => void) | undefined

  private backoffSleep: { interrupt(): void } | undefined

  private statusTimer: ReturnType<typeof setInterval> | undefined

  private refreshTimer: ReturnType<typeof setTimeout> | undefined

  /** Set when the account was rejected, which stops the loop permanently. */
  private fatal: Error | undefined

  /** True while a poll, not a push or a post-set, is asking for status. */
  private pollInFlight = false

  /** Aborts in-flight REST so shutdown does not wait out a 30s request deadline. */
  private readonly abort = new AbortController()

  private expiresAt: number | undefined

  private lastRefreshAt: number | undefined

  private lastMqttEventAt: number | undefined

  /** Families already announced at info, so a later channelinfo is not a new event. */
  private readonly announcedFamilies = new Set<string>()

  /** Firmware lines already announced at info, so a credential refresh is not a new event. */
  private readonly announcedFirmware = new Set<string>()

  /** True after the first `Publish-subscribe (mqtt) up` line, so a refresh is not a boot. */
  private liveAnnounced = false

  /** True after an unexpected drop, so the next connect is a recovery. */
  private liveWasDown = false

  /** True when the current wait ended because this plugin closed the socket. */
  private lastCloseWasExpected = false

  constructor(options: NaviLinkSessionOptions) {
    this.options = options
    this.log = options.log
    this.now = options.now ?? Date.now
    this.rest = options.rest ?? new NaviLinkRest({
      log: options.log,
      signal: this.abort.signal,
      ...(options.onCircuitOpen === undefined ? {} : { onCircuitOpen: options.onCircuitOpen }),
      ...(options.metrics === undefined
        ? {}
        : { metrics: (sample) => options.metrics?.apiRequest(sample.durationMs, sample.ok) }),
    })
  }

  /** Register a handler for fresh state. */
  onObservation(listener: ObservationListener): void {
    this.observationListeners.push(listener)
  }

  /** Register a handler for the cloud becoming unreachable. */
  onUnreachable(listener: UnreachableListener): void {
    this.unreachableListeners.push(listener)
  }

  /** Register a handler for one appliance going stale while the broker is up. */
  onStale(listener: StaleListener): void {
    this.staleListeners.push(listener)
  }

  /** In-memory gauges for diagnostics. Never reads the network. */
  health(): SessionHealth {
    const mqttState = this.fatal !== undefined
      ? 'auth-failed'
      : !this.running
        ? 'stopped'
        : this.connection?.isConnected === true
          ? 'running'
          : 'connecting'
    return {
      mqttState,
      lastMqttEventAt: this.lastMqttEventAt ?? null,
      expiresAt: this.expiresAt ?? null,
      lastRefreshAt: this.lastRefreshAt ?? null,
      onlineDeviceIds: this.options.devices
        .filter((device) => this.observationFor(device.id) !== undefined)
        .map((device) => device.id),
    }
  }

  /** REST circuit-breaker state for diagnostics. Never reads the network. */
  circuitBreakerState(): string {
    return this.rest.getCircuitBreakerStatus().state
  }

  /**
   * The current state of a device, or undefined when there is none to trust.
   *
   * Undefined covers two cases that accessories treat identically: nothing has
   * arrived yet, and what arrived is too old to present as current. See the
   * file header on why a stale reading is not returned.
   */
  observationFor(deviceId: string): ChannelObservation | undefined {
    const observation = this.observations.get(deviceId)
    if (observation === undefined) {
      return undefined
    }
    const maxAgeMs = this.options.statusIntervalSec * 1_000 * STALE_OBSERVATION_INTERVALS
    return this.now() - observation.observedAt > maxAgeMs ? undefined : observation
  }

  /**
   * Adopt the effect of a write before the appliance confirms it.
   *
   * The tile should settle on what was asked for rather than flicking back to
   * the old value for the second it takes a status frame to arrive. The next
   * real observation overwrites this wholesale, so a write that silently did
   * nothing corrects itself rather than sticking.
   */
  applyOptimisticWrite(deviceId: string, patch: Partial<ChannelObservation>): void {
    const existing = this.observations.get(deviceId)
    if (existing === undefined) {
      return
    }
    // Keep the appliance's observedAt. Refreshing it here would keep a
    // dead gateway looking current for as long as HomeKit writes keep landing.
    const merged: ChannelObservation = { ...existing, ...patch, observedAt: existing.observedAt }
    this.observations.set(deviceId, merged)
    this.emit(deviceId, merged, 'post-set')
  }

  /** Start the session and keep it running until {@link stop}. */
  start(): void {
    if (this.running) {
      return
    }
    this.running = true
    void this.runForever()
  }

  /** Stop the session and release everything it holds. */
  async stop(): Promise<void> {
    this.running = false
    this.clearTimers()
    this.backoffSleep?.interrupt()
    this.abort.abort()
    this.dropConnection()
    // A beat, so the DISCONNECT reaches the broker before Homebridge exits and
    // the gateway is not told we vanished when in fact we said goodbye.
    await sleep(50)
  }

  /**
   * Publish a control frame for a device.
   *
   * Rate-limited per gateway, and refused outright while a gateway is in a
   * control lockout. A HomeKit scene can touch several tiles at once, and the
   * cloud answers a burst by locking the account's control channel. See
   * {@link handleControlFailure}.
   */
  async publishControl(deviceId: string, spec: ControlSpec): Promise<void> {
    const parsed = parseDeviceId(deviceId)
    const gateway = parsed === undefined ? undefined : this.gateways.get(parsed.mac)
    const connection = this.connection
    if (parsed === undefined || gateway === undefined || connection?.isConnected !== true) {
      throw new ControlRejectedError('the appliance is not connected')
    }
    if (this.now() < gateway.controlLockedUntil) {
      const seconds = Math.ceil((gateway.controlLockedUntil - this.now()) / 1_000)
      throw new ControlRejectedError(`rate limited; retry in ${seconds}s`)
    }
    const since = this.now() - gateway.lastControlAt
    if (since < CONTROL_RATE_LIMIT_MS) {
      await sleep(CONTROL_RATE_LIMIT_MS - since)
    }
    gateway.lastControlAt = this.now()
    this.options.metrics?.command()

    const frame = spec.build({
      context: gateway.context,
      topics: gateway.topics,
      channelNumber: parsed.channel,
      // The channel-status response topic, not a control-specific one: a
      // control is answered with a status frame rather than an acknowledgement.
      responseTopic: responseTopic(gateway.context, 'channelstatus'),
    })
    await connection.publish(frame.topic, frame.payload, STATUS_RESPONSE_TIMEOUT_MS)
    // A PUBACK only means the broker has it. Confirmation that the appliance
    // acted is a status frame, and asking for one now closes the loop in a
    // second or two rather than at the next poll. The appliance's own
    // post-control frame has been observed carrying the pre-control value, so
    // this deliberately asks again rather than trusting it. A failed ask must
    // not fail the HomeKit write: the command was already accepted.
    try {
      await this.requestStatus(gateway, parsed.channel)
    } catch (error) {
      this.log.debug(`post-control status request failed: ${describeError(error)}`)
    }
  }

  // --- Lifecycle --------------------------------------------------------------

  /**
   * Sign in, connect, and keep doing so.
   *
   * One loop rather than a web of callbacks, so the order of operations is
   * readable and there is exactly one place that decides whether to try again.
   */
  private async runForever(): Promise<void> {
    let attempt = 0
    while (this.running) {
      try {
        await this.establish()
        attempt = 0
        await this.waitForSessionEnd()
        if (!this.running) {
          return
        }
        // A credential refresh closes the socket on purpose. Re-sign-in is
        // immediate, like the sibling plugins' token-refresh reconnect: no
        // outage line, no backoff, no recovery line for a drop we caused.
        if (this.lastCloseWasExpected) {
          continue
        }
      } catch (error) {
        if (error instanceof AuthenticationError && error.credentialsRejected) {
          this.stopPermanently(error)
          return
        }
        this.notifyUnreachable(error)
        if (error instanceof CircuitBreakerError) {
          // The OPEN line already named the outage. Fail-fast until cooldown.
          await this.waitToReconnect(Math.max(error.retryAfterMs, 1_000))
          continue
        }
        attempt += 1
        this.log.warn(`session failed: ${describeError(error)}`)
      }
      if (!this.running) {
        return
      }
      attempt = Math.max(attempt, 1)
      const delay = backoffDelayMs({
        attempt,
        baseMs: RECONNECT_BACKOFF_BASE_MS,
        maxMs: RECONNECT_BACKOFF_MAX_MS,
        ...(this.options.random === undefined ? {} : { random: this.options.random }),
      })
      await this.waitToReconnect(delay)
    }
  }

  /** Sleep the reconnect delay, abortable on shutdown. */
  private async waitToReconnect(delayMs: number): Promise<void> {
    if (!this.running) {
      return
    }
    this.log.info(`reconnect in ${Math.round(delayMs / 1_000)}s`)
    const backoff = interruptibleSleep(delayMs)
    this.backoffSleep = backoff
    await backoff.promise
    this.backoffSleep = undefined
  }

  /** Sign in, list devices, connect MQTT, subscribe, and ask for state. */
  private async establish(): Promise<void> {
    this.clearTimers()
    this.dropConnection()
    const tokens = await this.rest.signIn(this.options.account.email, this.options.account.password)
    this.expiresAt = tokens.expiresAt
    if (this.lastRefreshAt !== undefined) {
      this.options.metrics?.sessionRefresh()
    }
    this.lastRefreshAt = this.now()
    this.log.debug(`signed in as ${maskEmail(this.options.account.email)}`)

    const listed = await this.rest.listDevices({
      email: this.options.account.email,
      accessToken: tokens.accessToken,
    })
    this.adoptGateways(listed, tokens.userSeq)
    if (this.gateways.size === 0) {
      throw new Error('the account has no gateway matching any configured device')
    }
    await this.readFirmware(tokens.accessToken)

    await this.openConnection(tokens)
    this.scheduleRefresh(tokens)
    this.scheduleStatusPolling()
    for (const gateway of this.gateways.values()) {
      await this.requestChannelInfo(gateway)
    }
  }

  /** Match the account's gateways against what the user configured. */
  private adoptGateways(listed: readonly ListedDevice[], userSeq: string): void {
    const wanted = new Set(
      this.options.devices
        .map((device) => parseDeviceId(device.id)?.mac)
        .filter((mac): mac is string => mac !== undefined),
    )
    this.gateways.clear()
    for (const entry of listed) {
      if (!wanted.has(entry.macAddress)) {
        this.log.debug(
          `ignoring ${this.nameFor(entry.macAddress)}: not configured`,
        )
        continue
      }
      if (entry.connected !== 2) {
        this.log.warn(
          `${this.nameFor(entry.macAddress)}: cloud reports offline; subscribing`,
        )
      }
      const context: RequestContext = {
        macAddress: entry.macAddress,
        deviceType: entry.deviceType,
        homeSeq: entry.homeSeq,
        additionalValue: entry.additionalValue,
        userSeq,
        clientId: this.clientId,
      }
      this.gateways.set(entry.macAddress, {
        listed: entry,
        topics: buildTopics(context),
        context,
        infoByChannel: new Map(),
        lastControlAt: 0,
        controlLockedUntil: 0,
      })
    }
    for (const mac of wanted) {
      if (!this.gateways.has(mac)) {
        this.log.warn(`${this.nameFor(mac)}: not on this account`)
      }
    }
  }

  /**
   * Read each gateway's firmware, once per session.
   *
   * Only so the log says which firmware a report is about. The endpoint that
   * carries it also carries the installation's street address and
   * coordinates, which is why it is read through a method that takes only the
   * version and why nothing else from that response is available here.
   *
   * Never fatal: this endpoint has been seen answering 403 on accounts whose
   * device list works perfectly well, and an unknown firmware is not a reason
   * to refuse to run.
   */
  private async readFirmware(accessToken: string): Promise<void> {
    for (const gateway of this.gateways.values()) {
      try {
        const firmware = await this.rest.readFirmware({
          email: this.options.account.email,
          accessToken,
          macAddress: gateway.listed.macAddress,
          additionalValue: gateway.listed.additionalValue,
        })
        if (firmware !== undefined) {
          this.firmwareByMac.set(gateway.listed.macAddress, firmware)
          const line = `${this.nameFor(gateway.listed.macAddress)} firmware ${firmware}`
          const key = `${gateway.listed.macAddress}:${firmware}`
          if (this.announcedFirmware.has(key)) {
            this.log.debug(line)
          } else {
            this.announcedFirmware.add(key)
            this.log.info(line)
          }
        }
      } catch (error) {
        this.log.debug(`could not read gateway firmware: ${describeError(error)}`)
      }
    }
  }

  /** The gateway firmware behind a device, when the cloud disclosed it. */
  firmwareFor(deviceId: string): string | undefined {
    const mac = parseDeviceId(deviceId)?.mac
    return mac === undefined ? undefined : this.firmwareByMac.get(mac)
  }

  /** Appliance name from config, or a labelled masked gateway if there is none. */
  private nameFor(mac: string, channel?: number): string {
    const onGateway = this.options.devices.filter((device) => parseDeviceId(device.id)?.mac === mac)
    const exact = channel === undefined
      ? undefined
      : onGateway.find((device) => parseDeviceId(device.id)?.channel === channel)
    return labelAppliance({ mac, name: exact?.name ?? onGateway[0]?.name })
  }

  /**
   * Open the MQTT connection, trying both Host header signatures.
   *
   * The two forms are both defensible readings of the SigV4 rule for a default
   * port, and the wrong one fails as a silent rejected upgrade that is
   * indistinguishable from a bad password. Measured against this endpoint the
   * bare host works, so that is first; the other is tried rather than leaving
   * a user to guess which of the two their region wants.
   */
  private async openConnection(tokens: NaviLinkSessionTokens): Promise<void> {
    let lastError: unknown
    for (const signHostWithPort of [false, true]) {
      const connection = this.buildConnection(tokens, signHostWithPort)
      try {
        await connection.connect()
        await this.subscribeAll(connection)
        this.connection = connection
        // Close is only a session event after the connection is the live one.
        // A refused fallback must not look like an outage mid-establish.
        connection.onClose((error) => this.handleConnectionClosed(connection, error))
        if (!this.liveAnnounced || this.liveWasDown) {
          this.log.info(`${MQTT_CHANNEL} up`)
          this.liveAnnounced = true
          this.liveWasDown = false
        } else {
          this.log.debug(`${MQTT_CHANNEL} up`)
        }
        return
      } catch (error) {
        lastError = error
        connection.close()
        this.log.debug(
          `${MQTT_CHANNEL} connect failed with host${signHostWithPort ? ':443' : ''} signature: `
          + describeError(error),
        )
      }
    }
    throw lastError instanceof Error ? lastError : new Error('could not open the MQTT connection')
  }

  private buildConnection(
    tokens: NaviLinkSessionTokens,
    signHostWithPort: boolean,
  ): MqttConnection {
    // One gateway's will, because a will is per connection and there is one
    // connection. On a multi-gateway account the others simply do not get the
    // courtesy notice, which costs nothing: it only tells a gateway whether an
    // app is watching.
    const first = [...this.gateways.values()][0]
    const options: MqttConnectionOptions = {
      log: this.log,
      credentials: tokens.credentials,
      clientId: this.clientId,
      signHostWithPort,
      ...(first === undefined ? {} : {
        will: {
          topic: first.topics.appConnection,
          payload: appDisconnectWill(first.context, first.topics.appConnection),
          qos: 1,
          retain: false,
        },
      }),
    }
    const connection = this.options.createConnection?.(options) ?? new MqttConnection(options)
    connection.onMessage((message) => this.handleMessage(message.topic, message.payload))
    return connection
  }

  private async subscribeAll(connection: MqttConnection): Promise<void> {
    const topics = [...this.gateways.values()]
      .flatMap((gateway) => gateway.topics.subscriptions)
      .map((topic) => ({ topic, qos: 1 as const }))
    await connection.subscribe(topics)
  }

  private handleConnectionClosed(from: MqttConnection, error: Error): void {
    if (this.connection !== from) {
      return
    }
    this.connection = undefined
    this.clearTimers()
    this.lastCloseWasExpected = error instanceof ConnectionError && error.expected
    if (this.running && !this.lastCloseWasExpected) {
      this.liveWasDown = true
      this.options.metrics?.mqttReconnect()
      this.notifyUnreachable(error)
    }
    const ended = this.sessionEnded
    this.sessionEnded = undefined
    ended?.()
  }

  private waitForSessionEnd(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sessionEnded = resolve
    })
  }

  /** Stop trying, and say why exactly once. */
  private stopPermanently(error: Error): void {
    this.running = false
    this.fatal = error
    this.clearTimers()
    this.dropConnection()
    this.log.error(`${error.message}; sign-in stopped`)
    this.notifyUnreachable(error)
  }

  /** True when the session has given up for a reason the user must fix. */
  get hasStoppedPermanently(): boolean {
    return this.fatal !== undefined
  }

  // --- Requests ---------------------------------------------------------------

  private async requestChannelInfo(gateway: GatewayState): Promise<void> {
    const connection = this.connection
    if (connection?.isConnected !== true) {
      return
    }
    const frame = channelInfoRequest({
      context: gateway.context,
      topics: gateway.topics,
      responseTopic: responseTopic(gateway.context, 'channelinfo'),
    })
    await connection.publish(frame.topic, frame.payload, STATUS_RESPONSE_TIMEOUT_MS)
  }

  private async requestStatus(gateway: GatewayState, channelNumber: number): Promise<void> {
    const connection = this.connection
    if (connection?.isConnected !== true) {
      return
    }
    const info = gateway.infoByChannel.get(channelNumber)
    const unitCount = readUnitCount(info)
    const frame = channelStatusRequest({
      context: gateway.context,
      topics: gateway.topics,
      responseTopic: responseTopic(gateway.context, 'channelstatus'),
      channelNumber,
      unitCount,
    })
    await connection.publish(frame.topic, frame.payload, STATUS_RESPONSE_TIMEOUT_MS)
  }

  /** Ask every known channel for its state. Returns how many requests failed. */
  private async requestAllStatus(): Promise<number> {
    let failed = 0
    for (const gateway of this.gateways.values()) {
      for (const channelNumber of gateway.infoByChannel.keys()) {
        try {
          await this.requestStatus(gateway, channelNumber)
        } catch (error) {
          failed += 1
          this.log.debug(`status request failed: ${describeError(error)}`)
        }
      }
    }
    return failed
  }

  // --- Inbound ----------------------------------------------------------------

  private handleMessage(topic: string, payload: string): void {
    this.lastMqttEventAt = this.now()
    const kind = classifyTopic(topic)
    if (kind === 'other') {
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(payload)
    } catch {
      this.log.debug(`ignoring a ${kind} frame that is not JSON`)
      return
    }
    const gateway = this.gatewayForTopic(topic)
    if (gateway === undefined) {
      return
    }
    switch (kind) {
      case 'channelinfo':
        this.handleChannelInfo(gateway, frame)
        return
      case 'channelstatus':
        this.handleChannelStatus(gateway, frame)
        return
      case 'controlfail':
        this.handleControlFailure(gateway, frame)
        return
      case 'connection':
        this.log.debug(`${this.nameFor(gateway.listed.macAddress)}: gateway connection event`)
        return
    }
  }

  /**
   * Which gateway a frame is about.
   *
   * Answers arrive on the gateway prefix, which contains the MAC, so a frame
   * can be attributed even though it may be the answer to somebody else's
   * request: the NaviLink app on a phone, or the wall controller. That is how
   * a setpoint changed elsewhere reaches HomeKit without being asked for.
   */
  private gatewayForTopic(topic: string): GatewayState | undefined {
    for (const [mac, gateway] of this.gateways) {
      if (topic.includes(`navilink-${mac}`)) {
        return gateway
      }
    }
    // A session-prefix topic carries no MAC. With one gateway there is no
    // ambiguity; with several the frame is dropped rather than attributed to
    // the wrong appliance, and the gateway prefix carries it anyway.
    return this.gateways.size === 1 ? [...this.gateways.values()][0] : undefined
  }

  /**
   * A refused control command.
   *
   * This arrives on its own topic rather than as an answer to the publish, so
   * it cannot be handed back to the accessory that asked. The frame names no
   * command and echoes no correlation value that survives the round trip.
   * (The cloud truncates the `sessionID` it echoes from milliseconds to
   * seconds, so matching on it does not work either.) It is therefore logged,
   * not thrown, and logged as a warning because a control that
   * silently did nothing is exactly what a user needs to see.
   *
   * `failCode` 2 is the one documented value: commands sent too quickly. The
   * gateway is locked out of control for a while afterwards, so the plugin
   * stops sending rather than hammering a channel that is refusing.
   */
  private handleControlFailure(gateway: GatewayState, frame: unknown): void {
    const response = frame as { response?: { failCode?: unknown } }
    const failCode = response.response?.failCode
    const label = this.nameFor(gateway.listed.macAddress)

    if (failCode === CONTROL_INTERVAL_FAIL_CODE) {
      gateway.controlLockedUntil = this.now() + CONTROL_LOCKOUT_MS
      this.log.warn(
        `${label}: rate limited; pause ${Math.round(CONTROL_LOCKOUT_MS / 1_000)}s`,
      )
      return
    }
    this.log.warn(
      `${label}: control refused`
      + `${typeof failCode === 'number' ? ` (failCode ${failCode})` : ''}`,
    )
  }

  private handleChannelInfo(gateway: GatewayState, frame: unknown): void {
    const channels = parseChannelInfo(frame)
    if (channels.length === 0) {
      return
    }
    for (const channel of channels) {
      gateway.infoByChannel.set(channel.channelNumber, channel)
    }
    this.log.debug(
      `${this.nameFor(gateway.listed.macAddress)}: ${channels.length} channel(s) described`,
    )
    this.logChannelFamilies(gateway)
    this.warnMissingChannels(gateway)
    // Now that the channels and their unit counts are known, ask each for its
    // state. Nothing before this point can be decoded: `channelinfo` carries
    // the temperature scale.
    void this.requestAllStatus()
  }

  private handleChannelStatus(gateway: GatewayState, frame: unknown): void {
    const status = parseChannelStatus(frame)
    if (status === undefined) {
      return
    }
    const info = gateway.infoByChannel.get(status.channelNumber)
    if (info === undefined) {
      // A status frame before its description. Nothing can be read from it, so
      // ask for the description rather than guessing at the scale.
        this.log.debug(
          `${this.nameFor(gateway.listed.macAddress)}: status before channelinfo; requesting`,
        )
      void this.requestChannelInfo(gateway)
      return
    }
    const observation = decodeChannel({ info, status, now: this.now() })
    if (observation === undefined) {
      this.log.debug(`${this.nameFor(gateway.listed.macAddress)}: scale unknown`)
      return
    }
    const deviceId = makeDeviceId(gateway.listed.macAddress, status.channelNumber)
    const reason: RefreshReason = this.observations.has(deviceId)
      ? (this.pollInFlight ? 'poll' : 'push')
      : 'startup'
    this.observations.set(deviceId, observation)
    if (reason === 'push') {
      this.options.metrics?.push()
    }
    this.emit(deviceId, observation, reason)
  }

  private emit(deviceId: string, observation: ChannelObservation, reason: RefreshReason): void {
    for (const listener of this.observationListeners) {
      try {
        listener(deviceId, observation, reason)
      } catch (error) {
        this.log.debug(`an observation listener threw: ${describeError(error)}`)
      }
    }
  }

  private notifyUnreachable(error: unknown): void {
    this.observations.clear()
    for (const listener of this.unreachableListeners) {
      try {
        listener(error)
      } catch (listenerError) {
        this.log.debug(`an unreachable listener threw: ${describeError(listenerError)}`)
      }
    }
  }

  // --- Timers -----------------------------------------------------------------

  private scheduleStatusPolling(): void {
    this.statusTimer = setInterval(() => {
      void this.pollAllStatus()
    }, this.options.statusIntervalSec * 1_000)
    this.statusTimer.unref?.()
  }

  /** Ask every known channel, labelled as a poll so accessories can tell. */
  private async pollAllStatus(): Promise<void> {
    this.pollInFlight = true
    const started = this.now()
    let failed = 0
    try {
      failed = await this.requestAllStatus()
    } catch {
      failed += 1
    } finally {
      this.pollInFlight = false
      this.dropStaleObservations()
      this.options.metrics?.pollCycle(failed === 0 ? 1 : 0, failed, this.now() - started)
    }
  }

  /**
   * Push No Response for appliances whose last frame is now too old.
   *
   * The broker can stay connected while a gateway is dead. `observationFor`
   * already hides those readings from GET; this makes the tile follow now.
   */
  private dropStaleObservations(): void {
    const stale: string[] = []
    for (const deviceId of this.observations.keys()) {
      if (this.observationFor(deviceId) === undefined) {
        stale.push(deviceId)
      }
    }
    for (const deviceId of stale) {
      this.observations.delete(deviceId)
      for (const listener of this.staleListeners) {
        try {
          listener(deviceId)
        } catch (error) {
          this.log.debug(`a stale listener threw: ${describeError(error)}`)
        }
      }
    }
  }

  /** Close the live socket without treating a leftover as the current one. */
  private dropConnection(): void {
    const existing = this.connection
    this.connection = undefined
    existing?.close()
  }

  /**
   * One line per channel so a bug report can say `family=` without a capture.
   *
   * Channelinfo can arrive again on a poll, a reconnect, or a credential
   * refresh. The first time is the useful one; repeats stay at debug.
   */
  private logChannelFamilies(gateway: GatewayState): void {
    for (const channel of gateway.infoByChannel.values()) {
      const family = familyOf(channel.raw)
      const line = `${this.nameFor(gateway.listed.macAddress, channel.channelNumber)} `
        + `channel ${channel.channelNumber} family=${family}`
      const key = `${gateway.listed.macAddress}:${channel.channelNumber}:${family}`
      if (this.announcedFamilies.has(key)) {
        this.log.debug(line)
        continue
      }
      this.announcedFamilies.add(key)
      this.log.info(line)
    }
  }

  /** A configured id whose channel is missing stays No Response otherwise. */
  private warnMissingChannels(gateway: GatewayState): void {
    for (const device of this.options.devices) {
      const parsed = parseDeviceId(device.id)
      if (parsed === undefined || parsed.mac !== gateway.listed.macAddress) {
        continue
      }
      if (!gateway.infoByChannel.has(parsed.channel)) {
        this.log.warn(
          `${forLog(device.name)} channel ${parsed.channel}: not on gateway`,
        )
      }
    }
  }

  /**
   * Re-establish the session before its credentials expire.
   *
   * Closing the connection is what wakes {@link runForever}, which signs in
   * again from the top. Refreshing in place would be less disruptive and is
   * not done, because there is no confirmed refresh endpoint: a full sign-in
   * is the only path known to produce a working set of AWS credentials, and a
   * brief reconnect on a timer we choose is better than an expiry we do not
   * control.
   *
   * The close is marked expected, so it is not logged as an outage and does
   * not put the tiles into No Response. Sibling plugins do the same on a
   * token-refresh reconnect.
   */
  private scheduleRefresh(tokens: NaviLinkSessionTokens): void {
    const delay = Math.max(
      MIN_REFRESH_DELAY_MS,
      tokens.expiresAt - this.now() - CREDENTIAL_REFRESH_MARGIN_MS,
    )
    this.refreshTimer = setTimeout(() => {
      this.log.debug('credentials expiring; refresh')
      // A fresh client id, so the broker cannot mistake the new connection for
      // the old one and disconnect it as a duplicate.
      this.clientId = randomUUID()
      this.connection?.close()
    }, delay)
    this.refreshTimer.unref?.()
  }

  private clearTimers(): void {
    if (this.statusTimer !== undefined) {
      clearInterval(this.statusTimer)
      this.statusTimer = undefined
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }
}

/** How many units a channel has, defaulting safely when it has not said. */
function readUnitCount(info: ChannelInfo | undefined): number {
  const raw = info?.raw.unitCount
  return typeof raw === 'number' && raw >= 1 ? Math.trunc(raw) : 1
}
