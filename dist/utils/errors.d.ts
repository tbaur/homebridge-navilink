/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Error types and description helpers.
 *
 * Node wraps low-level network failures in `cause` chains, so a bare
 * `error.message` frequently reads "fetch failed" while the useful detail
 * (ENOTFOUND, ETIMEDOUT) sits one level down.
 *
 * Every description produced here is passed through {@link redactSecrets}. That
 * is not belt and braces: this plugin signs in with a password and holds AWS
 * credentials in a query string, and the places an error message comes from
 * (a failed request URL, a rejected sign-in body, a WebSocket close reason) are
 * exactly the places those values live. A credential reaches the log through an
 * error message or it does not reach it at all.
 */
/**
 * Describe an error, including any `cause` chain, for a single log line.
 *
 * Control characters are stripped: an error message can contain remote input,
 * and a newline inside a log line lets an attacker forge log entries. Secrets
 * are removed for the reason given in the file header.
 */
export declare function describeError(error: unknown): string;
/**
 * Raised when the cloud refused the account.
 *
 * Separated from every other failure because it is the one the user can act on
 * and the one that must not be retried in a loop: a wrong password retried
 * every thirty seconds is how an account gets locked. The platform stops
 * signing in when it sees this and says so once.
 */
export declare class AuthenticationError extends Error {
    /** True when the cloud named the credentials rather than failing generically. */
    readonly credentialsRejected: boolean;
    constructor(message: string, options?: {
        cause?: unknown;
        credentialsRejected?: boolean;
    });
}
/** Raised when the cloud answered, but not with something we can parse. */
export declare class ProtocolError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** Raised when the cloud could not be reached at all. */
export declare class ConnectionError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/**
 * Raised when this plugin refuses a control command before it is sent.
 *
 * Used for the rules the plugin itself enforces: read-only mode, the
 * power-off guard, a session that is not connected, a control lockout.
 * A cloud `controlfail` frame cannot be correlated back to the write that
 * caused it (no command id survives the round trip), so those are logged
 * in the session and never thrown as this error.
 */
export declare class ControlRejectedError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
