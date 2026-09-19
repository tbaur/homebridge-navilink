/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview JSON over HTTPS against the NaviLink cloud.
 *
 * Built on `node:https` rather than `fetch` for three reasons, in ascending
 * order of how much they matter.
 *
 * A response size cap. `fetch` gives you a body you have already committed to
 * buffering, or a stream you have to cap by hand; a cap applied as bytes
 * arrive is both simpler and actually enforced. The cloud is not ours and its
 * responses are not bounded by anything we control.
 *
 * Separate connect and total deadlines. `AbortSignal.timeout` expresses one
 * instant, so it cannot say "reach the host quickly, then allow it time to
 * answer". An unreachable cloud should fail startup in seconds, not hold a
 * slot for the whole request budget.
 *
 * Control over what is logged. Everything on this path is a credential: the
 * request body carries the password, and the response body carries a JWT pair
 * and a set of AWS keys. `fetch` errors quote the URL, and a debug logger
 * wrapped round it would eventually quote a body. Here, the only thing that
 * reaches the log is the method and the path.
 */

import https from 'node:https'

import { ConnectionError, ProtocolError } from '../utils/errors'
import { redactSecrets } from '../utils/redact'

/** Longest body excerpt put into a parse-failure message. */
const MAX_BODY_EXCERPT = 80

/** A completed HTTP response, with the body still unparsed. */
export interface HttpResponse {
  status: number
  body: string
}

/** Per-request timing and size limits. */
export interface JsonRequestOptions {
  /** Deadline for establishing the TCP and TLS connection. */
  connectTimeoutMs: number
  /** Deadline for the whole exchange. */
  totalTimeoutMs: number
  /** Largest response body accepted, in bytes. */
  maxBytes: number
  /** Extra headers. Used for the bearer-less `authorization` this API wants. */
  headers?: Readonly<Record<string, string>>
  /** Cancels the request, so a shutdown need not wait out a deadline. */
  signal?: AbortSignal
}

/** Performs one JSON POST. Injectable so tests never open a socket. */
export type JsonPost = (
  url: string,
  body: unknown,
  options: JsonRequestOptions,
) => Promise<HttpResponse>

/**
 * POST a JSON body and read the response as text.
 *
 * Rejects with {@link ConnectionError} for anything that prevented an answer
 * and {@link ProtocolError} when the answer arrived but was unusable. Parsing
 * is left to the caller: a non-200 from this API still carries a JSON body
 * explaining why, and throwing on the status here would discard it.
 *
 * Redirects are not followed. The cloud does not issue them, and following one
 * would let a compromised or spoofed endpoint move a request that carries the
 * user's password to a host of its choosing.
 */
export const postJson: JsonPost = (url, body, options) => {
  const { connectTimeoutMs, totalTimeoutMs, maxBytes, headers = {}, signal } = options
  const payload = JSON.stringify(body ?? {})

  return new Promise<HttpResponse>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new ConnectionError('request aborted before it started'))
      return
    }

    let settled = false
    let onAbort: (() => void) | undefined
    // Held in a container because `cleanup` closes over it before the timer
    // that fills it in can be created: the timer's callback needs `fail`, and
    // `fail` needs `cleanup`.
    const timers: {
      connect?: ReturnType<typeof setTimeout>
      total?: ReturnType<typeof setTimeout>
    } = {}

    const request = https.request(url, {
      method: 'POST',
      // A connection per request. There is no long-poll to queue behind here,
      // but sign-in and the device list are a handful of calls per hour and a
      // pooled socket to a cloud endpoint is one more thing holding state
      // across a token refresh.
      agent: false,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = []
      let received = 0

      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > maxBytes) {
          fail(new ProtocolError(`response exceeds ${maxBytes} bytes`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        finish({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.on('error', (error) => {
        fail(new ConnectionError('response stream failed', { cause: error }))
      })
    })

    const cleanup = (): void => {
      if (timers.connect !== undefined) {
        clearTimeout(timers.connect)
      }
      if (timers.total !== undefined) {
        clearTimeout(timers.total)
      }
      if (onAbort !== undefined) {
        signal?.removeEventListener('abort', onAbort)
      }
    }

    const finish = (response: HttpResponse): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(response)
    }

    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      request.destroy()
      reject(error)
    }

    // Our own timer, not `request.setTimeout`. Node defers that call until
    // the socket is already connected, then this module immediately clears
    // it. Without that, a host that blackholes the SYN would sit on the
    // total deadline instead of failing in seconds, which is the whole
    // point of having two clocks.
    timers.connect = setTimeout(() => {
      fail(new ConnectionError(`connect timed out after ${connectTimeoutMs}ms`))
    }, connectTimeoutMs)
    request.on('socket', (socket) => {
      const onReady = (): void => {
        if (timers.connect !== undefined) {
          clearTimeout(timers.connect)
          timers.connect = undefined
        }
        socket.setNoDelay(true)
      }
      if (socket.connecting) {
        // A TLSSocket has `encrypted`. Waiting on TCP `connect` would clear
        // the timer before the handshake finishes. A plain socket (the test
        // loopback under an `https:` URL) only emits `connect`.
        if ('encrypted' in socket) {
          socket.once('secureConnect', onReady)
        } else {
          socket.once('connect', onReady)
        }
      } else {
        onReady()
      }
    })

    request.on('error', (error) => {
      // The message is deliberately generic. Node puts the request URL into
      // some socket errors, and while this API's URLs carry no secrets, the
      // rule that nothing from this layer quotes a URL is easier to keep than
      // an exception list.
      fail(new ConnectionError('request failed', { cause: error }))
    })

    // Referenced on purpose, and always cleared in `cleanup`: a caller is
    // awaiting this request, so the process must not be free to exit under it.
    timers.total = setTimeout(() => {
      fail(new ConnectionError(`request timed out after ${totalTimeoutMs}ms`))
    }, totalTimeoutMs)

    if (signal !== undefined) {
      onAbort = (): void => {
        fail(new ConnectionError('request aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    request.end(payload)
  })
}

/**
 * Parse a response body as JSON, or explain why it could not be.
 *
 * The excerpt in the failure message is capped and redacted: a gateway error
 * page can be a whole HTML document, and a partial JSON body from this API
 * would otherwise put a token into the log.
 */
export function parseJsonBody(body: string): unknown {
  if (body.length === 0) {
    return undefined
  }
  try {
    return JSON.parse(body) as unknown
  } catch (error) {
    throw new ProtocolError(
      `the cloud returned a body that is not JSON (${bodyExcerpt(body)})`,
      { cause: error },
    )
  }
}

/** A short, redacted look at a body that could not be parsed. */
function bodyExcerpt(body: string): string {
  const cleaned = redactSecrets(body).replace(/[\u0000-\u001F\u007F]/g, '\uFFFD')
  return cleaned.length > MAX_BODY_EXCERPT
    ? `${cleaned.slice(0, MAX_BODY_EXCERPT)}\u2026`
    : cleaned
}
