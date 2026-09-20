/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The platform: accessory lifecycle, and the rules that govern
 * every write.
 *
 * It owns three things and delegates everything else.
 *
 * **Which accessories exist.** Configuration is validated once, expanded into
 * a list of accessories, and reconciled against what Homebridge restored from
 * its cache. Adopting a restored accessory rather than recreating it is what
 * keeps a tile attached to its room, its scenes and its automations.
 *
 * **What happens when configuration is unusable.** The platform disables
 * itself and leaves cached accessories registered, so HomeKit shows No
 * Response instead of losing the rooms built on them. Unregistering would be
 * tidier and is the wrong trade: a typo in a password should not cost
 * somebody their automations.
 *
 * **The rules that govern writes.** Read-only mode and the power-off guard
 * are enforced here, in {@link control}, rather than in each accessory that
 * might forget. An accessory can only express an intent; whether it is
 * carried out is decided in one place. Setpoint coalescing is thermostat-only
 * and lives on the thermostat accessory.
 */

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge'

import { formatFamily } from './api/channel'
import { accessoryIdentityKey, hasAccessoryIdentity } from './api/identity'
import {
  Command,
  dhwSetpointControl,
  heatingEnableControl,
  heatingSetpointControl,
  onDemandControl,
  powerControl,
} from './api/protocol'
import {
  BaseAccessory,
  DomesticHotWaterAccessory,
  FaultAccessory,
  PowerAccessory,
  ProbeAccessory,
  RecirculationAccessory,
  SpaceHeatingAccessory,
  type AccessoryHost,
  type AccessoryInit,
  type ControlIntent,
} from './devices'
import { DiagnosticsCollector, type DiagnosticsReaders } from './diagnostics/collector'
import {
  formatDiagnosticLine,
  formatHealthTransitionLine,
} from './diagnostics/format'
import { NaviLinkSession, type ControlSpec } from './session'
import {
  DEFAULT_MODEL,
  DEFAULT_STATUS_INTERVAL_SEC,
  PLATFORM_NAME,
  PLUGIN_NAME,
  readPluginVersion,
  UNREACHABLE_REWARN_MS,
  UUID_PREFIX,
} from './settings'
import type {
  AccessoryKind,
  ChannelObservation,
  DiagnosticsSnapshot,
  NaviLinkPlatformConfig,
  RefreshReason,
  ResolvedAccessory,
  ResolvedDevice,
} from './types'
import { isProbeKind } from './types'
import {
  bindAccessoryContext,
  ControlRejectedError,
  describeError,
  forLog,
  MQTT_CHANNEL,
  parseAccessoryContext,
  resolveAccessories,
  validateConfig,
  type ResolvedPlatformOptions,
  type TemperatureScale,
} from './utils'

/** Homebridge's dynamic platform for NaviLink appliances. */
export class NaviLinkPlatform implements DynamicPlatformPlugin, AccessoryHost {
  readonly api: API

  readonly log: Logging

  readonly pluginVersion: string

  readonly Service: typeof Service

  readonly Characteristic: typeof Characteristic

  /** Accessories Homebridge restored, by UUID, before configuration is read. */
  private readonly restored = new Map<string, PlatformAccessory>()

  /** Live accessory handlers, by UUID. */
  private readonly handlers = new Map<string, BaseAccessory>()

  private readonly devices = new Map<string, ResolvedDevice>()

  private options: ResolvedPlatformOptions = {
    statusIntervalSec: DEFAULT_STATUS_INTERVAL_SEC,
    allowPowerOff: false,
    readOnly: false,
    diagnosticsInterval: 0,
    structuredLogs: false,
    accessoryPrefix: '',
  }

  private session: NaviLinkSession | undefined

  private readonly platformConfig: NaviLinkPlatformConfig

  private readonly diagnostics: DiagnosticsCollector

  private diagnosticsTimer: ReturnType<typeof setInterval> | undefined

  private lastDiagnosticsHealth: 'healthy' | 'degraded' | null = null

  /** True when configuration was unusable and nothing should be attempted. */
  private disabled = false

  /** True between the cloud going quiet and the next observation. */
  private cloudOffline = false

  private lastOutageWarnAt = 0

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log
    this.api = api
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    this.pluginVersion = readPluginVersion(log)
    this.platformConfig = config as NaviLinkPlatformConfig
    this.diagnostics = new DiagnosticsCollector({
      pluginVersion: this.pluginVersion,
      config: this.platformConfig,
    })

    const result = validateConfig(config)
    for (const warning of result.warnings) {
      this.log.warn(warning)
    }
    this.options = result.options

    if (result.errors.length > 0 || result.account === undefined) {
      this.disabled = true
      for (const error of result.errors) {
        this.log.error(error)
      }
      this.log.error('platform disabled; cached accessories kept')
      // Still registered so Homebridge does not complain about orphans, and so
      // fixing the configuration restores them rather than recreating them.
      api.on('didFinishLaunching', () => this.keepRestoredRegistered())
      return
    }

    for (const device of result.devices) {
      this.devices.set(device.id, device)
    }
    const account = result.account
    api.on('didFinishLaunching', () => this.start(account, result.devices))
    api.on('shutdown', () => {
      void this.stop()
    })
  }

  get hap(): API['hap'] {
    return this.api.hap
  }

  get isReadOnly(): boolean {
    return this.options.readOnly
  }

  /** Homebridge hands back every accessory it restored from its cache. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.restored.set(accessory.UUID, accessory)
  }

  // --- Lifecycle --------------------------------------------------------------

  private start(
    account: { email: string; password: string },
    devices: readonly ResolvedDevice[],
  ): void {
    const warnings: string[] = []
    const accessories = resolveAccessories(devices, warnings, this.options.accessoryPrefix)
    for (const warning of warnings) {
      this.log.warn(warning)
    }
    this.syncAccessories(accessories)

    const session = new NaviLinkSession({
      log: this.log,
      account,
      devices,
      statusIntervalSec: this.options.statusIntervalSec,
      metrics: this.diagnostics,
    })
    session.onObservation((deviceId, observation, reason) => {
      this.distribute(deviceId, observation, reason)
    })
    session.onUnreachable((error) => this.markAllUnreachable(error))
    session.onStale((deviceId) => this.markDeviceUnreachable(deviceId))
    this.session = session
    session.start()
    this.startDiagnostics()

    this.log.info(
      `${devices.length} appliance(s), ${accessories.length} accessory(ies)`,
    )
  }

  private async stop(): Promise<void> {
    this.stopDiagnostics()
    for (const handler of this.handlers.values()) {
      handler.stop()
    }
    this.handlers.clear()
    await this.session?.stop()
    this.session = undefined
  }

  /** Keep cached accessories registered when configuration is unusable. */
  private keepRestoredRegistered(): void {
    if (this.restored.size === 0) {
      return
    }
    for (const accessory of this.restored.values()) {
      this.reviveAsUnavailable(accessory)
    }
    this.log.warn(
      `${this.restored.size} cached accessory(ies) inactive (config invalid)`,
    )
  }

  /**
   * Bind GET handlers on a restored tile so HomeKit shows No Response.
   *
   * Without handlers, HAP keeps serving the last persisted value. The
   * platform is disabled, so every read must fail as a communication error.
   */
  private reviveAsUnavailable(accessory: PlatformAccessory): void {
    const context = parseAccessoryContext(accessory.context)
    if (context === undefined) {
      return
    }
    const init: AccessoryInit = {
      host: this,
      accessory,
      deviceId: context.deviceId,
      displayName: accessory.displayName,
      model: context.model,
      serialNumber: context.serialNumber,
    }
    const handler = this.createHandler(context.kind, init)
    if (handler === undefined) {
      return
    }
    this.handlers.set(accessory.UUID, handler)
    handler.noteUnreachable(new Error('the NaviLink platform is disabled'))
  }

  /**
   * Bring the registered accessory set in line with configuration.
   *
   * Adopting a restored accessory rather than recreating it is the whole point
   * of this method. An accessory that is removed and re-added is a *different*
   * accessory to HomeKit, and takes its room, scenes and automations with it.
   */
  private syncAccessories(resolved: readonly ResolvedAccessory[]): void {
    const wanted = new Map<string, ResolvedAccessory>()
    for (const accessory of resolved) {
      wanted.set(this.uuidFor(accessory), accessory)
    }

    const stale = [...this.restored.entries()]
      .filter(([uuid]) => !wanted.has(uuid))
      .map(([, accessory]) => accessory)
    if (stale.length > 0) {
      for (const accessory of stale) {
        this.log.info(`removing ${forLog(accessory.displayName)}`)
        this.restored.delete(accessory.UUID)
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
    }

    const created: PlatformAccessory[] = []
    for (const [uuid, accessory] of wanted) {
      const existing = this.restored.get(uuid)
      if (existing !== undefined) {
        this.adopt(existing, accessory)
        continue
      }
      this.log.info(`adding ${forLog(accessory.name)}`)
      const platformAccessory = new this.api.platformAccessory(accessory.name, uuid)
      this.adopt(platformAccessory, accessory)
      created.push(platformAccessory)
    }
    if (created.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, created)
    }
  }

  private adopt(accessory: PlatformAccessory, resolved: ResolvedAccessory): void {
    const model = this.modelFor(resolved.deviceId)
    const context = bindAccessoryContext({ accessory, resolved, model })
    if (!hasAccessoryIdentity(context, resolved)) {
      // Cannot happen: the context was just written from `resolved`. Checked
      // anyway because getting it wrong silently re-keys somebody's tile.
      this.log.warn(`${forLog(resolved.name)}: identity bind failed; skipped`)
      return
    }
    if (accessory.displayName !== resolved.name) {
      this.log.info(
        `${forLog(accessory.displayName)} is now named ${forLog(resolved.name)}`,
      )
    }
    accessory.displayName = resolved.name
    const init: AccessoryInit = {
      host: this,
      accessory,
      deviceId: resolved.deviceId,
      displayName: resolved.name,
      model,
      serialNumber: context.serialNumber,
    }
    const handler = this.createHandler(resolved.kind, init)
    if (handler === undefined) {
      return
    }
    this.handlers.set(accessory.UUID, handler)
    this.restored.set(accessory.UUID, accessory)
  }

  private createHandler(kind: AccessoryKind, init: AccessoryInit): BaseAccessory | undefined {
    if (isProbeKind(kind)) {
      return new ProbeAccessory({ ...init, kind })
    }
    switch (kind) {
      case 'dhw':
        return new DomesticHotWaterAccessory(init)
      case 'heating':
        return new SpaceHeatingAccessory(init)
      case 'power':
        return new PowerAccessory(init)
      case 'recirculation':
        return new RecirculationAccessory(init)
      case 'fault':
        return new FaultAccessory(init)
      default:
        this.log.warn(`${forLog(init.displayName)}: unknown kind; skipped`)
        return undefined
    }
  }

  /**
   * The UUID for an accessory.
   *
   * Seeded from the identity key alone. Nothing about the account, the
   * address or the display name is in it, so none of those can change a UUID
   * and orphan somebody's tile.
   */
  private uuidFor(accessory: ResolvedAccessory): string {
    return this.api.hap.uuid.generate(`${UUID_PREFIX}${accessoryIdentityKey(accessory)}`)
  }

  private modelFor(deviceId: string): string {
    const observation = this.session?.observationFor(deviceId)
    return observation === undefined || observation.family === 'UNKNOWN'
      ? DEFAULT_MODEL
      : `Navien ${formatFamily(observation.family)}`
  }

  // --- Fan-out ----------------------------------------------------------------

  private distribute(
    deviceId: string,
    observation: ChannelObservation,
    reason: RefreshReason,
  ): void {
    this.noteCloudReachable()
    const model = this.modelFor(deviceId)
    const firmware = this.session?.firmwareFor(deviceId)
    for (const handler of this.handlers.values()) {
      if (handler.deviceId === deviceId) {
        handler.updateIdentity({
          model,
          ...(firmware === undefined ? {} : { firmware }),
        })
        handler.applyObservation(observation, reason)
      }
    }
  }

  /**
   * The cloud has stopped answering.
   *
   * Logged here rather than in each accessory, unlike the LAN plugins in this
   * family. There is one connection for the whole account, so an outage is
   * one event: a warning per accessory would turn a single dropped socket
   * into eight identical lines saying the same thing.
   */
  private markAllUnreachable(error: unknown): void {
    const now = Date.now()
    const isNew = !this.cloudOffline
    this.cloudOffline = true
    if (isNew || now - this.lastOutageWarnAt > UNREACHABLE_REWARN_MS) {
      this.lastOutageWarnAt = now
      this.log.warn(describeOutage(error))
    } else {
      this.log.debug(describeOutage(error, { repeating: true }))
    }
    for (const handler of this.handlers.values()) {
      handler.noteUnreachable(error)
    }
  }

  /** One appliance has gone quiet while the broker is still connected. */
  private markDeviceUnreachable(deviceId: string): void {
    for (const handler of this.handlers.values()) {
      if (handler.deviceId === deviceId) {
        handler.noteUnreachable(new Error('the appliance has not reported recently'))
      }
    }
  }

  /**
   * The cloud is answering again.
   *
   * Every outage warns on its way in, so it gets a matching line on its way
   * out. Without one, a log shows the cloud failing and never recovering, and
   * an outage that healed reads exactly like one still in progress.
   */
  private noteCloudReachable(): void {
    if (!this.cloudOffline) {
      return
    }
    this.cloudOffline = false
    this.lastOutageWarnAt = 0
    this.log.info(`${MQTT_CHANNEL} recovered`)
  }

  // --- AccessoryHost ----------------------------------------------------------

  deviceFor(deviceId: string): ResolvedDevice | undefined {
    return this.devices.get(deviceId)
  }

  observationFor(deviceId: string): ChannelObservation | undefined {
    return this.disabled ? undefined : this.session?.observationFor(deviceId)
  }

  noteOptimisticWrite(deviceId: string, patch: Partial<ChannelObservation>): void {
    this.session?.applyOptimisticWrite(deviceId, patch)
  }

  /**
   * The commands an accessory may issue, with this plugin's rules applied.
   *
   * `readOnly` and the power-off guard live here. An accessory expresses an
   * intent and this decides whether it happens. Setpoint coalescing is
   * thermostat-only and is not enforced here.
   */
  control(deviceId: string): ControlIntent {
    const send = (spec: ControlSpec): Promise<void> => {
      if (this.options.readOnly) {
        return Promise.reject(new ControlRejectedError(`readOnly; ${spec.what} not sent`))
      }
      const session = this.session
      if (session === undefined) {
        return Promise.reject(new ControlRejectedError('session not running'))
      }
      return session.publishControl(deviceId, spec)
    }

    /**
     * The scale to encode a setpoint in.
     *
     * Read from the appliance rather than assumed. A Celsius unit takes
     * half-degree ticks and a Fahrenheit one takes whole degrees, so guessing
     * wrong sends a setpoint out by a factor of two.
     */
    const requireScale = (): TemperatureScale => {
      const observation = this.observationFor(deviceId)
      if (observation === undefined) {
        throw new ControlRejectedError('scale unknown')
      }
      return observation.scale
    }

    return {
      setPower: async (on) => {
        if (!on && !this.options.allowPowerOff) {
          throw new ControlRejectedError('power-off disabled (allowPowerOff is off)')
        }
        await send({
          command: Command.POWER,
          what: 'a power change',
          build: (input) => powerControl({ ...input, on }),
        })
      },
      setHeating: async (on) => {
        await send({
          command: Command.HEAT,
          what: 'a space-heating enable command',
          build: (input) => heatingEnableControl({ ...input, on }),
        })
      },
      setDomesticHotWaterSetpoint: async (native) => {
        const scale = requireScale()
        await send({
          command: Command.DHW_TEMPERATURE,
          what: 'a hot water setpoint',
          build: (input) => dhwSetpointControl({ ...input, native, scale }),
        })
      },
      setHeatingSetpoint: async (native) => {
        const scale = requireScale()
        await send({
          command: Command.HEAT_TEMPERATURE,
          what: 'a space-heating setpoint',
          build: (input) => heatingSetpointControl({ ...input, native, scale }),
        })
      },
      setRecirculation: async (on) => {
        await send({
          command: Command.ON_DEMAND,
          what: 'a recirculation command',
          build: (input) => onDemandControl({ ...input, on }),
        })
      },
    }
  }

  private diagnosticsIntervalMs(): number {
    const seconds = this.options.diagnosticsInterval
    return seconds > 0 ? seconds * 1_000 : 0
  }

  private startDiagnostics(): void {
    const interval = this.diagnosticsIntervalMs()
    if (interval <= 0 || this.diagnosticsTimer !== undefined) {
      return
    }
    try {
      this.emitDiagnostic(
        'info',
        this.diagnostics.snapshot('diagnostics.start', this.buildDiagnosticsReaders()),
      )
    } catch (error) {
      this.log.debug(`Failed to emit diagnostics start snapshot: ${describeError(error)}`)
    }
    this.diagnosticsTimer = setInterval(() => this.diagnosticsHeartbeat(), interval)
    this.diagnosticsTimer.unref?.()
  }

  private stopDiagnostics(): void {
    if (this.diagnosticsTimer === undefined) {
      return
    }
    try {
      this.emitDiagnostic(
        'info',
        this.diagnostics.snapshot('diagnostics.stop', this.buildDiagnosticsReaders()),
      )
    } catch (error) {
      this.log.debug(`Failed to emit diagnostics stop snapshot: ${describeError(error)}`)
    }
    clearInterval(this.diagnosticsTimer)
    this.diagnosticsTimer = undefined
  }

  private diagnosticsHeartbeat(): void {
    try {
      const report = this.diagnostics.buildHeartbeat(this.buildDiagnosticsReaders())
      this.emitDiagnostic('info', report)
      const health = report.lifecycle.health
      if (this.lastDiagnosticsHealth !== null && health !== this.lastDiagnosticsHealth) {
        const isDegraded = health === 'degraded'
        this.emitDiagnostic(isDegraded ? 'warn' : 'info', {
          ...report,
          msg: isDegraded ? 'health.degraded' : 'health.recovered',
        }, { concise: true })
      }
      this.lastDiagnosticsHealth = health
    } catch (error) {
      this.log.debug(`Diagnostics heartbeat failed: ${describeError(error)}`)
    }
  }

  private buildDiagnosticsReaders(): DiagnosticsReaders {
    const health = this.session?.health()
    const now = Date.now()
    return {
      devices: () => ({
        total: this.devices.size,
        online: health?.onlineDeviceIds.length ?? 0,
      }),
      mqttState: () => health?.mqttState ?? 'stopped',
      lastMqttEventAgeSec: () => {
        if (health?.lastMqttEventAt === null || health?.lastMqttEventAt === undefined) {
          return null
        }
        return Math.round((now - health.lastMqttEventAt) / 1_000)
      },
      tokenExpiresInSec: () => {
        if (health?.expiresAt === null || health?.expiresAt === undefined) {
          return null
        }
        return Math.round((health.expiresAt - now) / 1_000)
      },
      tokenLastRefreshAt: () => health?.lastRefreshAt ?? null,
      pollingCadenceSec: () => this.options.statusIntervalSec,
    }
  }

  private emitDiagnostic(
    level: 'info' | 'warn',
    report: DiagnosticsSnapshot,
    options: { concise?: boolean } = {},
  ): void {
    this.log[level](
      options.concise === true
        ? formatHealthTransitionLine(report)
        : formatDiagnosticLine(report),
    )
    if (this.options.structuredLogs) {
      this.log[level](JSON.stringify(report))
    }
  }
}

/**
 * One outage line for the whole account.
 *
 * A broker close already names NaviLink, so it is logged as-is. Anything else
 * is prefixed so a generic `socket hang up` still names the outage.
 */
function describeOutage(error: unknown, options: { repeating?: boolean } = {}): string {
  const detail = describeError(error)
  if (detail.startsWith('NaviLink ')) {
    return detail
  }
  return options.repeating === true
    ? `not answering (repeat): ${detail}`
    : `not answering: ${detail}`
}

/** Describe an error for the log, re-exported so the entry point can use it. */
export { describeError }
