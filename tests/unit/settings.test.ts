/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import {
  DEFAULT_MODEL,
  MAX_PASSWORD_LENGTH,
  PLATFORM_NAME,
  PLUGIN_NAME,
  readPluginVersion,
  UNKNOWN_PLUGIN_VERSION,
} from '../../src/settings'

describe('plugin identity', () => {
  it('matches the names Homebridge loads the platform under', () => {
    expect(PLUGIN_NAME).toBe('homebridge-navilink')
    expect(PLATFORM_NAME).toBe('NaviLink')
    expect(DEFAULT_MODEL).toBe('NaviLink appliance')
  })

  it('reads the version HomeKit shows as FirmwareRevision', () => {
    expect(readPluginVersion()).toBe('0.1.0')
    expect(readPluginVersion()).not.toBe(UNKNOWN_PLUGIN_VERSION)
  })

  it('caps a password at the same length the schema and the settings page use', () => {
    expect(MAX_PASSWORD_LENGTH).toBe(256)
  })
})
