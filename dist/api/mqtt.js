"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MqttConnection = exports.openWebSocket = void 0;
const settings_1 = require("../settings");
const errors_1 = require("../utils/errors");
const errors_2 = require("../utils/errors");
const mqtt_codec_1 = require("./mqtt-codec");
const sigv4_1 = require("./sigv4");
/** The default socket factory: the runtime's own WebSocket. */
const openWebSocket = (url, handlers) => {
    // `mqtt` is the subprotocol AWS IoT requires on the upgrade. Omitting it
    // gets a successful handshake and a connection that never carries a packet.
    const socket = new WebSocket(url, ['mqtt']);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => handlers.onOpen());
    socket.addEventListener('message', (event) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) {
            handlers.onMessage(new Uint8Array(data));
            return;
        }
        // A text frame is a protocol violation here; MQTT is binary throughout.
        handlers.onError(new errors_1.ProtocolError('the broker sent a non-binary frame'));
    });
    socket.addEventListener('close', (event) => {
        handlers.onClose(`code ${event.code}${event.reason ? `: ${event.reason}` : ''}`);
    });
    // The DOM error event carries no detail by design, so there is nothing to
    // unwrap. The close event that follows is where the useful reason is.
    socket.addEventListener('error', () => handlers.onError(new errors_1.ConnectionError('websocket error')));
    return {
        send: (data) => socket.send(detach(data)),
        close: () => socket.close(),
    };
};
exports.openWebSocket = openWebSocket;
/**
 * Copy packet bytes into an ArrayBuffer of their own.
 *
 * `WebSocket.send` will not take a view whose buffer might be shared, and a
 * view handed straight to it would in any case be sent in full, including
 * anything else that happens to live in the same buffer. The packets are a
 * few hundred bytes each and sent rarely, so a copy costs nothing and removes
 * a class of bug where a subarray leaks its neighbours onto the wire.
 */
function detach(data) {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
}
/**
 * One live MQTT session.
 *
 * Single use. Once it has failed or been closed it stays that way; the owner
 * builds a new one to reconnect. That keeps the state machine to two states
 * and means a stale reference cannot silently resurrect a connection whose
 * credentials have since expired.
 */
class MqttConnection {
    options;
    decoder = new mqtt_codec_1.PacketDecoder();
    pending = new Map();
    socket;
    nextPacketId = 1;
    connected = false;
    closed = false;
    /** Set once, and the reason every later operation rejects with. */
    failure;
    connectSettle;
    keepaliveTimer;
    pingTimeoutTimer;
    onMessageHandler;
    onCloseHandler;
    constructor(options) {
        this.options = options;
    }
    /** True while the broker has accepted us and nothing has gone wrong. */
    get isConnected() {
        return this.connected && !this.closed;
    }
    /** Register the handler for inbound application messages. */
    onMessage(handler) {
        this.onMessageHandler = handler;
    }
    /**
     * Register the handler for the connection ending.
     *
     * Called exactly once, for any reason including a clean {@link close}, so an
     * owner has one place to decide whether to reconnect.
     */
    onClose(handler) {
        this.onCloseHandler = handler;
    }
    /**
     * Open the socket and complete the MQTT handshake.
     *
     * Resolves when CONNACK reports acceptance. Rejects on a refused CONNACK, a
     * socket that will not open, or a handshake that does not finish inside
     * {@link MQTT_CONNECT_TIMEOUT_MS}.
     */
    async connect() {
        if (this.closed) {
            throw this.failure ?? new errors_1.ConnectionError('this connection has already been closed');
        }
        const url = (0, sigv4_1.presignIotWebsocketUrl)(this.options.credentials, {
            signHostWithPort: this.options.signHostWithPort === true,
        });
        // The host, never the URL. See the file header.
        this.options.log.debug(`MQTT connecting to ${this.options.credentials.endpoint}`);
        const open = this.options.openSocket ?? exports.openWebSocket;
        const handshake = new Promise((resolve, reject) => {
            this.connectSettle = {
                resolve: () => resolve(),
                reject,
                timer: this.setTimer(() => {
                    this.fail(new errors_1.ConnectionError(`the broker did not complete the MQTT handshake within ${settings_1.MQTT_CONNECT_TIMEOUT_MS}ms`));
                }, settings_1.MQTT_CONNECT_TIMEOUT_MS),
            };
        });
        this.socket = open(url, {
            onOpen: () => this.handleOpen(),
            onMessage: (data) => this.handleData(data),
            onClose: (reason) => this.fail(new errors_1.ConnectionError(`the broker closed the connection (${reason})`)),
            onError: (error) => this.fail(error),
        });
        return handshake;
    }
    /**
     * Subscribe, and confirm the broker granted every filter.
     *
     * A refusal is treated as fatal rather than logged and carried on with. A
     * NaviLink session that is subscribed to some of its response topics is
     * worse than one that failed: state arrives for some accessories and not
     * others, which reads as a hardware fault rather than a permissions problem.
     */
    async subscribe(subscriptions) {
        const packetId = this.takePacketId();
        const packet = await this.exchange(packetId, (0, mqtt_codec_1.encodeSubscribe)(packetId, subscriptions), settings_1.MQTT_SUBSCRIBE_TIMEOUT_MS, 'SUBSCRIBE');
        if (packet.type !== mqtt_codec_1.PacketType.SUBACK) {
            throw new errors_1.ProtocolError(`expected a SUBACK, got packet type ${packet.type}`);
        }
        const refused = packet.returnCodes
            .map((code, index) => ({ code, topic: subscriptions[index]?.topic ?? '(unknown)' }))
            .filter((entry) => (0, mqtt_codec_1.isSubscribeFailure)(entry.code));
        if (refused.length > 0) {
            // Last path segment only: the full topic embeds the gateway MAC.
            const labels = refused.map((entry) => entry.topic.slice(entry.topic.lastIndexOf('/') + 1));
            throw new errors_1.ProtocolError(`the broker refused ${refused.length} subscription(s): ${labels.join(', ')}`);
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
    async publish(topic, payload, timeoutMs) {
        const packetId = this.takePacketId();
        const packet = await this.exchange(packetId, (0, mqtt_codec_1.encodePublish)({ topic, payload, qos: 1, packetId }), timeoutMs, 'PUBLISH');
        if (packet.type !== mqtt_codec_1.PacketType.PUBACK) {
            throw new errors_1.ProtocolError(`expected a PUBACK, got packet type ${packet.type}`);
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
    close() {
        if (this.closed) {
            return;
        }
        if (this.connected) {
            this.trySend((0, mqtt_codec_1.encodeDisconnect)());
        }
        this.fail(new errors_1.ConnectionError('the connection was closed by this plugin'), { expected: true });
    }
    // --- Internals ------------------------------------------------------------
    handleOpen() {
        this.trySend((0, mqtt_codec_1.encodeConnect)({
            clientId: this.options.clientId,
            keepaliveSec: settings_1.MQTT_KEEPALIVE_SEC,
            // A clean session every time. A persistent session would have the broker
            // queue messages for us while we are away, and on reconnect we would
            // replay a backlog of status frames oldest-first. That would publish a
            // sequence of stale states to HomeKit before arriving at the current one.
            cleanSession: true,
            ...(this.options.username === undefined ? {} : { username: this.options.username }),
            ...(this.options.will === undefined ? {} : { will: this.options.will }),
        }));
    }
    handleData(data) {
        let packets;
        try {
            packets = this.decoder.push(data);
        }
        catch (error) {
            // Framing is lost and MQTT has no delimiter to resynchronise on, so the
            // only correct response is to end the connection.
            this.fail(new errors_1.ProtocolError(`the broker sent an unreadable packet: ${(0, errors_2.describeError)(error)}`));
            return;
        }
        for (const packet of packets) {
            this.handlePacket(packet);
        }
    }
    handlePacket(packet) {
        switch (packet.type) {
            case mqtt_codec_1.PacketType.CONNACK:
                this.handleConnack(packet.returnCode);
                return;
            case mqtt_codec_1.PacketType.PUBLISH:
                this.handlePublish(packet.topic, packet.payload, packet.packetId);
                return;
            case mqtt_codec_1.PacketType.PUBACK:
            case mqtt_codec_1.PacketType.SUBACK:
                this.settle(packet.packetId, packet);
                return;
            case mqtt_codec_1.PacketType.PINGRESP:
                this.clearTimer(this.pingTimeoutTimer);
                this.pingTimeoutTimer = undefined;
                return;
        }
    }
    handleConnack(returnCode) {
        if (returnCode !== 0) {
            this.fail(new errors_1.ConnectionError(`the broker refused the connection: ${(0, mqtt_codec_1.describeConnackReturnCode)(returnCode)}`));
            return;
        }
        this.connected = true;
        const settle = this.connectSettle;
        this.connectSettle = undefined;
        if (settle !== undefined) {
            this.clearTimer(settle.timer);
            settle.resolve({ type: mqtt_codec_1.PacketType.PINGRESP });
        }
        this.scheduleKeepalive();
    }
    handlePublish(topic, payload, packetId) {
        if (packetId !== undefined) {
            // Acknowledged before the handler runs. A handler that throws must not
            // leave the broker redelivering a message forever, and at QoS 1 the
            // message has already been delivered whatever we do with it.
            this.trySend((0, mqtt_codec_1.encodePuback)(packetId));
        }
        const handler = this.onMessageHandler;
        if (handler === undefined) {
            return;
        }
        try {
            handler({ topic, payload: Buffer.from(payload).toString('utf8') });
        }
        catch (error) {
            // A handler fault is a bug in the layer above, not a reason to drop a
            // working connection and reconnect into the same fault.
            this.options.log.debug(`an MQTT message handler threw: ${(0, errors_2.describeError)(error)}`);
        }
    }
    /** Send a packet and wait for the acknowledgement carrying the same id. */
    async exchange(packetId, packet, timeoutMs, label) {
        if (this.failure !== undefined) {
            throw this.failure;
        }
        if (!this.connected) {
            throw new errors_1.ConnectionError(`cannot send ${label}: the MQTT session is not connected`);
        }
        return new Promise((resolve, reject) => {
            this.pending.set(packetId, {
                resolve,
                reject,
                timer: this.setTimer(() => {
                    this.pending.delete(packetId);
                    // Not fatal to the connection. A single unacknowledged publish is
                    // worth failing on its own so the accessory that asked hears about
                    // it, while an otherwise healthy session keeps carrying state for
                    // every other accessory.
                    reject(new errors_1.ConnectionError(`the broker did not acknowledge ${label} within ${timeoutMs}ms`));
                }, timeoutMs),
            });
            try {
                this.send(packet);
            }
            catch (error) {
                const entry = this.pending.get(packetId);
                this.pending.delete(packetId);
                if (entry !== undefined) {
                    this.clearTimer(entry.timer);
                }
                reject(error instanceof Error ? error : new errors_1.ConnectionError(String(error)));
            }
        });
    }
    settle(packetId, packet) {
        const entry = this.pending.get(packetId);
        if (entry === undefined) {
            // A duplicate or very late acknowledgement. Harmless, and worth a debug
            // line only: at QoS 1 the broker is allowed to repeat itself.
            this.options.log.debug(`ignoring an unmatched acknowledgement for packet ${packetId}`);
            return;
        }
        this.pending.delete(packetId);
        this.clearTimer(entry.timer);
        entry.resolve(packet);
    }
    /**
     * Allocate a packet identifier.
     *
     * One to 65535, wrapping, skipping any still in flight. Zero is reserved by
     * the specification. The scan is bounded so a session that somehow filled
     * the space fails loudly instead of looping.
     */
    takePacketId() {
        for (let attempt = 0; attempt < 0xFFFF; attempt += 1) {
            const candidate = this.nextPacketId;
            this.nextPacketId = this.nextPacketId >= 0xFFFF ? 1 : this.nextPacketId + 1;
            if (!this.pending.has(candidate)) {
                return candidate;
            }
        }
        throw new errors_1.ProtocolError('every MQTT packet identifier is in flight');
    }
    scheduleKeepalive() {
        this.clearTimer(this.keepaliveTimer);
        this.keepaliveTimer = this.setTimer(() => {
            if (this.closed) {
                return;
            }
            this.trySend((0, mqtt_codec_1.encodePingreq)());
            this.pingTimeoutTimer = this.setTimer(() => {
                this.fail(new errors_1.ConnectionError(`the broker did not answer a keepalive ping within ${settings_1.MQTT_PING_TIMEOUT_MS}ms`));
            }, settings_1.MQTT_PING_TIMEOUT_MS);
            this.scheduleKeepalive();
        }, settings_1.MQTT_KEEPALIVE_SEC * 1_000);
    }
    send(packet) {
        const socket = this.socket;
        if (socket === undefined) {
            throw new errors_1.ConnectionError('the MQTT socket is not open');
        }
        socket.send(packet);
    }
    /** Send without caring whether it worked, for teardown and keepalive paths. */
    trySend(packet) {
        try {
            this.send(packet);
        }
        catch (error) {
            this.options.log.debug(`could not write to the MQTT socket: ${(0, errors_2.describeError)(error)}`);
        }
    }
    /**
     * End the connection, settling everything waiting on it.
     *
     * Idempotent, because several paths can reach it at once: a socket error is
     * routinely followed by a close event, and a ping timeout can race the close
     * it predicted.
     */
    fail(error, options = {}) {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.connected = false;
        this.failure = error;
        this.clearTimer(this.keepaliveTimer);
        this.clearTimer(this.pingTimeoutTimer);
        this.keepaliveTimer = undefined;
        this.pingTimeoutTimer = undefined;
        const handshake = this.connectSettle;
        this.connectSettle = undefined;
        if (handshake !== undefined) {
            this.clearTimer(handshake.timer);
            handshake.reject(error);
        }
        for (const [, entry] of this.pending) {
            this.clearTimer(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
        try {
            this.socket?.close();
        }
        catch (closeError) {
            this.options.log.debug(`could not close the MQTT socket: ${(0, errors_2.describeError)(closeError)}`);
        }
        this.socket = undefined;
        if (options.expected !== true) {
            this.options.log.debug(`MQTT session ended: ${(0, errors_2.describeError)(error)}`);
        }
        this.onCloseHandler?.(error);
    }
    setTimer(handler, ms) {
        if (this.options.setTimer !== undefined) {
            return this.options.setTimer(handler, ms);
        }
        const timer = setTimeout(handler, ms);
        // Nothing awaits these directly, and a keepalive must not be the reason a
        // shutdown cannot finish.
        timer.unref?.();
        return timer;
    }
    clearTimer(handle) {
        if (handle === undefined) {
            return;
        }
        if (this.options.clearTimer !== undefined) {
            this.options.clearTimer(handle);
            return;
        }
        clearTimeout(handle);
    }
}
exports.MqttConnection = MqttConnection;
