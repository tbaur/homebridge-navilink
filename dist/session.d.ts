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
 *
 * **A connected socket does not mean a live appliance.** The broker will
 * happily hold a connection open for a gateway that has gone offline. So
 * observations carry the time they were taken, and one that has gone stale
 * stops being reported as current. The accessories go to No Response instead
 * of showing yesterday's setpoint.
 */
import { MqttConnection, type MqttConnectionOptions } from './api/mqtt';
import { type ControlInput, type OutboundFrame } from './api/protocol';
import { NaviLinkRest } from './api/rest';
import type { ChannelObservation, PluginLogger, RefreshReason, ResolvedDevice } from './types';
import { type ResolvedAccount } from './utils';
/**
 * One control command, with enough about it to log and to gate.
 *
 * The command code travels alongside the builder rather than being dug out
 * of the frame, so a log line does not have to re-parse JSON this module
 * just produced.
 */
export interface ControlSpec {
    /** The numeric command. */
    command: number;
    /** What this does, in words, for the log. */
    what: string;
    build(input: ControlInput & {
        channelNumber: number;
    }): OutboundFrame;
}
/** What the session tells the platform when state arrives. */
export type ObservationListener = (deviceId: string, observation: ChannelObservation, reason: RefreshReason) => void;
/** What the session tells the platform when the cloud is not answering. */
export type UnreachableListener = (error: unknown) => void;
/** What the session tells the platform when one appliance has gone quiet. */
export type StaleListener = (deviceId: string) => void;
/** Collaborators, all injectable so tests need no network and no real clock. */
export interface NaviLinkSessionOptions {
    log: PluginLogger;
    account: ResolvedAccount;
    devices: readonly ResolvedDevice[];
    statusIntervalSec: number;
    rest?: NaviLinkRest;
    createConnection?: (options: MqttConnectionOptions) => MqttConnection;
    now?: () => number;
    random?: () => number;
}
/** Owns the plugin's entire relationship with the NaviLink cloud. */
export declare class NaviLinkSession {
    private readonly options;
    private readonly log;
    private readonly rest;
    private readonly now;
    private readonly gateways;
    private readonly observations;
    private readonly observationListeners;
    private readonly unreachableListeners;
    private readonly staleListeners;
    private connection;
    /** Gateway firmware by MAC, read once per session for the log and bug reports. */
    private readonly firmwareByMac;
    private clientId;
    private running;
    /** Resolves when the current connection ends, so the loop can wait on it. */
    private sessionEnded;
    private backoffSleep;
    private statusTimer;
    private refreshTimer;
    /** Set when the account was rejected, which stops the loop permanently. */
    private fatal;
    /** True while a poll, not a push or a post-set, is asking for status. */
    private pollInFlight;
    /** Aborts in-flight REST so shutdown does not wait out a 30s request deadline. */
    private readonly abort;
    constructor(options: NaviLinkSessionOptions);
    /** Register a handler for fresh state. */
    onObservation(listener: ObservationListener): void;
    /** Register a handler for the cloud becoming unreachable. */
    onUnreachable(listener: UnreachableListener): void;
    /** Register a handler for one appliance going stale while the broker is up. */
    onStale(listener: StaleListener): void;
    /**
     * The current state of a device, or undefined when there is none to trust.
     *
     * Undefined covers two cases that accessories treat identically: nothing has
     * arrived yet, and what arrived is too old to present as current. See the
     * file header on why a stale reading is not returned.
     */
    observationFor(deviceId: string): ChannelObservation | undefined;
    /**
     * Adopt the effect of a write before the appliance confirms it.
     *
     * The tile should settle on what was asked for rather than flicking back to
     * the old value for the second it takes a status frame to arrive. The next
     * real observation overwrites this wholesale, so a write that silently did
     * nothing corrects itself rather than sticking.
     */
    applyOptimisticWrite(deviceId: string, patch: Partial<ChannelObservation>): void;
    /** Start the session and keep it running until {@link stop}. */
    start(): void;
    /** Stop the session and release everything it holds. */
    stop(): Promise<void>;
    /**
     * Publish a control frame for a device.
     *
     * Rate-limited per gateway, and refused outright while a gateway is in a
     * control lockout. A HomeKit scene can touch several tiles at once, and the
     * cloud answers a burst by locking the account's control channel. See
     * {@link handleControlFailure}.
     */
    publishControl(deviceId: string, spec: ControlSpec): Promise<void>;
    /**
     * Sign in, connect, and keep doing so.
     *
     * One loop rather than a web of callbacks, so the order of operations is
     * readable and there is exactly one place that decides whether to try again.
     */
    private runForever;
    /** Sign in, list devices, connect MQTT, subscribe, and ask for state. */
    private establish;
    /** Match the account's gateways against what the user configured. */
    private adoptGateways;
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
    private readFirmware;
    /** The gateway firmware behind a device, when the cloud disclosed it. */
    firmwareFor(deviceId: string): string | undefined;
    /**
     * Open the MQTT connection, trying both Host header signatures.
     *
     * The two forms are both defensible readings of the SigV4 rule for a default
     * port, and the wrong one fails as a silent rejected upgrade that is
     * indistinguishable from a bad password. Measured against this endpoint the
     * bare host works, so that is first; the other is tried rather than leaving
     * a user to guess which of the two their region wants.
     */
    private openConnection;
    private buildConnection;
    private subscribeAll;
    private handleConnectionClosed;
    private waitForSessionEnd;
    /** Stop trying, and say why exactly once. */
    private stopPermanently;
    /** True when the session has given up for a reason the user must fix. */
    get hasStoppedPermanently(): boolean;
    private requestChannelInfo;
    private requestStatus;
    /** Ask every known channel for its state. */
    private requestAllStatus;
    private handleMessage;
    /**
     * Which gateway a frame is about.
     *
     * Answers arrive on the gateway prefix, which contains the MAC, so a frame
     * can be attributed even though it may be the answer to somebody else's
     * request: the NaviLink app on a phone, or the wall controller. That is how
     * a setpoint changed elsewhere reaches HomeKit without being asked for.
     */
    private gatewayForTopic;
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
    private handleControlFailure;
    private handleChannelInfo;
    private handleChannelStatus;
    private emit;
    private notifyUnreachable;
    private scheduleStatusPolling;
    /** Ask every known channel, labelled as a poll so accessories can tell. */
    private pollAllStatus;
    /**
     * Push No Response for appliances whose last frame is now too old.
     *
     * The broker can stay connected while a gateway is dead. `observationFor`
     * already hides those readings from GET; this makes the tile follow now.
     */
    private dropStaleObservations;
    /** Close the live socket without treating a leftover as the current one. */
    private dropConnection;
    /** One line per channel so a bug report can say `family=` without a capture. */
    private logChannelFamilies;
    /** A configured id whose channel is missing stays No Response otherwise. */
    private warnMissingChannels;
    /**
     * Re-establish the session before its credentials expire.
     *
     * Closing the connection is what wakes {@link runForever}, which signs in
     * again from the top. Refreshing in place would be less disruptive and is
     * not done, because there is no confirmed refresh endpoint: a full sign-in
     * is the only path known to produce a working set of AWS credentials, and a
     * brief reconnect on a timer we choose is better than an expiry we do not
     * control.
     */
    private scheduleRefresh;
    private clearTimers;
}
