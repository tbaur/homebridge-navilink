/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The NaviLink REST surface: sign in, and list what the account
 * owns.
 *
 * Three calls, and they do very little. Everything that changes arrives over
 * MQTT: a temperature, a setpoint, a fault. REST exists to get the credentials
 * that make MQTT possible and to learn which appliances the account has.
 *
 * This is an unofficial API. There is no specification, no versioning promise
 * and no deprecation notice; it is the interface the NaviLink mobile app uses.
 * Everything here therefore treats an unexpected response as a protocol error
 * with a readable message. It does not reach into a shape it assumes is there.
 * When Navien changes something, the plugin should say what it did not
 * recognise.
 *
 * **Every value on this path is a credential or personal data.** The request
 * body carries the password; the response carries a JWT pair, temporary AWS
 * IAM credentials, the account holder's name, and, from `device/info`, the
 * street address and coordinates of the installation. Nothing from a response
 * is logged, and the fields the plugin does not need are never read out of it.
 */

import {
  API_BASE,
  CONNECT_TIMEOUT_MS,
  IOT_ENDPOINT,
  IOT_REGION,
  MAX_REST_BYTES,
  REST_TIMEOUT_MS,
} from '../settings'
import type { PluginLogger } from '../types'
import { AuthenticationError, ProtocolError } from '../utils/errors'
import { parseJsonBody, postJson, type JsonPost } from './http'
import type { IotCredentials } from './sigv4'

/**
 * How long a session lasts when the cloud's answer is not believable.
 *
 * The sign-in response reports two lifetimes, and neither their unit nor which
 * one governs the AWS credentials is documented. They are read as seconds and
 * sanity-checked; anything outside a plausible band falls back to this, which
 * is short enough to be safe against a much shorter real lifetime and long
 * enough not to be a sign-in loop.
 */
const FALLBACK_SESSION_MS = 50 * 60 * 1_000

/** Page size `device/list` requires. */
const DEVICE_LIST_PAGE_SIZE = 20

/** Hard stop so a cloud that always returns a full page cannot loop forever. */
const MAX_DEVICE_LIST_PAGES = 10

/** Shortest lifetime believed from the cloud. Below this, use the fallback. */
const MIN_BELIEVABLE_SESSION_MS = 5 * 60 * 1_000

/** Longest lifetime believed from the cloud. Above this, use the fallback. */
const MAX_BELIEVABLE_SESSION_MS = 24 * 60 * 60 * 1_000

/** A signed-in session. */
export interface NaviLinkSessionTokens {
  /** Account sequence number, which appears in every response topic. */
  userSeq: string
  /** Bearer-less token for later REST calls. */
  accessToken: string
  /** Present when the cloud offered one. */
  refreshToken: string | undefined
  /** Temporary IAM credentials for the IoT endpoint. */
  credentials: IotCredentials
  /** Epoch milliseconds after which the session must be re-established. */
  expiresAt: number
}

/** One appliance gateway on the account, as `device/list` reports it. */
export interface ListedDevice {
  /** Gateway MAC, as the cloud spells it: lower-case hex, no separators. */
  macAddress: string
  /** Opaque discriminator the topics need. Frequently an empty string. */
  additionalValue: string
  /** Gateway kind. `1` for every NaviLink gateway seen so far. */
  deviceType: number
  /** Home grouping id, which appears in every response topic. */
  homeSeq: string
  /** The name the user gave it in the NaviLink app. */
  deviceName: string
  /** `2` means the cloud believes the gateway is online. */
  connected: number
}

/** Injectable collaborators, so tests need neither sockets nor real clocks. */
export interface NaviLinkRestOptions {
  log: PluginLogger
  post?: JsonPost
  now?: () => number
  /** Cancels in-flight calls, so Homebridge shutdown need not wait out a deadline. */
  signal?: AbortSignal
  /** One sample per REST attempt, for diagnostics. Never receives the body. */
  metrics?: (sample: { durationMs: number; ok: boolean }) => void
}

/** Talks to the NaviLink REST service. */
export class NaviLinkRest {
  private readonly log: PluginLogger

  private readonly post: JsonPost

  private readonly now: () => number

  private readonly signal: AbortSignal | undefined

  private readonly metrics: NaviLinkRestOptions['metrics']

  constructor(options: NaviLinkRestOptions) {
    this.log = options.log
    this.post = options.post ?? postJson
    this.now = options.now ?? Date.now
    this.signal = options.signal
    this.metrics = options.metrics
  }

  /**
   * Exchange an email and password for a session.
   *
   * Distinguishes a rejected account from an unreachable cloud, because the
   * two need opposite responses: a wrong password must stop the plugin
   * retrying, and a cloud outage must not.
   */
  async signIn(email: string, password: string): Promise<NaviLinkSessionTokens> {
    if (typeof email !== 'string' || typeof password !== 'string') {
      // A JS caller that passes `{ email, password }` as one argument would
      // otherwise POST that object as `userId`. The cloud answers
      // COMMON_BAD_REQUEST, which looks like a credential problem.
      throw new TypeError('sign-in needs an email and a password as two strings')
    }
    const response = await this.call('/user/sign-in', { userId: email, password })
    const body = this.readBody(response.body, 'sign-in')

    const data = asRecord(body.data)
    const token = asRecord(data?.token)
    const accessToken = asNonEmptyString(token?.accessToken)
    if (accessToken === undefined || token === undefined || data === undefined) {
      // Deliberately not keyed on the status code. **This API answers a
      // rejected password with HTTP 200** and an error in the body, so a
      // status check alone classifies a wrong password as a transient
      // protocol fault, and then retries it every few seconds until the
      // account is locked. The presence of a token is the only reliable
      // discriminator, so that is what decides success here.
      throw this.signInFailure(response.status, body)
    }
    const accessKeyId = asNonEmptyString(token.accessKeyId)
    const secretKey = asNonEmptyString(token.secretKey)
    const sessionToken = asNonEmptyString(token.sessionToken)
    if (accessKeyId === undefined || secretKey === undefined || sessionToken === undefined) {
      throw new ProtocolError(
        'the sign-in response carried no AWS IoT credentials, so live status is not available',
      )
    }
    const userSeq = readUserSeq(data)
    if (userSeq === undefined) {
      throw new ProtocolError('the sign-in response carried no account identifier')
    }

    return {
      userSeq,
      accessToken,
      refreshToken: asNonEmptyString(token.refreshToken),
      credentials: {
        accessKeyId,
        secretKey,
        sessionToken,
        endpoint: IOT_ENDPOINT,
        region: IOT_REGION,
      },
      expiresAt: this.now() + this.sessionLifetimeMs(token),
    }
  }

  /**
   * List the gateways on the account.
   *
   * `count` is a page size the API requires rather than a limit worth
   * configuring. Pages are walked until a short one arrives, so a 21st
   * gateway is not dropped. A cloud that never sends a short page is capped.
   */
  async listDevices(input: { email: string; accessToken: string }): Promise<ListedDevice[]> {
    const found: ListedDevice[] = []
    for (let page = 0; page < MAX_DEVICE_LIST_PAGES; page += 1) {
      const { entries, isFull } = await this.listDevicePage(input, page * DEVICE_LIST_PAGE_SIZE)
      found.push(...entries)
      if (!isFull) {
        return found
      }
    }
    this.log.warn(
      `device list capped at ${MAX_DEVICE_LIST_PAGES * DEVICE_LIST_PAGE_SIZE}`,
    )
    return found
  }

  /** One page of the device list, already parsed. */
  private async listDevicePage(
    input: { email: string; accessToken: string },
    offset: number,
  ): Promise<{ entries: ListedDevice[]; isFull: boolean }> {
    const response = await this.call(
      '/device/list',
      { offset, count: DEVICE_LIST_PAGE_SIZE, userId: input.email },
      input.accessToken,
    )
    const body = this.readBody(response.body, 'device list')
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError('the cloud rejected the session token when listing devices')
    }
    if (response.status !== 200) {
      throw new ProtocolError(
        `the device list failed: ${describeApiFailure(response.status, body)}`,
      )
    }
    // Two shapes have been seen: a bare array, and an object wrapping one.
    // Both are accepted rather than one being declared correct, because there
    // is no specification to be right about.
    const data: unknown = body.data
    const raw = Array.isArray(data)
      ? data
      : (asRecord(data)?.deviceList ?? asRecord(data)?.devices)
    if (!Array.isArray(raw)) {
      throw new ProtocolError('the device list response did not contain a list of devices')
    }
    return {
      entries: raw.flatMap((entry) => {
        const device = this.readListedDevice(entry)
        return device === undefined ? [] : [device]
      }),
      isFull: raw.length >= DEVICE_LIST_PAGE_SIZE,
    }
  }

  /**
   * Read a single device's detail.
   *
   * Used only to learn the firmware revision, which is worth having in
   * Accessory Information and in a bug report. **The response also carries the
   * installation's street address and coordinates**; those fields are never
   * read, so they cannot reach a log, an accessory context or a capture.
   */
  async readFirmware(input: {
    email: string
    accessToken: string
    macAddress: string
    additionalValue: string
  }): Promise<string | undefined> {
    const response = await this.call('/device/info', {
      macAddress: input.macAddress,
      additionalValue: input.additionalValue,
      userId: input.email,
    }, input.accessToken)
    if (response.status !== 200) {
      // Not fatal, and deliberately quiet: firmware is a nicety, and this
      // endpoint has been observed answering 403 on accounts where the device
      // list works perfectly well.
      this.log.debug(`device/info HTTP ${response.status}; firmware unknown`)
      return undefined
    }
    const body = this.readBody(response.body, 'device info')
    const info = asRecord(asRecord(body.data)?.deviceInfo)
    return asNonEmptyString(info?.fwVersion)
  }

  private async call(
    path: string,
    body: unknown,
    accessToken?: string,
  ): Promise<{ status: number; body: string }> {
    // The path, never the body: the body of the very first call is the
    // password.
    this.log.debug(`POST ${path}`)
    const started = this.now()
    try {
      const response = await this.post(`${API_BASE}${path}`, body, {
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        totalTimeoutMs: REST_TIMEOUT_MS,
        maxBytes: MAX_REST_BYTES,
        // No `Bearer` prefix. The API wants the raw token, and sending a
        // correctly-formed bearer header gets a 401.
        ...(accessToken === undefined ? {} : { headers: { authorization: accessToken } }),
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      })
      this.metrics?.({ durationMs: this.now() - started, ok: true })
      return response
    } catch (error) {
      this.metrics?.({ durationMs: this.now() - started, ok: false })
      throw error
    }
  }

  private readBody(text: string, what: string): Record<string, unknown> {
    const parsed = parseJsonBody(text)
    const record = asRecord(parsed)
    if (record === undefined) {
      throw new ProtocolError(`the ${what} response was not a JSON object`)
    }
    return record
  }

  /**
   * Turn a failed sign-in into the right kind of error.
   *
   * The distinction is the point. `AuthenticationError` with
   * `credentialsRejected` stops the plugin trying again, because repeating a
   * wrong password is how an account gets locked out. Anything else is
   * transient and must be retried, because a cloud that is briefly unwell is
   * not a reason to require the user to restart Homebridge.
   */
  private signInFailure(status: number, body: Record<string, unknown>): Error {
    const message = asNonEmptyString(body.msg)?.toUpperCase() ?? ''
    if (message.includes('USER_NOT_FOUND')) {
      return new AuthenticationError(
        'NaviLink does not recognise that email address',
        { credentialsRejected: true },
      )
    }
    if (message.includes('PASSWORD') || message.includes('INVALID_USER')) {
      return new AuthenticationError(
        'NaviLink rejected the email address or password',
        { credentialsRejected: true },
      )
    }
    if (message.length > 0) {
      // The cloud named a fault we do not have a mapping for. Not treated as
      // a rejected credential, because guessing that would stop the plugin
      // retrying something that may well be transient.
      return new ProtocolError(`sign-in failed: ${describeApiFailure(status, body)}`)
    }
    return new ProtocolError(
      `sign-in did not return a token: ${describeApiFailure(status, body)}`,
    )
  }

  /**
   * Decide how long this session is good for.
   *
   * The response reports `authorizationExpiresIn` and
   * `authenticationExpiresIn`. Neither is documented, the unit is not stated,
   * and which one governs the AWS credentials rather than the JWT is not
   * obvious from the names. So: read both as seconds, take the shorter, and
   * only believe it if it lands in a plausible band. A value outside that band
   * means the reading is wrong, and a wrong reading in the optimistic
   * direction is a session that dies mid-winter without reconnecting.
   */
  private sessionLifetimeMs(token: Record<string, unknown>): number {
    const candidates = [token.authorizationExpiresIn, token.authenticationExpiresIn]
      .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value * 1_000 : undefined))
      .filter((value): value is number => value !== undefined)
      .filter((value) => value >= MIN_BELIEVABLE_SESSION_MS && value <= MAX_BELIEVABLE_SESSION_MS)

    if (candidates.length === 0) {
      this.log.debug(
        `session lifetime missing; assuming ${Math.round(FALLBACK_SESSION_MS / 60_000)}m`,
      )
      return FALLBACK_SESSION_MS
    }
    return Math.min(...candidates)
  }

  /**
   * Read one device-list entry, skipping anything unusable.
   *
   * Skipped rather than thrown on: an account with one unrecognised gateway
   * and one good one should expose the good one.
   */
  private readListedDevice(entry: unknown): ListedDevice | undefined {
    // Both a wrapped and a bare shape have been seen in the wild.
    const record = asRecord(asRecord(entry)?.deviceInfo) ?? asRecord(entry)
    const macAddress = asNonEmptyString(record?.macAddress)?.toLowerCase()
    if (record === undefined || macAddress === undefined) {
      this.log.debug('skipping device-list entry: no MAC')
      return undefined
    }
    return {
      macAddress,
      additionalValue: typeof record.additionalValue === 'string' ? record.additionalValue : '',
      deviceType: typeof record.deviceType === 'number' ? record.deviceType : 1,
      homeSeq: String(record.homeSeq ?? ''),
      deviceName: asNonEmptyString(record.deviceName) ?? 'NaviLink',
      connected: typeof record.connected === 'number' ? record.connected : 0,
    }
  }
}

/** Describe an API failure without quoting a body that may hold a token. */
function describeApiFailure(status: number, body: Record<string, unknown>): string {
  const message = asNonEmptyString(body.msg)
  const code = typeof body.code === 'number' ? body.code : undefined
  if (message !== undefined) {
    return `${message}${code === undefined ? '' : ` (code ${code})`}`
  }
  return `HTTP ${status}`
}

/**
 * The account identifier, wherever this response happens to put it.
 *
 * Observed under `userInfo.userSeq`. Read defensively because it is not
 * optional: it appears in every MQTT response topic, and a session without it
 * can subscribe to nothing.
 */
function readUserSeq(data: Record<string, unknown>): string | undefined {
  const direct = data.userSeq
  if (typeof direct === 'string' || typeof direct === 'number') {
    return String(direct)
  }
  const nested = asRecord(data.userInfo)?.userSeq
  if (typeof nested === 'string' || typeof nested === 'number') {
    return String(nested)
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
