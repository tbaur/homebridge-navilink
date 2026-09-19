"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview MQTT 3.1.1 packet encoding and decoding, for the subset AWS
 * IoT needs.
 *
 * Writing this rather than taking a dependency was a deliberate call, and the
 * reasoning belongs next to the code it justifies.
 *
 * `mqtt.js` rebuilds the WebSocket path from its own parsed options, which
 * discards the SigV4 query string, so the upgrade is rejected or hangs. The
 * documented way round is `transformWsUrl`, a hook that exists to undo what the
 * library just did. That is a bad sign for the one part of this plugin where a
 * subtle failure means a user's heating silently stops responding.
 *
 * AWS IoT speaks 3.1.1, this plugin needs seven packet types, and the wire
 * format is a fixed header, a variable-length integer and length-prefixed
 * strings. It is a few hundred lines with no I/O in it, which makes it
 * exhaustively testable without a socket. The family this plugin belongs to
 * already hand-rolls a capped XML reader for the same reason. The dependency
 * it replaces brings roughly twenty transitive packages into a plugin that
 * handles a cloud password, which the security posture would rather not carry.
 *
 * What is deliberately absent: QoS 2 (AWS IoT does not support it), retained
 * message handling beyond the flag, topic aliases and MQTT 5 properties. If a
 * future NaviLink protocol needs any of them, add it here with a test rather
 * than reaching back for the library.
 *
 * Section references are to the OASIS MQTT 3.1.1 specification.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PacketDecoder = exports.MAX_PACKET_BYTES = exports.PacketType = void 0;
exports.describeConnackReturnCode = describeConnackReturnCode;
exports.isSubscribeFailure = isSubscribeFailure;
exports.encodeRemainingLength = encodeRemainingLength;
exports.encodeConnect = encodeConnect;
exports.encodePublish = encodePublish;
exports.encodePuback = encodePuback;
exports.encodeSubscribe = encodeSubscribe;
exports.encodePingreq = encodePingreq;
exports.encodeDisconnect = encodeDisconnect;
const errors_1 = require("../utils/errors");
/** Packet type codes (§2.2.1). */
exports.PacketType = {
    CONNECT: 1,
    CONNACK: 2,
    PUBLISH: 3,
    PUBACK: 4,
    SUBSCRIBE: 8,
    SUBACK: 9,
    PINGREQ: 12,
    PINGRESP: 13,
    DISCONNECT: 14,
};
/**
 * Largest packet accepted from the broker.
 *
 * A status frame is a couple of kilobytes. 256 KiB is generous while keeping a
 * malfunctioning or hostile broker from growing the heap: the remaining-length
 * field can encode 256 MB, and a decoder that trusts it will happily buffer
 * that much before noticing.
 */
exports.MAX_PACKET_BYTES = 262_144;
/** CONNACK return codes (§3.2.2.3). */
const CONNACK_REASONS = {
    0: 'accepted',
    1: 'unacceptable protocol version',
    2: 'client identifier rejected',
    3: 'server unavailable',
    4: 'bad username or password',
    5: 'not authorised',
};
/** Human-readable text for a CONNACK return code. */
function describeConnackReturnCode(code) {
    return CONNACK_REASONS[code] ?? `unknown return code ${code}`;
}
/** True when a SUBACK return code means the subscription was refused (§3.9.3). */
function isSubscribeFailure(code) {
    return code === 0x80;
}
// --- Encoding --------------------------------------------------------------
/**
 * Encode the remaining-length field (§2.2.3).
 *
 * A base-128 varint, little-endian, with the top bit as the continuation flag
 * and a hard limit of four bytes.
 */
function encodeRemainingLength(length) {
    if (!Number.isInteger(length) || length < 0 || length > 268_435_455) {
        throw new errors_1.ProtocolError(`remaining length ${length} is outside the encodable range`);
    }
    const bytes = [];
    let value = length;
    do {
        let byte = value % 128;
        value = Math.floor(value / 128);
        if (value > 0) {
            byte = byte | 0x80;
        }
        bytes.push(byte);
    } while (value > 0);
    return bytes;
}
/** Length-prefixed UTF-8, as every MQTT string is (§1.5.3). */
function encodeString(value) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > 0xFFFF) {
        throw new errors_1.ProtocolError(`string of ${bytes.length} bytes exceeds the MQTT field limit`);
    }
    return [bytes.length >> 8, bytes.length & 0xFF, ...bytes];
}
function packet(type, flags, body) {
    return Uint8Array.from([
        (type << 4) | flags,
        ...encodeRemainingLength(body.length),
        ...body,
    ]);
}
/**
 * Build a CONNECT packet (§3.1).
 *
 * AWS IoT authenticates from the SigV4 signature on the WebSocket URL, so the
 * username and password fields are not credentials here. The username is
 * optional. The verified US endpoint accepts a CONNECT without one, so this
 * plugin omits it rather than inventing an SDK marker we have not recorded.
 */
function encodeConnect(options) {
    const { clientId, keepaliveSec, cleanSession, username, password, will } = options;
    let flags = 0;
    if (cleanSession) {
        flags |= 0x02;
    }
    if (will !== undefined) {
        flags |= 0x04;
        flags |= (will.qos & 0x03) << 3;
        if (will.retain) {
            flags |= 0x20;
        }
    }
    if (username !== undefined) {
        flags |= 0x80;
    }
    if (password !== undefined) {
        flags |= 0x40;
    }
    const body = [
        ...encodeString('MQTT'),
        // Protocol level 4 is 3.1.1 (§3.1.2.2).
        0x04,
        flags,
        (keepaliveSec >> 8) & 0xFF,
        keepaliveSec & 0xFF,
        ...encodeString(clientId),
    ];
    if (will !== undefined) {
        body.push(...encodeString(will.topic), ...encodeString(will.payload));
    }
    if (username !== undefined) {
        body.push(...encodeString(username));
    }
    if (password !== undefined) {
        body.push(...encodeString(password));
    }
    return packet(exports.PacketType.CONNECT, 0, body);
}
/**
 * Build a PUBLISH packet (§3.3).
 *
 * `packetId` is required for QoS 1 and forbidden for QoS 0, which the
 * specification states and this enforces: a QoS 1 publish with no identifier
 * cannot be acknowledged, so the caller would wait for a PUBACK that can never
 * be matched.
 */
function encodePublish(input) {
    const { topic, payload, qos, packetId, retain = false } = input;
    if (qos === 1 && packetId === undefined) {
        throw new errors_1.ProtocolError('a QoS 1 publish needs a packet identifier');
    }
    const flags = (qos << 1) | (retain ? 1 : 0);
    const body = [...encodeString(topic)];
    if (qos === 1 && packetId !== undefined) {
        body.push((packetId >> 8) & 0xFF, packetId & 0xFF);
    }
    body.push(...Buffer.from(payload, 'utf8'));
    return packet(exports.PacketType.PUBLISH, flags, body);
}
/** Build a PUBACK, acknowledging a QoS 1 message the broker sent us (§3.4). */
function encodePuback(packetId) {
    return packet(exports.PacketType.PUBACK, 0, [(packetId >> 8) & 0xFF, packetId & 0xFF]);
}
/**
 * Build a SUBSCRIBE packet (§3.8).
 *
 * The fixed-header flags are required to be `0b0010`; a broker must treat
 * anything else as a protocol violation and close the connection.
 */
function encodeSubscribe(packetId, subscriptions) {
    if (subscriptions.length === 0) {
        throw new errors_1.ProtocolError('a subscribe needs at least one topic filter');
    }
    const body = [(packetId >> 8) & 0xFF, packetId & 0xFF];
    for (const subscription of subscriptions) {
        body.push(...encodeString(subscription.topic), subscription.qos);
    }
    return packet(exports.PacketType.SUBSCRIBE, 0x02, body);
}
/** Build a PINGREQ (§3.12). */
function encodePingreq() {
    return packet(exports.PacketType.PINGREQ, 0, []);
}
/** Build a DISCONNECT (§3.14), which tells the broker not to send our will. */
function encodeDisconnect() {
    return packet(exports.PacketType.DISCONNECT, 0, []);
}
/**
 * Read a remaining-length varint from `buffer` at `offset`.
 *
 * Returns undefined when the field is not yet complete, which is normal: a
 * WebSocket frame boundary can fall anywhere, including inside this field.
 */
function readRemainingLength(buffer, offset) {
    let multiplier = 1;
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
        const byte = buffer[offset + index];
        if (byte === undefined) {
            return undefined;
        }
        value += (byte & 0x7F) * multiplier;
        if ((byte & 0x80) === 0) {
            return { value, bytes: index + 1 };
        }
        multiplier *= 128;
    }
    throw new errors_1.ProtocolError('remaining length field is longer than four bytes');
}
function readUint16(buffer, offset) {
    const high = buffer[offset];
    const low = buffer[offset + 1];
    if (high === undefined || low === undefined) {
        throw new errors_1.ProtocolError('packet ended inside a two-byte field');
    }
    return (high << 8) | low;
}
function readString(buffer, offset) {
    const length = readUint16(buffer, offset);
    const start = offset + 2;
    const end = start + length;
    if (end > buffer.length) {
        throw new errors_1.ProtocolError('packet ended inside a string');
    }
    return { value: Buffer.from(buffer.subarray(start, end)).toString('utf8'), next: end };
}
function decodePublish(flags, body) {
    const qos = (flags >> 1) & 0x03;
    if (qos > 1) {
        // QoS 2 needs a four-packet handshake this client does not implement. AWS
        // IoT does not offer it, so receiving one means something is badly wrong
        // and pretending otherwise would drop the message silently.
        throw new errors_1.ProtocolError(`QoS ${qos} is not supported`);
    }
    const { value: topic, next } = readString(body, 0);
    let offset = next;
    let packetId;
    if (qos === 1) {
        packetId = readUint16(body, offset);
        offset += 2;
    }
    const result = {
        type: exports.PacketType.PUBLISH,
        topic,
        payload: body.subarray(offset),
        qos: qos,
        retain: (flags & 0x01) === 1,
        dup: (flags & 0x08) !== 0,
    };
    if (packetId !== undefined) {
        result.packetId = packetId;
    }
    return result;
}
function decodeBody(type, flags, body) {
    switch (type) {
        case exports.PacketType.CONNACK: {
            if (body.length < 2) {
                throw new errors_1.ProtocolError('CONNACK is shorter than two bytes');
            }
            return {
                type: exports.PacketType.CONNACK,
                sessionPresent: ((body[0] ?? 0) & 0x01) === 1,
                returnCode: body[1] ?? 0,
            };
        }
        case exports.PacketType.PUBLISH:
            return decodePublish(flags, body);
        case exports.PacketType.PUBACK:
            return { type: exports.PacketType.PUBACK, packetId: readUint16(body, 0) };
        case exports.PacketType.SUBACK:
            return {
                type: exports.PacketType.SUBACK,
                packetId: readUint16(body, 0),
                returnCodes: [...body.subarray(2)],
            };
        case exports.PacketType.PINGRESP:
            return { type: exports.PacketType.PINGRESP };
        default:
            throw new errors_1.ProtocolError(`unexpected packet type ${type} from the broker`);
    }
}
/**
 * Reassembles packets from a byte stream.
 *
 * Needed because MQTT framing and WebSocket framing are unrelated. One
 * WebSocket message can carry several MQTT packets, one MQTT packet can be
 * split across several WebSocket messages, and a split can fall inside the
 * length field itself. A decoder that assumed one frame is one packet works
 * perfectly on a quiet connection and corrupts under load, which is the worst
 * possible failure schedule.
 */
class PacketDecoder {
    buffer = new Uint8Array(0);
    /**
     * Add received bytes and return every complete packet now available.
     *
     * Throws {@link ProtocolError} on a malformed stream. The caller is expected
     * to treat that as fatal for the connection: once framing is lost there is no
     * way to resynchronise, because MQTT has no frame delimiter to scan for.
     */
    push(chunk) {
        this.buffer = this.buffer.length === 0
            ? chunk
            : concat(this.buffer, chunk);
        const packets = [];
        let offset = 0;
        for (;;) {
            const header = this.buffer[offset];
            if (header === undefined) {
                break;
            }
            const length = readRemainingLength(this.buffer, offset + 1);
            if (length === undefined) {
                break;
            }
            if (length.value > exports.MAX_PACKET_BYTES) {
                throw new errors_1.ProtocolError(`packet of ${length.value} bytes exceeds the ${exports.MAX_PACKET_BYTES} byte limit`);
            }
            const start = offset + 1 + length.bytes;
            const end = start + length.value;
            if (end > this.buffer.length) {
                break;
            }
            packets.push(decodeBody(header >> 4, header & 0x0F, this.buffer.subarray(start, end)));
            offset = end;
        }
        // Retained rather than copied when nothing was consumed, so a large packet
        // arriving in many small frames does not re-copy its prefix each time.
        if (offset > 0) {
            this.buffer = this.buffer.subarray(offset);
        }
        return packets;
    }
    /** Bytes held pending the rest of a packet. Exposed for tests and diagnostics. */
    get pending() {
        return this.buffer.length;
    }
}
exports.PacketDecoder = PacketDecoder;
function concat(left, right) {
    const merged = new Uint8Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    return merged;
}
