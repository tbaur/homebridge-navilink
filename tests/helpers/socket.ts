/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * A stand-in WebSocket, so the transport can be driven end to end without a
 * network, a broker or a real clock. Everything the connection does (the
 * handshake, keepalive, acknowledgement matching, teardown) is observable
 * from here.
 */

import {
  encodePublish,
  PacketDecoder,
  PacketType,
  type DecodedPacket,
} from '../../src/api/mqtt-codec'
import type { MessageSocket, SocketHandlers } from '../../src/api/mqtt'

/** A socket that records what was written and lets a test write back. */
export class FakeSocket implements MessageSocket {
  /** Every packet the connection sent, decoded. */
  readonly sent: DecodedPacket[] = []

  /** Raw bytes, for assertions the decoder cannot make (CONNECT is one). */
  readonly sentBytes: Uint8Array[] = []

  closed = false

  private readonly handlers: SocketHandlers

  private readonly decoder = new PacketDecoder()

  constructor(handlers: SocketHandlers) {
    this.handlers = handlers
  }

  send(data: Uint8Array | ArrayBuffer): void {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    this.sentBytes.push(bytes)
    // The connection only ever sends client-to-server packets, which this
    // decoder rejects by design. Read the type from the fixed header instead.
    this.sent.push({ type: (bytes[0] ?? 0) >> 4 } as DecodedPacket)
  }

  close(): void {
    this.closed = true
  }

  /** Pretend the upgrade completed. */
  open(): void {
    this.handlers.onOpen()
  }

  /** Deliver raw bytes from the broker. */
  deliver(bytes: Uint8Array): void {
    this.handlers.onMessage(bytes)
  }

  /** Accept or refuse the connection. */
  sendConnack(returnCode = 0): void {
    this.deliver(Uint8Array.from([PacketType.CONNACK << 4, 2, 0x00, returnCode]))
  }

  /** Acknowledge a SUBSCRIBE, granting or refusing each filter. */
  sendSuback(packetId: number, returnCodes: number[]): void {
    this.deliver(Uint8Array.from([
      PacketType.SUBACK << 4,
      2 + returnCodes.length,
      (packetId >> 8) & 0xFF,
      packetId & 0xFF,
      ...returnCodes,
    ]))
  }

  /** Acknowledge a PUBLISH. */
  sendPuback(packetId: number): void {
    this.deliver(Uint8Array.from([
      PacketType.PUBACK << 4, 2, (packetId >> 8) & 0xFF, packetId & 0xFF,
    ]))
  }

  /** Answer a keepalive. */
  sendPingresp(): void {
    this.deliver(Uint8Array.from([PacketType.PINGRESP << 4, 0]))
  }

  /** Deliver an application message. */
  sendPublish(topic: string, payload: string): void {
    this.deliver(encodePublish({ topic, payload, qos: 0 }))
  }

  /** Report that the broker hung up. */
  hangUp(reason = 'code 1006'): void {
    this.handlers.onClose(reason)
  }

  /** Report a transport error, which a real socket follows with a close. */
  fail(error: Error): void {
    this.handlers.onError(error)
  }

  /** The packet identifier the connection used for its nth outbound packet. */
  packetIdOf(index: number): number {
    const bytes = this.sentBytes[index]
    if (bytes === undefined) {
      throw new Error(`nothing was sent at index ${index}`)
    }
    const type = (bytes[0] ?? 0) >> 4
    // SUBSCRIBE puts the identifier first in its body; PUBLISH puts it after
    // the topic string.
    if (type === PacketType.SUBSCRIBE) {
      return ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)
    }
    const topicLength = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)
    const at = 4 + topicLength
    return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
  }
}

/** A controllable clock, so keepalive and timeouts can be driven exactly. */
export class FakeTimers {
  private readonly pending = new Map<number, { handler: () => void; at: number }>()

  private next = 1

  private clock = 0

  readonly set = (handler: () => void, ms: number): unknown => {
    const handle = this.next
    this.next += 1
    this.pending.set(handle, { handler, at: this.clock + ms })
    return handle
  }

  readonly clear = (handle: unknown): void => {
    this.pending.delete(handle as number)
  }

  /** Advance time, firing anything that comes due. */
  advance(ms: number): void {
    this.clock += ms
    for (const [handle, entry] of [...this.pending]) {
      if (entry.at <= this.clock) {
        this.pending.delete(handle)
        entry.handler()
      }
    }
  }

  /** How many timers are outstanding, for leak assertions. */
  get outstanding(): number {
    return this.pending.size
  }
}
