/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Turns appliance faults and a rejected NaviLink sign-in into
 * homebridge-pagerduty signals.
 *
 * The store writer is the copied module. This file decides which conditions
 * are worth a page. A fault signal is the appliance's name from config. A
 * fault still in the store under a name that is no longer configured is
 * cleared from the store itself, so this plugin keeps no list of its own.
 */
import type { PagerDutySignalsOptions, SignalState } from './pagerduty-signals';
/** Logged once, with the pattern rather than each appliance name. */
export declare const PAGERDUTY_STARTUP_LOG = "homebridge-pagerduty support is enabled (fault.<name>, auth-failed)";
export declare const SIGNAL_AUTH_FAILED = "auth-failed";
/** One row this plugin has already written. */
export interface ListedSignal {
    signal: string;
    active: boolean;
    summary: string;
}
/** The subset of the store writer this class uses. */
export interface SignalWriter {
    write(signal: string, state: SignalState): void;
    list(): readonly ListedSignal[];
    close(): void;
}
/**
 * The signal name for one appliance, from its configured name.
 *
 * The store only accepts lowercase letters, digits, `.`, `_` and `-`. A space
 * or anything else becomes a hyphen. Undefined when the name has none of the
 * accepted characters.
 */
export declare function faultSignalName(name: string): string | undefined;
/**
 * The PagerDuty title for an appliance fault.
 *
 * The name is the one in config. The error code stays in the Homebridge log,
 * because a saved PagerDuty message is fixed text and would keep an old code.
 */
export declare function faultSummary(name: string): string;
/**
 * Fault and sign-in signals for this plugin.
 *
 * Fault rows are written when a status frame arrives, not before: a clear
 * written at startup would resolve a lockout that is still in progress.
 * Auth is written when sign-in is accepted or refused, and left alone for
 * every failure the session will retry.
 */
export declare class NaviLinkSignals {
    private readonly writer;
    private readonly log;
    private readonly warned;
    /** Signal name for each configured appliance, including collision suffixes. */
    private signalFor;
    constructor(writer: SignalWriter, log: {
        warn(message: string): void;
    });
    /**
     * Clear fault signals whose names are no longer configured.
     *
     * Does not write the current appliances: their fault state is not known
     * until a status frame arrives.
     */
    syncDevices(devices: readonly {
        id: string;
        name: string;
    }[]): void;
    /** Record whether this appliance's latest status frame has an error code. */
    setFault(deviceId: string, name: string, isActive: boolean): void;
    /** Record whether NaviLink has rejected the account and stopped sign-in. */
    setAuthenticationRejected(isRejected: boolean): void;
    /** Close the store. Does not clear any signal. */
    close(): void;
    private listedSignals;
    private warnUnusable;
    private warnOnce;
}
/** Build the signals for this plugin, backed by the homebridge-pagerduty store. */
export declare function createNaviLinkSignals(options: PagerDutySignalsOptions): NaviLinkSignals;
