/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * This plugin holds a cloud password and a set of temporary AWS credentials,
 * and puts the latter into a URL. The three things a plugin normally logs
 * without thinking (the request URL, the response body, the error message)
 * all carry a live secret here, so redaction is not a nicety and these tests
 * are not box-ticking.
 */

import {
  maskEmail,
  maskMac,
  maskMacsIn,
  redactObject,
  redactSecrets,
  REDACTED,
} from '../../src/utils/redact'
import {
  FAKE_AKIA_KEY,
  FAKE_ASIA_KEY,
  FAKE_JWT,
  FAKE_STS_TOKEN,
} from '../helpers/secrets'

describe('redactSecrets', () => {
  it('removes a password from a request body', () => {
    const result = redactSecrets('{"userId":"a@b.com","password":"hunter2"}')

    expect(result).not.toContain('hunter2')
    expect(result).toContain('"password":[redacted]')
    // The key survives, because a log line that says which field was removed
    // is far more diagnosable than one where the field vanished.
    expect(result).toContain('userId')
  })

  it('removes every credential a sign-in response carries', () => {
    const body = JSON.stringify({
      token: {
        accessToken: 'a'.repeat(40),
        refreshToken: 'b'.repeat(40),
        idToken: 'c'.repeat(40),
        accessKeyId: FAKE_ASIA_KEY,
        secretKey: 'd'.repeat(40),
        sessionToken: 'e'.repeat(200),
      },
    })

    const result = redactSecrets(body)

    for (const secret of ['a'.repeat(40), 'b'.repeat(40), FAKE_ASIA_KEY, 'e'.repeat(200)]) {
      expect(result).not.toContain(secret)
    }
  })

  it('removes the credentials from a signed IoT URL', () => {
    // The whole URL is a credential: anyone holding it can speak to the
    // account's IoT endpoint until it expires.
    const url = 'wss://x-ats.iot.us-east-1.amazonaws.com:443/mqtt'
      + '?X-Amz-Algorithm=AWS4-HMAC-SHA256'
      + `&X-Amz-Credential=${FAKE_ASIA_KEY}%2F20260101%2Fus-east-1%2Fiotdevicegateway%2Faws4_request`
      + '&X-Amz-Date=20260101T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host'
      + '&X-Amz-Signature=deadbeefdeadbeefdeadbeefdeadbeef'
      + `&X-Amz-Security-Token=${FAKE_STS_TOKEN}`

    const result = redactSecrets(url)

    expect(result).not.toContain('deadbeef')
    expect(result).not.toContain(FAKE_STS_TOKEN)
    expect(result).not.toContain(FAKE_ASIA_KEY)
    // The host survives, so a log line still says where the connection went.
    expect(result).toContain('iot.us-east-1.amazonaws.com')
  })

  it('catches a JWT that reached a string by an unanticipated route', () => {
    // Shape-matched rather than value-matched, so a token nothing was told
    // about is still removed.
    expect(redactSecrets(`failed with token ${FAKE_JWT} oh dear`)).not.toContain(FAKE_JWT)
  })

  it('catches a long-lived AWS key, which should never appear at all', () => {
    expect(redactSecrets(FAKE_AKIA_KEY)).toBe(REDACTED)
  })

  it('leaves ordinary text untouched', () => {
    // It sits unconditionally on the logging path, so it has to be a no-op on
    // everything that is not a secret.
    const text = 'channel 1 reported 120\u00B0F, error 0, family NCB'

    expect(redactSecrets(text)).toBe(text)
  })
})

describe('redactObject', () => {
  it('replaces secret fields at any depth', () => {
    const result = redactObject({
      data: { token: { accessToken: 'secret', authenticationExpiresIn: 3600 } },
    }) as Record<string, Record<string, Record<string, unknown>>>

    expect(result.data.token.accessToken).toBe(REDACTED)
    // Non-secret siblings survive, which is what makes a redacted capture
    // still useful as a fixture.
    expect(result.data.token.authenticationExpiresIn).toBe(3600)
  })

  it('walks arrays', () => {
    const result = redactObject([{ password: 'a' }, { password: 'b' }]) as { password: string }[]

    expect(result.map((entry) => entry.password)).toEqual([REDACTED, REDACTED])
  })

  it('redacts secrets inside string values too', () => {
    const result = redactObject({ note: 'url?X-Amz-Signature=abc123' }) as { note: string }

    expect(result.note).not.toContain('abc123')
  })
})

describe('maskEmail', () => {
  it('shows enough to recognise the account and no more', () => {
    expect(maskEmail('someone@example.com')).toBe('s\u2026e@example.com')
  })

  it('handles a very short local part', () => {
    expect(maskEmail('ab@example.com')).toBe('a\u2026@example.com')
  })

  it('refuses to guess at something that is not an address', () => {
    expect(maskEmail('not-an-address')).toBe(REDACTED)
  })
})

describe('maskMac', () => {
  it('shows the last four hex digits', () => {
    // The gateway MAC is the appliance's address in every MQTT topic, so it
    // is a capability and not merely an identifier.
    expect(maskMac('a1b2c3d4e5f6')).toBe('\u2026E5F6')
    expect(maskMac('a1:b2:c3:d4:e5:f6')).toBe('\u2026E5F6')
  })

  it('refuses anything too short to mask safely', () => {
    expect(maskMac('ab')).toBe(REDACTED)
  })
})

describe('maskMacsIn', () => {
  const MAC = 'a1b2c3d4e5f6'

  it('masks the field a frame states it in', () => {
    const result = maskMacsIn({ response: { macAddress: MAC } }, [MAC])
    expect(result).toEqual({ response: { macAddress: '\u2026E5F6' } })
  })

  it('masks it inside a client id, where it is only part of the string', () => {
    // A frame spells the same MAC three ways. Masking the field alone leaves
    // the other two, which is the same as not masking it at all.
    const result = maskMacsIn({ clientID: `navilink-${MAC}` }, [MAC])
    expect(result).toEqual({ clientID: 'navilink-\u2026E5F6' })
  })

  it('masks it inside a topic path', () => {
    const result = maskMacsIn(
      { requestTopic: `cmd/1/navilink-${MAC}/status/start` },
      [MAC],
    )
    expect(result).toEqual({ requestTopic: 'cmd/1/navilink-\u2026E5F6/status/start' })
  })

  it('matches whatever case the cloud happened to use', () => {
    const result = maskMacsIn({ a: MAC.toUpperCase(), b: MAC }, [MAC])
    expect(result).toEqual({ a: '\u2026E5F6', b: '\u2026E5F6' })
  })

  it('masks a sibling gateway named inside another one\u2019s frame', () => {
    const other = 'ffeeddccbbaa'
    const result = maskMacsIn({ peers: [MAC, other] }, [MAC, other])
    expect(result).toEqual({ peers: ['\u2026E5F6', '\u2026BBAA'] })
  })

  it('walks arrays and nested objects, because frames are both', () => {
    const result = maskMacsIn(
      { list: [{ deep: { mac: MAC } }] },
      [MAC],
    )
    expect(result).toEqual({ list: [{ deep: { mac: '\u2026E5F6' } }] })
  })

  it('leaves numbers alone, so a capture stays decodable', () => {
    const result = maskMacsIn({ swVersion: 4352, temp: 120.5, off: null }, [MAC])
    expect(result).toEqual({ swVersion: 4352, temp: 120.5, off: null })
  })

  it('does nothing when there is no MAC to mask', () => {
    const input = { macAddress: MAC }
    expect(maskMacsIn(input, [])).toBe(input)
  })

  it('ignores a value too short to be a MAC rather than redacting everything', () => {
    // A two-character pattern would match half the hex in a frame.
    const result = maskMacsIn({ macAddress: MAC }, ['ab'])
    expect(result).toEqual({ macAddress: MAC })
  })
})
