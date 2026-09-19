/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A HAP stand-in for accessory tests.
 *
 * Enough of HAP to exercise real accessory code without HAP-NodeJS: services
 * that remember their characteristics, characteristics that remember their
 * handlers and their last pushed value, and an accessory that behaves like a
 * restored one. Handlers are invoked directly, the way HomeKit would, so the
 * tests assert on the plugin's behaviour rather than on mock bookkeeping.
 */

import type { API, HAP, PlatformAccessory, Service } from 'homebridge'

import type { AccessoryHost, ControlIntent } from '../../src/devices/host'
import type {
  AccessoryContext,
  ChannelObservation,
  PluginLogger,
  ResolvedDevice,
} from '../../src/types'
import { bindAccessoryContext } from '../../src/utils/context'

/** A recorded characteristic. */
export class FakeCharacteristic {
  getHandler: (() => unknown) | undefined

  setHandler: ((value: unknown) => Promise<void> | void) | undefined

  /** Every value pushed with `updateCharacteristic`, in order. */
  readonly updates: unknown[] = []

  props: Record<string, unknown> = {}

  constructor(readonly name: string) {}

  onGet(handler: () => unknown): this {
    this.getHandler = handler
    return this
  }

  onSet(handler: (value: unknown) => Promise<void> | void): this {
    this.setHandler = handler
    return this
  }

  setProps(props: Record<string, unknown>): this {
    this.props = { ...this.props, ...props }
    return this
  }

  updateValue(value: unknown): this {
    this.updates.push(value)
    return this
  }

  /** Most recent pushed value. */
  get value(): unknown {
    return this.updates[this.updates.length - 1]
  }

  /** Invoke the read handler the way HomeKit would. */
  read(): unknown {
    if (this.getHandler === undefined) {
      throw new Error(`${this.name} has no read handler`)
    }
    return this.getHandler()
  }

  /** Invoke the write handler the way HomeKit would. */
  async write(value: unknown): Promise<void> {
    if (this.setHandler === undefined) {
      throw new Error(`${this.name} has no write handler`)
    }
    await this.setHandler(value)
  }
}

/**
 * A service that remembers its characteristics.
 *
 * Keys are coerced with `String`, because the characteristics below carry
 * their enum constants (`TargetHeatingCoolingState.HEAT`) and so have to be
 * String objects, which are never equal to the plain strings a test looks
 * them up with.
 */
export class FakeService {
  private readonly byName = new Map<string, FakeCharacteristic>()

  constructor(readonly UUID: string, public displayName?: string) {}

  /** An array, as HAP's own `Service.characteristics` is. */
  get characteristics(): FakeCharacteristic[] {
    return [...this.byName.values()]
  }

  getCharacteristic(name: unknown): FakeCharacteristic {
    const key = String(name)
    const existing = this.byName.get(key)
    if (existing !== undefined) {
      return existing
    }
    const created = new FakeCharacteristic(key)
    this.byName.set(key, created)
    return created
  }

  setCharacteristic(name: unknown, value: unknown): this {
    this.getCharacteristic(name).updates.push(value)
    return this
  }

  updateCharacteristic(name: unknown, value: unknown): this {
    this.getCharacteristic(name).updates.push(value)
    return this
  }

  /** The last value pushed to a characteristic. */
  lastValue(name: unknown): unknown {
    return this.byName.get(String(name))?.value
  }
}

/** Thrown in place of HAP's own, so tests can recognise a refused read. */
export class FakeHapStatusError extends Error {
  constructor(readonly hapStatus: number) {
    super(`HapStatusError:${hapStatus}`)
    this.name = 'HapStatusError'
  }
}

/**
 * Service constructors keyed by name.
 *
 * Each is a real constructor with a `UUID`, because `requireService` matches a
 * restored service by UUID and then constructs one if it finds none.
 */
function serviceConstructor(name: string): new (displayName?: string) => Service {
  const constructor = class extends FakeService {
    static readonly UUID = name

    constructor(displayName?: string) {
      super(name, displayName)
    }
  }
  Object.defineProperty(constructor, 'UUID', { value: name })
  return constructor as unknown as new (displayName?: string) => Service
}

const SERVICE_NAMES = [
  'AccessoryInformation',
  'ContactSensor',
  'Switch',
  'TemperatureSensor',
  'Thermostat',
] as const

/** HAP's `Characteristic` namespace, reduced to the names this plugin uses. */
export const characteristics = {
  ContactSensorState: Object.assign('ContactSensorState', {
    CONTACT_DETECTED: 0,
    CONTACT_NOT_DETECTED: 1,
  }),
  CurrentHeatingCoolingState: Object.assign('CurrentHeatingCoolingState', {
    OFF: 0,
    HEAT: 1,
    COOL: 2,
  }),
  CurrentTemperature: 'CurrentTemperature',
  FirmwareRevision: 'FirmwareRevision',
  HardwareRevision: 'HardwareRevision',
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  Name: 'Name',
  On: 'On',
  SerialNumber: 'SerialNumber',
  StatusActive: 'StatusActive',
  StatusFault: Object.assign('StatusFault', { NO_FAULT: 0, GENERAL_FAULT: 1 }),
  TargetHeatingCoolingState: Object.assign('TargetHeatingCoolingState', {
    OFF: 0,
    HEAT: 1,
    COOL: 2,
    AUTO: 3,
  }),
  TargetTemperature: 'TargetTemperature',
  TemperatureDisplayUnits: Object.assign('TemperatureDisplayUnits', {
    CELSIUS: 0,
    FAHRENHEIT: 1,
  }),
}

/** The HAP status code that makes the Home app show No Response. */
export const SERVICE_COMMUNICATION_FAILURE = -70402

export function fakeHap(): HAP {
  const services: Record<string, unknown> = {}
  for (const name of SERVICE_NAMES) {
    services[name] = serviceConstructor(name)
  }
  return {
    Service: services,
    Characteristic: characteristics,
    HapStatusError: FakeHapStatusError,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE },
    uuid: { generate: (seed: string) => `uuid:${seed}` },
  } as unknown as HAP
}

/** A restored `PlatformAccessory`, with services that persist across handlers. */
export class FakeAccessory {
  readonly services: FakeService[] = []

  /** Homebridge's own signature, so this can stand in for `platformAccessory`. */
  constructor(
    public displayName: string,
    public UUID = 'uuid:test',
    public context: Record<string, unknown> = {},
  ) {}

  getService(type: unknown): FakeService | undefined {
    const uuid = typeof type === 'string' ? type : (type as { UUID: string }).UUID
    return this.services.find((service) => service.UUID === uuid)
  }

  addService(service: unknown): FakeService {
    // Homebridge accepts either an instance or a constructor; both appear here.
    const instance = typeof service === 'function'
      ? new (service as new () => FakeService)()
      : service as FakeService
    this.services.push(instance)
    return instance
  }

  removeService(service: FakeService): void {
    const index = this.services.indexOf(service)
    if (index >= 0) {
      this.services.splice(index, 1)
    }
  }
}

export function fakeLogger(): PluginLogger & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    info: (message: string) => calls.push(`info ${message}`),
    warn: (message: string) => calls.push(`warn ${message}`),
    error: (message: string) => calls.push(`error ${message}`),
    debug: (message: string) => calls.push(`debug ${message}`),
  }
}

/** Every control call an accessory made, in order. */
export interface ControlCalls {
  power: boolean[]
  heating: boolean[]
  dhwSetpoint: number[]
  heatSetpoint: number[]
  recirculation: boolean[]
}

/** Everything a test needs to drive one accessory. */
export interface Harness {
  host: AccessoryHost
  accessory: PlatformAccessory
  context: AccessoryContext
  log: PluginLogger & { calls: string[] }
  control: ControlCalls
  /** Patches the accessory applied optimistically, in order. */
  optimistic: Partial<ChannelObservation>[]
  /** Set the observation the host reports for this device. */
  setObservation(next: ChannelObservation | undefined): void
  /** Make the next control call of any kind reject. */
  failNextControl(error: Error): void
  service(name: string): FakeService
}

const DEVICE_ID = 'a1b2c3d4e5f6:1'

const defaultDevice: ResolvedDevice = {
  id: DEVICE_ID,
  name: 'Boiler',
  channel: 1,
  dhw: true,
  heating: true,
  power: true,
  recirculation: true,
  fault: true,
  temperatureSensors: true,
  outdoorSensor: true,
}

/** Build a harness for one accessory. */
export function harness(overrides: {
  kind?: AccessoryContext['kind']
  displayName?: string
  observation?: ChannelObservation | undefined
  readOnly?: boolean
  device?: ResolvedDevice | undefined
  context?: Partial<AccessoryContext>
} = {}): Harness {
  const kind = overrides.kind ?? 'dhw'
  const accessory = new FakeAccessory(
    overrides.displayName ?? 'Boiler Hot Water',
    'uuid:test',
    { ...overrides.context },
  )
  const context = bindAccessoryContext({
    accessory: accessory as unknown as PlatformAccessory,
    resolved: { kind, deviceId: DEVICE_ID, name: accessory.displayName },
    model: 'Navien NCB',
  })
  const log = fakeLogger()
  const control: ControlCalls = {
    power: [],
    heating: [],
    dhwSetpoint: [],
    heatSetpoint: [],
    recirculation: [],
  }
  const optimistic: Partial<ChannelObservation>[] = []
  let observation = overrides.observation
  let nextFailure: Error | undefined

  /** Record a call, or reject with the failure a test armed. */
  const record = <T>(bucket: T[], value: T): Promise<void> => {
    if (nextFailure !== undefined) {
      const error = nextFailure
      nextFailure = undefined
      return Promise.reject(error)
    }
    bucket.push(value)
    return Promise.resolve()
  }

  const intent: ControlIntent = {
    setPower: (on) => record(control.power, on),
    setHeating: (on) => record(control.heating, on),
    setDomesticHotWaterSetpoint: (native) => record(control.dhwSetpoint, native),
    setHeatingSetpoint: (native) => record(control.heatSetpoint, native),
    setRecirculation: (on) => record(control.recirculation, on),
  }

  const hap = fakeHap()
  const host: AccessoryHost = {
    api: { hap } as unknown as API,
    hap,
    log,
    pluginVersion: '0.1.0',
    isReadOnly: overrides.readOnly === true,
    deviceFor: () => ('device' in overrides ? overrides.device : defaultDevice),
    observationFor: () => observation,
    control: () => intent,
    noteOptimisticWrite: (_deviceId, patch) => {
      optimistic.push(patch)
      if (observation !== undefined) {
        observation = { ...observation, ...patch }
      }
    },
  }

  return {
    host,
    accessory: accessory as unknown as PlatformAccessory,
    context,
    log,
    control,
    optimistic,
    setObservation: (next) => {
      observation = next
    },
    failNextControl: (error) => {
      nextFailure = error
    },
    service: (name: string) => {
      const found = accessory.getService(name)
      if (found === undefined) {
        throw new Error(`no ${name} service was created`)
      }
      return found
    },
  }
}

/** Everything an accessory constructor needs, from a harness. */
export function initFrom(built: Harness): {
  host: AccessoryHost
  accessory: PlatformAccessory
  deviceId: string
  displayName: string
  model: string
  serialNumber: string
} {
  return {
    host: built.host,
    accessory: built.accessory,
    deviceId: DEVICE_ID,
    displayName: built.accessory.displayName,
    model: built.context.model,
    serialNumber: built.context.serialNumber,
  }
}

/** A complete observation of a healthy combi, overridable per test. */
export function observation(
  overrides: Partial<ChannelObservation> = {},
): ChannelObservation {
  return {
    channelNumber: 1,
    family: 'NCB',
    scale: 'fahrenheit',
    unitCount: 1,
    power: true,
    heating: true,
    heatingActive: false,
    heatingSupported: true,
    dhwSetpoint: 120,
    dhwMin: 86,
    dhwMax: 140,
    heatSetpoint: 110,
    heatMin: 90,
    heatMax: 140,
    dhwOutlet: 88,
    dhwInlet: 84,
    heatSupply: 95,
    heatReturn: 97,
    recirculationEquipped: true,
    recirculationOn: false,
    readings: { errorCode: 0, subErrorCode: 0 },
    observedAt: 1_700_000_000_000,
    ...overrides,
  }
}

export { DEVICE_ID }
