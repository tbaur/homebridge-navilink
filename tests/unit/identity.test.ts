/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Identity is what carries a user's rooms, scenes and automations from one
 * restart to the next, so anything that quietly changes it empties their Home
 * app. It has to survive a rename, a re-paired gateway and a changed account
 * email, and it has to refuse a malformed value outright rather than build
 * something stable-looking on top of it.
 */

import { MAX_CHANNEL, MIN_CHANNEL } from '../../src/settings'
import {
  accessoryIdentityKey,
  hasAccessoryIdentity,
  makeDeviceId,
  normalizeMac,
  parseDeviceId,
} from '../../src/api/identity'
import type { ResolvedAccessory } from '../../src/types'

const MAC = 'a1b2c3d4e5f6'

describe('normalizeMac', () => {
  it('accepts the separated spelling a hand-edited configuration will use', () => {
    // Rejecting the form a person would naturally type is a puzzle rather
    // than a help.
    expect(normalizeMac('A1:B2:C3:D4:E5:F6')).toBe(MAC)
    expect(normalizeMac('a1-b2-c3-d4-e5-f6')).toBe(MAC)
    expect(normalizeMac('  A1B2C3D4E5F6  ')).toBe(MAC)
  })

  it('leaves the cloud spelling exactly as it found it', () => {
    expect(normalizeMac(MAC)).toBe(MAC)
  })

  it('refuses to guess at something that is not an address', () => {
    // A guess becomes a stable-looking identity for an appliance that will
    // never answer, which reads as a device that is permanently offline.
    expect(normalizeMac('a1b2c3d4e5')).toBeUndefined()
    expect(normalizeMac('a1b2c3d4e5f6ab')).toBeUndefined()
    expect(normalizeMac('g1b2c3d4e5f6')).toBeUndefined()
    expect(normalizeMac('')).toBeUndefined()
    expect(normalizeMac(undefined)).toBeUndefined()
    expect(normalizeMac(281_474_976_710_655)).toBeUndefined()
  })
})

describe('makeDeviceId and parseDeviceId', () => {
  it('round-trips a gateway and a channel', () => {
    const id = makeDeviceId(MAC, 1)

    expect(id).toBe('a1b2c3d4e5f6:1')
    expect(parseDeviceId(id)).toEqual({ mac: MAC, channel: 1 })
  })

  it('round-trips every channel a cascade can use', () => {
    for (const channel of [MIN_CHANNEL, 2, 9, MAX_CHANNEL]) {
      expect(parseDeviceId(makeDeviceId(MAC, channel))).toEqual({ mac: MAC, channel })
    }
  })

  it('writes the cloud spelling even when it was handed the separated one', () => {
    expect(makeDeviceId('A1B2C3D4E5F6', 1)).toBe('a1b2c3d4e5f6:1')
  })

  it('reads an id somebody typed with colons in the MAC', () => {
    // The channel is taken from the last colon, so the separators inside the
    // address do not confuse it.
    expect(parseDeviceId('a1:b2:c3:d4:e5:f6:2')).toEqual({ mac: MAC, channel: 2 })
  })

  it('rejects a malformed id instead of returning half an identity', () => {
    expect(parseDeviceId('a1b2c3d4e5f6')).toBeUndefined()
    expect(parseDeviceId(':1')).toBeUndefined()
    expect(parseDeviceId('a1b2c3d4e5f6:')).toBeUndefined()
    expect(parseDeviceId('a1b2c3d4e5f6:one')).toBeUndefined()
    expect(parseDeviceId('a1b2c3d4e5f6:1.5')).toBeUndefined()
    expect(parseDeviceId('zzzzzzzzzzzz:1')).toBeUndefined()
    expect(parseDeviceId('')).toBeUndefined()
    expect(parseDeviceId(undefined)).toBeUndefined()
    expect(parseDeviceId({ mac: MAC, channel: 1 })).toBeUndefined()
  })

  it('rejects a channel outside the range a gateway can address', () => {
    expect(parseDeviceId(makeDeviceId(MAC, MIN_CHANNEL - 1))).toBeUndefined()
    expect(parseDeviceId(makeDeviceId(MAC, MAX_CHANNEL + 1))).toBeUndefined()
    expect(parseDeviceId(makeDeviceId(MAC, -1))).toBeUndefined()
  })
})

describe('accessoryIdentityKey', () => {
  it('does not change when the user renames the accessory', () => {
    // A key that moved with the display name would take the room, the scenes
    // and every automation with it the first time somebody tidied up a name.
    const original: ResolvedAccessory = { kind: 'dhw', deviceId: 'a1b2c3d4e5f6:1', name: 'Boiler Hot Water' }
    const renamed: ResolvedAccessory = { ...original, name: 'Upstairs Hot Water' }

    expect(accessoryIdentityKey(renamed)).toBe(accessoryIdentityKey(original))
  })

  it('gives each accessory on one appliance its own identity', () => {
    const hotWater = accessoryIdentityKey({ kind: 'dhw', deviceId: 'a1b2c3d4e5f6:1' })
    const heating = accessoryIdentityKey({ kind: 'heating', deviceId: 'a1b2c3d4e5f6:1' })

    expect(hotWater).not.toBe(heating)
  })

  it('tells the same accessory on two appliances apart', () => {
    expect(accessoryIdentityKey({ kind: 'dhw', deviceId: 'a1b2c3d4e5f6:1' }))
      .not.toBe(accessoryIdentityKey({ kind: 'dhw', deviceId: 'f6e5d4c3b2a1:1' }))
  })

  it('tells two channels of one cascade apart', () => {
    expect(accessoryIdentityKey({ kind: 'dhw', deviceId: makeDeviceId(MAC, 1) }))
      .not.toBe(accessoryIdentityKey({ kind: 'dhw', deviceId: makeDeviceId(MAC, 2) }))
  })
})

describe('hasAccessoryIdentity', () => {
  const accessory: ResolvedAccessory = {
    kind: 'dhw',
    deviceId: 'a1b2c3d4e5f6:1',
    name: 'Boiler Hot Water',
  }

  it('recognises a cached accessory as the one the configuration describes', () => {
    expect(hasAccessoryIdentity({ kind: 'dhw', deviceId: 'a1b2c3d4e5f6:1' }, accessory)).toBe(true)
  })

  it('does not care what the cached accessory was called', () => {
    const cached: Record<string, unknown> = {
      kind: 'dhw',
      deviceId: 'a1b2c3d4e5f6:1',
      name: 'Something Else',
    }

    expect(hasAccessoryIdentity(cached, accessory)).toBe(true)
  })

  it('refuses a cache that describes a different job or a different appliance', () => {
    expect(hasAccessoryIdentity({ kind: 'heating', deviceId: 'a1b2c3d4e5f6:1' }, accessory))
      .toBe(false)
    expect(hasAccessoryIdentity({ kind: 'dhw', deviceId: 'f6e5d4c3b2a1:1' }, accessory))
      .toBe(false)
  })

  it('refuses a context with nothing in it, which is how an empty cache arrives', () => {
    expect(hasAccessoryIdentity({}, accessory)).toBe(false)
    expect(hasAccessoryIdentity({ kind: undefined, deviceId: undefined }, accessory)).toBe(false)
  })
})
