/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Record the raw `channelinfo` and `channelstatus` frames a real appliance
 * sends, so the parser is tested against bytes a gateway actually produced
 * rather than bytes someone assumed it would. Read-only: no control command
 * is published.
 *
 *   node scripts/capture-fixture.js --redact      # for a bug report
 *   node scripts/capture-fixture.js --label idle  # for a fixture
 *
 * Two modes, and the difference matters.
 *
 * `--redact` prints to the terminal with the account, the tokens and the MAC
 * addresses removed. That is the one to use for a bug report, and it is what
 * the issue template asks for.
 *
 * Without it, complete frames are written to `tests/fixtures/raw/`, which is
 * git-ignored, because an unredacted frame carries your gateway's MAC
 * address and your account's sequence numbers. Run `scripts/pseudonymise.js`
 * before moving anything into `tests/fixtures/`.
 *
 * To capture a state you cannot reach passively (recirculating, firing for
 * space heat, showing a fault), put the appliance in that state from the
 * NaviLink app first, then capture with a `--label` saying which state it
 * was in.
 */
const fs = require('node:fs')
const path = require('node:path')

const {
  consoleLogger,
  parseFlags,
  requireBuild,
  resolveAccount,
  run,
  slug,
} = require('./lib/common')

const OPTIONS = {
  out: 'string',
  label: 'string',
  redact: 'boolean',
  verbose: 'boolean',
}

const DEFAULT_OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'raw')

async function main() {
  const flags = parseFlags(process.argv.slice(2), OPTIONS)
  const api = requireBuild()
  const log = consoleLogger({ verbose: flags.verbose === true })
  const redact = flags.redact === true

  const account = await resolveAccount()
  console.log('\n=== signing in ===')

  const discovery = new api.NaviLinkDiscovery({ log })
  const frames = await discovery.capture({
    email: account.email,
    password: account.password,
    redact,
  })

  if (frames.length === 0) {
    console.log('\nNo appliance answered. Check the gateway is powered and shows as')
    console.log('connected in the NaviLink app.')
    return
  }

  if (redact) {
    console.log('\n=== redacted frames ===')
    console.log('Safe to paste into a bug report. Read it before you do, all the same.\n')
    for (const entry of frames) {
      console.log(`--- ${entry.kind} (channel ${entry.channelNumber}) ---`)
      console.log(JSON.stringify(entry.frame, null, 2))
    }
    return
  }

  const outDir = flags.out === undefined ? DEFAULT_OUT : path.resolve(flags.out)
  fs.mkdirSync(outDir, { recursive: true })

  const manifest = []
  for (const entry of frames) {
    const parts = ['navilink', `ch${entry.channelNumber}`, flags.label].filter(Boolean)
    const file = `${slug(parts.join('-'))}.${entry.kind}.json`
    const body = `${JSON.stringify(entry.frame, null, 2)}\n`
    fs.writeFileSync(path.join(outDir, file), body)
    manifest.push({
      file,
      kind: entry.kind,
      channel: entry.channelNumber,
      label: flags.label,
      bytes: body.length,
    })
    console.log(`  ${file} (${body.length} bytes)`)
  }

  fs.writeFileSync(
    path.join(outDir, 'MANIFEST.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  console.log(`\n${manifest.length} file(s) in ${outDir}`)
  console.log('These are unredacted. Run scripts/pseudonymise.js before committing any of them.')
}

run(main)
