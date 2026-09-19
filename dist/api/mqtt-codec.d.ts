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
/** Packet type codes (§2.2.1). */
export declare const PacketType: {
    readonly CONNECT: 1;
    readonly CONNACK: 2;
    readonly PUBLISH: 3;
    readonly PUBACK: 4;
    readonly SUBSCRIBE: 8;
    readonly SUBACK: 9;
    readonly PINGREQ: 12;
    readonly PINGRESP: 13;
    readonly DISCONNECT: 14;
};
/**
 * Largest packet accepted from the broker.
 *
 * A status frame is a couple of kilobytes. 256 KiB is generous while keeping a
 * malfunctioning or hostile broker from growing the heap: the remaining-length
 * field can encode 256 MB, and a decoder that trusts it will happily buffer
 * that much before noticing.
 */
export declare const MAX_PACKET_BYTES = 262144;
/** A message the broker delivered to us. */
export interface PublishPacket {
    type: typeof PacketType.PUBLISH;
    topic: string;
    payload: Uint8Array;
    qos: 0 | 1;
    retain: boolean;
    dup: boolean;
    /** Present for QoS 1, which must be acknowledged. */
    packetId?: number;
}
/** The broker's answer to our CONNECT. */
export interface ConnackPacket {
    type: typeof PacketType.CONNACK;
    sessionPresent: boolean;
    returnCode: number;
}
/** The broker's acknowledgement of a QoS 1 PUBLISH we sent. */
export interface PubackPacket {
    type: typeof PacketType.PUBACK;
    packetId: number;
}
/** The broker's answer to a SUBSCRIBE. */
export interface SubackPacket {
    type: typeof PacketType.SUBACK;
    packetId: number;
    /** One per requested topic: the granted QoS, or 0x80 for a refusal. */
    returnCodes: number[];
}
/** The broker's answer to a PINGREQ. */
export interface PingrespPacket {
    type: typeof PacketType.PINGRESP;
}
/** Any packet this decoder produces. */
export type DecodedPacket = ConnackPacket | PublishPacket | PubackPacket | SubackPacket | PingrespPacket;
/** A topic filter and the QoS to request for it. */
export interface Subscription {
    topic: string;
    qos: 0 | 1;
}
/** A last-will message, published by the broker if we disappear. */
export interface WillMessage {
    topic: string;
    payload: string;
    qos: 0 | 1;
    retain: boolean;
}
/** Everything CONNECT carries. */
export interface ConnectOptions {
    clientId: string;
    keepaliveSec: number;
    cleanSession: boolean;
    username?: string;
    password?: string;
    will?: WillMessage;
}
/** Human-readable text for a CONNACK return code. */
export declare function describeConnackReturnCode(code: number): string;
/** True when a SUBACK return code means the subscription was refused (§3.9.3). */
export declare function isSubscribeFailure(code: number): boolean;
/**
 * Encode the remaining-length field (§2.2.3).
 *
 * A base-128 varint, little-endian, with the top bit as the continuation flag
 * and a hard limit of four bytes.
 */
export declare function encodeRemainingLength(length: number): number[];
/**
 * Build a CONNECT packet (§3.1).
 *
 * AWS IoT authenticates from the SigV4 signature on the WebSocket URL, so the
 * username and password fields are not credentials here. The username is
 * optional. The verified US endpoint accepts a CONNECT without one, so this
 * plugin omits it rather than inventing an SDK marker we have not recorded.
 */
export declare function encodeConnect(options: ConnectOptions): Uint8Array;
/**
 * Build a PUBLISH packet (§3.3).
 *
 * `packetId` is required for QoS 1 and forbidden for QoS 0, which the
 * specification states and this enforces: a QoS 1 publish with no identifier
 * cannot be acknowledged, so the caller would wait for a PUBACK that can never
 * be matched.
 */
export declare function encodePublish(input: {
    topic: string;
    payload: string;
    qos: 0 | 1;
    packetId?: number;
    retain?: boolean;
}): Uint8Array;
/** Build a PUBACK, acknowledging a QoS 1 message the broker sent us (§3.4). */
export declare function encodePuback(packetId: number): Uint8Array;
/**
 * Build a SUBSCRIBE packet (§3.8).
 *
 * The fixed-header flags are required to be `0b0010`; a broker must treat
 * anything else as a protocol violation and close the connection.
 */
export declare function encodeSubscribe(packetId: number, subscriptions: readonly Subscription[]): Uint8Array;
/** Build a PINGREQ (§3.12). */
export declare function encodePingreq(): Uint8Array;
/** Build a DISCONNECT (§3.14), which tells the broker not to send our will. */
export declare function encodeDisconnect(): Uint8Array;
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
export declare class PacketDecoder {
    private buffer;
    /**
     * Add received bytes and return every complete packet now available.
     *
     * Throws {@link ProtocolError} on a malformed stream. The caller is expected
     * to treat that as fatal for the connection: once framing is lost there is no
     * way to resynchronise, because MQTT has no frame delimiter to scan for.
     */
    push(chunk: Uint8Array): DecodedPacket[];
    /** Bytes held pending the rest of a packet. Exposed for tests and diagnostics. */
    get pending(): number;
}
