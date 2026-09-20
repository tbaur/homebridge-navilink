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

import { redactSecrets } from './redact'

/** Longest description produced, so a hostile endpoint cannot flood the log. */
const MAX_DESCRIPTION_LENGTH = 300

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code.length > 0
      ? `${error.message} (${code})`
      : error.message
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * Describe an error, including any `cause` chain, for a single log line.
 *
 * Control characters are stripped: an error message can contain remote input,
 * and a newline inside a log line lets an attacker forge log entries. Secrets
 * are removed for the reason given in the file header.
 */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    const text = messageOf(current)
    if (text.length > 0 && !parts.includes(text)) {
      parts.push(text)
    }
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined
  }
  const joined = parts.length > 0 ? parts.join(': ') : 'unknown error'

  const sanitized = redactSecrets(joined).replace(/[\u0000-\u001F\u007F]/g, '\uFFFD')
  return sanitized.length > MAX_DESCRIPTION_LENGTH
    ? `${sanitized.slice(0, MAX_DESCRIPTION_LENGTH)}\u2026`
    : sanitized
}

/**
 * Raised when the cloud refused the account.
 *
 * Separated from every other failure because it is the one the user can act on
 * and the one that must not be retried in a loop: a wrong password retried
 * every thirty seconds is how an account gets locked. The platform stops
 * signing in when it sees this and says so once.
 */
export class AuthenticationError extends Error {
  /** True when the cloud named the credentials rather than failing generically. */
  readonly credentialsRejected: boolean

  constructor(message: string, options?: { cause?: unknown; credentialsRejected?: boolean }) {
    super(message, options)
    this.name = 'AuthenticationError'
    this.credentialsRejected = options?.credentialsRejected === true
  }
}

/** Raised when the cloud answered, but not with something we can parse. */
export class ProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProtocolError'
  }
}

/** Raised when the cloud could not be reached at all. */
export class ConnectionError extends Error {
  /**
   * True when this plugin closed the socket on purpose.
   *
   * A credential refresh closes the live connection so it can sign in again.
   * That is not an outage: the tiles stay current and the log stays quiet.
   */
  readonly expected: boolean

  constructor(message: string, options?: { cause?: unknown; expected?: boolean }) {
    super(message, options)
    this.name = 'ConnectionError'
    this.expected = options?.expected === true
  }
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
export class ControlRejectedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ControlRejectedError'
  }
}
