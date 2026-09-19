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
import type { PluginLogger } from '../types';
import { type Subscription, type WillMessage } from './mqtt-codec';
import { type IotCredentials } from './sigv4';
/** Callbacks a socket implementation must drive. */
export interface SocketHandlers {
    onOpen(): void;
    onMessage(data: Uint8Array): void;
    onClose(reason: string): void;
    onError(error: Error): void;
}
/** The socket operations this transport needs. */
export interface MessageSocket {
    send(data: Uint8Array): void;
    close(): void;
}
/** Opens a WebSocket. Injectable so tests never touch the network. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => MessageSocket;
/** A message delivered by the broker. */
export interface MqttMessage {
    topic: string;
    payload: string;
}
/** Collaborators for one connection. */
export interface MqttConnectionOptions {
    log: PluginLogger;
    credentials: IotCredentials;
    clientId: string;
    will?: WillMessage;
    /**
     * Username presented in CONNECT.
     *
     * Optional. AWS IoT authenticates from the URL signature. The verified
     * endpoint accepts a CONNECT without a username, so the session leaves this
     * unset rather than inventing an SDK marker.
     */
    username?: string;
    /** Sign the `host` header with `:443`. The fallback; see {@link presignIotWebsocketUrl}. */
    signHostWithPort?: boolean;
    openSocket?: SocketFactory;
    /** Injected in tests so keepalive can be driven without real time. */
    setTimer?: (handler: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}
/** The default socket factory: the runtime's own WebSocket. */
export declare const openWebSocket: SocketFactory;
/**
 * One live MQTT session.
 *
 * Single use. Once it has failed or been closed it stays that way; the owner
 * builds a new one to reconnect. That keeps the state machine to two states
 * and means a stale reference cannot silently resurrect a connection whose
 * credentials have since expired.
 */
export declare class MqttConnection {
    private readonly options;
    private readonly decoder;
    private readonly pending;
    private socket;
    private nextPacketId;
    private connected;
    private closed;
    /** Set once, and the reason every later operation rejects with. */
    private failure;
    private connectSettle;
    private keepaliveTimer;
    private pingTimeoutTimer;
    private onMessageHandler;
    private onCloseHandler;
    constructor(options: MqttConnectionOptions);
    /** True while the broker has accepted us and nothing has gone wrong. */
    get isConnected(): boolean;
    /** Register the handler for inbound application messages. */
    onMessage(handler: (message: MqttMessage) => void): void;
    /**
     * Register the handler for the connection ending.
     *
     * Called exactly once, for any reason including a clean {@link close}, so an
     * owner has one place to decide whether to reconnect.
     */
    onClose(handler: (error: Error) => void): void;
    /**
     * Open the socket and complete the MQTT handshake.
     *
     * Resolves when CONNACK reports acceptance. Rejects on a refused CONNACK, a
     * socket that will not open, or a handshake that does not finish inside
     * {@link MQTT_CONNECT_TIMEOUT_MS}.
     */
    connect(): Promise<void>;
    /**
     * Subscribe, and confirm the broker granted every filter.
     *
     * A refusal is treated as fatal rather than logged and carried on with. A
     * NaviLink session that is subscribed to some of its response topics is
     * worse than one that failed: state arrives for some accessories and not
     * others, which reads as a hardware fault rather than a permissions problem.
     */
    subscribe(subscriptions: readonly Subscription[]): Promise<void>;
    /**
     * Publish at QoS 1 and wait for the broker's acknowledgement.
     *
     * QoS 1 rather than 0 because a control command that vanished in transit
     * must not be reported to HomeKit as applied. Note the limit of what this
     * proves: a PUBACK means the *broker* has the message, not that the
     * appliance has acted on it. The appliance's answer arrives separately, as a
     * status frame or a rejection on the failure topic.
     */
    publish(topic: string, payload: string, timeoutMs: number): Promise<void>;
    /**
     * Close cleanly.
     *
     * DISCONNECT before closing the socket is what stops the broker publishing
     * our last will. The will exists to tell the gateway we have gone away
     * unexpectedly, so firing it on an orderly shutdown would be a lie, and on
     * a Homebridge restart, a lie the gateway acts on.
     */
    close(): void;
    private handleOpen;
    private handleData;
    private handlePacket;
    private handleConnack;
    private handlePublish;
    /** Send a packet and wait for the acknowledgement carrying the same id. */
    private exchange;
    private settle;
    /**
     * Allocate a packet identifier.
     *
     * One to 65535, wrapping, skipping any still in flight. Zero is reserved by
     * the specification. The scan is bounded so a session that somehow filled
     * the space fails loudly instead of looping.
     */
    private takePacketId;
    private scheduleKeepalive;
    private send;
    /** Send without caring whether it worked, for teardown and keepalive paths. */
    private trySend;
    /**
     * End the connection, settling everything waiting on it.
     *
     * Idempotent, because several paths can reach it at once: a socket error is
     * routinely followed by a close event, and a ping timeout can race the close
     * it predicted.
     */
    private fail;
    private setTimer;
    private clearTimer;
}
