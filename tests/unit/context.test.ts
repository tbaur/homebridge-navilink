/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Accessory context is untrusted input that the plugin wrote itself: it comes
 * back from disk on every start, possibly from a version that predates half
 * the fields. What it decides is whether a user keeps the rooms, scenes and
 * automations built on an accessory, so a cache it cannot fully read has to be
 * repaired rather than thrown away.
 */

import type { PlatformAccessory } from 'homebridge'

import { DEFAULT_MODEL } from '../../src/settings'
import type { AccessoryContext, ResolvedAccessory } from '../../src/types'
import { bindAccessoryContext, parseAccessoryContext } from '../../src/utils/context'
import { newAccessorySerialNumber } from '../../src/utils/serial'
import { DEVICE_ID, FakeAccessory } from '../helpers/hap'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function restored(context: Record<string, unknown> = {}): FakeAccessory {
  return new FakeAccessory('Boiler Hot Water', 'uuid:test', context)
}

function bind(
  accessory: FakeAccessory,
  overrides: Partial<ResolvedAccessory> = {},
  model = 'Navien NCB-240E',
): AccessoryContext {
  return bindAccessoryContext({
    accessory: accessory as unknown as PlatformAccessory,
    resolved: { kind: 'dhw', deviceId: DEVICE_ID, name: 'Boiler Hot Water', ...overrides },
    model,
  })
}

describe('parseAccessoryContext', () => {
  it('repairs a cache written before serial numbers were persisted', () => {
    // The alternative is discarding it, which re-registers the accessory and
    // costs the user the room and the automations attached to it.
    const parsed = parseAccessoryContext({ kind: 'dhw', deviceId: DEVICE_ID })!

    expect(parsed.kind).toBe('dhw')
    expect(parsed.deviceId).toBe(DEVICE_ID)
    expect(parsed.serialNumber).toMatch(UUID_V4)
  })

  it('names an appliance the cloud never described rather than leaving it blank', () => {
    expect(parseAccessoryContext({ kind: 'dhw', deviceId: DEVICE_ID })?.model).toBe(DEFAULT_MODEL)
    expect(parseAccessoryContext({ kind: 'dhw', deviceId: DEVICE_ID, model: '' })?.model)
      .toBe(DEFAULT_MODEL)
    expect(parseAccessoryContext({ kind: 'dhw', deviceId: DEVICE_ID, model: 7 })?.model)
      .toBe(DEFAULT_MODEL)
  })

  it('keeps everything a current cache already holds', () => {
    const parsed = parseAccessoryContext({
      kind: 'heating',
      deviceId: DEVICE_ID,
      model: 'Navien NCB-240E',
      serialNumber: 'already-issued',
      adoptedLegacyUuid: true,
      scale: 'fahrenheit',
    })

    expect(parsed).toEqual({
      kind: 'heating',
      deviceId: DEVICE_ID,
      model: 'Navien NCB-240E',
      serialNumber: 'already-issued',
      adoptedLegacyUuid: true,
      scale: 'fahrenheit',
    })
  })

  it('remembers the scale so a restart can publish display units before the first frame', () => {
    expect(parseAccessoryContext({ kind: 'dhw', deviceId: DEVICE_ID, scale: 'celsius' })?.scale)
      .toBe('celsius')
  })

  it('drops a scale it does not recognise instead of publishing an impossible range', () => {
    expect(parseAccessoryContext({ kind: 'dhw', deviceId: DEVICE_ID, scale: 'kelvin' })?.scale)
      .toBeUndefined()
  })

  it('assumes an accessory was not adopted unless the cache says it was', () => {
    expect(parseAccessoryContext({ kind: 'dhw', deviceId: DEVICE_ID })?.adoptedLegacyUuid)
      .toBe(false)
    expect(parseAccessoryContext({
      kind: 'dhw',
      deviceId: DEVICE_ID,
      adoptedLegacyUuid: 'yes',
    })?.adoptedLegacyUuid).toBe(false)
  })

  it('gives up on a context with no identity in it, because there is nothing to repair', () => {
    expect(parseAccessoryContext({ deviceId: DEVICE_ID })).toBeUndefined()
    expect(parseAccessoryContext({ kind: 'jacuzzi', deviceId: DEVICE_ID })).toBeUndefined()
    expect(parseAccessoryContext({ kind: 'dhw' })).toBeUndefined()
    expect(parseAccessoryContext({ kind: 'dhw', deviceId: 12 })).toBeUndefined()
  })

  it('gives up on a value that is not an object at all', () => {
    expect(parseAccessoryContext(undefined)).toBeUndefined()
    expect(parseAccessoryContext(null)).toBeUndefined()
    expect(parseAccessoryContext('dhw')).toBeUndefined()
    expect(parseAccessoryContext([])).toBeUndefined()
  })
})

describe('bindAccessoryContext', () => {
  it('keeps the serial number across a re-bind, so the Home app sees the same appliance', () => {
    const accessory = restored()

    const first = bind(accessory)
    const second = bind(accessory)

    expect(second.serialNumber).toBe(first.serialNumber)
  })

  it('issues a serial number to an accessory that has never had one', () => {
    const accessory = restored()

    expect(bind(accessory).serialNumber).toMatch(UUID_V4)
  })

  it('writes the identity into the object Homebridge persists, not just the one it returns', () => {
    const accessory = restored()

    const context = bind(accessory)

    expect(accessory.context).toMatchObject({ ...context })
  })

  it('leaves unrelated cached fields where they are', () => {
    // Homebridge hands back whatever was on disk, including keys written by a
    // version that is not this one.
    const accessory = restored({ somethingOlder: 'keep me' })

    bind(accessory)

    expect(accessory.context.somethingOlder).toBe('keep me')
  })

  it('takes the model the cloud now reports without disturbing identity', () => {
    const accessory = restored()
    const before = bind(accessory, {}, 'NaviLink appliance')

    const after = bind(accessory, {}, 'Navien NCB-240E')

    expect(after.model).toBe('Navien NCB-240E')
    expect(after.serialNumber).toBe(before.serialNumber)
  })

  it('carries a remembered scale and an adoption through a re-bind', () => {
    // Losing the adoption flag would offer the same accessory for adoption a
    // second time, under a third UUID.
    const accessory = restored()
    bind(accessory)
    accessory.context.scale = 'celsius'
    accessory.context.adoptedLegacyUuid = true

    const rebound = bind(accessory)

    expect(rebound.scale).toBe('celsius')
    expect(rebound.adoptedLegacyUuid).toBe(true)
  })

  it('rebuilds a cache it cannot read rather than trusting the parts it recognises', () => {
    const accessory = restored({ kind: 'jacuzzi', serialNumber: 'from-a-broken-cache' })

    const context = bind(accessory)

    expect(context.kind).toBe('dhw')
    expect(context.serialNumber).not.toBe('from-a-broken-cache')
    expect(context.serialNumber).toMatch(UUID_V4)
  })

  it('re-points an accessory at the appliance the configuration now names', () => {
    const accessory = restored()
    bind(accessory)

    const moved = bind(accessory, { kind: 'heating', deviceId: 'f6e5d4c3b2a1:2' })

    expect(moved).toMatchObject({ kind: 'heating', deviceId: 'f6e5d4c3b2a1:2' })
  })
})

describe('newAccessorySerialNumber', () => {
  it('never hands the same number to two accessories', () => {
    const issued = new Set(Array.from({ length: 500 }, () => newAccessorySerialNumber()))

    expect(issued.size).toBe(500)
  })

  it('is not derived from the appliance, which is the whole point of it', () => {
    // HomeKit shows SerialNumber in the Home app, so it reaches screenshots
    // and bug reports. The gateway MAC is the appliance's address in every
    // MQTT topic, so publishing it there would be handing out a capability.
    const mac = DEVICE_ID.split(':')[0]

    const first = parseAccessoryContext({ kind: 'dhw', deviceId: DEVICE_ID })!
    const second = parseAccessoryContext({ kind: 'heating', deviceId: DEVICE_ID })!

    expect(first.serialNumber).not.toContain(mac)
    expect(first.serialNumber).not.toBe(second.serialNumber)
  })
})

