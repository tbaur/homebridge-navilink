/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * A wrong signature fails as a rejected WebSocket upgrade with no detail,
 * which is indistinguishable from a bad password and sends you looking at IAM
 * policy. These tests pin the parts that are easy to get subtly wrong.
 */

import { amzTimestamps, presignIotWebsocketUrl, uriEncode } from '../../src/api/sigv4'
import { FAKE_ASIA_KEY, FAKE_STS_TOKEN_WITH_SYMBOLS } from '../helpers/secrets'

const credentials = {
  accessKeyId: FAKE_ASIA_KEY,
  secretKey: ['wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY'].join(''),
  sessionToken: FAKE_STS_TOKEN_WITH_SYMBOLS,
  endpoint: 'a1t30mldyslmuq-ats.iot.us-east-1.amazonaws.com',
  region: 'us-east-1',
}
const now = new Date('2026-01-02T03:04:05.678Z')

describe('uriEncode', () => {
  it('encodes an asterisk, which encodeURIComponent leaves alone', () => {
    // Session tokens contain these, so getting either wrong produces a
    // signature mismatch rather than an obvious error.
    expect(uriEncode('a*b')).toBe('a%2Ab')
  })

  it('leaves a tilde alone, which encodeURIComponent encodes', () => {
    expect(uriEncode('a~b')).toBe('a~b')
  })

  it('encodes the characters AWS expects encoded', () => {
    expect(uriEncode('a/b+c=d')).toBe('a%2Fb%2Bc%3Dd')
  })
})

describe('amzTimestamps', () => {
  it('produces the two forms SigV4 wants from one instant', () => {
    expect(amzTimestamps(now)).toEqual({
      amzDate: '20260102T030405Z',
      dateStamp: '20260102',
    })
  })
})

describe('presignIotWebsocketUrl', () => {
  const url = presignIotWebsocketUrl(credentials, { now })

  it('addresses the IoT MQTT path over wss on 443', () => {
    expect(url.startsWith(`wss://${credentials.endpoint}:443/mqtt?`)).toBe(true)
  })

  it('scopes the credential to the iotdevicegateway service', () => {
    // Not `iot`. The data plane signs as a different service name from the
    // control plane, and using the wrong one is a silent rejection.
    expect(url).toContain('iotdevicegateway')
    expect(url).toContain(uriEncode(`${credentials.accessKeyId}/20260102/us-east-1/iotdevicegateway/aws4_request`))
  })

  it('appends the security token after the signature, not before it', () => {
    // Specific to IoT's WebSocket flow: including the token in the canonical
    // query string produces a signature the endpoint rejects.
    const signatureAt = url.indexOf('X-Amz-Signature=')
    const tokenAt = url.indexOf('X-Amz-Security-Token=')

    expect(signatureAt).toBeGreaterThan(0)
    expect(tokenAt).toBeGreaterThan(signatureAt)
  })

  it('percent-encodes the session token', () => {
    expect(url).toContain(uriEncode(credentials.sessionToken))
    // The raw form must not survive: it contains `+` and `=`, which would end
    // the parameter early.
    expect(url).not.toContain(FAKE_STS_TOKEN_WITH_SYMBOLS)
  })

  it('is deterministic for one instant', () => {
    expect(presignIotWebsocketUrl(credentials, { now })).toBe(url)
  })

  it('signs a different URL for the host:443 variant', () => {
    // The two are both defensible readings of the rule for a default port,
    // and the transport tries one then the other rather than making a user
    // guess which their region wants.
    const withPort = presignIotWebsocketUrl(credentials, { now, signHostWithPort: true })

    expect(withPort).not.toBe(url)
    // Only the signature differs; the URL still dials the same place.
    expect(withPort.startsWith(`wss://${credentials.endpoint}:443/mqtt?`)).toBe(true)
  })

  it('orders the canonical query parameters as SigV4 requires', () => {
    const query = url.slice(url.indexOf('?') + 1).split('&').map((pair) => pair.split('=')[0]!)
    const canonical = query.slice(0, 5)

    expect(canonical).toEqual([
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
    ])
    expect([...canonical].sort()).toEqual(canonical)
  })
})
