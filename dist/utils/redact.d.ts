/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Keeping credentials out of logs, errors and captures.
 *
 * The LAN plugins in this family have nothing to redact. This one signs in to a
 * vendor cloud with the user's password and is handed, in one response, a JWT
 * pair and a set of temporary AWS IAM credentials. Those credentials are then
 * put into a query string to sign a WebSocket URL. Three of the four things a
 * plugin normally logs without thinking (the request URL, the response body,
 * the error message) therefore carry live secrets here.
 *
 * So redaction is not a courtesy applied at call sites. It is applied inside
 * {@link describeError}, inside the HTTP layer's debug logging, and inside the
 * capture script, which between them cover every path from a value to a log
 * line. The rule this file exists to enforce: nothing derived from a sign-in
 * response is ever interpolated into a string a user might see or paste.
 *
 * Note what is deliberately *not* here. There is no `redactPassword(password)`
 * that takes the secret as an argument and looks for it in the text. Matching
 * on the value means the value has to be passed around to every logging site,
 * which is one refactor away from being logged by the thing meant to hide it.
 * These patterns match the *shape* of a credential instead, so a token the
 * plugin has never been told about is still caught.
 */
/** Replacement written in place of any matched secret. */
export declare const REDACTED = "[redacted]";
/**
 * Remove anything credential-shaped from a string.
 *
 * Safe to apply to text that contains no secrets: it is a no-op on those, so it
 * can sit unconditionally on the logging path rather than being reached for
 * when someone remembers.
 */
export declare function redactSecrets(value: string): string;
/**
 * Deep-copy a value with every secret field replaced.
 *
 * For the capture script and for debug dumps of a parsed body, where the input
 * is an object rather than a string and matching its serialised form would
 * depend on how it happened to be serialised.
 *
 * Cycles are not handled, because nothing this is applied to has any: the
 * inputs are `JSON.parse` results and plain request bodies.
 */
export declare function redactObject(value: unknown): unknown;
/**
 * Deep-copy a value with every occurrence of the given MAC addresses masked.
 *
 * Separate from {@link redactObject} because a MAC is not a credential and
 * removing it from a debug dump would remove the thing that says which
 * appliance the dump is about. It is removed only on the path to something
 * published: a captured frame attached to a bug report.
 *
 * Substitution is by known value rather than by shape. The MACs come from the
 * account's own device list, so the set is exact, and a hex-run pattern would
 * eventually match a serial number or a firmware version and corrupt the
 * capture it was meant to make safe.
 *
 * Every spelling has to be covered, because one frame contains three: the
 * `macAddress` field, `navilink-{mac}` in the client id, and the same again
 * inside every topic string. Matching the bare hex covers all three at once.
 */
export declare function maskMacsIn(value: unknown, macAddresses: readonly string[]): unknown;
/**
 * Show enough of an account name to recognise it, and no more.
 *
 * The email address identifies the user's account, so it is treated as personal
 * data rather than as a harmless label: it is written at debug, and a support
 * thread should be able to confirm *which* account without publishing it.
 * `someone@example.com` becomes `s\u2026e@example.com`.
 */
export declare function maskEmail(value: string): string;
/**
 * Show the last four characters of a MAC address, and no more.
 *
 * The gateway MAC is the appliance's identity in every topic and every log
 * line about it, and it is a globally unique hardware identifier tied to the
 * user's home. Four hex digits is enough to tell two appliances apart in a log
 * while being useless to anyone else.
 */
export declare function maskMac(value: string): string;
