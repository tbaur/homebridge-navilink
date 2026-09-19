/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * End-to-end check of the built plugin against a real NaviLink account.
 * Read-only: it never publishes to the control topic, so it cannot change a
 * setpoint, a power state or recirculation.
 *
 * It exercises the paths that unit tests can only fake: the REST sign-in
 * that answers a rejected password with HTTP 200, the AWS credential
 * exchange, the SigV4 WebSocket handshake, and a live `channelinfo` /
 * `channelstatus` pair. That is why it is worth running before a release
 * even though CI cannot.
 *
 *   node scripts/smoke.js
 *   node scripts/smoke.js --verbose
 *
 * Credentials come from NAVILINK_EMAIL / NAVILINK_PASSWORD, or a prompt.
 * Never a command-line flag for the password.
 *
 * Output describes your account: appliance names, families, firmware and
 * masked MACs. Redact it before attaching it to a public issue.
 */
const { consoleLogger, parseFlags, requireBuild, resolveAccount, run } = require('./lib/common')

/** `{masked-mac}:{channel}`, so a smoke run does not print a live address. */
function maskDeviceId(api, id) {
  const parsed = api.parseDeviceId(id)
  return parsed === undefined ? id : `${api.maskMac(parsed.mac)}:${parsed.channel}`
}

const OPTIONS = {
  verbose: 'boolean',
}

/** Report what discovery made of each appliance. */
function describe(api, devices) {
  for (const device of devices) {
    const flags = [
      device.capabilities.dhw ? 'DHW' : null,
      device.capabilities.heating ? 'HEAT' : null,
      device.capabilities.recirculation ? 'RECIRC' : null,
      device.capabilities.outdoorSensor ? 'OUTDOOR' : null,
    ].filter(Boolean).join(' ')
    console.log(`  ${device.name}`)
    console.log(`    id       ${maskDeviceId(api, device.id)}`)
    console.log(`    family   ${device.family}  model ${device.model}`)
    console.log(`    firmware ${device.firmware ?? 'unknown'}`)
    if (flags) {
      console.log(`    capable  ${flags}`)
    }
  }
}

/**
 * Check that identity is unique per appliance.
 *
 * The interesting case is a cascade: several appliances share one gateway
 * MAC and the channel is the only thing separating them. A collision here
 * would mean two boilers sharing one HomeKit accessory.
 */
function checkIdentity(api, devices) {
  const ids = devices.map((device) => device.id)
  const unique = new Set(ids)
  console.log('\n=== identity ===')
  console.log(
    `  ${ids.length} appliance(s), ${unique.size} unique id(s) -> `
    + `${unique.size === ids.length ? 'OK' : 'COLLISION'}`,
  )

  const perMac = new Map()
  for (const device of devices) {
    const mac = device.id.split(':')[0]
    perMac.set(mac, (perMac.get(mac) || 0) + 1)
  }
  for (const [mac, count] of perMac) {
    if (count > 1) {
      console.log(`  ${api.maskMac(mac)} carries ${count} channels on one gateway (cascade)`)
    }
  }
  return unique.size === ids.length
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), OPTIONS)
  const api = requireBuild()
  const log = consoleLogger({ verbose: flags.verbose === true })
  const account = await resolveAccount()

  console.log('\n=== sign-in and discovery ===')
  const discovery = new api.NaviLinkDiscovery({ log })
  const devices = await discovery.discover(account.email, account.password)

  if (devices.length === 0) {
    throw new Error(
      'no appliance answered. Check the gateway is powered and shows as connected in the NaviLink app.',
    )
  }

  describe(api, devices)
  const identityOk = checkIdentity(api, devices)

  console.log('\n=== frames ===')
  const frames = await discovery.capture({
    email: account.email,
    password: account.password,
    redact: true,
  })
  const kinds = frames.reduce((counts, entry) => {
    counts[entry.kind] = (counts[entry.kind] || 0) + 1
    return counts
  }, {})
  console.log(`  captured ${frames.length} redacted frame(s): ${JSON.stringify(kinds)}`)
  if (!kinds.channelinfo || !kinds.channelstatus) {
    throw new Error('expected at least one channelinfo and one channelstatus frame')
  }

  if (!identityOk) {
    throw new Error('two appliances derived the same identity')
  }
  console.log('\nsmoke test complete')
}

run(main)
