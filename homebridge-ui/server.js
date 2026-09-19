/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Backend for the plugin's custom configuration UI.
 *
 * Runs in its own short-lived process, separate from Homebridge, and exists
 * only while a user has the settings page open. It reuses the compiled
 * discovery code from `dist/` rather than reimplementing it: a second
 * implementation of identity derivation would be a second thing to get
 * wrong, and the ids written here have to match exactly what the platform
 * expects.
 *
 * **This is the one process in the plugin that handles a password.** Three
 * rules follow from that, and none of them is optional:
 *
 * 1. The password is used for the sign-in of the request that carried it and
 *    is never stored here, never cached between requests and never written
 *    to a file by this process.
 * 2. Nothing from a sign-in response goes back to the page. The page gets
 *    appliances; the tokens and AWS credentials stay in this process and die
 *    with the request.
 * 3. The captured log handed back on failure is the plugin's own redacted
 *    output. It is still filtered again here, because a diagnostic line that
 *    reaches a browser can end up in a screenshot in a public issue.
 */

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils')

/** Shapes that must never reach the page, whatever produced them. */
const CREDENTIAL_SHAPED = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.?[A-Za-z0-9_-]*/g,
  /\b(?:ASIA|AKIA)[0-9A-Z]{16}\b/g,
  /X-Amz-(?:Security-Token|Signature|Credential)=[^&\s]*/gi,
]

class NaviLinkUiServer extends HomebridgePluginUiServer {
  constructor() {
    super()

    this.onRequest('/discover', (payload) => this.handleDiscover(payload))

    // Must be last: the page is not told the server is up until this fires.
    this.ready()
  }

  /**
   * Load the compiled plugin API.
   *
   * Deferred rather than required at module scope so that a missing build
   * produces an actionable message in the UI instead of the settings page
   * failing to open at all.
   */
  loadApi() {
    if (this.api === undefined) {
      try {
        // `ui-api` is the explicit contract for this process, not the whole plugin.
        this.api = require('../dist/ui-api')
      } catch (error) {
        throw new RequestError(
          'The plugin is not built. Run "npm run build" in the plugin directory.',
          { message: String(error && error.message ? error.message : error) },
        )
      }
    }
    return this.api
  }

  /** A logger that keeps UI-process output out of the Homebridge log. */
  makeLogger() {
    const messages = []
    const record = (level) => (message) => {
      if (messages.length < 200) {
        messages.push(`${level} ${scrub(message)}`)
      }
    }
    return {
      logger: {
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        debug: record('debug'),
      },
      messages,
    }
  }

  /**
   * Sign in and list what the account owns.
   *
   * The credentials arrive with the request rather than being read from the
   * saved configuration, so the button works before anything has been saved
   * and so a user can correct a typo without first writing it to disk.
   */
  async handleDiscover(payload) {
    const api = this.loadApi()
    const email = typeof payload?.email === 'string' ? payload.email.trim() : ''
    const password = typeof payload?.password === 'string' ? payload.password.trim() : ''

    if (!api.isValidEmail(email)) {
      throw new RequestError('Enter the email address for your NaviLink account.')
    }
    if (password.length === 0) {
      throw new RequestError('Enter your NaviLink password.')
    }
    if (password.length > api.MAX_PASSWORD_LENGTH) {
      throw new RequestError('That password is longer than this plugin accepts.')
    }

    const { logger, messages } = this.makeLogger()
    const discovery = new api.NaviLinkDiscovery({ log: logger })
    try {
      const devices = await discovery.discover(email, password)
      return { devices: devices.map((device) => describe(device)), log: messages }
    } catch (error) {
      // The message is the plugin's own, which is written not to quote a
      // credential; it is scrubbed anyway rather than trusted.
      throw new RequestError(scrub(messageOf(error)), { log: messages })
    }
  }
}

/**
 * Shape a discovered appliance for the page, with opt-in accessory defaults.
 *
 * Hot water is suggested because it is why people install this. Nothing else
 * is: discovery listing an appliance is not a request for six HomeKit tiles,
 * and space heating in particular is something a user should turn on
 * deliberately rather than inherit from pressing a button.
 */
function describe(device) {
  return {
    id: device.id,
    name: device.name,
    channel: device.channel,
    family: device.family,
    model: device.model,
    firmware: device.firmware || '',
    online: device.online === true,
    described: device.described !== false,
    capabilities: device.capabilities,
    suggested: {
      dhw: device.capabilities.dhw,
      heating: false,
      power: false,
      recirculation: false,
      fault: false,
      temperatureSensors: false,
      outdoorSensor: false,
    },
  }
}

function messageOf(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

/** Remove anything credential-shaped from a string bound for the browser. */
function scrub(value) {
  let text = typeof value === 'string' ? value : String(value)
  for (const pattern of CREDENTIAL_SHAPED) {
    text = text.replace(pattern, '[redacted]')
  }
  return text
}

// Homebridge starts this file as a child process and expects the instance to be
// constructed immediately.
;(() => new NaviLinkUiServer())()
