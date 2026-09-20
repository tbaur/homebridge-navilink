/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The settings page writes the user's configuration, so a defect here
 * destroys something they cannot get back. It also holds their NaviLink
 * password, which makes two things testable that are otherwise a matter of
 * hoping: that the password reaches the configuration, and that it reaches
 * nothing else.
 *
 * Exercised against a stand-in DOM rather than jsdom. What matters is what
 * the page saves, not how it lays a card out, and a dependency that large for
 * a dozen element lookups would be carried by everyone who clones this.
 *
 * The page builds itself on load, so each test loads a fresh copy against a
 * fresh set of elements.
 */

const PAGE = '../../homebridge-ui/public/index.js'

/** The subset of an element the page uses. */
class FakeNode {
  readonly children: FakeNode[] = []

  readonly attributes = new Map<string, string>()

  readonly dataset: Record<string, string> = {}

  readonly listeners = new Map<string, ((event?: unknown) => void)[]>()

  /** Only a `<select>` has these; the page appends to them. */
  readonly options: FakeNode[] = []

  className = ''

  value = ''

  checked = false

  disabled = false

  private text = ''

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return [this.text, ...this.children.map((child) => child.textContent)].join('')
  }

  set textContent(value: string) {
    this.text = value
    this.children.length = 0
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes)
    if (this.tagName === 'select') {
      this.options.push(...nodes)
    }
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(handler)
    this.listeners.set(type, existing)
  }

  /** Fire a listener the page registered, as a click or an edit would. */
  fire(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler()
    }
  }

  /** Every node in this subtree, so a test can find a control by its label. */
  descendants(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()])
  }
}

interface Toast {
  success: jest.Mock
  error: jest.Mock
  warning: jest.Mock
  info: jest.Mock
}

interface Page {
  byId(id: string): FakeNode
  /** The platform block as last pushed into Homebridge. */
  pushed(): Record<string, unknown>
  savedDevices(): Record<string, unknown>[]
  savedOptions(): Record<string, unknown>
  /** Every push, so a test can prove a value never appeared in any of them. */
  allPushes(): string
  toast: Toast
  cards(): FakeNode[]
  /** A checkbox by the label next to it. */
  option(label: string): FakeNode
  labels(): string[]
  request: jest.Mock
  showSpinner: jest.Mock
  hideSpinner: jest.Mock
  showSchemaForm: jest.Mock
  hideSchemaForm: jest.Mock
  settle(): Promise<void>
}

/** Let the page's promise chains run to completion. */
async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
}

const ELEMENT_IDS = [
  'devices', 'summary', 'email', 'password', 'discover',
  'interval', 'read-only', 'allow-power-off', 'accessory-prefix',
  'diagnostics-interval', 'structured-logs', 'toggle-json',
]

/** A discovered appliance, as the UI server would return it. */
function discovered(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1b2c3d4e5f6:1',
    name: 'Boiler',
    channel: 1,
    family: 'NCB',
    model: 'NCB',
    firmware: '17.0',
    capabilities: { dhw: true, heating: true, recirculation: false, outdoorSensor: false },
    suggested: { dhw: true, fault: true },
    ...overrides,
  }
}

async function load(options: {
  config?: unknown[]
  request?: jest.Mock
  getPluginConfig?: jest.Mock
  updatePluginConfig?: jest.Mock
} = {}): Promise<Page> {
  const elements = new Map<string, FakeNode>()
  for (const id of ELEMENT_IDS) {
    elements.set(id, new FakeNode(id === 'interval' ? 'select' : 'div'))
  }
  // The interval control is a real `<select>` with the offered values in it.
  const interval = elements.get('interval')
  for (const seconds of [30, 60, 120, 300, 900, 1800, 3600]) {
    const option = new FakeNode('option')
    option.value = String(seconds)
    interval?.append(option)
  }

  const toast: Toast = {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
  }
  const pushes: Record<string, unknown>[][] = []
  const request = options.request ?? jest.fn().mockResolvedValue({ devices: [] })
  const homebridge = {
    getPluginConfig: options.getPluginConfig
      ?? jest.fn().mockResolvedValue(options.config ?? []),
    updatePluginConfig: options.updatePluginConfig ?? jest.fn((blocks: unknown) => {
      // Cloned, because the page keeps editing the object it handed over.
      pushes.push(JSON.parse(JSON.stringify(blocks)) as Record<string, unknown>[])
      return Promise.resolve()
    }),
    savePluginConfig: jest.fn().mockResolvedValue(undefined),
    request,
    showSpinner: jest.fn(),
    hideSpinner: jest.fn(),
    showSchemaForm: jest.fn(),
    hideSchemaForm: jest.fn(),
    toast,
  }
  const document = {
    getElementById: (id: string) => elements.get(id),
    createElement: (tag: string) => new FakeNode(tag),
  }

  // Loaded the way Homebridge's UI would load it, on the globals a browser
  // provides, so the coverage report reflects it.
  Object.assign(globalThis, { document, homebridge })
  jest.resetModules()
  require(PAGE)
  await settle()

  const byId = (id: string): FakeNode => {
    const node = elements.get(id)
    if (node === undefined) {
      throw new Error(`no element ${id}`)
    }
    return node
  }
  const pushed = (): Record<string, unknown> => pushes.at(-1)?.[0] ?? {}

  return {
    byId,
    toast,
    request,
    pushed,
    savedDevices: () => (pushed().devices ?? []) as Record<string, unknown>[],
    savedOptions: () => (pushed().options ?? {}) as Record<string, unknown>,
    allPushes: () => JSON.stringify(pushes),
    cards: () => byId('devices').children,
    option: (label) => {
      const wrapper = byId('devices').descendants()
        .find((node) => node.tagName === 'div'
          && node.className.startsWith('nl-check')
          && node.textContent === label)
      const input = wrapper?.children.find((child) => child.tagName === 'input')
      if (input === undefined) {
        throw new Error(`no checkbox labelled ${label}`)
      }
      return input
    },
    labels: () => byId('devices').descendants()
      .filter((node) => node.tagName === 'label')
      .map((node) => node.textContent),
    showSpinner: homebridge.showSpinner,
    hideSpinner: homebridge.hideSpinner,
    showSchemaForm: homebridge.showSchemaForm,
    hideSchemaForm: homebridge.hideSchemaForm,
    settle,
  }
}

const configured = [{
  platform: 'NaviLink',
  name: 'NaviLink',
  email: 'someone@example.com',
  password: 'hunter2',
  devices: [{ id: 'a1b2c3d4e5f6:1', name: 'Boiler', channel: 1, dhw: true, fault: true }],
  options: { statusIntervalSec: 120, readOnly: true },
}]

describe('opening the page', () => {
  it('says what to do when nothing is configured', async () => {
    const page = await load()
    expect(page.byId('devices').textContent).toContain('Sign in above')
  })

  it('shows a configured appliance before any sign-in', async () => {
    const page = await load({ config: configured })
    // Making the user hand over a password again just to rename a tile would
    // be a poor trade for a list the configuration already contains.
    expect(page.cards()).toHaveLength(1)
    expect(page.byId('devices').textContent).toContain('from configuration')
  })

  it('fills the account fields from the configuration', async () => {
    const page = await load({ config: configured })
    expect(page.byId('email').value).toBe('someone@example.com')
    expect(page.byId('password').value).toBe('hunter2')
  })

  it('restores the whole-install settings', async () => {
    const page = await load({ config: configured })
    expect(page.byId('interval').value).toBe('120')
    expect(page.byId('read-only').checked).toBe(true)
    expect(page.byId('allow-power-off').checked).toBe(false)
    expect(page.byId('accessory-prefix').value).toBe('')
  })

  it('keeps a hand-edited interval rather than snapping it to an offered one', async () => {
    const page = await load({
      config: [{ ...configured[0], options: { statusIntervalSec: 45 } }],
    })
    // 45 is not in the list. Snapping it to 30 or 60 would silently rewrite a
    // deliberate choice made in the advanced editor.
    expect(page.byId('interval').value).toBe('45')
  })

  it('hides the advanced editor, so two editors cannot fight', async () => {
    const page = await load()
    expect(page.hideSchemaForm).toHaveBeenCalled()
  })

  it('counts the tiles an appliance will produce, not the ticks', async () => {
    const page = await load({ config: configured })
    // One tick for temperature sensors makes four tiles, so a count of ticks
    // would understate the result by three.
    expect(page.byId('summary').textContent).toBe('1 appliance(s), 2 HomeKit accessory(s).')
  })

  it('offers every accessory for an appliance nothing is known about', async () => {
    const page = await load({ config: configured })
    // Greying out a control the user already chose, on no evidence, is worse
    // than offering one that turns out to be unsupported.
    const disabled = page.byId('devices').descendants()
      .filter((node) => node.tagName === 'input' && node.disabled)
    expect(disabled).toHaveLength(0)
  })

  it('says so rather than throwing when the configuration cannot be read', async () => {
    const page = await load({
      getPluginConfig: jest.fn().mockRejectedValue(new Error('config.json is not valid JSON')),
    })
    expect(page.toast.error).toHaveBeenCalledWith(
      'config.json is not valid JSON',
      'Could not read the configuration',
    )
    // Still rendered, so the page is not a blank rectangle.
    expect(page.byId('devices').textContent).toContain('No appliances yet')
  })

  it('ignores a configured entry with no id rather than writing a broken one', async () => {
    const page = await load({
      config: [{ ...configured[0], devices: [{ name: 'Nameless' }] }],
    })
    // An id is what addresses the appliance. An entry without one cannot be
    // rendered into anything the user could fix.
    expect(page.byId('devices').textContent).toContain('No appliances yet')
    expect(page.savedDevices()).toHaveLength(0)
  })
})

describe('signing in', () => {
  it('refuses to send an empty password', async () => {
    const page = await load()
    page.byId('email').value = 'someone@example.com'
    page.byId('discover').fire('click')
    await page.settle()
    expect(page.request).not.toHaveBeenCalled()
    expect(page.toast.error).toHaveBeenCalledWith(
      'Enter your NaviLink email address and password.',
      'Cannot sign in',
    )
  })

  it('sends the account to the server and lists what comes back', async () => {
    const request = jest.fn().mockResolvedValue({ devices: [discovered()] })
    const page = await load({ request })
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = 'hunter2'
    page.byId('discover').fire('click')
    await page.settle()

    expect(request).toHaveBeenCalledWith('/discover', {
      email: 'someone@example.com',
      password: 'hunter2',
    })
    expect(page.cards()).toHaveLength(1)
  })

  it('takes the suggested accessories from what the appliance reports', async () => {
    const request = jest.fn().mockResolvedValue({ devices: [discovered()] })
    const page = await load({ request })
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = 'hunter2'
    page.byId('discover').fire('click')
    await page.settle()

    const [saved] = page.savedDevices()
    expect(saved?.dhw).toBe(true)
    expect(saved?.fault).toBe(true)
    // Written as an explicit false rather than omitted, so the saved file
    // says what will be created instead of leaving it to a default.
    expect(saved?.heating).toBe(false)
  })

  it('greys out an accessory the appliance cannot support, and says why', async () => {
    const request = jest.fn().mockResolvedValue({ devices: [discovered()] })
    const page = await load({ request })
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = 'hunter2'
    page.byId('discover').fire('click')
    await page.settle()

    const label = page.labels().find((text) => text.startsWith('Recirculation switch'))
    expect(label).toBe('Recirculation switch (no recirculation pump is fitted)')
    expect(page.option(label ?? '').disabled).toBe(true)
  })

  it('turns off a choice the appliance turns out not to support', async () => {
    const request = jest.fn().mockResolvedValue({ devices: [discovered()] })
    const page = await load({
      config: [{
        ...configured[0],
        devices: [{ id: 'a1b2c3d4e5f6:1', name: 'Boiler', recirculation: true }],
      }],
      request,
    })
    page.byId('discover').fire('click')
    await page.settle()

    // Leaving it ticked would promise a tile that can never work.
    expect(page.savedDevices()[0]?.recirculation).toBe(false)
  })

  it('keeps the name the user chose over the one the cloud reports', async () => {
    const request = jest.fn().mockResolvedValue({
      devices: [discovered({ name: 'NaviLink Boiler' })],
    })
    const page = await load({
      config: [{
        ...configured[0],
        devices: [{ id: 'a1b2c3d4e5f6:1', name: 'Downstairs Boiler' }],
      }],
      request,
    })
    page.byId('discover').fire('click')
    await page.settle()

    expect(page.savedDevices()[0]?.name).toBe('Downstairs Boiler')
  })

  it('flags a configured appliance that did not answer, rather than dropping it', async () => {
    const request = jest.fn().mockResolvedValue({ devices: [] })
    const page = await load({ config: configured, request })
    page.byId('discover').fire('click')
    await page.settle()

    // An appliance that is merely powered down should not vanish from a
    // configuration somebody already built.
    expect(page.byId('devices').textContent).toContain('not found')
    expect(page.savedDevices()).toHaveLength(1)
  })

  it('marks a listed gateway the cloud says is offline', async () => {
    const request = jest.fn().mockResolvedValue({
      devices: [discovered({ online: false, described: true })],
    })
    const page = await load({ config: configured, request })
    page.byId('discover').fire('click')
    await page.settle()

    expect(page.byId('devices').textContent).toContain('offline')
    expect(page.byId('devices').textContent).toContain('The cloud says this gateway is offline.')
    expect(page.byId('devices').textContent).not.toContain('not found')
  })

  it('explains an empty result instead of leaving the page blank', async () => {
    const page = await load()
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = 'hunter2'
    page.byId('discover').fire('click')
    await page.settle()
    expect(page.toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('no appliance answered'),
      'Nothing found',
    )
  })

  it('reports a rejected password as a failure the user can act on', async () => {
    const request = jest.fn().mockRejectedValue({
      error: 'NaviLink rejected the email address or password',
    })
    const page = await load({ request })
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = 'wrong'
    page.byId('discover').fire('click')
    await page.settle()

    expect(page.toast.error).toHaveBeenCalledWith(
      'NaviLink rejected the email address or password',
      'Sign-in failed',
    )
  })

  it('always takes the spinner down, including after a failure', async () => {
    const request = jest.fn().mockRejectedValue(new Error('socket hang up'))
    const page = await load({ request })
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = 'hunter2'
    page.byId('discover').fire('click')
    await page.settle()
    expect(page.hideSpinner).toHaveBeenCalled()
  })

  it('shows a channel badge only when there is more than one', async () => {
    const request = jest.fn().mockResolvedValue({
      devices: [discovered(), discovered({ id: 'a1b2c3d4e5f6:2', channel: 2 })],
    })
    const page = await load({ request })
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = 'hunter2'
    page.byId('discover').fire('click')
    await page.settle()

    const badges = page.byId('devices').descendants()
      .filter((node) => node.className === 'nl-badge')
      .map((node) => node.textContent)
    expect(badges).toEqual(['channel 2'])
  })
})

describe('what gets written', () => {
  it('writes the password, because the plugin has to sign in again after a restart', async () => {
    const page = await load()
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = 'hunter2'
    page.byId('password').fire('input')
    await page.settle()
    expect(page.pushed().password).toBe('hunter2')
  })

  it('trims a pasted password before writing it', async () => {
    const page = await load()
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = ' hunter2\n'
    page.byId('password').fire('input')
    await page.settle()
    expect(page.pushed().password).toBe('hunter2')
  })

  it('removes the account rather than writing an empty string', async () => {
    const page = await load({ config: configured })
    page.byId('email').value = ''
    page.byId('password').value = ''
    page.byId('email').fire('input')
    await page.settle()
    // An empty string is a value the platform would have to special-case. An
    // absent key already means "not configured".
    expect(page.pushed()).not.toHaveProperty('email')
    expect(page.pushed()).not.toHaveProperty('password')
  })

  it('drops a default interval rather than writing what the plugin would do anyway', async () => {
    const page = await load({ config: configured })
    page.byId('interval').value = '120'
    page.byId('interval').fire('change')
    await page.settle()
    expect(page.savedOptions()).not.toHaveProperty('statusIntervalSec')
  })

  it('drops allowPowerOff when it is off, so an absent key is not a decision', async () => {
    const page = await load({ config: configured })
    page.byId('allow-power-off').checked = false
    page.byId('allow-power-off').fire('change')
    await page.settle()
    expect(page.savedOptions()).not.toHaveProperty('allowPowerOff')
  })

  it('writes allowPowerOff when the user opts in', async () => {
    const page = await load({ config: configured })
    page.byId('allow-power-off').checked = true
    page.byId('allow-power-off').fire('change')
    await page.settle()
    expect(page.savedOptions().allowPowerOff).toBe(true)
  })

  it('drops a default-off diagnostics interval rather than writing 0', async () => {
    const page = await load({ config: configured })
    page.byId('diagnostics-interval').value = '0'
    page.byId('diagnostics-interval').fire('change')
    await page.settle()
    expect(page.savedOptions()).not.toHaveProperty('diagnosticsInterval')
    expect(page.savedOptions()).not.toHaveProperty('structuredLogs')
  })

  it('drops a blank accessory prefix rather than writing an empty string', async () => {
    const page = await load({
      config: [{ ...configured[0], options: { accessoryPrefix: 'Zone One' } }],
    })
    page.byId('accessory-prefix').value = '  '
    page.byId('accessory-prefix').fire('input')
    await page.settle()
    expect(page.savedOptions()).not.toHaveProperty('accessoryPrefix')
  })

  it('writes an accessory prefix when the user sets one', async () => {
    const page = await load({ config: configured })
    page.byId('accessory-prefix').value = 'Zone One'
    page.byId('accessory-prefix').fire('input')
    await page.settle()
    expect(page.savedOptions().accessoryPrefix).toBe('Zone One')
  })

  it('restores a saved accessory prefix', async () => {
    const page = await load({
      config: [{ ...configured[0], options: { accessoryPrefix: 'Zone One' } }],
    })
    expect(page.byId('accessory-prefix').value).toBe('Zone One')
  })

  it('writes diagnostics options when the user turns them on', async () => {
    const page = await load({ config: configured })
    page.byId('diagnostics-interval').value = '300'
    page.byId('diagnostics-interval').fire('change')
    page.byId('structured-logs').checked = true
    page.byId('structured-logs').fire('change')
    await page.settle()
    expect(page.savedOptions().diagnosticsInterval).toBe(300)
    expect(page.savedOptions().structuredLogs).toBe(true)
  })

  it('keeps a setting this page does not model', async () => {
    const page = await load({
      config: [{
        ...configured[0],
        devices: [{ id: 'a1b2c3d4e5f6:1', name: 'Boiler', someFutureOption: 7 }],
      }],
    })
    // Opening this page and saving must not quietly discard a key a later
    // version added.
    expect(page.savedDevices()[0]?.someFutureOption).toBe(7)
  })

  it('drops an appliance the user unticked', async () => {
    const page = await load({ config: configured })
    const include = page.byId('devices').descendants()
      .find((node) => node.attributes.get('aria-label')?.startsWith('Expose'))
    if (include === undefined) {
      throw new Error('no include checkbox')
    }
    include.checked = false
    include.fire('change')
    await page.settle()
    expect(page.savedDevices()).toHaveLength(0)
  })

  it('falls back to the id when a name is blanked out', async () => {
    const page = await load({ config: configured })
    const nameInput = page.byId('devices').descendants()
      .find((node) => node.attributes.get('maxlength') === '64')
    if (nameInput === undefined) {
      throw new Error('no name field')
    }
    nameInput.value = '   '
    nameInput.fire('input')
    await page.settle()
    // A nameless accessory is one HomeKit will not show.
    expect(page.savedDevices()[0]?.name).toBe('a1b2c3d4e5f6:1')
  })

  it('says so when the configuration cannot be updated', async () => {
    const page = await load({
      config: configured,
      updatePluginConfig: jest.fn().mockRejectedValue(new Error('read-only file system')),
    })
    expect(page.toast.error).toHaveBeenCalledWith(
      'read-only file system',
      'Could not update the configuration',
    )
  })
})

describe('the password', () => {
  it('never reaches a toast, which is what ends up in a screenshot', async () => {
    const request = jest.fn().mockRejectedValue(new Error('sign-in failed for hunter2'))
    const page = await load({ request })
    page.byId('email').value = 'someone@example.com'
    page.byId('password').value = 'hunter2'
    page.byId('discover').fire('click')
    await page.settle()

    const shown = page.toast.error.mock.calls.flat().join(' ')
    expect(shown).not.toContain('hunter2')
    expect(shown).toContain('[redacted]')
    expect(shown).toContain('Sign-in failed')
  })

  it('never reaches a data attribute or a summary line', async () => {
    const page = await load({ config: configured })
    expect(page.byId('devices').textContent).not.toContain('hunter2')
    expect(page.byId('summary').textContent).not.toContain('hunter2')
    const attributes = page.byId('devices').descendants()
      .flatMap((node) => [...node.attributes.values(), ...Object.values(node.dataset)])
    expect(attributes.join(' ')).not.toContain('hunter2')
  })
})

describe('the advanced editor', () => {
  it('shows and hides on request', async () => {
    const page = await load()
    page.byId('toggle-json').fire('click')
    expect(page.showSchemaForm).toHaveBeenCalledTimes(1)
    page.byId('toggle-json').fire('click')
    // Once on load, once here.
    expect(page.hideSchemaForm).toHaveBeenCalledTimes(2)
  })
})
