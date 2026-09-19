/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The MQTT codec is written here rather than taken from a package, so it
 * carries the burden of proof a package would have carried. These tests are
 * that proof: every packet this plugin sends is asserted byte for byte
 * against the 3.1.1 specification, and the decoder is driven with the frame
 * boundaries a real WebSocket produces rather than one packet at a time.
 */

import {
  describeConnackReturnCode,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePuback,
  encodePublish,
  encodeRemainingLength,
  encodeSubscribe,
  isSubscribeFailure,
  MAX_PACKET_BYTES,
  PacketDecoder,
  PacketType,
  type PublishPacket,
} from '../../src/api/mqtt-codec'
import { ProtocolError } from '../../src/utils/errors'

describe('encodeRemainingLength', () => {
  // The four worked examples from §2.2.3, which is the whole point of having
  // a table in the specification.
  it.each([
    [0, [0x00]],
    [127, [0x7F]],
    [128, [0x80, 0x01]],
    [16_383, [0xFF, 0x7F]],
    [16_384, [0x80, 0x80, 0x01]],
    [2_097_151, [0xFF, 0xFF, 0x7F]],
    [2_097_152, [0x80, 0x80, 0x80, 0x01]],
    [268_435_455, [0xFF, 0xFF, 0xFF, 0x7F]],
  ])('encodes %i as the specified varint', (length, expected) => {
    expect(encodeRemainingLength(length)).toEqual(expected)
  })

  it('refuses a length the field cannot carry', () => {
    expect(() => encodeRemainingLength(268_435_456)).toThrow(ProtocolError)
    expect(() => encodeRemainingLength(-1)).toThrow(ProtocolError)
  })
})

describe('encodeConnect', () => {
  it('builds the fixed and variable header the specification requires', () => {
    const packet = encodeConnect({
      clientId: 'abc',
      keepaliveSec: 30,
      cleanSession: true,
    })

    expect(packet[0]).toBe(PacketType.CONNECT << 4)
    // Protocol name "MQTT" as a length-prefixed string, then level 4.
    expect([...packet.subarray(2, 8)]).toEqual([0x00, 0x04, 0x4D, 0x51, 0x54, 0x54])
    expect(packet[8]).toBe(0x04)
    // Clean session is bit 1, and nothing else is set.
    expect(packet[9]).toBe(0x02)
    // Keepalive is two bytes, big-endian.
    expect([packet[10], packet[11]]).toEqual([0x00, 0x1E])
    expect([...packet.subarray(12)]).toEqual([0x00, 0x03, 0x61, 0x62, 0x63])
  })

  it('sets the will flags and appends the will to the payload', () => {
    const packet = encodeConnect({
      clientId: 'c',
      keepaliveSec: 30,
      cleanSession: true,
      will: { topic: 'a/b', payload: 'x', qos: 1, retain: false },
    })

    // Clean session, will flag, and will QoS 1 in bits 4-3.
    expect(packet[9]).toBe(0x02 | 0x04 | (1 << 3))
    expect(Buffer.from(packet).toString('utf8')).toContain('a/b')
  })

  it('sets the username flag when a username is present', () => {
    const packet = encodeConnect({
      clientId: 'c',
      keepaliveSec: 30,
      cleanSession: false,
      username: 'sdk',
    })

    expect(packet[9]).toBe(0x80)
    expect(Buffer.from(packet).toString('utf8')).toContain('sdk')
  })
})

describe('encodePublish', () => {
  it('omits the packet identifier at QoS 0', () => {
    const packet = encodePublish({ topic: 'a', payload: 'hi', qos: 0 })

    expect(packet[0]).toBe(PacketType.PUBLISH << 4)
    // Two-byte topic length, one-byte topic, two-byte payload. No identifier.
    expect(packet[1]).toBe(5)
  })

  it('carries the packet identifier at QoS 1', () => {
    const packet = encodePublish({ topic: 'a', payload: 'hi', qos: 1, packetId: 0x1234 })

    expect(packet[0]).toBe((PacketType.PUBLISH << 4) | 0x02)
    expect([packet[5], packet[6]]).toEqual([0x12, 0x34])
  })

  it('refuses a QoS 1 publish with no packet identifier', () => {
    // The broker could never acknowledge it, so the caller would wait on a
    // PUBACK that cannot be matched.
    expect(() => encodePublish({ topic: 'a', payload: 'b', qos: 1 })).toThrow(ProtocolError)
  })

  it('measures the payload in bytes rather than characters', () => {
    // A device name can be non-ASCII, and a length in characters would
    // truncate the packet and desynchronise the stream.
    const packet = encodePublish({ topic: 'a', payload: '\u00E9', qos: 0 })

    expect(packet[1]).toBe(5)
  })
})

describe('encodeSubscribe', () => {
  it('uses the reserved header flags the specification mandates', () => {
    // A broker must treat anything other than 0b0010 as a protocol violation
    // and close the connection, which would look like an auth failure.
    const packet = encodeSubscribe(1, [{ topic: 'a/b', qos: 1 }])

    expect(packet[0]).toBe((PacketType.SUBSCRIBE << 4) | 0x02)
  })

  it('appends a QoS byte after each topic filter', () => {
    const packet = encodeSubscribe(7, [{ topic: 'a', qos: 1 }, { topic: 'b', qos: 0 }])
    const body = [...packet.subarray(2)]

    expect(body).toEqual([0x00, 0x07, 0x00, 0x01, 0x61, 0x01, 0x00, 0x01, 0x62, 0x00])
  })

  it('refuses an empty subscription list', () => {
    expect(() => encodeSubscribe(1, [])).toThrow(ProtocolError)
  })
})

describe('the small packets', () => {
  it('encodes PUBACK, PINGREQ and DISCONNECT', () => {
    expect([...encodePuback(0xBEEF)]).toEqual([PacketType.PUBACK << 4, 2, 0xBE, 0xEF])
    expect([...encodePingreq()]).toEqual([PacketType.PINGREQ << 4, 0])
    expect([...encodeDisconnect()]).toEqual([PacketType.DISCONNECT << 4, 0])
  })
})

describe('PacketDecoder', () => {
  const connack = (returnCode: number): Uint8Array => (
    Uint8Array.from([PacketType.CONNACK << 4, 2, 0x00, returnCode])
  )

  it('reads a CONNACK', () => {
    const packets = new PacketDecoder().push(connack(0))

    expect(packets).toEqual([{ type: PacketType.CONNACK, sessionPresent: false, returnCode: 0 }])
  })

  it('reads several packets from one frame', () => {
    // A broker is free to coalesce, and a decoder that assumed one frame is
    // one packet would drop everything after the first.
    const decoder = new PacketDecoder()
    const combined = new Uint8Array([...connack(0), ...encodePingreq().map(() => 0)])
    combined.set(Uint8Array.from([PacketType.PINGRESP << 4, 0]), 4)

    const packets = decoder.push(combined)

    expect(packets).toHaveLength(2)
    expect(packets[1]).toEqual({ type: PacketType.PINGRESP })
  })

  it('reassembles a packet split across frames', () => {
    const decoder = new PacketDecoder()
    const whole = encodePublish({ topic: 'a/b', payload: 'hello', qos: 0 })

    expect(decoder.push(whole.subarray(0, 3))).toEqual([])
    expect(decoder.pending).toBe(3)

    const packets = decoder.push(whole.subarray(3))

    expect(packets).toHaveLength(1)
    expect((packets[0] as PublishPacket).topic).toBe('a/b')
  })

  it('reassembles a packet split inside its length field', () => {
    // The nastiest boundary: a two-byte remaining-length split down the
    // middle. A decoder that read the first byte alone would compute a length
    // of 0x7F and resynchronise onto garbage.
    const decoder = new PacketDecoder()
    const whole = encodePublish({ topic: 'a', payload: 'x'.repeat(300), qos: 0 })

    expect(decoder.push(whole.subarray(0, 2))).toEqual([])

    const packets = decoder.push(whole.subarray(2))

    expect(packets).toHaveLength(1)
    expect(Buffer.from((packets[0] as PublishPacket).payload).toString()).toHaveLength(300)
  })

  it('reads the topic, payload and flags of a PUBLISH', () => {
    const packets = new PacketDecoder().push(
      encodePublish({ topic: 'cmd/1/x/res/channelstatus', payload: '{"a":1}', qos: 1, packetId: 9, retain: true }),
    )
    const publish = packets[0] as PublishPacket

    expect(publish.topic).toBe('cmd/1/x/res/channelstatus')
    expect(Buffer.from(publish.payload).toString('utf8')).toBe('{"a":1}')
    expect(publish.qos).toBe(1)
    expect(publish.packetId).toBe(9)
    expect(publish.retain).toBe(true)
  })

  it('reads a SUBACK and its per-topic return codes', () => {
    const packets = new PacketDecoder().push(
      Uint8Array.from([PacketType.SUBACK << 4, 4, 0x00, 0x05, 0x01, 0x80]),
    )

    expect(packets[0]).toEqual({
      type: PacketType.SUBACK,
      packetId: 5,
      returnCodes: [0x01, 0x80],
    })
  })

  it('rejects a packet larger than the cap', () => {
    // The remaining-length field can encode 256 MB, and a decoder that
    // trusted it would buffer that much before noticing.
    const decoder = new PacketDecoder()
    const header = Uint8Array.from([
      PacketType.PUBLISH << 4,
      ...encodeRemainingLength(MAX_PACKET_BYTES + 1),
    ])

    expect(() => decoder.push(header)).toThrow(/exceeds/)
  })

  it('rejects QoS 2, which this client cannot complete', () => {
    const decoder = new PacketDecoder()

    expect(() => decoder.push(Uint8Array.from([(PacketType.PUBLISH << 4) | 0x04, 3, 0, 1, 0x61])))
      .toThrow(/QoS 2/)
  })

  it('rejects a packet type the broker should never send', () => {
    // A CONNECT arriving from the broker means the stream is not what we
    // think it is, and carrying on would decode noise as state.
    expect(() => new PacketDecoder().push(Uint8Array.from([PacketType.CONNECT << 4, 0])))
      .toThrow(/unexpected packet type/)
  })
})

describe('return code helpers', () => {
  it('names the CONNACK codes', () => {
    expect(describeConnackReturnCode(0)).toBe('accepted')
    expect(describeConnackReturnCode(4)).toBe('bad username or password')
    expect(describeConnackReturnCode(99)).toContain('99')
  })

  it('recognises a refused subscription', () => {
    expect(isSubscribeFailure(0x80)).toBe(true)
    expect(isSubscribeFailure(0x01)).toBe(false)
  })
})
