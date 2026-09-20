/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * The split between fatal and non-fatal is deliberate. A missing account, or a
 * `devices` value that is not a list, means the file does not describe
 * anything we can act on, so the platform disables itself while leaving cached
 * accessories registered. HomeKit then shows them as No Response rather than
 * losing the rooms and automations built on them.
 *
 * A problem with one device is different: rejecting the whole installation
 * because one entry is malformed would be a worse outcome than skipping that
 * entry. Skipped devices are warned about by name and reason, because a device
 * that silently fails to appear is the hardest kind of bug for a user to
 * report.
 *
 * One rule specific to this plugin: **nothing in here ever puts the password
 * into a message.** Not its length, not a prefix, not "you typed
 * `hunter2␣`" to explain a trailing space. Validation says whether it is
 * present and usable and stops there.
 */
import type { ResolvedAccessory, ResolvedDevice } from '../types';
/** Platform-wide settings after validation and defaulting. */
export interface ResolvedPlatformOptions {
    statusIntervalSec: number;
    allowPowerOff: boolean;
    readOnly: boolean;
    diagnosticsInterval: number;
    structuredLogs: boolean;
    accessoryPrefix: string;
}
/** The account, once it is known to be usable. */
export interface ResolvedAccount {
    email: string;
    password: string;
}
/** Outcome of validating a platform configuration block. */
export interface ConfigValidationResult {
    /** Fatal problems. Any entry means the platform must not sign in. */
    errors: string[];
    /** Problems worth reporting that do not prevent operation. */
    warnings: string[];
    /** The account, or undefined when it was missing or unusable. */
    account: ResolvedAccount | undefined;
    /** Devices that survived validation, in configuration order. */
    devices: ResolvedDevice[];
    options: ResolvedPlatformOptions;
}
/**
 * Make an untrusted string safe to interpolate into a log line.
 *
 * Device names come from configuration and from the cloud, so they are
 * attacker-influenced in the threat model where someone can write to either. A
 * newline in a log line lets them forge entries; truncation stops one long
 * name from burying everything else.
 */
export declare function forLog(value: unknown): string;
/**
 * Make an untrusted string safe to publish to HomeKit.
 *
 * Same sanitising as {@link forLog} but capped at HomeKit's name budget rather
 * than the log field budget, for values that become characteristic values and
 * are written into the accessory cache. An empty result becomes undefined, so
 * a caller keeps the value it already had instead of publishing a blank.
 */
export declare function forDisplay(value: string): string | undefined;
/** True when a value is safe to use as a device id and accessory UUID seed. */
export declare function isValidDeviceId(value: unknown): value is string;
/** True for something shaped like an email address. */
export declare function isValidEmail(value: unknown): value is string;
/** Clamp the status interval into the supported range. */
export declare function resolveStatusIntervalSec(value: unknown, warnings?: string[]): number;
/**
 * Resolve the diagnostics heartbeat interval.
 *
 * `0` and anything not a number is off. Values between 1 and 29 clamp up to
 * 30 so a typo does not silently disable the heartbeat.
 */
export declare function resolveDiagnosticsIntervalSec(value: unknown, warnings?: string[]): number;
/**
 * Resolve the HomeKit accessory-name prefix.
 *
 * Blank means each appliance's own name is used. The value is trimmed and
 * stripped of control characters; it is never required.
 */
export declare function resolveAccessoryPrefix(value: unknown, warnings?: string[]): string;
/**
 * Validate a platform configuration block.
 *
 * Never throws: the platform needs the errors and warnings in order to report
 * them, and a configuration problem should produce a diagnosable log rather
 * than an exception during Homebridge startup.
 */
export declare function validateConfig(config: unknown): ConfigValidationResult;
/**
 * Expand validated devices into the accessories to expose.
 *
 * Names are derived here rather than at use time so that duplicates can be
 * detected once: two accessories sharing a name still work, but they make Siri
 * ambiguous, which is worth a warning.
 *
 * When `accessoryPrefix` is set it replaces the appliance name as the stem
 * (`Zone One Hot Water`). Two appliances on one prefix keep the appliance
 * name after it so the tiles stay distinct.
 *
 * The probe accessories are created unconditionally when `temperatureSensors`
 * is on, rather than only for the probes the appliance turns out to report.
 * Whether a probe exists is only knowable from a live status frame, which
 * arrives after accessories are registered, and creating them later would mean
 * an accessory appearing minutes into a session. Each one disables itself on
 * the first observation that shows nothing behind it.
 */
export declare function resolveAccessories(devices: readonly ResolvedDevice[], warnings?: string[], accessoryPrefix?: string): ResolvedAccessory[];
