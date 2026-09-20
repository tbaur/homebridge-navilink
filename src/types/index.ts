/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared types for configuration, accessory identity and the
 * observations read back from an appliance.
 */

import type { TemperatureScale } from '../utils/temperature'

/** The subset of Homebridge's logger this plugin uses. */
export interface PluginLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
}

/**
 * What an accessory does. Part of its identity, and therefore of its UUID.
 *
 * `dhw` and `heating` are the two thermostats, which are the point of the
 * plugin. `power` is the appliance's own power state. `recirculation` triggers
 * the on-demand hot-water pump on units that have one. `fault` is a contact
 * sensor that opens on an error code. The rest are read-only temperature
 * probes, each of which exists only when the appliance actually reports it.
 */
export const ACCESSORY_KINDS = [
  'dhw',
  'heating',
  'power',
  'recirculation',
  'fault',
  'outdoor',
  'dhwOutlet',
  'dhwInlet',
  'heatSupply',
  'heatReturn',
] as const

/** @see ACCESSORY_KINDS */
export type AccessoryKind = (typeof ACCESSORY_KINDS)[number]

/** Narrow an unknown value to an {@link AccessoryKind}. */
export function isAccessoryKind(value: unknown): value is AccessoryKind {
  return typeof value === 'string' && (ACCESSORY_KINDS as readonly string[]).includes(value)
}

/** The temperature probes, which share one accessory implementation. */
export const PROBE_KINDS = ['outdoor', 'dhwOutlet', 'dhwInlet', 'heatSupply', 'heatReturn'] as const

/** @see PROBE_KINDS */
export type ProbeKind = (typeof PROBE_KINDS)[number]

/** Narrow an {@link AccessoryKind} to one of the temperature probes. */
export function isProbeKind(value: AccessoryKind): value is ProbeKind {
  return (PROBE_KINDS as readonly string[]).includes(value)
}

/**
 * The appliance family, as `unitType` reports it.
 *
 * Decoded from the same table the NaviLink app uses.
 * It decides which capabilities are even plausible: an NPE is a tankless water
 * heater with no space heating at all, while an NCB is a combi that has both.
 * Kept as a named value rather than a number so that a log line and a
 * capability check both read as the family rather than as `2`.
 */
export const APPLIANCE_FAMILIES = [
  'NPE', 'NCB', 'NHB', 'CAS_NPE', 'CAS_NHB', 'NFB', 'CAS_NFB', 'NFC',
  'NPN', 'CAS_NPN', 'NPE2', 'CAS_NPE2', 'NCB_H', 'NVW', 'CAS_NVW', 'UNKNOWN',
] as const

/** @see APPLIANCE_FAMILIES */
export type ApplianceFamily = (typeof APPLIANCE_FAMILIES)[number]

/** One configured appliance channel. */
export interface NaviLinkDeviceConfig {
  /**
   * Stable identity, `{mac}:{channel}`.
   *
   * Written by the settings page. Hand-editable but not derived from anything
   * that changes, so an accessory keeps its HomeKit room across a router
   * change, a firmware update and a re-pairing of the gateway.
   */
  id: string
  name: string
  /** Channel on the gateway. One for a single appliance; cascades use more. */
  channel?: number
  dhw?: boolean
  heating?: boolean
  power?: boolean
  recirculation?: boolean
  fault?: boolean
  /** Expose the inlet, outlet, supply and return probes the appliance reports. */
  temperatureSensors?: boolean
  /** Expose the outdoor probe, on an installation that has one fitted. */
  outdoorSensor?: boolean
}

/** Platform-level tuning. */
export interface NaviLinkPlatformOptions {
  /**
   * How often to ask the appliance for a full status frame.
   *
   * The gateway pushes changes unprompted, so this is a floor on staleness
   * rather than the way state normally arrives. It is someone else's cloud, so
   * the default is deliberately unhurried.
   */
  statusIntervalSec?: number

  /**
   * Allow HomeKit to switch the appliance off.
   *
   * Off by default, and the default is the important part. A combi boiler's
   * power state governs central heating as well as hot water, so "turn off the
   * water heater", said to Siri, or swept up by a scene that turns everything
   * off, would take the heating with it, in a house that may be empty and
   * freezing. With this off, a power-off request is declined and explained,
   * not obeyed.
   */
  allowPowerOff?: boolean

  /**
   * Never send a control command, whatever HomeKit asks for.
   *
   * For an installation where the appliance should be observed and not driven,
   * and for anyone who wants the readings while remaining certain the plugin
   * cannot change a setpoint. Every accessory still reports state; writes are
   * declined with one explanatory line.
   */
  readOnly?: boolean

  /**
   * Seconds between diagnostics health lines in the Homebridge log.
   *
   * `0` (the default) is off. Otherwise `30`–`3600`. Logs only; nothing is
   * exposed in HomeKit.
   */
  diagnosticsInterval?: number

  /**
   * Also emit each diagnostics report as a JSON line.
   *
   * Has no effect while diagnostics are off.
   */
  structuredLogs?: boolean

  /**
   * Prefix for every HomeKit accessory name.
   *
   * When set, tiles become `Prefix Hot Water`, `Prefix Heating`, and so on.
   * When left blank, each appliance's own name is used (`Boiler Hot Water`).
   * A prefix does not change accessory identity, so rooms and automations stay
   * attached if you rename later.
   */
  accessoryPrefix?: string
}

/** Shape of one `platforms[]` entry in `config.json`. */
export interface NaviLinkPlatformConfig {
  platform: string
  name?: string
  /** NaviLink account email. Identifies the account; treated as personal data. */
  email?: string
  /** NaviLink account password. Never logged, never persisted by this plugin. */
  password?: string
  devices?: NaviLinkDeviceConfig[]
  options?: NaviLinkPlatformOptions
}

/** A configured device after validation and defaulting. */
export interface ResolvedDevice {
  id: string
  name: string
  channel: number
  dhw: boolean
  heating: boolean
  power: boolean
  recirculation: boolean
  fault: boolean
  temperatureSensors: boolean
  outdoorSensor: boolean
}

/** One accessory to expose, derived from a {@link ResolvedDevice}. */
export interface ResolvedAccessory {
  kind: AccessoryKind
  /** Owning device's stable id. */
  deviceId: string
  /** HomeKit display name. */
  name: string
}

/**
 * What gets persisted in `PlatformAccessory.context`.
 *
 * Survives restarts, so anything needed to serve HomeKit before the first
 * status frame arrives belongs here. Note what is absent: no token and no
 * credential. `deviceId` is `{mac}:{channel}` because that is the identity
 * the session addresses; the MAC is the appliance's address in every MQTT
 * topic. The accessory cache is a plain JSON file on the Homebridge host,
 * and it is included in the diagnostic bundles users attach to issues.
 */
export interface AccessoryContext {
  kind: AccessoryKind
  deviceId: string
  model: string
  /** Opaque, stable, generated once. Not the MAC: that would leak and churn. */
  serialNumber: string
  /**
   * Reserved for a future UUID migration. Always false in this version;
   * kept so a cache written today still parses after one.
   */
  adoptedLegacyUuid: boolean
  /**
   * The scale last observed, so a restart can publish display units before
   * the first frame lands. Setpoint bounds still come from a live observation.
   */
  scale?: TemperatureScale
}

/** Charge, flow and usage readings that only some families report. */
export interface UnitReadings {
  /** Non-zero when the appliance is reporting a fault. */
  errorCode: number
  subErrorCode: number
  /** Firmware of the burner controller, as reported per unit. */
  controllerVersion?: number
}

/**
 * A decoded view of one channel: what it is, and what it is doing.
 *
 * Everything optional is optional because the appliance genuinely may not
 * report it. A field that is absent must leave its characteristic alone rather
 * than publish a zero: `0` is a real temperature, and several of these fields
 * use it to mean "no probe fitted".
 */
export interface ChannelObservation {
  channelNumber: number
  family: ApplianceFamily
  scale: TemperatureScale
  unitCount: number

  /** True when the appliance is powered on. */
  power: boolean
  /** True when space heating is enabled. Meaningless on a water-heater family. */
  heating: boolean
  /**
   * True when space heating is enabled.
   *
   * The same `heatStatus` flag as {@link heating}. No field on the verified
   * frame distinguishes "heating is switched on" from "the burner is firing",
   * so this is not a firing signal.
   */
  heatingActive: boolean
  /**
   * True when this appliance actually has a space-heating loop.
   *
   * A tankless water heater answers the same frames as a combi and fills the
   * heating fields with placeholders, so the fields being present proves
   * nothing. Decided from the commissioning flag and the setpoint bounds
   * together; see `hasUsableHeatingLoop` in `api/channel.ts`.
   */
  heatingSupported: boolean

  /** Domestic hot water setpoint and the limits the installer set, native scale. */
  dhwSetpoint?: number
  dhwMin?: number
  dhwMax?: number

  /** Space-heating water setpoint and its limits, native scale. */
  heatSetpoint?: number
  heatMin?: number
  heatMax?: number

  /** Probe readings, native scale. Absent when the appliance does not report one. */
  dhwOutlet?: number
  dhwInlet?: number
  heatSupply?: number
  heatReturn?: number
  outdoor?: number

  /** True when a recirculation pump is fitted and enabled in commissioning. */
  recirculationEquipped: boolean
  /** True when recirculation is running now. */
  recirculationOn: boolean

  readings: UnitReadings
  /** When this observation was decoded, for staleness checks. */
  observedAt: number
}

/** Why a refresh happened, for logging and for suppressing redundant writes. */
export type RefreshReason = 'push' | 'poll' | 'post-set' | 'startup'

/** MQTT session lifecycle, as diagnostics reports it. */
export type MqttTransportState = 'connecting' | 'running' | 'stopped' | 'auth-failed'

/** Live appliance counts for a diagnostics heartbeat. */
export interface DeviceGauges {
  total: number
  online: number
}

/** In-memory session gauges the diagnostics collector can read. */
export interface SessionHealth {
  mqttState: MqttTransportState
  lastMqttEventAt: number | null
  expiresAt: number | null
  lastRefreshAt: number | null
  onlineDeviceIds: readonly string[]
}

/** Counters the session reports into the diagnostics collector. */
export interface SessionMetrics {
  apiRequest(durationMs: number, ok: boolean): void
  mqttReconnect(): void
  pollCycle(ok: number, failed: number, durationMs: number): void
  command(): void
  sessionRefresh(): void
  push(): void
}

/** One opt-in diagnostics report. */
export interface DiagnosticsSnapshot {
  msg: string
  lifecycle: {
    health: 'healthy' | 'degraded'
    reasons: string[]
    uptimeSec: number
    pluginVersion: string
  }
  devices: DeviceGauges
  transport: {
    mqttState: MqttTransportState
  }
  polling: {
    cadenceSec: number
    lastDurationMs: number | null
    ok: number
    failed: number
  }
  token: {
    expiresInSec: number | null
    lastRefreshAt: number | null
    refreshes: number
  }
  api: {
    p50Ms: number
    p95Ms: number
    requests: number
    errors: number
  }
  activity: {
    reconnects: number
    commands: number
    pushes: number
  }
  circuitBreaker: {
    state: string
    lastTripAt: number | null
    trips: number
  }
  /** Redacted config echo, present only on boot/shutdown snapshots. */
  config?: Record<string, unknown>
}

/** An accessory handler the platform can drive. */
export interface RefreshableAccessory {
  readonly deviceId: string
  readonly displayName: string
  /** Apply a fresh observation to HomeKit characteristics. */
  applyObservation(observation: ChannelObservation, reason: RefreshReason): void
  /** Report that the appliance could not be reached. */
  noteUnreachable(error: unknown): void
}

/** An appliance the account owns, as the cloud lists it. */
export interface DiscoveredDevice {
  /** `{mac}:{channel}`. */
  id: string
  name: string
  /** Gateway MAC, lower-case hex with no separators. Never logged unmasked. */
  mac: string
  channel: number
  family: ApplianceFamily
  model: string
  firmware?: string
  /** False when the cloud's device list says this gateway is offline. */
  online: boolean
  /**
   * True when this entry came from a `channelinfo` frame.
   *
   * A listed gateway that never answered still has to appear on the settings
   * card so the page can say it is offline. That stub has no capabilities.
   */
  described: boolean
  /** What the appliance reports it can do, so the page offers only those. */
  capabilities: {
    dhw: boolean
    heating: boolean
    recirculation: boolean
    outdoorSensor: boolean
  }
}
