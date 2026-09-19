/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * The split between fatal and non-fatal is deliberate. A missing account, or a
 * `devices` value that is not a list, means the file does not describe
 * anything we can act on, so the platform disables itself while leaving cached
 * accessories registered. HomeKit then shows them as No Response rather than
 * losing the rooms and automations built on them.
 *
 * A problem with one device is different: rejecting the whole installation
 * because one entry is malformed would be a worse outcome than skipping that
 * entry. Skipped devices are warned about by name and reason, because a device
 * that silently fails to appear is the hardest kind of bug for a user to
 * report.
 *
 * One rule specific to this plugin: **nothing in here ever puts the password
 * into a message.** Not its length, not a prefix, not "you typed
 * `hunter2␣`" to explain a trailing space. Validation says whether it is
 * present and usable and stops there.
 */

import { makeDeviceId, parseDeviceId } from '../api/identity'
import {
  DEFAULT_STATUS_INTERVAL_SEC,
  MAX_CHANNEL,
  MAX_LOG_FIELD_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_STATUS_INTERVAL_SEC,
  MIN_CHANNEL,
  MIN_STATUS_INTERVAL_SEC,
} from '../settings'
import type {
  NaviLinkDeviceConfig,
  NaviLinkPlatformConfig,
  ResolvedAccessory,
  ResolvedDevice,
} from '../types'

/** Platform-wide settings after validation and defaulting. */
export interface ResolvedPlatformOptions {
  statusIntervalSec: number
  allowPowerOff: boolean
  readOnly: boolean
}

/** The account, once it is known to be usable. */
export interface ResolvedAccount {
  email: string
  password: string
}

/** Outcome of validating a platform configuration block. */
export interface ConfigValidationResult {
  /** Fatal problems. Any entry means the platform must not sign in. */
  errors: string[]
  /** Problems worth reporting that do not prevent operation. */
  warnings: string[]
  /** The account, or undefined when it was missing or unusable. */
  account: ResolvedAccount | undefined
  /** Devices that survived validation, in configuration order. */
  devices: ResolvedDevice[]
  options: ResolvedPlatformOptions
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/
/**
 * The same class, global, for replacement.
 *
 * Kept separate because a global regex carries `lastIndex` state, which would
 * make two `test` calls on one input return alternating answers.
 */
const ALL_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g

/**
 * A deliberately loose address check.
 *
 * The authority on whether an address is an account is the cloud, which will
 * say so in one round trip. All this has to catch is the shape that is
 * certainly a mistake (no `@`, whitespace in the middle, a control character)
 * so that an obvious typo is a startup error instead of a failed sign-in
 * that looks like a wrong password.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/


/**
 * Make an untrusted string safe to interpolate into a log line.
 *
 * Device names come from configuration and from the cloud, so they are
 * attacker-influenced in the threat model where someone can write to either. A
 * newline in a log line lets them forge entries; truncation stops one long
 * name from burying everything else.
 */
export function forLog(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  const sanitized = text.replace(ALL_CONTROL_CHARACTERS, '\uFFFD')
  return sanitized.length > MAX_LOG_FIELD_LENGTH
    ? `${sanitized.slice(0, MAX_LOG_FIELD_LENGTH)}\u2026`
    : sanitized
}

/**
 * Make an untrusted string safe to publish to HomeKit.
 *
 * Same sanitising as {@link forLog} but capped at HomeKit's name budget rather
 * than the log field budget, for values that become characteristic values and
 * are written into the accessory cache. An empty result becomes undefined, so
 * a caller keeps the value it already had instead of publishing a blank.
 */
export function forDisplay(value: string): string | undefined {
  const cleaned = value.replace(ALL_CONTROL_CHARACTERS, '').trim()
  if (cleaned.length === 0) {
    return undefined
  }
  return cleaned.length > MAX_NAME_LENGTH
    ? `${cleaned.slice(0, MAX_NAME_LENGTH - 1)}\u2026`
    : cleaned
}

/** True when a value is safe to use as a device id and accessory UUID seed. */
export function isValidDeviceId(value: unknown): value is string {
  return parseDeviceId(value) !== undefined
}

/** True for something shaped like an email address. */
export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value.trim())
}

/** Clamp the status interval into the supported range. */
export function resolveStatusIntervalSec(value: unknown, warnings?: string[]): number {
  if (value === undefined) {
    return DEFAULT_STATUS_INTERVAL_SEC
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) {
    warnings?.push(
      `options.statusIntervalSec is not a number; using ${DEFAULT_STATUS_INTERVAL_SEC}s`,
    )
    return DEFAULT_STATUS_INTERVAL_SEC
  }
  const clamped = Math.min(
    MAX_STATUS_INTERVAL_SEC,
    Math.max(MIN_STATUS_INTERVAL_SEC, Math.round(numeric)),
  )
  if (clamped !== numeric) {
    warnings?.push(`options.statusIntervalSec clamped to ${clamped}s`)
  }
  return clamped
}

function validateName(value: unknown, label: string, problems: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push(`${label} is missing a name`)
    return undefined
  }
  const name = value.trim()
  if (CONTROL_CHARACTERS.test(name)) {
    problems.push(`${label} name contains control characters`)
    return undefined
  }
  if (name.length > MAX_NAME_LENGTH) {
    problems.push(`${label} name is longer than ${MAX_NAME_LENGTH} characters`)
    return undefined
  }
  return name
}

function validateChannel(value: unknown, label: string, warnings: string[]): number {
  if (value === undefined) {
    return MIN_CHANNEL
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric) || numeric < MIN_CHANNEL || numeric > MAX_CHANNEL) {
    warnings.push(`${label} channel ${forLog(value)} is invalid; using ${MIN_CHANNEL}`)
    return MIN_CHANNEL
  }
  return numeric
}

/**
 * Validate the account.
 *
 * Trimmed on the way in, because a trailing space pasted from a password
 * manager is a real and very confusing failure: the cloud rejects it and the
 * user sees "wrong password" for a password that is right. The address is
 * trimmed for the same reason. Neither value is echoed back in any message.
 */
function validateAccount(
  config: Partial<NaviLinkPlatformConfig>,
  errors: string[],
  warnings: string[],
): ResolvedAccount | undefined {
  const rawEmail = typeof config.email === 'string' ? config.email.trim() : ''
  const rawPassword = typeof config.password === 'string' ? config.password : ''

  if (rawEmail.length === 0 || rawPassword.length === 0) {
    errors.push(
      'a NaviLink email address and password are required; open the plugin settings and sign in',
    )
    return undefined
  }
  if (!isValidEmail(rawEmail)) {
    errors.push('the configured NaviLink email address is not a valid address')
    return undefined
  }
  const password = rawPassword.trim()
  if (password.length === 0) {
    errors.push('the configured NaviLink password is blank')
    return undefined
  }
  if (password !== rawPassword) {
    // Said once, without quoting anything: a pasted password often carries a
    // trailing newline, and the resulting rejection is otherwise unexplainable.
    warnings.push('the NaviLink password had surrounding whitespace, which has been trimmed')
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    errors.push(`the configured NaviLink password is longer than ${MAX_PASSWORD_LENGTH} characters`)
    return undefined
  }
  return { email: rawEmail, password }
}

/** MAC and channel from `id`, which is what the session addresses. */
function resolveDeviceIdentity(input: {
  rawId: unknown
  rawChannel: unknown
  label: string
  problems: string[]
  warnings: string[]
}): { id: string; channel: number } | undefined {
  const parsed = parseDeviceId(input.rawId)
  if (parsed === undefined) {
    input.problems.push(
      `${input.label} has no usable id (open the plugin settings and sign in again)`,
    )
    return undefined
  }
  const id = makeDeviceId(parsed.mac, parsed.channel)
  if (input.rawChannel !== undefined) {
    const configured = validateChannel(input.rawChannel, input.label, input.warnings)
    if (configured !== parsed.channel) {
      input.warnings.push(
        `${input.label} channel ${forLog(input.rawChannel)} does not match id ${forLog(id)}; `
        + `using channel ${parsed.channel} from the id`,
      )
    }
  }
  return { id, channel: parsed.channel }
}

function validateDevice(input: {
  entry: unknown
  index: number
  warnings: string[]
}): ResolvedDevice | undefined {
  const { entry, index, warnings } = input
  const label = `devices[${index}]`
  if (typeof entry !== 'object' || entry === null) {
    warnings.push(`${label} is not an object; skipping it`)
    return undefined
  }
  const device = entry as Partial<NaviLinkDeviceConfig>
  const problems: string[] = []

  const name = validateName(device.name, label, problems)
  const identity = resolveDeviceIdentity({
    rawId: device.id,
    rawChannel: device.channel,
    label,
    problems,
    warnings,
  })
  if (name === undefined || identity === undefined || problems.length > 0) {
    warnings.push(`${problems.join('; ')}; skipping ${name === undefined ? label : forLog(name)}`)
    return undefined
  }

  return {
    id: identity.id,
    name,
    channel: identity.channel,
    // Hot water is the reason most people install this, so it is the one
    // accessory that is on unless it is turned off. Everything else is opt-in,
    // including space heating: a plugin that invents a heating thermostat
    // nobody asked for is a plugin that can be told to stop heating a house.
    dhw: device.dhw !== false,
    heating: device.heating === true,
    power: device.power === true,
    recirculation: device.recirculation === true,
    fault: device.fault === true,
    temperatureSensors: device.temperatureSensors === true,
    outdoorSensor: device.outdoorSensor === true,
  }
}

/**
 * Validate a platform configuration block.
 *
 * Never throws: the platform needs the errors and warnings in order to report
 * them, and a configuration problem should produce a diagnosable log rather
 * than an exception during Homebridge startup.
 */
export function validateConfig(config: unknown): ConfigValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const defaults: ResolvedPlatformOptions = {
    statusIntervalSec: DEFAULT_STATUS_INTERVAL_SEC,
    allowPowerOff: false,
    readOnly: false,
  }

  if (typeof config !== 'object' || config === null) {
    return { errors: ['platform configuration is missing'], warnings, account: undefined, devices: [], options: defaults }
  }
  const platform = config as Partial<NaviLinkPlatformConfig>
  const account = validateAccount(platform, errors, warnings)

  const options: ResolvedPlatformOptions = {
    statusIntervalSec: resolveStatusIntervalSec(platform.options?.statusIntervalSec, warnings),
    allowPowerOff: platform.options?.allowPowerOff === true,
    readOnly: platform.options?.readOnly === true,
  }

  const rawDevices = platform.devices
  if (rawDevices === undefined) {
    errors.push('configuration has no "devices" list; open the plugin settings and sign in')
    return { errors, warnings, account, devices: [], options }
  }
  if (!Array.isArray(rawDevices)) {
    errors.push('configuration "devices" must be a list')
    return { errors, warnings, account, devices: [], options }
  }

  const devices: ResolvedDevice[] = []
  const seenIds = new Set<string>()
  rawDevices.forEach((entry, index) => {
    const device = validateDevice({ entry, index, warnings })
    if (device === undefined) {
      return
    }
    if (seenIds.has(device.id)) {
      warnings.push(`devices[${index}] repeats id ${forLog(device.id)}; skipping the duplicate`)
      return
    }
    seenIds.add(device.id)
    devices.push(device)
  })

  if (rawDevices.length > 0 && devices.length === 0) {
    // Every entry was rejected. The user plainly meant to configure something,
    // so this is fatal rather than an idle platform.
    errors.push(`all ${rawDevices.length} configured device(s) were rejected; see the warnings above`)
  } else if (rawDevices.length === 0) {
    // An empty list with a valid account used to start a session and then
    // unregister every cached tile. Fatal keeps the rooms.
    errors.push('no devices are configured; open the plugin settings and sign in')
  }

  if (options.readOnly && devices.length > 0) {
    warnings.push(
      'options.readOnly is on: every accessory will report state, and HomeKit will not be '
      + 'able to change a setpoint, a power state or recirculation',
    )
  }

  return { errors, warnings, account, devices, options }
}

/**
 * Expand validated devices into the accessories to expose.
 *
 * Names are derived here rather than at use time so that duplicates can be
 * detected once: two accessories sharing a name still work, but they make Siri
 * ambiguous, which is worth a warning.
 *
 * The probe accessories are created unconditionally when `temperatureSensors`
 * is on, rather than only for the probes the appliance turns out to report.
 * Whether a probe exists is only knowable from a live status frame, which
 * arrives after accessories are registered, and creating them later would mean
 * an accessory appearing minutes into a session. Each one disables itself on
 * the first observation that shows nothing behind it.
 */
export function resolveAccessories(
  devices: readonly ResolvedDevice[],
  warnings?: string[],
): ResolvedAccessory[] {
  const accessories: ResolvedAccessory[] = []
  for (const device of devices) {
    if (device.dhw) {
      accessories.push({ kind: 'dhw', deviceId: device.id, name: suffixName(device.name, 'Hot Water') })
    }
    if (device.heating) {
      accessories.push({ kind: 'heating', deviceId: device.id, name: suffixName(device.name, 'Heating') })
    }
    if (device.power) {
      accessories.push({ kind: 'power', deviceId: device.id, name: suffixName(device.name, 'Power') })
    }
    if (device.recirculation) {
      accessories.push({
        kind: 'recirculation',
        deviceId: device.id,
        name: suffixName(device.name, 'Recirculation'),
      })
    }
    if (device.fault) {
      accessories.push({ kind: 'fault', deviceId: device.id, name: suffixName(device.name, 'Fault') })
    }
    if (device.temperatureSensors) {
      accessories.push(
        { kind: 'dhwOutlet', deviceId: device.id, name: suffixName(device.name, 'Hot Water Out') },
        { kind: 'dhwInlet', deviceId: device.id, name: suffixName(device.name, 'Hot Water In') },
        { kind: 'heatSupply', deviceId: device.id, name: suffixName(device.name, 'Heating Flow') },
        { kind: 'heatReturn', deviceId: device.id, name: suffixName(device.name, 'Heating Return') },
      )
    }
    if (device.outdoorSensor) {
      accessories.push({ kind: 'outdoor', deviceId: device.id, name: suffixName(device.name, 'Outdoor') })
    }
  }

  const names = new Map<string, number>()
  for (const accessory of accessories) {
    names.set(accessory.name, (names.get(accessory.name) ?? 0) + 1)
  }
  for (const [name, count] of names) {
    if (count > 1) {
      warnings?.push(`${count} accessories are named ${forLog(name)}; Siri cannot tell them apart`)
    }
  }
  return accessories
}

/** Append a suffix to a device name without exceeding HomeKit's name budget. */
function suffixName(name: string, suffix: string): string {
  const combined = `${name} ${suffix}`
  if (combined.length <= MAX_NAME_LENGTH) {
    return combined
  }
  return `${name.slice(0, MAX_NAME_LENGTH - suffix.length - 2)}\u2026 ${suffix}`
}
