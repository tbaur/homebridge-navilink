/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * An error message is the one path by which a live credential can still reach
 * a log file, because the strings involved are a signed request URL, a
 * rejected sign-in body and a WebSocket close reason. It is also the only
 * place a user learns why their boiler stopped answering, so the description
 * has to survive a `cause` chain and a thrown value that is not an Error.
 */

import {
  AuthenticationError,
  ConnectionError,
  ControlRejectedError,
  describeError,
  ProtocolError,
} from '../../src/utils/errors'
import { FAKE_SHORT_JWT, FAKE_SIGNED_QUERY, FAKE_STS_TOKEN } from '../helpers/secrets'

describe('describeError', () => {
  it('reaches past "fetch failed" to the reason underneath it', () => {
    // Node wraps low-level network failures, so the bare message is almost
    // never the one that tells a user their DNS is broken.
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND nlus.example.com'), {
      code: 'ENOTFOUND',
    })

    expect(describeError(new Error('fetch failed', { cause })))
      .toBe('fetch failed: getaddrinfo ENOTFOUND nlus.example.com (ENOTFOUND)')
  })

  it('walks a chain several levels deep', () => {
    const inner = new Error('ECONNRESET')
    const middle = new ConnectionError('websocket closed', { cause: inner })

    expect(describeError(new ProtocolError('session lost', { cause: middle })))
      .toBe('session lost: websocket closed: ECONNRESET')
  })

  it('says a repeated message once', () => {
    // A rethrow that keeps the message would otherwise read "timeout: timeout:
    // timeout" and say nothing three times.
    const error = new Error('request timed out', { cause: new Error('request timed out') })

    expect(describeError(error)).toBe('request timed out')
  })

  it('does not hang on an error that names itself as its own cause', () => {
    const error: Error & { cause?: unknown } = new Error('circular')
    error.cause = error

    expect(describeError(error)).toBe('circular')
  })

  it('removes a credential the far end put into its own error message', () => {
    const error = new Error(
      'sign-in rejected: {"email":"someone@example.com","password":"hunter-two"}',
    )

    const described = describeError(error)

    expect(described).not.toContain('hunter-two')
    expect(described).toContain('"password":[redacted]')
    // The rest of the message survives, or the redaction has cost the user
    // the only description they were going to get.
    expect(described).toContain('sign-in rejected')
  })

  it('removes the signature from a failed request to the IoT endpoint', () => {
    const error = new Error(
      'connect failed wss://a-ats.iot.us-east-1.amazonaws.com/mqtt'
      + `?X-Amz-Signature=deadbeefdeadbeef&${FAKE_SIGNED_QUERY}`,
    )

    const described = describeError(error)

    expect(described).not.toContain('deadbeefdeadbeef')
    expect(described).not.toContain(FAKE_STS_TOKEN)
    expect(described).toContain('iot.us-east-1.amazonaws.com')
  })

  it('redacts a credential carried by a cause rather than by the outer error', () => {
    const cause = new Error(`body was {"accessToken":"${FAKE_SHORT_JWT}"}`)

    expect(describeError(new Error('sign-in failed', { cause }))).not.toContain(FAKE_SHORT_JWT)
  })

  it('neutralises a newline a remote message could use to forge a log entry', () => {
    const described = describeError(new Error('rejected\n[error] the boiler is on fire'))

    expect(described).not.toContain('\n')
    expect(described).toContain('\uFFFD')
  })

  it('caps a description so a hostile endpoint cannot flood the log', () => {
    const described = describeError(new Error('e'.repeat(1_000)))

    expect(described.length).toBeLessThanOrEqual(301)
    expect(described.endsWith('\u2026')).toBe(true)
  })

  it('describes a thrown value that is not an Error', () => {
    // A rejected promise can carry anything at all, and a description that
    // threw while describing would replace the real failure.
    expect(describeError('the gateway said no')).toBe('the gateway said no')
    expect(describeError({ failCode: 2 })).toBe('{"failCode":2}')
    expect(describeError(404)).toBe('404')
  })

  it('describes a value that cannot even be serialised', () => {
    // Serialising is the last resort before giving up, and it is the step
    // most likely to throw on its own and lose the original failure.
    expect(describeError(BigInt(7))).toBe('7')
    expect(describeError(Symbol('gateway'))).toBe('Symbol(gateway)')
  })

  it('admits to knowing nothing rather than logging an empty line', () => {
    expect(describeError(undefined)).toBe('unknown error')
    expect(describeError(null)).toBe('unknown error')
    expect(describeError(new Error(''))).toBe('unknown error')
  })
})

describe('AuthenticationError', () => {
  it('distinguishes a rejected password from a cloud that merely failed', () => {
    // A wrong password retried every thirty seconds is how an account gets
    // locked, so this flag is what stops the platform signing in again.
    expect(new AuthenticationError('rejected', { credentialsRejected: true }).credentialsRejected)
      .toBe(true)
    expect(new AuthenticationError('sign-in failed').credentialsRejected).toBe(false)
    expect(new AuthenticationError('sign-in failed', { cause: new Error('503') })
      .credentialsRejected).toBe(false)
  })

  it('keeps its cause, so the log can say what actually went wrong', () => {
    const error = new AuthenticationError('sign-in failed', { cause: new Error('fetch failed') })

    expect(describeError(error)).toBe('sign-in failed: fetch failed')
  })
})

describe('the error classes', () => {
  it('each name themselves, because the name is what reaches a log line', () => {
    const errors = [
      new AuthenticationError('rejected'),
      new ProtocolError('unparseable frame'),
      new ConnectionError('unreachable'),
      new ControlRejectedError('the appliance refused it'),
    ]

    expect(errors.map((error) => error.name)).toEqual([
      'AuthenticationError',
      'ProtocolError',
      'ConnectionError',
      'ControlRejectedError',
    ])
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error)
    }
  })

  it('can be told apart from one another, which is what the platform branches on', () => {
    expect(new AuthenticationError('rejected')).not.toBeInstanceOf(ConnectionError)
    expect(new ControlRejectedError('refused')).not.toBeInstanceOf(ProtocolError)
  })
})
