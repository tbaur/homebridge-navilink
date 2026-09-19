/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One MQTT-over-WebSocket connection to AWS IoT.
 *
 * This is the transport and nothing else: it knows about packets, packet
 * identifiers, keepalive and the socket. It knows nothing about NaviLink
 * topics, commands or appliances, which live in `protocol.ts` and `session.ts`.
 * The split is what lets the whole of this file be tested against a stand-in
 * socket with no network and no clock.
 *
 * Three behaviours here are load-bearing and easy to leave out.
 *
 * **An unanswered ping ends the connection.** A WebSocket can stay open with
 * nothing behind it: a NAT that dropped the mapping, a broker that vanished
 * without a close frame. Nothing surfaces that except a ping that goes
 * unanswered, and without this check the plugin reports yesterday's setpoint
 * as current state for as long as the socket stays nominally open.
 *
 * **A failure is terminal for the connection, never for the process.** Every
 * error path ends in {@link fail}, which settles anything waiting, reports
 * once, and hands control to the owner to decide about reconnecting. Nothing
 * here retries: a transport that reconnects itself competes with the session
 * above it that also wants to.
 *
 * **The signed URL is never logged.** It carries the session token. The one
 * thing this file prints about its destination is the endpoint host.
 */

import {
  MQTT_CONNECT_TIMEOUT_MS,
  MQTT_KEEPALIVE_SEC,
  MQTT_PING_TIMEOUT_MS,
  MQTT_SUBSCRIBE_TIMEOUT_MS,
} from '../settings'
import type { PluginLogger } from '../types'
import { ConnectionError, ProtocolError } from '../utils/errors'
import { describeError } from '../utils/errors'
import {
  describeConnackReturnCode,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePuback,
  encodePublish,
  encodeSubscribe,
  isSubscribeFailure,
  PacketDecoder,
  PacketType,
  type DecodedPacket,
  type Subscription,
  type WillMessage,
} from './mqtt-codec'
import { presignIotWebsocketUrl, type IotCredentials } from './sigv4'

/** Callbacks a socket implementation must drive. */
export interface SocketHandlers {
  onOpen(): void
  onMessage(data: Uint8Array): void
  onClose(reason: string): void
  onError(error: Error): void
}

/** The socket operations this transport needs. */
export interface MessageSocket {
  send(data: Uint8Array): void
  close(): void
}

/** Opens a WebSocket. Injectable so tests never touch the network. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => MessageSocket

/** A message delivered by the broker. */
export interface MqttMessage {
  topic: string
  payload: string
}

/** Collaborators for one connection. */
export interface MqttConnectionOptions {
  log: PluginLogger
  credentials: IotCredentials
  clientId: string
  will?: WillMessage
  /**
   * Username presented in CONNECT.
   *
   * Optional. AWS IoT authenticates from the URL signature. The verified
   * endpoint accepts a CONNECT without a username, so the session leaves this
   * unset rather than inventing an SDK marker.
   */
  username?: string
  /** Sign the `host` header with `:443`. The fallback; see {@link presignIotWebsocketUrl}. */
  signHostWithPort?: boolean
  openSocket?: SocketFactory
  /** Injected in tests so keepalive can be driven without real time. */
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** A pending request waiting for its matching acknowledgement. */
interface Pending {
  resolve: (packet: DecodedPacket) => void
  reject: (error: Error) => void
  timer: unknown
}

/** The default socket factory: the runtime's own WebSocket. */
export const openWebSocket: SocketFactory = (url, handlers) => {
  // `mqtt` is the subprotocol AWS IoT requires on the upgrade. Omitting it
  // gets a successful handshake and a connection that never carries a packet.
  const socket = new WebSocket(url, ['mqtt'])
  socket.binaryType = 'arraybuffer'
  socket.addEventListener('open', () => handlers.onOpen())
  socket.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data
    if (data instanceof ArrayBuffer) {
      handlers.onMessage(new Uint8Array(data))
      return
    }
    // A text frame is a protocol violation here; MQTT is binary throughout.
    handlers.onError(new ProtocolError('the broker sent a non-binary frame'))
  })
  socket.addEventListener('close', (event: CloseEvent) => {
    handlers.onClose(`code ${event.code}${event.reason ? `: ${event.reason}` : ''}`)
  })
  // The DOM error event carries no detail by design, so there is nothing to
  // unwrap. The close event that follows is where the useful reason is.
  socket.addEventListener('error', () => handlers.onError(new ConnectionError('websocket error')))
  return {
    send: (data) => socket.send(detach(data)),
    close: () => socket.close(),
  }
}

/**
 * Copy packet bytes into an ArrayBuffer of their own.
 *
 * `WebSocket.send` will not take a view whose buffer might be shared, and a
 * view handed straight to it would in any case be sent in full, including
 * anything else that happens to live in the same buffer. The packets are a
 * few hundred bytes each and sent rarely, so a copy costs nothing and removes
 * a class of bug where a subarray leaks its neighbours onto the wire.
 */
function detach(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength)
  new Uint8Array(copy).set(data)
  return copy
}

/**
 * One live MQTT session.
 *
 * Single use. Once it has failed or been closed it stays that way; the owner
 * builds a new one to reconnect. That keeps the state machine to two states
 * and means a stale reference cannot silently resurrect a connection whose
 * credentials have since expired.
 */
export class MqttConnection {
  private readonly options: MqttConnectionOptions

  private readonly decoder = new PacketDecoder()

  private readonly pending = new Map<number, Pending>()

  private socket: MessageSocket | undefined

  private nextPacketId = 1

  private connected = false

  private closed = false

  /** Set once, and the reason every later operation rejects with. */
  private failure: Error | undefined

  private connectSettle: Pending | undefined

  private keepaliveTimer: unknown

  private pingTimeoutTimer: unknown

  private onMessageHandler: ((message: MqttMessage) => void) | undefined

  private onCloseHandler: ((error: Error) => void) | undefined

  constructor(options: MqttConnectionOptions) {
    this.options = options
  }

  /** True while the broker has accepted us and nothing has gone wrong. */
  get isConnected(): boolean {
    return this.connected && !this.closed
  }

  /** Register the handler for inbound application messages. */
  onMessage(handler: (message: MqttMessage) => void): void {
    this.onMessageHandler = handler
  }

  /**
   * Register the handler for the connection ending.
   *
   * Called exactly once, for any reason including a clean {@link close}, so an
   * owner has one place to decide whether to reconnect.
   */
  onClose(handler: (error: Error) => void): void {
    this.onCloseHandler = handler
  }

  /**
   * Open the socket and complete the MQTT handshake.
   *
   * Resolves when CONNACK reports acceptance. Rejects on a refused CONNACK, a
   * socket that will not open, or a handshake that does not finish inside
   * {@link MQTT_CONNECT_TIMEOUT_MS}.
   */
  async connect(): Promise<void> {
    if (this.closed) {
      throw this.failure ?? new ConnectionError('this connection has already been closed')
    }
    const url = presignIotWebsocketUrl(this.options.credentials, {
      signHostWithPort: this.options.signHostWithPort === true,
    })
    // The host, never the URL. See the file header.
    this.options.log.debug(`MQTT connecting to ${this.options.credentials.endpoint}`)

    const open = this.options.openSocket ?? openWebSocket
    const handshake = new Promise<void>((resolve, reject) => {
      this.connectSettle = {
        resolve: () => resolve(),
        reject,
        timer: this.setTimer(() => {
          this.fail(new ConnectionError(
            `the broker did not complete the MQTT handshake within ${MQTT_CONNECT_TIMEOUT_MS}ms`,
          ))
        }, MQTT_CONNECT_TIMEOUT_MS),
      }
    })

    this.socket = open(url, {
      onOpen: () => this.handleOpen(),
      onMessage: (data) => this.handleData(data),
      onClose: (reason) => this.fail(new ConnectionError(`the broker closed the connection (${reason})`)),
      onError: (error) => this.fail(error),
    })

    return handshake
  }

  /**
   * Subscribe, and confirm the broker granted every filter.
   *
   * A refusal is treated as fatal rather than logged and carried on with. A
   * NaviLink session that is subscribed to some of its response topics is
   * worse than one that failed: state arrives for some accessories and not
   * others, which reads as a hardware fault rather than a permissions problem.
   */
  async subscribe(subscriptions: readonly Subscription[]): Promise<void> {
    const packetId = this.takePacketId()
    const packet = await this.exchange(
      packetId,
      encodeSubscribe(packetId, subscriptions),
      MQTT_SUBSCRIBE_TIMEOUT_MS,
      'SUBSCRIBE',
    )
    if (packet.type !== PacketType.SUBACK) {
      throw new ProtocolError(`expected a SUBACK, got packet type ${packet.type}`)
    }
    const refused = packet.returnCodes
      .map((code, index) => ({ code, topic: subscriptions[index]?.topic ?? '(unknown)' }))
      .filter((entry) => isSubscribeFailure(entry.code))
    if (refused.length > 0) {
      // Last path segment only: the full topic embeds the gateway MAC.
      const labels = refused.map((entry) => entry.topic.slice(entry.topic.lastIndexOf('/') + 1))
      throw new ProtocolError(
        `the broker refused ${refused.length} subscription(s): ${labels.join(', ')}`,
      )
    }
  }

  /**
   * Publish at QoS 1 and wait for the broker's acknowledgement.
   *
   * QoS 1 rather than 0 because a control command that vanished in transit
   * must not be reported to HomeKit as applied. Note the limit of what this
   * proves: a PUBACK means the *broker* has the message, not that the
   * appliance has acted on it. The appliance's answer arrives separately, as a
   * status frame or a rejection on the failure topic.
   */
  async publish(topic: string, payload: string, timeoutMs: number): Promise<void> {
    const packetId = this.takePacketId()
    const packet = await this.exchange(
      packetId,
      encodePublish({ topic, payload, qos: 1, packetId }),
      timeoutMs,
      'PUBLISH',
    )
    if (packet.type !== PacketType.PUBACK) {
      throw new ProtocolError(`expected a PUBACK, got packet type ${packet.type}`)
    }
  }

  /**
   * Close cleanly.
   *
   * DISCONNECT before closing the socket is what stops the broker publishing
   * our last will. The will exists to tell the gateway we have gone away
   * unexpectedly, so firing it on an orderly shutdown would be a lie, and on
   * a Homebridge restart, a lie the gateway acts on.
   */
  close(): void {
    if (this.closed) {
      return
    }
    if (this.connected) {
      this.trySend(encodeDisconnect())
    }
    this.fail(new ConnectionError('the connection was closed by this plugin'), { expected: true })
  }

  // --- Internals ------------------------------------------------------------

  private handleOpen(): void {
    this.trySend(encodeConnect({
      clientId: this.options.clientId,
      keepaliveSec: MQTT_KEEPALIVE_SEC,
      // A clean session every time. A persistent session would have the broker
      // queue messages for us while we are away, and on reconnect we would
      // replay a backlog of status frames oldest-first. That would publish a
      // sequence of stale states to HomeKit before arriving at the current one.
      cleanSession: true,
      ...(this.options.username === undefined ? {} : { username: this.options.username }),
      ...(this.options.will === undefined ? {} : { will: this.options.will }),
    }))
  }

  private handleData(data: Uint8Array): void {
    let packets: DecodedPacket[]
    try {
      packets = this.decoder.push(data)
    } catch (error) {
      // Framing is lost and MQTT has no delimiter to resynchronise on, so the
      // only correct response is to end the connection.
      this.fail(new ProtocolError(`the broker sent an unreadable packet: ${describeError(error)}`))
      return
    }
    for (const packet of packets) {
      this.handlePacket(packet)
    }
  }

  private handlePacket(packet: DecodedPacket): void {
    switch (packet.type) {
      case PacketType.CONNACK:
        this.handleConnack(packet.returnCode)
        return
      case PacketType.PUBLISH:
        this.handlePublish(packet.topic, packet.payload, packet.packetId)
        return
      case PacketType.PUBACK:
      case PacketType.SUBACK:
        this.settle(packet.packetId, packet)
        return
      case PacketType.PINGRESP:
        this.clearTimer(this.pingTimeoutTimer)
        this.pingTimeoutTimer = undefined
        return
    }
  }

  private handleConnack(returnCode: number): void {
    if (returnCode !== 0) {
      this.fail(new ConnectionError(
        `the broker refused the connection: ${describeConnackReturnCode(returnCode)}`,
      ))
      return
    }
    this.connected = true
    const settle = this.connectSettle
    this.connectSettle = undefined
    if (settle !== undefined) {
      this.clearTimer(settle.timer)
      settle.resolve({ type: PacketType.PINGRESP })
    }
    this.scheduleKeepalive()
  }

  private handlePublish(topic: string, payload: Uint8Array, packetId: number | undefined): void {
    if (packetId !== undefined) {
      // Acknowledged before the handler runs. A handler that throws must not
      // leave the broker redelivering a message forever, and at QoS 1 the
      // message has already been delivered whatever we do with it.
      this.trySend(encodePuback(packetId))
    }
    const handler = this.onMessageHandler
    if (handler === undefined) {
      return
    }
    try {
      handler({ topic, payload: Buffer.from(payload).toString('utf8') })
    } catch (error) {
      // A handler fault is a bug in the layer above, not a reason to drop a
      // working connection and reconnect into the same fault.
      this.options.log.debug(`an MQTT message handler threw: ${describeError(error)}`)
    }
  }

  /** Send a packet and wait for the acknowledgement carrying the same id. */
  private async exchange(
    packetId: number,
    packet: Uint8Array,
    timeoutMs: number,
    label: string,
  ): Promise<DecodedPacket> {
    if (this.failure !== undefined) {
      throw this.failure
    }
    if (!this.connected) {
      throw new ConnectionError(`cannot send ${label}: the MQTT session is not connected`)
    }
    return new Promise<DecodedPacket>((resolve, reject) => {
      this.pending.set(packetId, {
        resolve,
        reject,
        timer: this.setTimer(() => {
          this.pending.delete(packetId)
          // Not fatal to the connection. A single unacknowledged publish is
          // worth failing on its own so the accessory that asked hears about
          // it, while an otherwise healthy session keeps carrying state for
          // every other accessory.
          reject(new ConnectionError(`the broker did not acknowledge ${label} within ${timeoutMs}ms`))
        }, timeoutMs),
      })
      try {
        this.send(packet)
      } catch (error) {
        const entry = this.pending.get(packetId)
        this.pending.delete(packetId)
        if (entry !== undefined) {
          this.clearTimer(entry.timer)
        }
        reject(error instanceof Error ? error : new ConnectionError(String(error)))
      }
    })
  }

  private settle(packetId: number, packet: DecodedPacket): void {
    const entry = this.pending.get(packetId)
    if (entry === undefined) {
      // A duplicate or very late acknowledgement. Harmless, and worth a debug
      // line only: at QoS 1 the broker is allowed to repeat itself.
      this.options.log.debug(`ignoring an unmatched acknowledgement for packet ${packetId}`)
      return
    }
    this.pending.delete(packetId)
    this.clearTimer(entry.timer)
    entry.resolve(packet)
  }

  /**
   * Allocate a packet identifier.
   *
   * One to 65535, wrapping, skipping any still in flight. Zero is reserved by
   * the specification. The scan is bounded so a session that somehow filled
   * the space fails loudly instead of looping.
   */
  private takePacketId(): number {
    for (let attempt = 0; attempt < 0xFFFF; attempt += 1) {
      const candidate = this.nextPacketId
      this.nextPacketId = this.nextPacketId >= 0xFFFF ? 1 : this.nextPacketId + 1
      if (!this.pending.has(candidate)) {
        return candidate
      }
    }
    throw new ProtocolError('every MQTT packet identifier is in flight')
  }

  private scheduleKeepalive(): void {
    this.clearTimer(this.keepaliveTimer)
    this.keepaliveTimer = this.setTimer(() => {
      if (this.closed) {
        return
      }
      this.trySend(encodePingreq())
      this.pingTimeoutTimer = this.setTimer(() => {
        this.fail(new ConnectionError(
          `the broker did not answer a keepalive ping within ${MQTT_PING_TIMEOUT_MS}ms`,
        ))
      }, MQTT_PING_TIMEOUT_MS)
      this.scheduleKeepalive()
    }, MQTT_KEEPALIVE_SEC * 1_000)
  }

  private send(packet: Uint8Array): void {
    const socket = this.socket
    if (socket === undefined) {
      throw new ConnectionError('the MQTT socket is not open')
    }
    socket.send(packet)
  }

  /** Send without caring whether it worked, for teardown and keepalive paths. */
  private trySend(packet: Uint8Array): void {
    try {
      this.send(packet)
    } catch (error) {
      this.options.log.debug(`could not write to the MQTT socket: ${describeError(error)}`)
    }
  }

  /**
   * End the connection, settling everything waiting on it.
   *
   * Idempotent, because several paths can reach it at once: a socket error is
   * routinely followed by a close event, and a ping timeout can race the close
   * it predicted.
   */
  private fail(error: Error, options: { expected?: boolean } = {}): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.connected = false
    this.failure = error

    this.clearTimer(this.keepaliveTimer)
    this.clearTimer(this.pingTimeoutTimer)
    this.keepaliveTimer = undefined
    this.pingTimeoutTimer = undefined

    const handshake = this.connectSettle
    this.connectSettle = undefined
    if (handshake !== undefined) {
      this.clearTimer(handshake.timer)
      handshake.reject(error)
    }
    for (const [, entry] of this.pending) {
      this.clearTimer(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()

    try {
      this.socket?.close()
    } catch (closeError) {
      this.options.log.debug(`could not close the MQTT socket: ${describeError(closeError)}`)
    }
    this.socket = undefined

    if (options.expected !== true) {
      this.options.log.debug(`MQTT session ended: ${describeError(error)}`)
    }
    this.onCloseHandler?.(error)
  }

  private setTimer(handler: () => void, ms: number): unknown {
    if (this.options.setTimer !== undefined) {
      return this.options.setTimer(handler, ms)
    }
    const timer = setTimeout(handler, ms)
    // Nothing awaits these directly, and a keepalive must not be the reason a
    // shutdown cannot finish.
    timer.unref?.()
    return timer
  }

  private clearTimer(handle: unknown): void {
    if (handle === undefined) {
      return
    }
    if (this.options.clearTimer !== undefined) {
      this.options.clearTimer(handle)
      return
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}
