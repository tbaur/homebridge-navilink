/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Custom configuration UI. Signs in to NaviLink, lists the appliances on the
 * account and writes them into the plugin configuration, so a user never has
 * to find a MAC address or work out which channel a cascade uses.
 *
 * Appliance names and models arrive from the cloud and are therefore
 * untrusted. Every value from the cloud is inserted with textContent or as a
 * form value, never as HTML, which is why this file builds nodes instead of
 * assembling markup from strings.
 *
 * The password is the reason several things here are deliberate. It is held
 * in a form field and sent with the sign-in request; it is written into the
 * plugin configuration, because the plugin has to sign in again after a
 * restart and Navien offers no other credential; and it is never put into a
 * toast, a summary line or a data attribute, because those are what end up
 * in the screenshots attached to bug reports.
 *
 * A separate file rather than an inline script so that the linter and the
 * tests can reach it: it is shipped to users and it writes their
 * configuration.
 */
(() => {
  'use strict'

  const PLATFORM = 'NaviLink'

  /** Default status interval, matching DEFAULT_STATUS_INTERVAL_SEC in settings.ts. */
  const DEFAULT_INTERVAL_SEC = 120

  /** Every appliance known to the page, keyed by its stable identity. */
  const devices = new Map()

  /**
   * The accessories a card offers, in the order they appear.
   *
   * `requires` names the capability the appliance must report. An accessory
   * with no requirement is one every appliance can support.
   */
  const ACCESSORIES = [
    { key: 'dhw', label: 'Hot water thermostat', requires: 'dhw' },
    { key: 'heating', label: 'Heating thermostat', requires: 'heating' },
    { key: 'power', label: 'Power switch' },
    { key: 'recirculation', label: 'Recirculation switch', requires: 'recirculation' },
    { key: 'fault', label: 'Fault sensor' },
    { key: 'temperatureSensors', label: 'Temperature sensors (flow, return, in, out)' },
    { key: 'outdoorSensor', label: 'Outdoor temperature', requires: 'outdoorSensor' },
  ]

  /** Why an accessory is unavailable, shown on the disabled checkbox. */
  const UNAVAILABLE = {
    dhw: 'this appliance does not heat domestic hot water',
    heating: 'this appliance has no space-heating loop',
    recirculation: 'no recirculation pump is fitted',
    outdoorSensor: 'no outdoor sensor is fitted',
  }

  let platformConfig = { platform: PLATFORM, name: PLATFORM, devices: [], options: {} }
  let schemaFormVisible = false

  const byId = (id) => document.getElementById(id)
  const devicesEl = byId('devices')

  /** Build an element. Text is always set as text, never parsed as HTML. */
  function el(tag, attributes = {}, text) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === false) {
        continue
      }
      if (key === 'class') {
        node.className = value
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value)
      } else {
        node.setAttribute(key, value === true ? '' : String(value))
      }
    }
    if (text !== undefined) {
      node.textContent = text
    }
    return node
  }

  function describeError(error) {
    let text
    if (error && typeof error === 'object') {
      if (error.error) {
        text = String(error.error)
      } else if (error.message) {
        text = String(error.message)
      }
    }
    if (text === undefined) {
      text = String(error)
    }
    // A toast ends up in screenshots. The typed password must not.
    const password = byId('password').value
    if (typeof password === 'string' && password.length > 0) {
      text = text.split(password).join('[redacted]')
    }
    return text
  }

  // --- Configuration ------------------------------------------------------

  async function loadConfig() {
    const blocks = await homebridge.getPluginConfig()
    const existing = Array.isArray(blocks) && blocks.length > 0 ? blocks[0] : undefined
    platformConfig = Object.assign({ platform: PLATFORM, name: PLATFORM }, existing)
    platformConfig.platform = PLATFORM
    if (!Array.isArray(platformConfig.devices)) {
      platformConfig.devices = []
    }
    // Copied rather than aliased: `getPluginConfig` hands back the live
    // objects, and editing a control must not change them. The page pushes a
    // fresh copy into Homebridge; the footer Save is what writes it to disk.
    platformConfig.options = typeof platformConfig.options === 'object' && platformConfig.options !== null
      ? Object.assign({}, platformConfig.options)
      : {}

    byId('email').value = typeof platformConfig.email === 'string' ? platformConfig.email : ''
    byId('password').value = typeof platformConfig.password === 'string' ? platformConfig.password : ''
    loadPlatformOptions()

    // Configured appliances are shown before any sign-in, so a user can adjust
    // an existing setup without handing over a password again.
    for (const device of platformConfig.devices) {
      if (!device || typeof device.id !== 'string') {
        continue
      }
      devices.set(device.id, {
        id: device.id,
        name: device.name || device.id,
        channel: Number(device.channel) || 1,
        family: '',
        model: '',
        firmware: '',
        // Nothing is known about an appliance loaded from configuration until
        // a sign-in says otherwise, so every accessory stays available. The
        // alternative is greying out a control the user already chose.
        capabilities: { dhw: true, heating: true, recirculation: true, outdoorSensor: true },
        known: false,
        online: undefined,
        missing: false,
        selected: true,
        dhw: device.dhw !== false,
        heating: device.heating === true,
        power: device.power === true,
        recirculation: device.recirculation === true,
        fault: device.fault === true,
        temperatureSensors: device.temperatureSensors === true,
        outdoorSensor: device.outdoorSensor === true,
        // Kept so that a later push preserves settings this page does not
        // model. Without it, opening this page and saving would discard them.
        saved: device,
      })
    }
  }

  function mergeDiscovered(found) {
    for (const device of found) {
      const existing = devices.get(device.id)
      if (existing !== undefined) {
        // The cloud is authoritative about what an appliance is and what it
        // is fitted with, never about what the user called it or which
        // accessories they chose. The name is left alone whatever the cloud
        // now says: it is the name Siri answers to and the name every
        // automation refers to, and a rename in the NaviLink app must not
        // reach in and break those.
        existing.channel = device.channel
        existing.family = device.family
        existing.model = device.model
        existing.firmware = device.firmware
        existing.online = device.online !== false
        existing.missing = false
        if (device.described !== false) {
          applyDescribedCapabilities(existing, device)
        }
        continue
      }
      devices.set(device.id, Object.assign({
        id: device.id,
        name: device.name,
        channel: device.channel,
        family: device.family,
        model: device.model,
        firmware: device.firmware,
        capabilities: device.capabilities,
        known: device.described !== false,
        online: device.online !== false,
        missing: false,
        selected: true,
        saved: undefined,
      }, device.suggested))
    }
  }

  /** Apply live capabilities without greying a card that never described itself. */
  function applyDescribedCapabilities(existing, device) {
    existing.capabilities = device.capabilities
    existing.known = true
    for (const accessory of ACCESSORIES) {
      if (accessory.requires && device.capabilities[accessory.requires] !== true) {
        existing[accessory.key] = false
      }
    }
  }

  function toDevices() {
    const list = []
    for (const device of devices.values()) {
      if (!device.selected) {
        continue
      }
      const entry = Object.assign({}, device.saved, {
        id: device.id,
        name: device.name.trim() || device.id,
        channel: device.channel,
      })
      for (const accessory of ACCESSORIES) {
        const available = !accessory.requires || device.capabilities[accessory.requires] === true
        entry[accessory.key] = device[accessory.key] === true && available
      }
      list.push(entry)
    }
    return list
  }

  function loadPlatformOptions() {
    const interval = Number(platformConfig.options.statusIntervalSec) || DEFAULT_INTERVAL_SEC
    const select = byId('interval')
    // A hand-edited interval that is not one of the offered values is kept
    // rather than snapped to the nearest option, which would silently rewrite
    // a deliberate choice made in the advanced editor.
    if (!Array.from(select.options).some((option) => Number(option.value) === interval)) {
      select.append(el('option', { value: String(interval) }, `Every ${interval} seconds`))
    }
    select.value = String(interval)
    byId('read-only').checked = platformConfig.options.readOnly === true
    byId('allow-power-off').checked = platformConfig.options.allowPowerOff === true
    byId('accessory-prefix').value = typeof platformConfig.options.accessoryPrefix === 'string'
      ? platformConfig.options.accessoryPrefix
      : ''
    const diagnostics = Number(platformConfig.options.diagnosticsInterval) || 0
    byId('diagnostics-interval').value = String(diagnostics)
    syncDiagnosticsLabel()
    byId('structured-logs').checked = platformConfig.options.structuredLogs === true
  }

  /** Keep the slider's number in step with the thumb. 0 is Off. */
  function syncDiagnosticsLabel() {
    const seconds = Number(byId('diagnostics-interval').value) || 0
    byId('diagnostics-interval-value').textContent = seconds === 0 ? 'Off' : String(seconds)
  }

  /**
   * Fold the whole-install settings back into the configuration.
   *
   * Defaults are removed rather than written, so the saved file says what the
   * user chose and not what the plugin would have done anyway. That matters
   * most for `allowPowerOff`: an explicit `false` and an absent key behave
   * identically, and the absent one cannot be mistaken for a decision.
   */
  function applyPlatformOptions() {
    const interval = Number(byId('interval').value) || DEFAULT_INTERVAL_SEC
    if (interval === DEFAULT_INTERVAL_SEC) {
      delete platformConfig.options.statusIntervalSec
    } else {
      platformConfig.options.statusIntervalSec = interval
    }
    setFlag('readOnly', byId('read-only').checked === true)
    setFlag('allowPowerOff', byId('allow-power-off').checked === true)
    const prefix = byId('accessory-prefix').value.trim()
    if (prefix.length === 0) {
      delete platformConfig.options.accessoryPrefix
    } else {
      platformConfig.options.accessoryPrefix = prefix
    }
    const diagnostics = Number(byId('diagnostics-interval').value) || 0
    if (diagnostics === 0) {
      delete platformConfig.options.diagnosticsInterval
    } else {
      platformConfig.options.diagnosticsInterval = diagnostics
    }
    setFlag('structuredLogs', byId('structured-logs').checked === true)

    const email = byId('email').value.trim()
    const password = byId('password').value.trim()
    if (email.length > 0) {
      platformConfig.email = email
    } else {
      delete platformConfig.email
    }
    if (password.length > 0) {
      platformConfig.password = password
    } else {
      delete platformConfig.password
    }
  }

  function setFlag(key, enabled) {
    if (enabled) {
      platformConfig.options[key] = true
    } else {
      delete platformConfig.options[key]
    }
  }

  /**
   * Copy the form into Homebridge's in-memory plugin config.
   *
   * The purple footer Save writes that copy to disk. This page does not save
   * on its own: a second Save is easy to miss, and `savePluginConfig` is the
   * same action as that footer button.
   */
  async function pushConfig() {
    platformConfig.devices = toDevices()
    applyPlatformOptions()
    try {
      await homebridge.updatePluginConfig([platformConfig])
    } catch (error) {
      homebridge.toast.error(describeError(error), 'Could not update the configuration')
    }
  }

  function changed() {
    refreshSummary()
    void pushConfig()
  }

  function renderChanged() {
    render()
    void pushConfig()
  }

  // --- Rendering ----------------------------------------------------------

  function checkbox(label, checked, disabled, onChange) {
    const wrapper = el('div', { class: `nl-check${disabled === true ? ' is-unavailable' : ''}` })
    const id = `opt-${Math.random().toString(36).slice(2)}`
    const input = el('input', { type: 'checkbox', id })
    input.checked = checked
    input.disabled = disabled === true
    input.addEventListener('change', () => {
      onChange(input.checked)
      changed()
    })
    wrapper.append(input, el('label', { for: id }, label))
    return wrapper
  }

  function renderDevice(device) {
    const card = el('div', { class: `nl-card${device.selected ? ' is-selected' : ''}` })
    const head = el('div', { class: 'nl-card-head' })

    const include = el('input', { type: 'checkbox', class: 'mr-1' })
    include.checked = device.selected
    include.setAttribute('aria-label', 'Expose this appliance in HomeKit')
    include.addEventListener('change', () => {
      device.selected = include.checked
      renderChanged()
    })

    const title = el('div', { class: 'nl-card-title' })
    const nameInput = el('input', { type: 'text', class: 'form-control form-control-sm', maxlength: '64' })
    nameInput.value = device.name
    nameInput.addEventListener('input', () => {
      device.name = nameInput.value
      changed()
    })
    title.append(nameInput)
    head.append(include, title)

    if (device.channel > 1) {
      head.append(el('span', { class: 'nl-badge' }, `channel ${device.channel}`))
    }
    if (device.missing === true) {
      head.append(el('span', { class: 'nl-badge warn' }, 'not found'))
    } else if (device.online === false) {
      head.append(el('span', { class: 'nl-badge warn' }, 'offline'))
    }
    if (!device.known) {
      head.append(el('span', { class: 'nl-badge' }, 'from configuration'))
    }
    card.append(head)

    const meta = el('div', { class: 'nl-meta' })
    if (device.online === false && device.missing !== true) {
      meta.textContent = 'The cloud says this gateway is offline.'
    } else if (device.known) {
      meta.textContent = [device.model, device.firmware ? `firmware ${device.firmware}` : '']
        .filter(Boolean).join(' · ')
    } else {
      meta.textContent = 'Sign in to confirm what this appliance supports.'
    }
    card.append(meta)

    const options = el('div', { class: 'nl-options' })
    for (const accessory of ACCESSORIES) {
      const available = !accessory.requires || device.capabilities[accessory.requires] === true
      const label = available
        ? accessory.label
        : `${accessory.label} (${UNAVAILABLE[accessory.requires]})`
      options.append(checkbox(
        label,
        device[accessory.key] === true && available,
        !available,
        (value) => { device[accessory.key] = value },
      ))
    }
    card.append(options)
    return card
  }

  function refreshSummary() {
    const list = toDevices()
    let tiles = 0
    for (const entry of list) {
      for (const accessory of ACCESSORIES) {
        if (entry[accessory.key] !== true) {
          continue
        }
        // The temperature-sensor option is one tick and four tiles, so a
        // summary that counted it as one would understate the result by three.
        tiles += accessory.key === 'temperatureSensors' ? 4 : 1
      }
    }
    byId('summary').textContent = list.length === 0
      ? 'Nothing selected.'
      : `${list.length} appliance(s), ${tiles} HomeKit accessory(s).`
  }

  function render() {
    devicesEl.textContent = ''
    if (devices.size === 0) {
      devicesEl.append(el(
        'div',
        { class: 'nl-empty' },
        'No appliances yet. Sign in above to list what is on your account.',
      ))
    } else {
      const sorted = [...devices.values()].sort((left, right) => (
        left.id.localeCompare(right.id)
      ))
      for (const device of sorted) {
        devicesEl.append(renderDevice(device))
      }
    }
    refreshSummary()
  }

  // --- Actions ------------------------------------------------------------

  async function discover() {
    const email = byId('email').value.trim()
    const password = byId('password').value.trim()
    if (email.length === 0 || password.length === 0) {
      homebridge.toast.error('Enter your NaviLink email address and password.', 'Cannot sign in')
      return
    }
    homebridge.showSpinner()
    // The overlay can sit in the middle of a long list. The toast is drawn on
    // the Config UI chrome, so it stays visible.
    homebridge.toast.info('Signing in to NaviLink…', 'Please wait')
    try {
      const response = await homebridge.request('/discover', { email, password })
      const found = Array.isArray(response && response.devices) ? response.devices : []
      // Anything previously configured but missing now is flagged rather than
      // removed: an appliance that is merely offline should not disappear from
      // a configuration the user already built.
      for (const device of devices.values()) {
        if (!found.some((entry) => entry.id === device.id)) {
          device.missing = true
          device.online = false
        }
      }
      mergeDiscovered(found)
      renderChanged()
      if (found.length === 0) {
        homebridge.toast.warning(
          'The account signed in, but no appliance answered. Check that the gateway is '
          + 'powered and shows as connected in the NaviLink app.',
          'Nothing found',
        )
      } else {
        homebridge.toast.success(`Found ${found.length} appliance(s).`, 'Signed in')
      }
    } catch (error) {
      homebridge.toast.error(describeError(error), 'Sign-in failed')
    } finally {
      homebridge.hideSpinner()
    }
  }

  byId('discover').addEventListener('click', () => void discover())
  byId('email').addEventListener('input', () => changed())
  byId('password').addEventListener('input', () => changed())
  byId('interval').addEventListener('change', () => changed())
  byId('accessory-prefix').addEventListener('input', () => changed())
  byId('read-only').addEventListener('change', () => changed())
  byId('allow-power-off').addEventListener('change', () => changed())
  byId('diagnostics-interval').addEventListener('input', () => {
    syncDiagnosticsLabel()
    changed()
  })
  byId('diagnostics-interval').addEventListener('change', () => {
    syncDiagnosticsLabel()
    changed()
  })
  byId('structured-logs').addEventListener('change', () => changed())
  byId('toggle-json').addEventListener('click', () => {
    schemaFormVisible = !schemaFormVisible
    if (schemaFormVisible) {
      homebridge.showSchemaForm()
    } else {
      homebridge.hideSchemaForm()
    }
  })

  // The schema form is hidden by default: this page is the primary way to
  // configure the plugin, and showing both at once invites edits in one that
  // the other silently overwrites.
  homebridge.hideSchemaForm()

  loadConfig()
    .then(() => {
      render()
      return pushConfig()
    })
    .catch((error) => {
      homebridge.toast.error(describeError(error), 'Could not read the configuration')
      render()
    })
})()
