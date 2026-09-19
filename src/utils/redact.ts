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
export const REDACTED = '[redacted]'

/**
 * Query parameters whose values are credentials.
 *
 * `X-Amz-Security-Token` is the session token, `X-Amz-Credential` embeds the
 * access key id, and `X-Amz-Signature` is derived from the secret key. A signed
 * IoT URL therefore cannot be logged at all, which is why the MQTT transport
 * logs the endpoint host instead of the URL it dials.
 */
const SECRET_QUERY_KEYS = [
  'X-Amz-Security-Token',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'password',
  'accessToken',
  'refreshToken',
  'idToken',
]

/**
 * JSON keys whose values are credentials.
 *
 * The full set returned by `POST /user/sign-in`, plus the fields a request
 * body carries on the way in.
 */
const SECRET_JSON_KEYS = [
  'password',
  'accessToken',
  'refreshToken',
  'idToken',
  'accessKeyId',
  'secretKey',
  'sessionToken',
  'authorization',
  'Authorization',
]

const PATTERNS: readonly RegExp[] = [
  // `"password":"..."` and friends, with or without spaces around the colon.
  new RegExp(`("(?:${SECRET_JSON_KEYS.join('|')})"\\s*:\\s*)"[^"]*"`, 'gi'),
  // `X-Amz-Security-Token=...` in a query string, up to the next delimiter.
  new RegExp(`((?:${SECRET_QUERY_KEYS.join('|')})=)[^&\\s"')]+`, 'gi'),
  // A JWT anywhere at all: three base64url segments joined by dots. The id and
  // access tokens are JWTs, and this catches one that reached a string by a
  // route nothing above anticipated.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  // An AWS access key id. `ASIA` is the temporary-credential prefix, which is
  // what a sign-in returns; `AKIA` is a long-lived one and should never appear,
  // which is precisely why it is worth catching if it does.
  /\b(?:ASIA|AKIA)[0-9A-Z]{16}\b/g,
]

/**
 * Remove anything credential-shaped from a string.
 *
 * Safe to apply to text that contains no secrets: it is a no-op on those, so it
 * can sit unconditionally on the logging path rather than being reached for
 * when someone remembers.
 */
export function redactSecrets(value: string): string {
  let result = value
  for (const pattern of PATTERNS) {
    // The capture group, where a pattern has one, is the key and separator, so
    // the key stays readable and only its value is replaced. A log line reading
    // `"password":[redacted]` is far more diagnosable than one where the field
    // vanished.
    //
    // The type check is load-bearing, not defensive. For a pattern with no
    // capture group, `replace` passes the match *offset* as the second
    // argument, so a truthiness or undefined check prepends a number to the
    // replacement and leaves `0[redacted]` in the log.
    result = result.replace(pattern, (_match: string, prefix: unknown) => (
      typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED
    ))
  }
  return result
}

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
export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactObject)
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redactSecrets(value) : value
  }
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_JSON_KEYS.includes(key) ? REDACTED : redactObject(child)
  }
  return result
}

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
export function maskMacsIn(value: unknown, macAddresses: readonly string[]): unknown {
  const substitutions = macAddresses
    .map((mac) => mac.replace(/[^0-9A-Fa-f]/g, ''))
    .filter((mac) => mac.length >= 4)
    .map((mac) => ({ pattern: new RegExp(mac, 'gi'), replacement: maskMac(mac) }))
  if (substitutions.length === 0) {
    return value
  }

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk)
    }
    if (typeof node === 'string') {
      return substitutions.reduce(
        (text, { pattern, replacement }) => text.replace(pattern, replacement),
        node,
      )
    }
    if (node === null || typeof node !== 'object') {
      return node
    }
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      result[key] = walk(child)
    }
    return result
  }
  return walk(value)
}

/**
 * Show enough of an account name to recognise it, and no more.
 *
 * The email address identifies the user's account, so it is treated as personal
 * data rather than as a harmless label: it is written to the log once at
 * startup, and a support thread should be able to confirm *which* account
 * without publishing it. `someone@example.com` becomes `s\u2026e@example.com`.
 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@')
  if (at <= 0) {
    return REDACTED
  }
  const local = value.slice(0, at)
  const domain = value.slice(at)
  if (local.length <= 2) {
    return `${local[0] ?? ''}\u2026${domain}`
  }
  return `${local[0] ?? ''}\u2026${local[local.length - 1] ?? ''}${domain}`
}

/**
 * Show the last four characters of a MAC address, and no more.
 *
 * The gateway MAC is the appliance's identity in every topic and every log
 * line about it, and it is a globally unique hardware identifier tied to the
 * user's home. Four hex digits is enough to tell two appliances apart in a log
 * while being useless to anyone else.
 */
export function maskMac(value: string): string {
  const cleaned = value.replace(/[^0-9A-Fa-f]/g, '')
  if (cleaned.length < 4) {
    return REDACTED
  }
  return `\u2026${cleaned.slice(-4).toUpperCase()}`
}
