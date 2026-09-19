/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * A guard, not a unit test.
 *
 * A raw NaviLink capture carries the gateway MAC, which is the appliance's
 * address in every MQTT topic, so it is a capability as well as a label. It
 * also carries the account holder's name, live tokens, and from `device/info`
 * the installation's street address and coordinates. Committing one is not an
 * embarrassment, it is a disclosure.
 *
 * This is deliberately stricter than the pseudonymiser. A MAC appears in
 * `response.macAddress` and again inside `clientID`. The guard allowlists
 * the documented example values and rejects anything else that has the
 * shape of a real one, wherever it appears.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURES = join(__dirname, '..', 'fixtures')

/** The values documentation and fixtures are allowed to use. */
const ALLOWED_MAC = 'a1b2c3d4e5f6'
const ALLOWED_EMAIL_DOMAIN = 'example.com'

/** Twelve hex digits, the form the cloud spells a MAC in. */
const BARE_MAC = /\b[0-9a-f]{12}\b/gi
/** Colon-separated, in case a capture ever arrives in that form. */
const COLON_MAC = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi
const EMAIL = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./g
const AWS_KEY = /\b(?:ASIA|AKIA)[0-9A-Z]{16}\b/g
const COORDINATE_KEY = /"(?:latitude|longitude|address|zipCode|postalCode|city|state)"\s*:/gi

function fixtureFiles(): string[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(FIXTURES, name))
}

describe('committed fixtures', () => {
  const files = fixtureFiles()

  it('there are fixtures to check', () => {
    // A guard that silently checks nothing is worse than no guard: it reports
    // success for an empty directory after someone moves the files.
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s contains no MAC address but the documented one', (file) => {
    const text = readFileSync(file, 'utf8')
    const found = [
      ...(text.match(BARE_MAC) ?? []),
      ...(text.match(COLON_MAC) ?? []),
    ].map((value) => value.toLowerCase().replaceAll(':', ''))

    // Every occurrence, not just the first: `clientID` carries the MAC in a
    // different field from `response.macAddress`.
    for (const mac of found) {
      expect(mac).toBe(ALLOWED_MAC)
    }
  })

  it.each(files)('%s contains no real email address', (file) => {
    const text = readFileSync(file, 'utf8')

    for (const address of text.match(EMAIL) ?? []) {
      expect(address.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)).toBe(true)
    }
  })

  it.each(files)('%s contains no token or AWS key', (file) => {
    const text = readFileSync(file, 'utf8')

    expect(text.match(JWT)).toBeNull()
    expect(text.match(AWS_KEY)).toBeNull()
  })

  it.each(files)('%s contains no location data', (file) => {
    // `device/info` answers with the installation's street address and
    // coordinates. Nothing from that endpoint should ever be a fixture, and
    // the fields are named here so that a future capture of it fails loudly.
    const text = readFileSync(file, 'utf8')

    expect(text.match(COORDINATE_KEY)).toBeNull()
  })
})
