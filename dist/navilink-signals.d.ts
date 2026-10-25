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
 * are worth a page, and remembers which appliances were configured so a
 * removed one can be cleared. The remembered file is this plugin's own. It
 * is not the signal store, and it is never logged.
 */
import type { PagerDutySignalsOptions, SignalState } from './pagerduty-signals';
/** Logged once, with the pattern rather than each gateway. */
export declare const PAGERDUTY_STARTUP_LOG = "homebridge-pagerduty support is enabled (fault.<gateway>.<channel>, auth-failed)";
export declare const SIGNAL_AUTH_FAILED = "auth-failed";
/** The subset of the store writer this class uses. */
export interface SignalWriter {
    write(signal: string, state: SignalState): void;
    close(): void;
}
/**
 * The signal name for one appliance.
 *
 * The device id is `{mac}:{channel}`. A signal name cannot contain a colon,
 * so the separator becomes a dot. Undefined when the id is not one this
 * plugin would configure.
 */
export declare function faultSignalName(deviceId: string): string | undefined;
/**
 * The PagerDuty title for an appliance fault.
 *
 * The name is the one in config. The error code stays in the Homebridge log,
 * because a saved PagerDuty message is fixed text and would keep an old code.
 */
export declare function faultSummary(name: string): string;
/** Where the remembered appliance list lives. Local storage, not the repo. */
export declare function rememberedDevicesPath(storagePath: string): string;
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
    private readonly storagePath;
    private readonly log;
    private readonly warned;
    constructor(writer: SignalWriter, storagePath: string, log: {
        warn(message: string): void;
    });
    /**
     * Clear fault signals for appliances that are no longer configured, then
     * remember the current set. Does not write the current appliances: their
     * fault state is not known until a status frame arrives.
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
    private readRemembered;
    private writeRemembered;
    private warnOnce;
}
/** Build the signals for this plugin, backed by the homebridge-pagerduty store. */
export declare function createNaviLinkSignals(options: PagerDutySignalsOptions): NaviLinkSignals;
