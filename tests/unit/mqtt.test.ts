/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The transport is driven against a stand-in socket and a controllable
 * clock, so the behaviours that only show up on a bad connection (an
 * unanswered keepalive, a refused subscription, a broker that hangs up
 * mid-publish) are tested directly, not hoped for.
 */

import { MqttConnection, type MqttConnectionOptions } from '../../src/api/mqtt'
import { encodePublish, PacketType } from '../../src/api/mqtt-codec'
import {
  MQTT_KEEPALIVE_SEC,
  MQTT_PING_TIMEOUT_MS,
  MQTT_CONNECT_TIMEOUT_MS,
} from '../../src/settings'
import { FAKE_ASIA_KEY } from '../helpers/secrets'
import { FakeSocket, FakeTimers } from '../helpers/socket'

const credentials = {
  accessKeyId: FAKE_ASIA_KEY,
  secretKey: 'secret',
  sessionToken: 'token',
  endpoint: 'a1t30mldyslmuq-ats.iot.us-east-1.amazonaws.com',
  region: 'us-east-1',
}

function makeLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}

function build(overrides: Partial<MqttConnectionOptions> = {}) {
  const log = makeLog()
  const timers = new FakeTimers()
  let socket: FakeSocket | undefined
  let dialled = ''

  const connection = new MqttConnection({
    log,
    credentials,
    clientId: 'client-1',
    openSocket: (url, handlers) => {
      dialled = url
      socket = new FakeSocket(handlers)
      return socket
    },
    setTimer: timers.set,
    clearTimer: timers.clear,
    ...overrides,
  })

  return {
    connection,
    log,
    timers,
    get socket(): FakeSocket {
      if (socket === undefined) {
        throw new Error('the connection never opened a socket')
      }
      return socket
    },
    get dialled(): string {
      return dialled
    },
  }
}

/** Connect and settle, which every test but the handshake ones needs. */
async function connected(harness = build()) {
  const pending = harness.connection.connect()
  harness.socket.open()
  harness.socket.sendConnack(0)
  await pending
  return harness
}

describe('the handshake', () => {
  it('sends CONNECT once the socket opens, and resolves on CONNACK', async () => {
    const harness = build()
    const pending = harness.connection.connect()

    // Nothing is sent before the upgrade completes.
    expect(harness.socket.sent).toHaveLength(0)

    harness.socket.open()

    expect(harness.socket.sent[0]?.type).toBe(PacketType.CONNECT)
    expect(harness.connection.isConnected).toBe(false)

    harness.socket.sendConnack(0)
    await pending

    expect(harness.connection.isConnected).toBe(true)
  })

  it('dials a signed URL without logging it', async () => {
    const harness = await connected()

    expect(harness.dialled).toContain('X-Amz-Signature=')
    // The URL is a credential. The one thing logged about the destination is
    // the endpoint host.
    const logged = harness.log.debug.mock.calls.flat().join('\n')
    expect(logged).not.toContain('X-Amz-Signature')
    expect(logged).not.toContain('X-Amz-Security-Token')
    expect(logged).toContain(credentials.endpoint)
  })

  it('rejects when the broker refuses the connection', async () => {
    const harness = build()
    const pending = harness.connection.connect()
    harness.socket.open()
    harness.socket.sendConnack(5)

    await expect(pending).rejects.toThrow(/not authorised/)
    expect(harness.connection.isConnected).toBe(false)
  })

  it('rejects when the handshake never completes', async () => {
    // A WebSocket that upgrades and then says nothing. Without this the
    // session waits forever and every accessory sits at No Response with no
    // explanation.
    const harness = build()
    const pending = harness.connection.connect()
    harness.socket.open()
    harness.timers.advance(MQTT_CONNECT_TIMEOUT_MS)

    await expect(pending).rejects.toThrow(/did not complete the MQTT handshake/)
  })

  it('refuses to be reused once it has closed, and says why it closed', async () => {
    // Single use by design: the owner builds a new connection to reconnect,
    // so a stale reference cannot resurrect a session whose credentials have
    // since expired. The rejection carries the original reason rather than a
    // generic one, so a log says what actually happened.
    const harness = await connected()
    harness.connection.close()

    await expect(harness.connection.connect()).rejects.toThrow(/closed by this plugin/)
  })
})

describe('subscribe', () => {
  it('resolves when the broker grants every filter', async () => {
    const harness = await connected()
    const pending = harness.connection.subscribe([
      { topic: 'a', qos: 1 },
      { topic: 'b', qos: 1 },
    ])
    harness.socket.sendSuback(harness.socket.packetIdOf(1), [0x01, 0x01])

    await expect(pending).resolves.toBeUndefined()
  })

  it('fails when the broker refuses a filter, naming it', async () => {
    // A session subscribed to some of its response topics is worse than one
    // that failed: state arrives for some accessories and not others, which
    // reads as a hardware fault rather than a permissions problem.
    const harness = await connected()
    const pending = harness.connection.subscribe([
      { topic: 'allowed', qos: 1 },
      { topic: 'forbidden', qos: 1 },
    ])
    harness.socket.sendSuback(harness.socket.packetIdOf(1), [0x01, 0x80])

    await expect(pending).rejects.toThrow(/forbidden/)
  })
})

describe('publish', () => {
  it('resolves on the matching PUBACK', async () => {
    const harness = await connected()
    const pending = harness.connection.publish('t', '{}', 5_000)
    harness.socket.sendPuback(harness.socket.packetIdOf(1))

    await expect(pending).resolves.toBeUndefined()
  })

  it('fails the publish, but not the session, when no PUBACK arrives', async () => {
    // The accessory that asked needs to hear about it, while the session
    // keeps carrying state for every other accessory.
    const harness = await connected()
    const pending = harness.connection.publish('t', '{}', 5_000)
    harness.timers.advance(5_000)

    await expect(pending).rejects.toThrow(/did not acknowledge/)
    expect(harness.connection.isConnected).toBe(true)
  })

  it('does not reuse a packet identifier that is still in flight', async () => {
    const harness = await connected()
    const first = harness.connection.publish('t', '1', 5_000)
    const second = harness.connection.publish('t', '2', 5_000)

    expect(harness.socket.packetIdOf(1)).not.toBe(harness.socket.packetIdOf(2))

    harness.socket.sendPuback(harness.socket.packetIdOf(1))
    harness.socket.sendPuback(harness.socket.packetIdOf(2))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('refuses to publish on a session that is not connected', async () => {
    const harness = build()

    await expect(harness.connection.publish('t', '{}', 1_000)).rejects.toThrow(/not connected/)
  })
})

describe('inbound messages', () => {
  it('hands the topic and payload to the handler', async () => {
    const harness = await connected()
    const received: { topic: string; payload: string }[] = []
    harness.connection.onMessage((message) => received.push(message))

    harness.socket.sendPublish('cmd/1/navilink-a1b2c3d4e5f6/res/channelstatus', '{"a":1}')

    expect(received).toEqual([
      { topic: 'cmd/1/navilink-a1b2c3d4e5f6/res/channelstatus', payload: '{"a":1}' },
    ])
  })

  it('survives a handler that throws', async () => {
    // A fault in the layer above is a bug there, not a reason to drop a
    // working connection and reconnect into the same fault.
    const harness = await connected()
    harness.connection.onMessage(() => {
      throw new Error('bad handler')
    })

    harness.socket.sendPublish('t', '{}')

    expect(harness.connection.isConnected).toBe(true)
  })

  it('ends the connection on an unreadable stream', async () => {
    // Framing is lost and MQTT has no delimiter to resynchronise on.
    const harness = await connected()
    const closes: Error[] = []
    harness.connection.onClose((error) => closes.push(error))

    harness.socket.deliver(Uint8Array.from([PacketType.CONNECT << 4, 0]))

    expect(harness.connection.isConnected).toBe(false)
    expect(closes[0]?.message).toMatch(/unreadable packet/)
  })
})

describe('keepalive', () => {
  it('pings on the keepalive interval', async () => {
    const harness = await connected()
    const before = harness.socket.sent.length

    harness.timers.advance(MQTT_KEEPALIVE_SEC * 1_000)

    expect(harness.socket.sent[before]?.type).toBe(PacketType.PINGREQ)
  })

  it('ends the connection when a ping goes unanswered', async () => {
    // A WebSocket can stay open with nothing behind it. Without this the
    // plugin reports yesterday's setpoint as current for as long as the
    // socket stays nominally open.
    const harness = await connected()
    const closes: Error[] = []
    harness.connection.onClose((error) => closes.push(error))

    harness.timers.advance(MQTT_KEEPALIVE_SEC * 1_000)
    harness.timers.advance(MQTT_PING_TIMEOUT_MS)

    expect(closes[0]?.message).toMatch(/keepalive/)
    expect(harness.connection.isConnected).toBe(false)
  })

  it('stays up when the ping is answered', async () => {
    const harness = await connected()

    harness.timers.advance(MQTT_KEEPALIVE_SEC * 1_000)
    harness.socket.sendPingresp()
    harness.timers.advance(MQTT_PING_TIMEOUT_MS)

    expect(harness.connection.isConnected).toBe(true)
  })
})

describe('teardown', () => {
  it('sends DISCONNECT before closing, so the will does not fire', async () => {
    // The will tells the gateway we vanished. Firing it on an orderly
    // shutdown is a lie the gateway acts on.
    const harness = await connected()
    harness.connection.close()

    expect(harness.socket.sent.at(-1)?.type).toBe(PacketType.DISCONNECT)
    expect(harness.socket.closed).toBe(true)
  })

  it('reports closure exactly once, however many things go wrong', async () => {
    // A socket error is routinely followed by a close event, and a ping
    // timeout can race the close it predicted.
    const harness = await connected()
    const closes: Error[] = []
    harness.connection.onClose((error) => closes.push(error))

    harness.socket.hangUp()
    harness.socket.hangUp()
    harness.connection.close()

    expect(closes).toHaveLength(1)
  })

  it('rejects everything in flight when the broker hangs up', async () => {
    const harness = await connected()
    const pending = harness.connection.publish('t', '{}', 60_000)

    harness.socket.hangUp('code 1006')

    await expect(pending).rejects.toThrow(/closed the connection/)
  })

  it('leaves no timer behind', async () => {
    const harness = await connected()
    harness.connection.close()

    expect(harness.timers.outstanding).toBe(0)
  })
})

describe('the last will', () => {
  it('registers one when the caller supplies it', async () => {
    const harness = await connected(build({
      will: {
        topic: 'cmd/1/navilink-a1b2c3d4e5f6/connection',
        payload: '{"bye":1}',
        qos: 1,
        retain: false,
      },
    }))
    // The will is how the gateway learns this plugin vanished. Reading it out
    // of the CONNECT bytes rather than trusting the option was passed on.
    const connect = Buffer.from(harness.socket.sentBytes[0] ?? new Uint8Array())
    expect(connect.toString('utf8')).toContain('navilink-a1b2c3d4e5f6/connection')
  })

  it('sets the will flag in the CONNECT header, or the broker ignores it', async () => {
    const harness = await connected(build({
      will: { topic: 't', payload: 'p', qos: 1, retain: false },
    }))
    const connect = harness.socket.sentBytes[0] ?? new Uint8Array()
    // Byte layout: two-byte length, `MQTT`, level, flags. Bit 2 is the will.
    const flags = connect[9] ?? 0
    expect(flags & 0b0000_0100).not.toBe(0)
  })

  it('leaves the flag clear when there is no will', async () => {
    const harness = await connected()
    const flags = harness.socket.sentBytes[0]?.[9] ?? 0
    expect(flags & 0b0000_0100).toBe(0)
  })
})

describe('acknowledging what the broker sends', () => {
  it('acknowledges a QoS 1 delivery, so the broker stops redelivering', async () => {
    const harness = await connected()
    const before = harness.socket.sent.length
    harness.socket.deliver(encodePublish({ topic: 't', payload: '{}', qos: 1, packetId: 42 }))
    expect(harness.socket.sent[before]?.type).toBe(PacketType.PUBACK)
  })

  it('acknowledges before running the handler, so a throw cannot cause a redelivery loop', async () => {
    const harness = await connected()
    const before = harness.socket.sent.length
    harness.connection.onMessage(() => {
      throw new Error('bad handler')
    })
    harness.socket.deliver(encodePublish({ topic: 't', payload: '{}', qos: 1, packetId: 7 }))
    expect(harness.socket.sent[before]?.type).toBe(PacketType.PUBACK)
  })

  it('sends nothing back for a QoS 0 delivery', async () => {
    const harness = await connected()
    const before = harness.socket.sent.length
    harness.socket.sendPublish('t', '{}')
    expect(harness.socket.sent).toHaveLength(before)
  })

  it('drops a message that arrives with no handler registered', async () => {
    const harness = await connected()
    expect(() => harness.socket.sendPublish('t', '{}')).not.toThrow()
    expect(harness.connection.isConnected).toBe(true)
  })
})

describe('when the socket fails underneath', () => {
  it('reports a hang-up with the reason the socket gave', async () => {
    const harness = await connected()
    const closes: Error[] = []
    harness.connection.onClose((error) => closes.push(error))

    harness.socket.hangUp('code 1006')

    expect(closes[0]?.message).toContain('1006')
    expect(harness.connection.isConnected).toBe(false)
  })

  it('fails an in-flight publish rather than leaving it hanging forever', async () => {
    const harness = await connected()
    const pending = harness.connection.publish('t', '{}', 30_000)
    harness.socket.hangUp()

    // Left unsettled, the accessory that asked would never hear either way
    // and its write would sit until HAP gave up on it.
    await expect(pending).rejects.toThrow()
  })

  it('leaves no timer behind, so the process is free to exit', async () => {
    const harness = await connected()
    const pending = harness.connection.publish('t', '{}', 30_000)
    harness.socket.hangUp()
    await expect(pending).rejects.toThrow()

    expect(harness.timers.outstanding).toBe(0)
  })

  it('treats a socket error as the end of the session', async () => {
    const harness = await connected()
    const closes: Error[] = []
    harness.connection.onClose((error) => closes.push(error))

    harness.socket.fail(new Error('ECONNRESET'))

    expect(closes[0]?.message).toContain('ECONNRESET')
  })

  it('rejects a publish attempted after the session ended', async () => {
    const harness = await connected()
    harness.socket.hangUp()

    await expect(harness.connection.publish('t', '{}', 1_000)).rejects.toThrow()
  })

  it('rejects a subscribe attempted after the session ended', async () => {
    const harness = await connected()
    harness.socket.hangUp()

    await expect(harness.connection.subscribe([{ topic: 't', qos: 1 }])).rejects.toThrow()
  })

  it('is safe to close twice', async () => {
    const harness = await connected()
    harness.connection.close()
    expect(() => harness.connection.close()).not.toThrow()
  })

  it('stops pinging once the session has ended', async () => {
    const harness = await connected()
    harness.connection.close()
    const after = harness.socket.sent.length

    harness.timers.advance(MQTT_KEEPALIVE_SEC * 1_000 * 3)

    // A keepalive on a dead socket is a write to a closed handle.
    expect(harness.socket.sent).toHaveLength(after)
    expect(harness.timers.outstanding).toBe(0)
  })
})

describe('a broker that answers the wrong thing', () => {
  it('rejects a subscribe answered with a PUBACK', async () => {
    const harness = await connected()
    const pending = harness.connection.subscribe([{ topic: 't', qos: 1 }])
    harness.socket.sendPuback(harness.socket.packetIdOf(1))

    await expect(pending).rejects.toThrow(/expected a SUBACK/)
  })

  it('rejects a publish answered with a SUBACK', async () => {
    const harness = await connected()
    const pending = harness.connection.publish('t', '{}', 5_000)
    harness.socket.sendSuback(harness.socket.packetIdOf(1), [0x01])

    await expect(pending).rejects.toThrow(/expected a PUBACK/)
  })

  it('ignores an acknowledgement for something nobody is waiting on', async () => {
    const harness = await connected()
    expect(() => harness.socket.sendPuback(9_999)).not.toThrow()
    expect(harness.connection.isConnected).toBe(true)
  })
})
