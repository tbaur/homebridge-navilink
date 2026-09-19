/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One-shot sign-in, for the settings page and the scripts.
 *
 * The LAN plugins in this family discover over mDNS and can describe a device
 * from the first reply. Here the account is the directory: signing in lists
 * the gateways, and only a gateway itself can say what is attached to it. So
 * this does the whole round trip (sign in, list, connect, ask each gateway
 * to describe its channels) and then puts everything down again.
 *
 * It is deliberately not the session. The session is a long-lived thing with
 * reconnects, backoff and a credential clock; this runs inside a settings
 * page that the user may close at any moment, so every part of it is bounded
 * and nothing is retried. If it cannot answer within the budget, the page
 * says so and the user presses the button again.
 *
 * Two views of the same round trip. {@link NaviLinkDiscovery.discover}
 * returns capabilities, which is what the settings page needs to offer a
 * recirculation switch only where a pump is fitted.
 * {@link NaviLinkDiscovery.capture} returns the raw frames, which is what a
 * fixture and a bug report need. They are one class because they are one
 * conversation with the cloud, and keeping them apart would mean two
 * implementations of a handshake that is fiddly enough once.
 */
import { MqttConnection, type MqttConnectionOptions } from './api/mqtt';
import { NaviLinkRest } from './api/rest';
import { type FrameKind } from './api/topics';
import type { DiscoveredDevice, PluginLogger } from './types';
/** Collaborators, injectable so the tests need no network. */
export interface DiscoveryOptions {
    log: PluginLogger;
    rest?: NaviLinkRest;
    createConnection?: (options: MqttConnectionOptions) => MqttConnection;
}
/** One raw frame, as the gateway sent it. */
export interface CapturedFrame {
    kind: FrameKind;
    /** Gateway MAC this frame came from, unmasked: a capture is a local file. */
    macAddress: string;
    channelNumber: number | undefined;
    frame: unknown;
}
/** Signs in once and reports what the account owns. */
export declare class NaviLinkDiscovery {
    private readonly log;
    private readonly rest;
    private readonly options;
    constructor(options: DiscoveryOptions);
    /** Sign in and describe every appliance on the account. */
    discover(email: string, password: string): Promise<DiscoveredDevice[]>;
    /**
     * Sign in and record the raw frames every channel answers with.
     *
     * For fixtures and bug reports. `redact` removes the account, the tokens
     * and the MAC addresses; it is the default for anything a user will paste
     * somewhere public, and it is off only when recording a fixture that
     * `scripts/pseudonymise.js` will rewrite deliberately.
     */
    capture(input: {
        email: string;
        password: string;
        redact?: boolean;
    }): Promise<CapturedFrame[]>;
    /**
     * Sign in, connect, run the caller's work, and always hang up.
     *
     * The connection is closed on every path, including the timeout. A leaked
     * MQTT connection in a UI process is worse than it sounds: that process
     * outlives the request and would hold a client id the real session then
     * competes with.
     */
    private withConnection;
    /**
     * Open MQTT, trying both Host header signatures, then run the work.
     *
     * The connection is closed on every path, including the timeout.
     */
    private withMqttSession;
    /**
     * One signature attempt. Returns true on success, or the connect error.
     *
     * An error after the connection is up is thrown, not returned: that is the
     * caller's work failing, not a reason to try `:443`.
     */
    private tryMqttSession;
    /**
     * Read each gateway's firmware, for the card.
     *
     * Cosmetic, so a failure is not one: this endpoint answers 403 on some
     * accounts whose device list works perfectly well. The same endpoint also
     * carries the installation's street address and coordinates, which is why
     * it is read through a method that returns only the version.
     */
    private readFirmware;
}
