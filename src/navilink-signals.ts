/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Turns appliance faults and a rejected NaviLink sign-in into
 * homebridge-pagerduty signals.
 *
 * The store writer is the copied module. This file decides which conditions
 * are worth a page. A fault signal is the appliance's name from config. A
 * fault still in the store under a name that is no longer configured is
 * cleared from the store itself, so this plugin keeps no list of its own.
 */

import { parseDeviceId } from './api/identity'
import { PagerDutySignals } from './pagerduty-signals'
import type { PagerDutySignalsOptions, SignalState } from './pagerduty-signals'
import { forLog } from './utils/validators'

/** Logged once, with the pattern rather than each appliance name. */
export const PAGERDUTY_STARTUP_LOG =
  'homebridge-pagerduty support is enabled (fault.<name>, auth-failed)'

export const SIGNAL_AUTH_FAILED = 'auth-failed'

const AUTH_FAILED_SUMMARY =
  'NaviLink rejected the account email or password. Sign-in has stopped until it is corrected in Homebridge.'

const FAULT_SUMMARY_FALLBACK = 'Navien appliance is reporting a fault'

/** Signal names the store will accept: lowercase, digits, and . _ - */
const MAX_SIGNAL_LENGTH = 64

const FAULT_PREFIX = 'fault.'

const MAX_SLUG_LENGTH = MAX_SIGNAL_LENGTH - FAULT_PREFIX.length

/** One row this plugin has already written. */
export interface ListedSignal {
  signal: string
  active: boolean
  summary: string
}

/** The subset of the store writer this class uses. */
export interface SignalWriter {
  write(signal: string, state: SignalState): void
  list(): readonly ListedSignal[]
  close(): void
}

/**
 * The signal name for one appliance, from its configured name.
 *
 * The store only accepts lowercase letters, digits, `.`, `_` and `-`. A space
 * or anything else becomes a hyphen. Undefined when the name has none of the
 * accepted characters.
 */
export function faultSignalName(name: string): string | undefined {
  const slug = faultSlug(name)
  if (slug === undefined) {
    return undefined
  }
  return `${FAULT_PREFIX}${slug}`
}

/**
 * The PagerDuty title for an appliance fault.
 *
 * The name is the one in config. The error code stays in the Homebridge log,
 * because a saved PagerDuty message is fixed text and would keep an old code.
 */
export function faultSummary(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) {
    return FAULT_SUMMARY_FALLBACK
  }
  return `Navien ${cleaned} is reporting a fault`
}

/**
 * Fault and sign-in signals for this plugin.
 *
 * Fault rows are written when a status frame arrives, not before: a clear
 * written at startup would resolve a lockout that is still in progress.
 * Auth is written when sign-in is accepted or refused, and left alone for
 * every failure the session will retry.
 */
export class NaviLinkSignals {
  private readonly writer: SignalWriter

  private readonly log: { warn(message: string): void }

  private readonly warned = new Set<string>()

  /** Signal name for each configured appliance, including collision suffixes. */
  private signalFor = new Map<string, string>()

  constructor(
    writer: SignalWriter,
    log: { warn(message: string): void },
  ) {
    this.writer = writer
    this.log = log
  }

  /**
   * Clear fault signals whose names are no longer configured.
   *
   * Does not write the current appliances: their fault state is not known
   * until a status frame arrives.
   */
  syncDevices(devices: readonly { id: string; name: string }[]): void {
    for (const device of devices) {
      if (faultSlug(device.name) === undefined) {
        this.warnUnusable(device.name)
      }
    }
    this.signalFor = assignFaultSignals(devices)
    const current = new Set(this.signalFor.values())
    for (const row of this.listedSignals()) {
      if (!row.signal.startsWith(FAULT_PREFIX) || !row.active || current.has(row.signal)) {
        continue
      }
      this.writer.write(row.signal, {
        active: false,
        severity: 'critical',
        summary: row.summary.length > 0 ? row.summary : FAULT_SUMMARY_FALLBACK,
      })
    }
  }

  /** Record whether this appliance's latest status frame has an error code. */
  setFault(deviceId: string, name: string, isActive: boolean): void {
    const signal = this.signalFor.get(deviceId) ?? faultSignalName(name)
    if (signal === undefined) {
      this.warnUnusable(name)
      return
    }
    this.writer.write(signal, {
      active: isActive,
      severity: 'critical',
      summary: faultSummary(name),
    })
  }

  /** Record whether NaviLink has rejected the account and stopped sign-in. */
  setAuthenticationRejected(isRejected: boolean): void {
    this.writer.write(SIGNAL_AUTH_FAILED, {
      active: isRejected,
      severity: 'error',
      summary: AUTH_FAILED_SUMMARY,
    })
  }

  /** Close the store. Does not clear any signal. */
  close(): void {
    this.writer.close()
  }

  private listedSignals(): readonly ListedSignal[] {
    try {
      return this.writer.list()
    } catch {
      this.warnOnce(
        'PagerDuty signals could not be read; removed appliances will not be cleared this start',
      )
      return []
    }
  }

  private warnUnusable(name: string): void {
    this.warnOnce(
      `PagerDuty fault signal skipped for ${forLog(name)}; the name has no usable characters`,
    )
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) {
      return
    }
    this.warned.add(message)
    this.log.warn(message)
  }
}

/** Build the signals for this plugin, backed by the homebridge-pagerduty store. */
export function createNaviLinkSignals(options: PagerDutySignalsOptions): NaviLinkSignals {
  return new NaviLinkSignals(new PagerDutySignals(options), options.log)
}

/** The part of a name the store will accept, or undefined when nothing is left. */
function faultSlug(name: string): string | undefined {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[.-]+$/g, '')
  if (slug.length === 0 || !/^[a-z0-9]/.test(slug)) {
    return undefined
  }
  return slug
}

/**
 * One signal per appliance.
 *
 * The name is the key. Two appliances whose names slug the same way get the
 * channel appended, so each still has its own row. The order follows the
 * device id, which does not move when the config is reordered.
 */
function assignFaultSignals(
  devices: readonly { id: string; name: string }[],
): Map<string, string> {
  const ready = devices.flatMap((device) => {
    const slug = faultSlug(device.name)
    return slug === undefined ? [] : [{ id: device.id, slug }]
  })
  const shared = sharedSlugs(ready)
  const used = new Set<string>()
  const assigned = new Map<string, string>()
  const ordered = [...ready].sort((left, right) => compareId(left.id, right.id))
  for (const device of ordered) {
    const channel = parseDeviceId(device.id)?.channel
    const base = shared.has(device.slug) && channel !== undefined
      ? `${FAULT_PREFIX}${device.slug}.${channel}`
      : `${FAULT_PREFIX}${device.slug}`
    const signal = uniqueSignal(base, used)
    used.add(signal)
    assigned.set(device.id, signal)
  }
  return assigned
}

function sharedSlugs(devices: readonly { slug: string }[]): Set<string> {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const device of devices) {
    if (seen.has(device.slug)) {
      shared.add(device.slug)
    } else {
      seen.add(device.slug)
    }
  }
  return shared
}

function compareId(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

/** Shorten a signal to the column limit without leaving a trailing separator. */
function fitSignal(signal: string): string {
  return signal.slice(0, MAX_SIGNAL_LENGTH).replace(/[.-]+$/g, '')
}

function uniqueSignal(base: string, used: ReadonlySet<string>): string {
  const first = fitSignal(base)
  if (!used.has(first)) {
    return first
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const tail = `.${suffix}`
    const stem = fitSignal(base.slice(0, MAX_SIGNAL_LENGTH - tail.length))
    const candidate = `${stem}${tail}`
    if (!used.has(candidate)) {
      return candidate
    }
  }
  return first
}
