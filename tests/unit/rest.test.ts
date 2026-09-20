/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The behaviour that matters most here is the one that is easiest to get
 * wrong: **this API answers a rejected password with HTTP 200** and an error
 * in the body. A status-code check alone classifies a wrong password as a
 * transient fault, and the retry loop above then repeats it every few
 * seconds until the account locks out. Several of these tests exist only to
 * hold that line.
 */

import type { JsonPost } from '../../src/api/http'
import { NaviLinkRest } from '../../src/api/rest'
import { AuthenticationError, ProtocolError } from '../../src/utils/errors'
import { FAKE_ASIA_KEY } from '../helpers/secrets'

function makeLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}

/** A sign-in response with every field the plugin needs. */
function signInBody(overrides: Record<string, unknown> = {}) {
  return {
    code: 200,
    msg: 'SUCCESS',
    data: {
      userInfo: { userSeq: 100_000 },
      token: {
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
        idToken: 'id-token-value',
        accessKeyId: FAKE_ASIA_KEY,
        secretKey: 'secret-key-value',
        sessionToken: 'session-token-value',
        authenticationExpiresIn: 3600,
        authorizationExpiresIn: 3600,
      },
      ...overrides,
    },
  }
}

/** A post that answers each call from a queue, recording what it was sent. */
function stubPost(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; body: unknown; headers?: Record<string, string> }[] = []
  const post: JsonPost = async (url, body, options) => {
    calls.push({
      url,
      body,
      ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
    })
    const next = responses.shift()
    if (next === undefined) {
      throw new Error(`unexpected call to ${url}`)
    }
    return { status: next.status, body: JSON.stringify(next.body) }
  }
  return { post, calls }
}

function build(
  responses: { status: number; body: unknown }[],
  extras: { metrics?: (sample: { durationMs: number; ok: boolean }) => void } = {},
) {
  const log = makeLog()
  const { post, calls } = stubPost(responses)
  return {
    log,
    calls,
    rest: new NaviLinkRest({
      log,
      post,
      now: () => 1_700_000_000_000,
      ...(extras.metrics === undefined ? {} : { metrics: extras.metrics }),
    }),
  }
}

describe('signIn', () => {
  it('returns the tokens and credentials a session needs', async () => {
    const { rest } = build([{ status: 200, body: signInBody() }])

    const tokens = await rest.signIn('someone@example.com', 'secret')

    expect(tokens.userSeq).toBe('100000')
    expect(tokens.accessToken).toBe('access-token-value')
    expect(tokens.refreshToken).toBe('refresh-token-value')
    expect(tokens.credentials.accessKeyId).toBe(FAKE_ASIA_KEY)
    expect(tokens.credentials.region).toBe('us-east-1')
    expect(tokens.credentials.endpoint).toContain('iot.us-east-1.amazonaws.com')
  })

  it('treats a rejected password as fatal even though it arrives as HTTP 200', async () => {
    // The whole point. A wrong password must stop the loop rather than be
    // retried until the account is locked.
    const { rest } = build([{
      status: 200,
      body: { code: 1001, msg: 'INVALID_USER_PASSWORD' },
    }])

    const failure = await rest.signIn('someone@example.com', 'wrong').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AuthenticationError)
    expect((failure as AuthenticationError).credentialsRejected).toBe(true)
  })

  it('treats an unknown account as fatal, also on HTTP 200', async () => {
    const { rest } = build([{ status: 200, body: { code: 1000, msg: 'USER_NOT_FOUND' } }])

    const failure = await rest.signIn('nobody@example.com', 'x').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AuthenticationError)
    expect((failure as AuthenticationError).credentialsRejected).toBe(true)
    expect((failure as Error).message).toMatch(/does not recognise/)
  })

  it('treats an unmapped cloud error as transient, so it keeps retrying', async () => {
    // Guessing that an unfamiliar error is a bad credential would stop the
    // plugin retrying something that may well clear on its own.
    const { rest } = build([{ status: 200, body: { code: 5000, msg: 'INTERNAL_SERVER_ERROR' } }])

    const failure = await rest.signIn('someone@example.com', 'x').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ProtocolError)
    expect(failure).not.toBeInstanceOf(AuthenticationError)
  })

  it('treats a bare HTTP 403 as transient, not as a rejected password', async () => {
    // An edge 403 with no PASSWORD / INVALID_USER string is a WAF or an
    // outage. Treating it as credentialsRejected would stop the plugin for
    // good on a cloud that is briefly unwell.
    const { rest } = build([{ status: 403, body: { msg: 'FORBIDDEN' } }])

    const failure = await rest.signIn('someone@example.com', 'x').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ProtocolError)
    expect(failure).not.toBeInstanceOf(AuthenticationError)
  })

  it('fails when the response carries no AWS credentials', async () => {
    // Without them there is no MQTT, and without MQTT there is no state at
    // all, so this is not something to carry on from.
    const { rest } = build([{
      status: 200,
      body: {
        data: { userInfo: { userSeq: 1 }, token: { accessToken: 'a', authorizationExpiresIn: 3600 } },
      },
    }])

    await expect(rest.signIn('someone@example.com', 'x')).rejects.toThrow(/AWS IoT credentials/)
  })

  it('believes a plausible session lifetime', async () => {
    const { rest } = build([{ status: 200, body: signInBody() }])

    const tokens = await rest.signIn('someone@example.com', 'x')

    expect(tokens.expiresAt).toBe(1_700_000_000_000 + 3_600_000)
  })

  it('takes the shorter of the two reported lifetimes', async () => {
    // They expire independently and the connection dies with the first one.
    const body = signInBody()
    body.data.token.authorizationExpiresIn = 900
    const { rest } = build([{ status: 200, body }])

    const tokens = await rest.signIn('someone@example.com', 'x')

    expect(tokens.expiresAt).toBe(1_700_000_000_000 + 900_000)
  })

  it('falls back when the reported lifetime is not believable', async () => {
    // A wrong reading in the optimistic direction is a session that dies
    // mid-winter without reconnecting.
    const body = signInBody()
    body.data.token.authorizationExpiresIn = 0
    body.data.token.authenticationExpiresIn = 99_999_999
    const { rest } = build([{ status: 200, body }])

    const tokens = await rest.signIn('someone@example.com', 'x')

    expect(tokens.expiresAt).toBe(1_700_000_000_000 + 50 * 60 * 1_000)
  })

  it('refuses a non-string email before it talks to the cloud', async () => {
    const { rest, calls } = build([])
    const email = { email: 'someone@example.com', password: 'secret' } as never

    await expect(rest.signIn(email, undefined as never)).rejects.toThrow(/two strings/)
    expect(calls).toEqual([])
  })

  it('never logs the password or anything from the response', async () => {
    const { rest, log } = build([{ status: 200, body: signInBody() }])

    await rest.signIn('someone@example.com', 'hunter2')

    const logged = [...log.debug.mock.calls, ...log.info.mock.calls].flat().join('\n')
    expect(logged).not.toContain('hunter2')
    expect(logged).not.toContain('access-token-value')
    expect(logged).not.toContain(FAKE_ASIA_KEY)
  })

  it('forwards a shutdown signal so an in-flight sign-in does not hold the process', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const post: JsonPost = async (_url, _body, options) => {
      seen = options.signal
      return { status: 200, body: JSON.stringify(signInBody()) }
    }
    const rest = new NaviLinkRest({ log: makeLog(), post, signal: controller.signal })

    await rest.signIn('someone@example.com', 'x')

    expect(seen).toBe(controller.signal)
  })
})

describe('listDevices', () => {
  const listBody = {
    code: 200,
    data: [{
      macAddress: 'A1B2C3D4E5F6',
      additionalValue: '5089',
      deviceType: 1,
      homeSeq: 200_000,
      deviceName: 'Zone One',
      connected: 2,
    }],
  }

  it('sends the token with no Bearer prefix', async () => {
    // A correctly-formed bearer header gets a 401 from this API.
    const { rest, calls } = build([{ status: 200, body: listBody }])

    await rest.listDevices({ email: 'someone@example.com', accessToken: 'raw-token' })

    expect(calls[0]?.headers?.authorization).toBe('raw-token')
  })

  it('normalises the MAC to the spelling topics use', async () => {
    const { rest } = build([{ status: 200, body: listBody }])

    const devices = await rest.listDevices({ email: 'someone@example.com', accessToken: 't' })

    expect(devices[0]?.macAddress).toBe('a1b2c3d4e5f6')
    expect(devices[0]?.homeSeq).toBe('200000')
  })

  it('accepts the wrapped list shape as well as the bare one', async () => {
    // Both have been seen, and there is no specification to be right about.
    const { rest } = build([{ status: 200, body: { data: { deviceList: listBody.data } } }])

    await expect(rest.listDevices({ email: 'someone@example.com', accessToken: 't' }))
      .resolves.toHaveLength(1)
  })

  it('skips an entry with no MAC rather than failing the account', async () => {
    const { rest } = build([{
      status: 200,
      body: { data: [{ deviceName: 'broken' }, ...listBody.data] },
    }])

    const devices = await rest.listDevices({ email: 'someone@example.com', accessToken: 't' })

    expect(devices).toHaveLength(1)
  })

  it('reports a rejected token as an authentication failure', async () => {
    const { rest } = build([{ status: 401, body: { msg: 'UNAUTHORIZED' } }])

    await expect(rest.listDevices({ email: 'someone@example.com', accessToken: 't' }))
      .rejects.toBeInstanceOf(AuthenticationError)
  })

  it('walks a second page, so a 21st gateway is not dropped', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      ...listBody.data[0],
      macAddress: `a1b2c3d4e5${index.toString(16).padStart(2, '0')}`,
    }))
    const secondPage = [{
      ...listBody.data[0],
      macAddress: 'b1b2c3d4e5f6',
    }]
    const { rest, calls } = build([
      { status: 200, body: { data: firstPage } },
      { status: 200, body: { data: secondPage } },
    ])

    const devices = await rest.listDevices({ email: 'someone@example.com', accessToken: 't' })

    expect(devices).toHaveLength(21)
    expect(devices[20]?.macAddress).toBe('b1b2c3d4e5f6')
    expect((calls[1]?.body as { offset?: number }).offset).toBe(20)
  })
})

describe('readFirmware', () => {
  it('reads only the version, never the location fields beside it', async () => {
    // This endpoint also answers with the installation's street address and
    // coordinates. Nothing else is read out of it, so nothing else can reach
    // a log, an accessory context or a capture.
    const { rest } = build([{
      status: 200,
      body: {
        data: {
          deviceInfo: { fwVersion: '4352', deviceName: 'Zone One' },
          location: { latitude: 1.23, longitude: 4.56, address: 'somewhere' },
        },
      },
    }])

    await expect(rest.readFirmware({
      email: 'someone@example.com',
      accessToken: 't',
      macAddress: 'a1b2c3d4e5f6',
      additionalValue: '',
    })).resolves.toBe('4352')
  })

  it('shrugs off a 403, which some accounts return', async () => {
    // Firmware is a nicety; an account whose device list works fine has been
    // seen refusing this endpoint.
    const { rest } = build([{ status: 403, body: {} }])

    await expect(rest.readFirmware({
      email: 'someone@example.com',
      accessToken: 't',
      macAddress: 'a1b2c3d4e5f6',
      additionalValue: '',
    })).resolves.toBeUndefined()
  })
})

describe('diagnostics metrics', () => {
  it('reports one sample per REST attempt, success or failure', async () => {
    const samples: { durationMs: number; ok: boolean }[] = []
    const { rest } = build(
      [{ status: 200, body: signInBody() }],
      { metrics: (sample) => samples.push(sample) },
    )
    await rest.signIn('someone@example.com', 'secret')
    expect(samples).toEqual([{ durationMs: 0, ok: true }])

    const failing = build(
      [],
      { metrics: (sample) => samples.push(sample) },
    )
    await expect(failing.rest.signIn('someone@example.com', 'secret')).rejects.toThrow()
    expect(samples[1]).toEqual({ durationMs: 0, ok: false })
  })
})
