/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * This process is handed the user's NaviLink password and it answers a
 * browser, which makes it the one place in the plugin where a credential and
 * an HTML page meet. Everything asserted here is about that meeting: a typo is
 * refused before anything is sent to Navien, a sign-in failure comes back as
 * an explanation rather than as whatever the cloud said, and a token, an AWS
 * key id or a signed query string is unrecognisable by the time it reaches the
 * page. A diagnostic line that reaches a browser ends up in a screenshot in a
 * public issue, and no later fix takes it back.
 *
 * The module exports nothing and constructs itself on require, so it is driven
 * the way Homebridge drives it: start it, then call the handler it registered.
 */

import { isValidEmail } from '../../src/utils/validators'
import {
  FAKE_AKIA_KEY,
  FAKE_ASIA_KEY,
  FAKE_JWT,
  FAKE_SIGNED_QUERY,
  FAKE_STS_TOKEN,
} from '../helpers/secrets'

/** What `dist/ui-api` hands over for each appliance on the account. */
interface Appliance {
  id: string
  name: string
  mac: string
  channel: number
  family: string
  model: string
  firmware?: string
  online?: boolean
  described?: boolean
  capabilities: {
    dhw: boolean
    heating: boolean
    recirculation: boolean
    outdoorSensor: boolean
  }
}

/** The logger the server hands to discovery, whose output the page is shown. */
interface CaptureLog {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  debug: (message: string) => void
}

/** What the page receives on success. */
interface DiscoverResult {
  devices: {
    id: string
    name: string
    channel: number
    family: string
    model: string
    firmware: string
    online: boolean
    described: boolean
    capabilities: Record<string, boolean>
    suggested: Record<string, boolean>
  }[]
  log: string[]
}

/** What the page receives on failure, once Homebridge has forwarded it. */
interface PageError extends Error {
  requestError?: { log?: string[] }
}

type RequestHandler = (payload: unknown) => Promise<unknown>

/** Credential shapes that really do turn up in this plugin's own output. */
const TOKEN = FAKE_JWT
const KEY_ID = FAKE_ASIA_KEY
const LONG_TERM_KEY_ID = FAKE_AKIA_KEY
const SIGNED_QUERY = FAKE_SIGNED_QUERY

const routes = new Map<string, RequestHandler>()
const started = { readyCalls: 0, routesAtReady: [] as string[] }

/** Stands in for the base class Homebridge provides in the UI process. */
class FakeUiServer {
  onRequest(path: string, handler: RequestHandler): void {
    routes.set(path, handler)
  }

  ready(): void {
    started.readyCalls += 1
    // Captured at the moment of the call: the page is told nothing until this
    // fires, so a route registered afterwards is a route the page can miss.
    started.routesAtReady = [...routes.keys()]
  }
}

/** Matches the real class: the page reads `message`, Homebridge the rest. */
class FakeRequestError extends Error {
  readonly requestError: unknown

  constructor(message: string, requestError?: unknown) {
    super(message)
    this.name = 'RequestError'
    this.requestError = requestError
  }
}

jest.mock('@homebridge/plugin-ui-utils', () => ({
  // Getters rather than values: `resetMocks` strips an implementation out of a
  // factory, and the server subclasses whatever this hands back, so it has to
  // survive being re-read for every test.
  get HomebridgePluginUiServer() {
    return FakeUiServer
  },
  get RequestError() {
    return FakeRequestError
  },
}))

function appliance(overrides: Partial<Appliance> = {}): Appliance {
  return {
    id: 'a1b2c3d4e5f6:1',
    name: 'Zone One',
    mac: 'a1b2c3d4e5f6',
    channel: 1,
    family: 'combi-boiler',
    model: 'NCB-240E',
    firmware: '4352',
    online: true,
    described: true,
    capabilities: { dhw: true, heating: true, recirculation: true, outdoorSensor: false },
    ...overrides,
  }
}

/**
 * A stand-in for the compiled plugin API.
 *
 * `isValidEmail` is the real one rather than a lookalike: the point of the
 * check is that the UI and the platform agree about what an address is, and a
 * second spelling of the rule here would hide the day they stop agreeing.
 */
function makeApi(onDiscover?: (log: CaptureLog) => Appliance[] | Promise<Appliance[]>) {
  const attempts: { email: string; password: string }[] = []

  const api = {
    isValidEmail,
    MAX_PASSWORD_LENGTH: 256,
    NaviLinkDiscovery: class FakeDiscovery {
      private readonly log: CaptureLog

      constructor(options: { log: CaptureLog }) {
        this.log = options.log
      }

      async discover(email: string, password: string): Promise<Appliance[]> {
        attempts.push({ email, password })
        return onDiscover === undefined ? [appliance()] : onDiscover(this.log)
      }
    },
  }

  return { api, attempts }
}

/** Start the server the way Homebridge does, and take the route it registers. */
function start(api: unknown): RequestHandler {
  routes.clear()
  started.readyCalls = 0
  started.routesAtReady = []
  jest.resetModules()
  // Resolved from here to the same file the server reaches for as `../dist`.
  jest.doMock('../../dist/ui-api', () => api)
  require('../../homebridge-ui/server')

  const handler = routes.get('/discover')
  if (handler === undefined) {
    throw new Error('the server registered no /discover route')
  }
  return handler
}

/** The same, with a `dist/` that is not there. */
function startWithoutBuild(): RequestHandler {
  routes.clear()
  started.readyCalls = 0
  jest.resetModules()
  jest.doMock('../../dist/ui-api', () => {
    throw new Error("Cannot find module '../dist/ui-api'")
  })
  require('../../homebridge-ui/server')

  const handler = routes.get('/discover')
  if (handler === undefined) {
    throw new Error('the server registered no /discover route')
  }
  return handler
}

function failureOf(pending: Promise<unknown>): Promise<PageError> {
  return pending.then(
    () => {
      throw new Error('the request was expected to fail and did not')
    },
    (error: unknown) => error as PageError,
  )
}

const CREDENTIALS = { email: 'someone@example.com', password: 'hunter2' }

describe('starting up', () => {
  it('registers the discover route before it says the page can be used', () => {
    // `ready()` is the page's signal that the backend exists. A route
    // registered after it can be called before it is there.
    start(makeApi().api)

    expect(started.readyCalls).toBe(1)
    expect(started.routesAtReady).toContain('/discover')
  })

  it('opens the settings page even when the plugin has not been built', () => {
    // The compiled API is required on demand for this reason alone: a missing
    // build must leave a page that can explain itself.
    startWithoutBuild()

    expect(started.readyCalls).toBe(1)
  })
})

describe('before anything reaches Navien', () => {
  it('tells the user to build the plugin instead of quoting a resolution failure', async () => {
    const discover = startWithoutBuild()

    const failure = await failureOf(discover(CREDENTIALS))

    expect(failure.message).toContain('npm run build')
    expect(failure.message).not.toContain('Cannot find module')
  })

  it('turns away a mistyped address without sending it anywhere', async () => {
    // A sign-in attempt with an obviously wrong address is one more failed
    // attempt against an account that locks after a few of them.
    const { api, attempts } = makeApi()
    const discover = start(api)

    const failure = await failureOf(discover({ email: 'someone@', password: 'hunter2' }))

    expect(failure.message).toBe('Enter the email address for your NaviLink account.')
    expect(attempts).toHaveLength(0)
  })

  it('treats a request with no fields at all as a missing address', async () => {
    // The page sends what the form holds, and an empty form is the ordinary
    // state of it the first time it opens.
    const { api, attempts } = makeApi()
    const discover = start(api)

    const failure = await failureOf(discover(undefined))

    expect(failure.message).toContain('email address')
    expect(attempts).toHaveLength(0)
  })

  it('refuses an empty password rather than attempting a sign-in without one', async () => {
    const { api, attempts } = makeApi()
    const discover = start(api)

    const failure = await failureOf(discover({ email: 'someone@example.com', password: '' }))

    expect(failure.message).toBe('Enter your NaviLink password.')
    expect(attempts).toHaveLength(0)
  })

  it('refuses a password longer than the plugin accepts', async () => {
    const { api, attempts } = makeApi()
    const discover = start(api)

    const failure = await failureOf(discover({
      email: 'someone@example.com',
      password: 'x'.repeat(257),
    }))

    expect(failure.message).toBe('That password is longer than this plugin accepts.')
    expect(attempts).toHaveLength(0)
  })

  it('trims a pasted address and password the same way the plugin does', async () => {
    // Copying out of a password manager often brings a trailing newline. The
    // plugin already trims; the settings page has to match or Sign in fails
    // and a later restart succeeds.
    const { api, attempts } = makeApi()
    const discover = start(api)

    await discover({ email: '  someone@example.com  ', password: ' hunter2 ' })

    expect(attempts[0]!.email).toBe('someone@example.com')
    expect(attempts[0]!.password).toBe('hunter2')
  })
})

describe('a successful discovery', () => {
  it('suggests hot water, because that is why the plugin gets installed', async () => {
    const { api } = makeApi()
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(result.devices[0]!.suggested.dhw).toBe(true)
  })

  it('suggests nothing for an appliance that cannot heat hot water', async () => {
    // Offering a hot water thermostat on a boiler with no domestic loop
    // creates a tile that reports nothing and accepts nothing.
    const { api } = makeApi(() => [appliance({
      capabilities: { dhw: false, heating: true, recirculation: false, outdoorSensor: false },
    })])
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(result.devices[0]!.suggested.dhw).toBe(false)
  })

  it('never suggests space heating, even on an appliance fitted for it', async () => {
    // Pressing a button called Sign in is not a request to let HomeKit run
    // the central heating. That one is turned on deliberately or not at all.
    const { api } = makeApi(() => [appliance({
      capabilities: { dhw: true, heating: true, recirculation: true, outdoorSensor: true },
    })])
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(result.devices[0]!.suggested.heating).toBe(false)
    expect(result.devices[0]!.suggested).toEqual({
      dhw: true,
      heating: false,
      power: false,
      recirculation: false,
      fault: false,
      temperatureSensors: false,
      outdoorSensor: false,
    })
  })

  it('reports what each appliance is, so the page can label it without guessing', async () => {
    const { api } = makeApi(() => [
      appliance(),
      appliance({ id: 'a1b2c3d4e5f6:2', name: 'Zone Two', channel: 2 }),
    ])
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(result.devices).toHaveLength(2)
    expect(result.devices[1]!).toMatchObject({
      id: 'a1b2c3d4e5f6:2',
      name: 'Zone Two',
      channel: 2,
      family: 'combi-boiler',
      model: 'NCB-240E',
      firmware: '4352',
    })
    expect(result.devices[0]!.capabilities).toEqual({
      dhw: true,
      heating: true,
      recirculation: true,
      outdoorSensor: false,
    })
  })

  it('forwards the cloud online flag so the card can say the gateway is down', async () => {
    const { api } = makeApi(() => [appliance({ online: false })])
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(result.devices[0]?.online).toBe(false)
  })

  it('reports an unreadable firmware version as blank rather than as undefined', async () => {
    // Some accounts refuse the firmware endpoint outright. The page prints
    // this beside the model, where the word "undefined" reads as a fault.
    const { api } = makeApi(() => [appliance({ firmware: undefined })])
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(result.devices[0]!.firmware).toBe('')
  })

  it('hands back appliances and nothing else from the sign-in', async () => {
    // The tokens and the AWS credentials that made the discovery possible die
    // with this request. Pinning the shape is what keeps them out: adding one
    // field to the reply is otherwise a one-line change nobody reviews.
    const { api } = makeApi()
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(Object.keys(result).sort()).toEqual(['devices', 'log'])
    expect(Object.keys(result.devices[0]!).sort()).toEqual([
      'capabilities', 'channel', 'described', 'family', 'firmware', 'id', 'model', 'name',
      'online', 'suggested',
    ])
  })

  it('answers a second sign-in from the same process', async () => {
    // The page keeps the button enabled: a user who mistyped a password
    // corrects it and presses it again, in the same short-lived process.
    const { api, attempts } = makeApi()
    const discover = start(api)

    await discover(CREDENTIALS)
    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(attempts).toHaveLength(2)
    expect(result.devices).toHaveLength(1)
  })

  it('carries the captured log back, so a puzzling success can still be read', async () => {
    const { api } = makeApi((log) => {
      log.info('found 1 appliance on the account')
      log.warn('channel 2 did not answer')
      return [appliance()]
    })
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(result.log).toEqual([
      'info found 1 appliance on the account',
      'warn channel 2 did not answer',
    ])
  })
})

describe('a failed discovery', () => {
  it('passes on the plugin explanation, with the log that led to it', async () => {
    const { api } = makeApi((log) => {
      log.debug('signing in')
      throw new Error('NaviLink does not recognise this email address')
    })
    const discover = start(api)

    const failure = await failureOf(discover(CREDENTIALS))

    expect(failure.message).toBe('NaviLink does not recognise this email address')
    expect(failure.requestError?.log).toEqual(['debug signing in'])
  })

  it('describes something thrown that was never an error', async () => {
    // A rejected promise carrying a string is what a hand-written callback
    // produces, and "[object Object]" on the page helps nobody.
    const { api } = makeApi(() => Promise.reject('the gateway is offline') as Promise<Appliance[]>)
    const discover = start(api)

    const failure = await failureOf(discover(CREDENTIALS))

    expect(failure.message).toBe('the gateway is offline')
  })

  it('caps the captured log, so a failing sign-in cannot flood the page', async () => {
    // Discovery retries and logs as it goes. An unbounded capture is an
    // unbounded message sent to a browser.
    const { api } = makeApi((log) => {
      for (let index = 0; index < 250; index += 1) {
        log.debug(`attempt ${index}`)
      }
      throw new Error('gave up')
    })
    const discover = start(api)

    const failure = await failureOf(discover(CREDENTIALS))

    expect(failure.requestError?.log).toHaveLength(200)
    expect(failure.requestError?.log?.at(-1)).toBe('debug attempt 199')
  })
})

describe('what reaches the browser', () => {
  it('never lets a token, a key id or a signed query out through the log', async () => {
    // The captured log is the plugin's own redacted output, and it is filtered
    // again here rather than trusted. This is the assertion that holds that
    // line: whatever put a credential into a line, the page does not see it.
    const { api } = makeApi((log) => {
      log.debug(`session token ${TOKEN}`)
      log.info(`signed in with ${KEY_ID}`)
      log.warn(`rotated to ${LONG_TERM_KEY_ID}`)
      log.error(`dialling wss://example.com/mqtt?${SIGNED_QUERY}&X-Amz-Date=20260919T000000Z`)
      return [appliance()]
    })
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult
    const captured = result.log.join('\n')

    expect(captured).not.toContain(TOKEN)
    expect(captured).not.toContain('eyJ')
    expect(captured).not.toContain(KEY_ID)
    expect(captured).not.toContain(LONG_TERM_KEY_ID)
    expect(captured).not.toContain(FAKE_STS_TOKEN)
    expect(captured).toContain('[redacted]')
    // Redacted, not dropped: the line still has to say what was happening.
    expect(captured).toContain('session token')
    expect(captured).toContain('X-Amz-Date=20260919T000000Z')
  })

  it('never lets them out through a failure message either', async () => {
    // The message is the one thing the page always shows, and the one thing a
    // user screenshots when asking for help.
    const { api } = makeApi(() => {
      throw new Error(
        `sign-in rejected: token=${TOKEN} key=${KEY_ID} url=https://iot?${SIGNED_QUERY}`,
      )
    })
    const discover = start(api)

    const failure = await failureOf(discover(CREDENTIALS))

    expect(failure.message).not.toContain(TOKEN)
    expect(failure.message).not.toContain(KEY_ID)
    expect(failure.message).not.toContain(FAKE_STS_TOKEN)
    expect(failure.message).toContain('[redacted]')
    expect(failure.message).toContain('sign-in rejected')
  })

  it('filters a line that was logged as an error rather than as a message', async () => {
    // `log.error(error)` instead of `log.error(error.message)` is a natural
    // thing to write, and an unfiltered object reaching the page would carry
    // whatever the failure quoted.
    const { api } = makeApi((log) => {
      const logObject = log.error as unknown as (value: unknown) => void
      logObject(new Error(`could not sign in with ${KEY_ID}`))
      return [appliance()]
    })
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(result.log[0]).not.toContain(KEY_ID)
    expect(result.log[0]).toContain('[redacted]')
  })

  it('redacts every occurrence in a line, not only the first', async () => {
    // The patterns are global for this reason. A refresh logs the token it
    // replaced beside the one it got, and a first-match-only filter publishes
    // the second.
    const { api } = makeApi((log) => {
      log.debug(`old ${KEY_ID} new ${LONG_TERM_KEY_ID} and again ${KEY_ID}`)
      return [appliance()]
    })
    const discover = start(api)

    const result = await discover(CREDENTIALS) as DiscoverResult

    expect(result.log[0]).toBe('debug old [redacted] new [redacted] and again [redacted]')
  })
})
