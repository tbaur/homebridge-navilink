/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The NaviLink REST surface: sign in, and list what the account
 * owns.
 *
 * Three calls, and they do very little. Everything that changes arrives over
 * MQTT: a temperature, a setpoint, a fault. REST exists to get the credentials
 * that make MQTT possible and to learn which appliances the account has.
 *
 * This is an unofficial API. There is no specification, no versioning promise
 * and no deprecation notice; it is the interface the NaviLink mobile app uses.
 * Everything here therefore treats an unexpected response as a protocol error
 * with a readable message. It does not reach into a shape it assumes is there.
 * When Navien changes something, the plugin should say what it did not
 * recognise.
 *
 * **Every value on this path is a credential or personal data.** The request
 * body carries the password; the response carries a JWT pair, temporary AWS
 * IAM credentials, the account holder's name, and, from `device/info`, the
 * street address and coordinates of the installation. Nothing from a response
 * is logged, and the fields the plugin does not need are never read out of it.
 */
import type { PluginLogger } from '../types';
import { type JsonPost } from './http';
import type { IotCredentials } from './sigv4';
/** A signed-in session. */
export interface NaviLinkSessionTokens {
    /** Account sequence number, which appears in every response topic. */
    userSeq: string;
    /** Bearer-less token for later REST calls. */
    accessToken: string;
    /** Present when the cloud offered one. */
    refreshToken: string | undefined;
    /** Temporary IAM credentials for the IoT endpoint. */
    credentials: IotCredentials;
    /** Epoch milliseconds after which the session must be re-established. */
    expiresAt: number;
}
/** One appliance gateway on the account, as `device/list` reports it. */
export interface ListedDevice {
    /** Gateway MAC, as the cloud spells it: lower-case hex, no separators. */
    macAddress: string;
    /** Opaque discriminator the topics need. Frequently an empty string. */
    additionalValue: string;
    /** Gateway kind. `1` for every NaviLink gateway seen so far. */
    deviceType: number;
    /** Home grouping id, which appears in every response topic. */
    homeSeq: string;
    /** The name the user gave it in the NaviLink app. */
    deviceName: string;
    /** `2` means the cloud believes the gateway is online. */
    connected: number;
}
/** Injectable collaborators, so tests need neither sockets nor real clocks. */
export interface NaviLinkRestOptions {
    log: PluginLogger;
    post?: JsonPost;
    now?: () => number;
    /** Cancels in-flight calls, so Homebridge shutdown need not wait out a deadline. */
    signal?: AbortSignal;
}
/** Talks to the NaviLink REST service. */
export declare class NaviLinkRest {
    private readonly log;
    private readonly post;
    private readonly now;
    private readonly signal;
    constructor(options: NaviLinkRestOptions);
    /**
     * Exchange an email and password for a session.
     *
     * Distinguishes a rejected account from an unreachable cloud, because the
     * two need opposite responses: a wrong password must stop the plugin
     * retrying, and a cloud outage must not.
     */
    signIn(email: string, password: string): Promise<NaviLinkSessionTokens>;
    /**
     * List the gateways on the account.
     *
     * `count` is a page size the API requires rather than a limit worth
     * configuring. Pages are walked until a short one arrives, so a 21st
     * gateway is not dropped. A cloud that never sends a short page is capped.
     */
    listDevices(input: {
        email: string;
        accessToken: string;
    }): Promise<ListedDevice[]>;
    /** One page of the device list, already parsed. */
    private listDevicePage;
    /**
     * Read a single device's detail.
     *
     * Used only to learn the firmware revision, which is worth having in
     * Accessory Information and in a bug report. **The response also carries the
     * installation's street address and coordinates**; those fields are never
     * read, so they cannot reach a log, an accessory context or a capture.
     */
    readFirmware(input: {
        email: string;
        accessToken: string;
        macAddress: string;
        additionalValue: string;
    }): Promise<string | undefined>;
    private call;
    private readBody;
    /**
     * Turn a failed sign-in into the right kind of error.
     *
     * The distinction is the point. `AuthenticationError` with
     * `credentialsRejected` stops the plugin trying again, because repeating a
     * wrong password is how an account gets locked out. Anything else is
     * transient and must be retried, because a cloud that is briefly unwell is
     * not a reason to require the user to restart Homebridge.
     */
    private signInFailure;
    /**
     * Decide how long this session is good for.
     *
     * The response reports `authorizationExpiresIn` and
     * `authenticationExpiresIn`. Neither is documented, the unit is not stated,
     * and which one governs the AWS credentials rather than the JWT is not
     * obvious from the names. So: read both as seconds, take the shorter, and
     * only believe it if it lands in a plausible band. A value outside that band
     * means the reading is wrong, and a wrong reading in the optimistic
     * direction is a session that dies mid-winter without reconnecting.
     */
    private sessionLifetimeMs;
    /**
     * Read one device-list entry, skipping anything unusable.
     *
     * Skipped rather than thrown on: an account with one unrecognised gateway
     * and one good one should expose the good one.
     */
    private readListedDevice;
}
