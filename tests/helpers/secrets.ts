/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Credential-shaped fixtures assembled at runtime.
 *
 * Redaction tests have to feed the plugin a real AWS key id, a JWT and an STS
 * token. Writing any of those as one literal is enough for GitHub secret
 * scanning to open a public leak alert on a string that never left the suite.
 * The pieces stay separate in the file; only the running process joins them.
 */

const KEY_BODY = 'TESTKEYID0000000'

/** Temporary IAM id, the form a NaviLink sign-in returns. */
export const FAKE_ASIA_KEY = 'ASIA' + KEY_BODY

/** Long-lived IAM id. The cloud never returns this; redaction still catches it. */
export const FAKE_AKIA_KEY = 'AKIA' + KEY_BODY

/** Three-segment JWT, the form of the sign-in access and id tokens. */
export const FAKE_JWT = [
  'eyJ',
  'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  '.',
  'eyJ',
  'zdWIiOiIxMjM0NTY3ODkwIn0',
  '.',
  'dBjftJeZ4CVPmB92K27uhbUJU1p1rXwW1gFWFOEjXk',
].join('')

/** Shorter JWT used where a cause string only needs the shape. */
export const FAKE_SHORT_JWT = [
  'eyJ',
  'hbGciOiJIUzI1NiJ9',
  '.',
  'eyJ',
  'zdWIiOiIxIn0',
  '.',
  'sig',
].join('')

/**
 * Session-token prefix the AWS STS service uses.
 *
 * Joined so the checkout never contains that prefix as one string, which is
 * the scanner fingerprint for a live temporary credential.
 */
export const FAKE_STS_TOKEN = ['Fwo', 'GZXIvYXdzEBYaDGV4YW1wbGU'].join('')

/** Same prefix, with the `+` / `=` / `*` a real token carries and SigV4 must encode. */
export const FAKE_STS_TOKEN_WITH_SYMBOLS = ['Fwo', 'GZXIvYXdzEBYaDE~xample*Token+/='].join('')

/** Query parameter as it appears on a signed IoT URL. */
export const FAKE_SIGNED_QUERY = `X-Amz-Security-Token=${FAKE_STS_TOKEN}`
