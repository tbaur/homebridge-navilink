/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The two module boundaries a user never sees but every install depends on:
 * the name the platform is registered under, and the surface the
 * configuration UI is allowed to reach. A mistake in the first makes
 * Homebridge load nothing at all, with no error to explain it; a gap in the
 * second breaks the settings page, which runs in another process and is not
 * typechecked against this code.
 */

import type { API } from 'homebridge'

import { makeDeviceId, parseDeviceId } from '../../src/api/identity'
import register from '../../src/index'
import { NaviLinkPlatform } from '../../src/platform'
import { PLATFORM_NAME, PLUGIN_NAME } from '../../src/settings'
import * as uiApi from '../../src/ui-api'

describe('the plugin entry point', () => {
  it('registers the platform under the name the config schema uses', () => {
    const registerPlatform = jest.fn()

    register({ registerPlatform } as unknown as API)

    expect(registerPlatform).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, NaviLinkPlatform)
  })

  it('uses the package name, which is what Homebridge looks the plugin up by', () => {
    const manifest = require('../../package.json') as { name: string }
    expect(PLUGIN_NAME).toBe(manifest.name)
  })

  it('matches the platform name in the config schema, or the settings page is orphaned', () => {
    const schema = require('../../config.schema.json') as {
      pluginAlias: string
      pluginType: string
    }
    expect(schema.pluginAlias).toBe(PLATFORM_NAME)
    expect(schema.pluginType).toBe('platform')
  })
})

describe('the surface the settings page may use', () => {
  it('exports everything the UI server imports', () => {
    // The UI runs in a separate process and is not typechecked against this
    // code, so a missing export is only found by opening the settings page.
    expect(typeof uiApi.NaviLinkDiscovery).toBe('function')
    expect(typeof uiApi.isValidEmail).toBe('function')
    expect(typeof uiApi.resolveStatusIntervalSec).toBe('function')
    expect(uiApi.PLATFORM_NAME).toBe(PLATFORM_NAME)
    expect(typeof uiApi.DEFAULT_STATUS_INTERVAL_SEC).toBe('number')
    expect(typeof uiApi.MIN_STATUS_INTERVAL_SEC).toBe('number')
    expect(typeof uiApi.MAX_STATUS_INTERVAL_SEC).toBe('number')
  })

  it('does not export the session, which must not run in a settings process', () => {
    // It holds a connection open, refreshes credentials on a timer and
    // retries on failure. A process that exists only while a browser tab is
    // open should be able to do none of those.
    expect(uiApi).not.toHaveProperty('NaviLinkSession')
    expect(uiApi).not.toHaveProperty('NaviLinkPlatform')
  })

  it('shares the identity helpers rather than letting the page reimplement them', () => {
    // The ids the page writes have to match what the platform derives. Two
    // implementations would eventually disagree, and the symptom would be
    // duplicated tiles rather than an error.
    const id = makeDeviceId('a1b2c3d4e5f6', 1)
    expect(parseDeviceId(id)).toEqual({ mac: 'a1b2c3d4e5f6', channel: 1 })
  })
})
