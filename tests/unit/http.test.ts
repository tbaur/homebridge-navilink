/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * This is the only path in the plugin that carries the user's password out of
 * the house, and the only one that brings a token pair back. Its limits are
 * therefore driven against a real loopback server rather than a stand-in for
 * `node:https`: the response cap, the request deadline and the refusal to
 * follow a redirect are all properties of a socket and a stream, and a
 * hand-written emitter would only confirm that the emitter behaves.
 *
 * What goes wrong when this module is wrong is not a late reading. It is a
 * password posted to whatever host a spoofed redirect names, a log line
 * quoting the body that carried it, or a plugin that hangs for good because
 * the cloud stopped answering half way through a response.
 */

import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'

import { parseJsonBody, postJson, type JsonRequestOptions } from '../../src/api/http'
import { ConnectionError, ProtocolError } from '../../src/utils/errors'

/** What the loopback server saw, so a test can assert on the wire form. */
interface SeenRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: string
}

type Answer = (request: http.IncomingMessage, response: http.ServerResponse) => void

/** Shaped like the real thing so a leak into a message is unmistakable. */
const PASSWORD = 'correct-horse-battery-staple'

/** Limits of the same order as the ones the plugin uses for real. */
function requestOptions(overrides: Partial<JsonRequestOptions> = {}): JsonRequestOptions {
  return {
    connectTimeoutMs: 5_000,
    totalTimeoutMs: 5_000,
    maxBytes: 64 * 1024,
    ...overrides,
  }
}

let server: http.Server
let origin = ''
let deadPort = 0
let seen: SeenRequest[] = []
let answer: Answer = () => undefined

/**
 * Send the request over plain TCP on the loopback interface.
 *
 * Only the TLS handshake is swapped out. `postJson` still builds the request
 * with `https.request`, and everything above the handshake (the request
 * stream, the chunked response, both deadlines, the socket errors) is Node's
 * own. The alternative is a certificate minted in the test, which `node:crypto`
 * cannot do, or a fake `node:https`, which would test the fake. That the URL
 * asked for is an `https:` one is asserted separately, so the substitution
 * cannot hide a downgrade.
 */
function dialLoopback(extra: http.ClientRequestArgs = {}) {
  return jest.spyOn(https, 'request').mockImplementation((
    url: string | URL,
    options: https.RequestOptions,
    handleResponse?: (response: http.IncomingMessage) => void,
  ) => {
    const target = new URL(String(url))
    target.protocol = 'http:'
    return http.request(target, { ...options, ...extra }, handleResponse)
  })
}

/** Answer with a JSON body, as the cloud does when all is well. */
function replyJson(status: number, body: unknown): Answer {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}

/** A promise that settles when the server has the whole request. */
function arrival(): Promise<void> {
  return new Promise<void>((resolve) => {
    answer = () => resolve()
  })
}

/**
 * Every message in a cause chain, which is where a leak would hide.
 *
 * Duck-typed rather than `instanceof Error`: the errors Node raises from a
 * socket are built outside this test's realm, so the chain would stop at the
 * first one and the assertions below would pass by not looking.
 */
function chainOf(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    const { message, cause } = current as { message?: unknown; cause?: unknown }
    if (typeof message === 'string') {
      parts.push(message)
    }
    current = cause
  }
  return parts.join(' | ')
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    // A test that trips the response cap destroys the socket mid-body, and the
    // write that loses is an error on this side, not a failure of the test.
    request.on('error', () => undefined)
    response.on('error', () => undefined)
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      answer(request, response)
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`

  // A port that was listening and is not any more, so a refused connection is
  // as deterministic as an accepted one.
  const closed = http.createServer()
  await new Promise<void>((resolve) => {
    closed.listen(0, '127.0.0.1', resolve)
  })
  deadPort = (closed.address() as AddressInfo).port
  await new Promise<void>((resolve) => {
    closed.close(() => resolve())
  })
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
})

beforeEach(() => {
  seen = []
  answer = replyJson(200, { code: 200, msg: 'SUCCESS' })
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('a normal exchange', () => {
  it('posts the body as JSON to the path the caller named', async () => {
    dialLoopback()

    const response = await postJson(
      `${origin}/user/sign-in`,
      { email: 'someone@example.com', password: PASSWORD },
      requestOptions(),
    )

    expect(response.status).toBe(200)
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.path).toBe('/user/sign-in')
    expect(seen[0]!.headers['content-type']).toBe('application/json')
    expect(seen[0]!.headers.accept).toBe('application/json')
    expect(JSON.parse(seen[0]!.body)).toEqual({
      email: 'someone@example.com',
      password: PASSWORD,
    })
  })

  it('measures content-length in bytes, not characters', async () => {
    // A name with an accent in it is a device name the cloud will echo back.
    // Counting characters truncates the body and the endpoint answers 400.
    dialLoopback()

    await postJson(`${origin}/rename`, { name: 'Chaudière' }, requestOptions())

    expect(seen[0]!.headers['content-length'])
      .toBe(String(Buffer.byteLength(JSON.stringify({ name: 'Chaudière' }))))
  })

  it('adds the caller headers, which is how this API wants its token sent', async () => {
    // Bearer-less by requirement of the cloud, so the header has to come from
    // the caller rather than be assembled here.
    dialLoopback()

    await postJson(`${origin}/device/list`, {}, requestOptions({
      headers: { authorization: 'raw-token-value' },
    }))

    expect(seen[0]!.headers.authorization).toBe('raw-token-value')
  })

  it('posts an empty object when there is nothing to send', async () => {
    // `undefined` on the wire is not JSON, and this API answers such a body
    // with a 400 rather than the list that was asked for.
    dialLoopback()

    await postJson(`${origin}/device/list`, undefined, requestOptions())

    expect(seen[0]!.body).toBe('{}')
  })

  it('asks for https, for a request that carries a password', async () => {
    // The loopback substitution below swaps TLS for plain TCP. This is what
    // stops that from hiding a module that had stopped asking for it.
    const requested = dialLoopback()

    await postJson(`${origin}/user/sign-in`, { password: PASSWORD }, requestOptions())

    expect(String(requested.mock.calls[0]![0]).startsWith('https://')).toBe(true)
  })

  it('returns the body unparsed, because a refusal from this cloud arrives inside a 200', async () => {
    // Parsing here and throwing on a non-success code would discard the code
    // that distinguishes a wrong password from a cloud outage.
    dialLoopback()
    answer = replyJson(200, { code: 1001, msg: 'INVALID_USER_PASSWORD' })

    const response = await postJson(`${origin}/user/sign-in`, {}, requestOptions())

    expect(response.status).toBe(200)
    expect(parseJsonBody(response.body)).toEqual({ code: 1001, msg: 'INVALID_USER_PASSWORD' })
  })

  it('hands back a non-2xx status instead of throwing, so the explanation survives', async () => {
    // The body of a 401 from this API says whether the token expired or the
    // account is locked, and the caller needs to tell those apart.
    dialLoopback()
    answer = replyJson(401, { msg: 'UNAUTHORIZED' })

    const response = await postJson(`${origin}/device/list`, {}, requestOptions())

    expect(response.status).toBe(401)
    expect(response.body).toContain('UNAUTHORIZED')
  })

  it('reads a body that arrives in several chunks as one string', async () => {
    dialLoopback()
    answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"msg":"')
      response.write('SUCC')
      response.end('ESS"}')
    }

    const response = await postJson(`${origin}/device/list`, {}, requestOptions())

    expect(parseJsonBody(response.body)).toEqual({ msg: 'SUCCESS' })
  })

  it('does not follow a redirect, so a spoofed endpoint cannot collect the password', async () => {
    // A redirect followed by this module would repost the body, password and
    // all, to a host named by whoever answered.
    dialLoopback()
    answer = (_request, response) => {
      response.writeHead(302, { location: '/collect' })
      response.end()
    }

    const response = await postJson(`${origin}/user/sign-in`, { password: PASSWORD }, requestOptions())

    expect(response.status).toBe(302)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.path).toBe('/user/sign-in')
  })
})

describe('the response cap', () => {
  it('stops reading a response that grows past what was allowed', async () => {
    // The cloud is not ours and nothing bounds what it sends. Without the cap
    // a hostile or broken endpoint decides how much memory Homebridge uses.
    dialLoopback()
    answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('x'.repeat(4_096))
    }

    const failure = await postJson(`${origin}/device/list`, {}, requestOptions({ maxBytes: 64 }))
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ProtocolError)
    expect((failure as Error).message).toBe('response exceeds 64 bytes')
  })

  it('accepts a response that is exactly as large as the cap', async () => {
    // The boundary is the interesting one: a cap applied as `>=` would reject
    // the largest legitimate device list this account can have.
    dialLoopback()
    const body = JSON.stringify({ msg: 'SUCCESS' })
    answer = replyJson(200, { msg: 'SUCCESS' })

    const response = await postJson(`${origin}/device/list`, {}, requestOptions({
      maxBytes: Buffer.byteLength(body),
    }))

    expect(response.body).toBe(body)
  })
})

describe('deadlines', () => {
  it('gives up on a host that never accepts the TCP connection', async () => {
    // `request.setTimeout` cannot express this: Node defers it until the
    // socket is already up. A SYN that is blackholed used to sit on the
    // total deadline instead of failing in seconds. The request here never
    // emits `connect`, so only our own connect clock can settle it.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'Date', 'hrtime', 'performance'],
    })
    const fake = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock
      destroy: jest.Mock
      end: jest.Mock
    }
    fake.setTimeout = jest.fn()
    fake.destroy = jest.fn()
    fake.end = jest.fn()
    jest.spyOn(https, 'request').mockImplementation(() => {
      queueMicrotask(() => {
        fake.emit('socket', { connecting: true, once() { /* never connects */ }, setNoDelay() { /* unused */ } })
      })
      return fake as unknown as http.ClientRequest
    })

    const pending = postJson('https://nlus.example/user/sign-in', {}, requestOptions({
      connectTimeoutMs: 80,
      totalTimeoutMs: 30_000,
    }))
    await Promise.resolve()
    jest.advanceTimersByTime(80)

    const failure = await pending.catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionError)
    expect((failure as Error).message).toBe('connect timed out after 80ms')
    expect(fake.destroy).toHaveBeenCalled()
  })

  it('keeps the connect clock running until TLS finishes, not just TCP', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'Date', 'hrtime', 'performance'],
    })
    const fake = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock
      destroy: jest.Mock
      end: jest.Mock
    }
    fake.setTimeout = jest.fn()
    fake.destroy = jest.fn()
    fake.end = jest.fn()
    const socket = new EventEmitter() as EventEmitter & {
      connecting: boolean
      encrypted: boolean
      setNoDelay: () => void
    }
    socket.connecting = true
    socket.encrypted = false
    socket.setNoDelay = () => undefined
    jest.spyOn(https, 'request').mockImplementation(() => {
      queueMicrotask(() => {
        fake.emit('socket', socket)
        socket.emit('connect')
      })
      return fake as unknown as http.ClientRequest
    })

    const pending = postJson('https://nlus.example/user/sign-in', {}, requestOptions({
      connectTimeoutMs: 80,
      totalTimeoutMs: 30_000,
    }))
    await Promise.resolve()
    jest.advanceTimersByTime(80)

    const failure = await pending.catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionError)
    expect((failure as Error).message).toBe('connect timed out after 80ms')
    expect(fake.destroy).toHaveBeenCalled()
  })

  it('gives up on a cloud that takes the request and then says nothing', async () => {
    // Left alone this is the failure that never resolves: the socket stays
    // open, the accessory waits on it and nothing in HomeKit ever changes.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'Date', 'hrtime', 'performance'],
    })
    dialLoopback()
    const arrived = arrival()

    const pending = postJson(`${origin}/device/list`, {}, requestOptions({ totalTimeoutMs: 30_000 }))
    await arrived
    jest.advanceTimersByTime(30_000)

    const failure = await pending.catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionError)
    expect((failure as Error).message).toBe('request timed out after 30000ms')
  })

  it('leaves no timer behind once the answer has arrived', async () => {
    // The total deadline holds a referenced timer on purpose, so one that is
    // not cleared keeps a finished Homebridge process alive.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'Date', 'hrtime', 'performance'],
    })
    dialLoopback()

    await postJson(`${origin}/device/list`, {}, requestOptions())

    expect(jest.getTimerCount()).toBe(0)
  })
})

describe('cancellation', () => {
  it('refuses before opening a socket when the caller has already given up', async () => {
    // Homebridge shutting down mid-startup is the ordinary way to get here,
    // and a socket opened after that is one nothing will ever read.
    const requested = dialLoopback()

    const failure = await postJson(`${origin}/device/list`, {}, requestOptions({
      signal: AbortSignal.abort(),
    })).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionError)
    expect((failure as Error).message).toBe('request aborted before it started')
    expect(requested).not.toHaveBeenCalled()
  })

  it('abandons a request in flight when the signal fires, rather than waiting out the deadline', async () => {
    dialLoopback()
    const controller = new AbortController()
    const arrived = arrival()

    const pending = postJson(`${origin}/device/list`, {}, requestOptions({
      signal: controller.signal,
    }))
    await arrived
    controller.abort()

    const failure = await pending.catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionError)
    expect((failure as Error).message).toBe('request aborted')
  })

  it('lets go of the abort signal once the answer has arrived', async () => {
    // The signal outlives the request: it belongs to the platform and is
    // shared by everything the plugin has in flight. A listener left on it
    // keeps this request, and the body it was sent, reachable for as long as
    // Homebridge runs.
    dialLoopback()
    const controller = new AbortController()
    const released = jest.spyOn(controller.signal, 'removeEventListener')

    const response = await postJson(`${origin}/device/list`, { password: PASSWORD }, requestOptions({
      signal: controller.signal,
    }))
    controller.abort()

    expect(response.status).toBe(200)
    expect(released).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('when the connection fails', () => {
  it('reports a cloud that hangs up mid-body as a connection failure', async () => {
    // Not a protocol failure: the answer was never complete, so retrying is
    // the right response rather than giving up on the account.
    dialLoopback()
    answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' })
      response.write('{"msg":"SUC')
      response.socket?.destroy()
    }

    const failure = await postJson(`${origin}/device/list`, {}, requestOptions())
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionError)
  })

  it('keeps the address it dialled out of its own message', async () => {
    // Node puts the request URL into some socket errors. This API's URLs carry
    // no secret, but a rule that nothing from this layer quotes a URL is
    // easier to keep than a list of the ones that would be safe.
    dialLoopback()

    const failure = await postJson(`https://127.0.0.1:${deadPort}/user/sign-in`, {}, requestOptions())
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionError)
    expect((failure as Error).message).toBe('request failed')
    // The reason is still recoverable by a maintainer, one level down.
    expect(chainOf(failure)).toContain('ECONNREFUSED')
  })

  it('never lets the request body into anything it raises, whatever went wrong', async () => {
    // Nothing here takes a logger, so this is the whole surface a password can
    // escape through: the messages the module raises, and their causes.
    dialLoopback()
    const body = { email: 'someone@example.com', password: PASSWORD }
    const failures: unknown[] = []

    failures.push(await postJson(`https://127.0.0.1:${deadPort}/user/sign-in`, body, requestOptions())
      .catch((error: unknown) => error))

    answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('y'.repeat(2_048))
    }
    failures.push(await postJson(`${origin}/user/sign-in`, body, requestOptions({ maxBytes: 32 }))
      .catch((error: unknown) => error))

    failures.push(await postJson(`${origin}/user/sign-in`, body, requestOptions({
      signal: AbortSignal.abort(),
    })).catch((error: unknown) => error))

    expect(failures).toHaveLength(3)
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error)
      expect(chainOf(failure)).not.toContain(PASSWORD)
      expect(chainOf(failure)).not.toContain('someone@example.com')
    }
  })
})

describe('parseJsonBody', () => {
  it('reads the body the cloud sent', () => {
    expect(parseJsonBody('{"code":200,"msg":"SUCCESS"}')).toEqual({ code: 200, msg: 'SUCCESS' })
  })

  it('treats an empty body as nothing rather than as a parse failure', () => {
    // Some endpoints on this API answer a successful write with no body at
    // all, and that is a success, not a malformed response.
    expect(parseJsonBody('')).toBeUndefined()
  })

  it('never quotes the page it could not parse', () => {
    // A gateway in front of the cloud answers with an HTML error page, and a
    // truncated JSON body from the cloud itself carries a token. Either one
    // quoted in the message ends up in the log.
    const jwtHeader = ['eyJ', 'hbGciOiJIUzI1NiJ9'].join('')
    const page = `<html><body>502 Bad Gateway ${jwtHeader}.${'a'.repeat(20)}.sig</body></html>`

    const failure = (() => {
      try {
        parseJsonBody(page)
        return undefined
      } catch (error) {
        return error
      }
    })()

    expect(failure).toBeInstanceOf(ProtocolError)
    expect((failure as Error).message).toContain('the cloud returned a body that is not JSON')
    expect((failure as Error).message).toContain('[redacted]')
    expect((failure as Error).message).not.toContain('eyJ')
    expect((failure as Error).message.length).toBeLessThan(200)
    // The reason is kept for a maintainer reading a stack, not for the log.
    expect(((failure as Error).cause as Error).name).toBe('SyntaxError')
  })
})
