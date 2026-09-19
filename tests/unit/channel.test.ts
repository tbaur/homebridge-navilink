/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Decoded against the recorded frames rather than against hand-written
 * objects, so these assertions describe what an NCB-240E actually sends. The
 * appliance behind the fixtures has no recirculation pump and no outdoor
 * sensor, which is what makes it the right one to test absent hardware with.
 */

import {
  decodeChannel,
  familyOf,
  formatFamily,
  hasDomesticHotWater,
  hasSpaceHeating,
  isFlagOn,
  parseChannelInfo,
  parseChannelStatus,
  scaleOf,
} from '../../src/api/channel'
import channelInfoFrame from '../fixtures/ncb-240e.channelinfo.json'
import channelStatusFrame from '../fixtures/ncb-240e.channelstatus.json'

const info = parseChannelInfo(channelInfoFrame)[0]!
const status = parseChannelStatus(channelStatusFrame)!

describe('parseChannelInfo', () => {
  it('finds the channel and its description', () => {
    expect(parseChannelInfo(channelInfoFrame)).toHaveLength(1)
    expect(info.channelNumber).toBe(1)
    expect(info.raw.setupDHWTempMin).toBe(86)
  })

  it('de-duplicates a channel repeated across a frame', () => {
    // A gateway can repeat a channel, and two entries would become two
    // accessories for one appliance.
    const doubled = {
      response: {
        channelInfo: {
          channelList: [
            { channelNumber: 1, channel: { unitType: 2 } },
            { channelNumber: 1, channel: { unitType: 2 } },
          ],
        },
      },
    }

    expect(parseChannelInfo(doubled)).toHaveLength(1)
  })

  it('returns nothing for a frame that is not a channel list', () => {
    expect(parseChannelInfo({})).toEqual([])
    expect(parseChannelInfo(undefined)).toEqual([])
    expect(parseChannelInfo({ response: { channelInfo: { channelList: 'nope' } } })).toEqual([])
  })

  it('skips an entry with no channel number rather than attaching it to channel 1', () => {
    const frame = {
      response: {
        channelInfo: {
          channelList: [
            { channel: { unitType: 2 } },
            { channelNumber: 2, channel: { unitType: 2 } },
          ],
        },
      },
    }

    const parsed = parseChannelInfo(frame)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.channelNumber).toBe(2)
  })
})

describe('parseChannelStatus', () => {
  it('finds the channel state', () => {
    expect(status.channelNumber).toBe(1)
    expect(status.raw.DHWSettingTemp).toBe(120)
  })

  it('returns nothing for a frame with no channel status', () => {
    expect(parseChannelStatus({ response: {} })).toBeUndefined()
  })

  it('returns nothing when the wrapper has no channel number', () => {
    expect(parseChannelStatus({
      response: { channelStatus: { channel: { DHWSettingTemp: 120 } } },
    })).toBeUndefined()
  })
})

describe('family decoding', () => {
  it('reads the NCB family from unitType', () => {
    expect(familyOf(info.raw)).toBe('NCB')
  })

  it('does not invent a family it does not know', () => {
    expect(familyOf({ unitType: 999 })).toBe('UNKNOWN')
    expect(familyOf({})).toBe('UNKNOWN')
  })

  it('spells a family the same way in HomeKit and on the settings page', () => {
    expect(formatFamily('NCB_H')).toBe('NCB-H')
    expect(formatFamily('CAS_NPE2')).toBe('CAS-NPE2')
  })

  it('knows which families do which jobs', () => {
    expect(hasDomesticHotWater('NCB')).toBe(true)
    expect(hasSpaceHeating('NCB')).toBe(true)
    // A tankless water heater has no space-heating loop at all.
    expect(hasSpaceHeating('NPE')).toBe(false)
    expect(hasDomesticHotWater('NPE')).toBe(true)
    // A boiler has no domestic hot water.
    expect(hasDomesticHotWater('NHB')).toBe(false)
    expect(hasSpaceHeating('NHB')).toBe(true)
    // NVW is a tank water heater. A real heat range would otherwise put a
    // heating thermostat on hardware that has no loop.
    expect(hasSpaceHeating('NVW')).toBe(false)
    expect(hasSpaceHeating('CAS_NVW')).toBe(false)
    expect(hasDomesticHotWater('NVW')).toBe(true)
  })
})

describe('isFlagOn', () => {
  it('treats 1 as on and everything else as off', () => {
    // Confirmed across several unrelated fields on one appliance: 1 while on,
    // 2 for every feature that is not fitted or not enabled.
    expect(isFlagOn(1)).toBe(true)
    expect(isFlagOn(2)).toBe(false)
    expect(isFlagOn(0)).toBe(false)
    expect(isFlagOn(undefined)).toBe(false)
  })
})

describe('scaleOf', () => {
  it('reads Fahrenheit from the fixture', () => {
    expect(scaleOf(info)).toBe('fahrenheit')
  })
})

describe('decodeChannel', () => {
  const observation = decodeChannel({ info, status, now: 1_700_000_000_000 })!

  it('produces an observation', () => {
    expect(observation).toBeDefined()
    expect(observation.channelNumber).toBe(1)
    expect(observation.family).toBe('NCB')
    expect(observation.scale).toBe('fahrenheit')
    expect(observation.observedAt).toBe(1_700_000_000_000)
  })

  it('reads the power and heating flags', () => {
    expect(observation.power).toBe(true)
    expect(observation.heating).toBe(true)
  })

  it('recognises a real space-heating loop on this combi', () => {
    expect(observation.heatingSupported).toBe(true)
  })

  it('rejects the placeholder heating range a water heater reports', () => {
    // An NPE-2 answers the same frames as a combi and fills the heating
    // fields rather than omitting them, reporting min and max both as 32.
    // Reading that as a one-degree range puts a working-looking heating
    // thermostat on an appliance with no radiators attached to it.
    const placeholder = decodeChannel({
      info: { ...info, raw: { ...info.raw, setupHeatTempMin: 32, setupHeatTempMax: 32 } },
      status,
      now: 1_700_000_000_000,
    })

    expect(placeholder?.heatingSupported).toBe(false)
  })

  it('rejects a loop the installer never commissioned', () => {
    const uncommissioned = decodeChannel({
      info: { ...info, raw: { ...info.raw, heatControl: 2 } },
      status,
      now: 1_700_000_000_000,
    })

    expect(uncommissioned?.heatingSupported).toBe(false)
  })

  it('rejects a heating loop on a family that cannot have one', () => {
    const tankless = decodeChannel({
      info: { ...info, raw: { ...info.raw, unitType: 1 } },
      status: { ...status, raw: { ...status.raw, unitType: 1 } },
      now: 1_700_000_000_000,
    })

    expect(tankless?.heatingSupported).toBe(false)
  })

  it('reads both setpoints and both installer ranges', () => {
    expect(observation.dhwSetpoint).toBe(120)
    expect(observation.dhwMin).toBe(86)
    expect(observation.dhwMax).toBe(140)
    expect(observation.heatSetpoint).toBe(110)
    expect(observation.heatMin).toBe(90)
    expect(observation.heatMax).toBe(140)
  })

  it('reads the four probes this appliance has', () => {
    expect(observation.dhwOutlet).toBe(88)
    expect(observation.dhwInlet).toBe(84)
    expect(observation.heatSupply).toBe(95)
    expect(observation.heatReturn).toBe(97)
  })

  it('reports the absent outdoor sensor as absent, not as zero', () => {
    // The appliance sends 0 for a probe it does not have. Publishing that
    // would put -17.8 °C on a HomeKit tile for a sensor that is not fitted,
    // and an automation could act on it.
    expect(observation.outdoor).toBeUndefined()
    expect('outdoor' in observation).toBe(false)
  })

  it('reports no recirculation pump on hardware that has none', () => {
    expect(observation.recirculationEquipped).toBe(false)
    expect(observation.recirculationOn).toBe(false)
  })

  it('reads the fault codes', () => {
    expect(observation.readings.errorCode).toBe(0)
    expect(observation.readings.subErrorCode).toBe(0)
    expect(observation.readings.controllerVersion).toBe(3587)
  })

  it('refuses to decode before the appliance has reported its scale', () => {
    // Every temperature in a status frame is unreadable without the scale, so
    // a partial observation would be wrong rather than incomplete.
    const unknownScale = { channelNumber: 1, raw: { ...info.raw, temperatureType: 0 } }

    expect(decodeChannel({ info: unknownScale, status })).toBeUndefined()
  })

  it('reads a Celsius appliance in half-degree ticks', () => {
    const celsius = { channelNumber: 1, raw: { ...info.raw, temperatureType: 1 } }

    // 120 ticks is 60.0 °C, not 120 °C.
    expect(decodeChannel({ info: celsius, status })?.dhwSetpoint).toBe(60)
  })

  it('bounds a unit count a malformed frame could inflate', () => {
    // It decides how many units a status request asks for.
    const huge = { channelNumber: 1, raw: { ...info.raw, unitCount: 100_000 } }

    expect(decodeChannel({ info: huge, status })?.unitCount).toBeLessThanOrEqual(32)
  })

  it('recognises a recirculation pump when one is fitted', () => {
    const equipped = { channelNumber: 1, raw: { ...info.raw, onDemandUse: 1 } }
    const running = { channelNumber: 1, raw: { ...status.raw, onDemandUseFlag: 1 } }

    const decoded = decodeChannel({ info: equipped, status: running })!

    expect(decoded.recirculationEquipped).toBe(true)
    expect(decoded.recirculationOn).toBe(true)
  })

  it('surfaces a fault code', () => {
    const faulted = {
      channelNumber: 1,
      raw: {
        ...status.raw,
        unitInfo: { unitStatusList: [{ errorCode: 3, subErrorCode: 12 }] },
      },
    }

    const decoded = decodeChannel({ info, status: faulted })!

    expect(decoded.readings.errorCode).toBe(3)
    expect(decoded.readings.subErrorCode).toBe(12)
  })

  it('opens the fault on a later cascade unit, not only the first', () => {
    const cascade = {
      channelNumber: 1,
      raw: {
        ...status.raw,
        unitInfo: {
          unitStatusList: [
            { errorCode: 0, subErrorCode: 0, controllerVersion: 3587 },
            { errorCode: 21, subErrorCode: 2, controllerVersion: 3588 },
          ],
        },
      },
    }

    const decoded = decodeChannel({ info, status: cascade })!

    expect(decoded.readings.errorCode).toBe(21)
    expect(decoded.readings.subErrorCode).toBe(2)
    expect(decoded.readings.controllerVersion).toBe(3587)
  })

  it('falls back to the per-unit probes when the averages are missing', () => {
    // A cascade reports averages; a single appliance has been seen reporting
    // only the per-unit values on some firmware.
    const perUnitOnly = {
      channelNumber: 1,
      raw: {
        ...status.raw,
        avgOutletTemp: undefined,
        unitInfo: { unitStatusList: [{ errorCode: 0, subErrorCode: 0, currentOutletTemp: 91 }] },
      },
    }

    expect(decodeChannel({ info, status: perUnitOnly })?.dhwOutlet).toBe(91)
  })
})
