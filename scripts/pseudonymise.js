/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Make a captured fixture publishable: rewrite the MAC addresses, sequence
 * numbers and names it carries, then prove none of them survived.
 *
 *   node scripts/pseudonymise.js --map ~/navilink.map.json
 *   node scripts/pseudonymise.js --in tests/fixtures --check
 *
 * The substitution map lives outside this repository, or beside it as
 * `*.map.json`, which is git-ignored: it is a list of your real values and
 * is the one thing here that must never be committed. See
 * `scripts/README.md` for its shape.
 *
 * Substitutions are applied longest-first, so no replacement can be a prefix
 * of another, and they are structure-preserving by convention: a MAC for a
 * MAC, a twelve-digit sequence for a twelve-digit sequence. So every quirk
 * the parser tests depend on survives byte for byte.
 *
 * The audit is the part that earns its keep. A NaviLink frame carries the
 * gateway MAC in **two** places and two spellings: `response.macAddress`,
 * and again inside `clientID` and both topic strings. A rewrite driven only
 * by a list of field names misses the second, which is exactly what happened
 * to the capture that started this plugin. So the audit reads the output and
 * reports every identifier still in it, whatever field it sits in.
 *
 * `--check` skips rewriting and only audits, which is worth running over
 * `tests/fixtures/` before a release.
 */
const fs = require('node:fs')
const path = require('node:path')

const { fail, parseFlags, run } = require('./lib/common')

const OPTIONS = {
  map: 'string',
  in: 'string',
  out: 'string',
  check: 'boolean',
}

const DEFAULT_IN = path.join(__dirname, '..', 'tests', 'fixtures', 'raw')

/** Twelve bare hex characters: how NaviLink spells a MAC everywhere. */
const BARE_MAC = /\b[0-9a-f]{12}\b/gi
const COLON_MAC = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi
const EMAIL = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./g
const AWS_KEY = /\b(?:ASIA|AKIA)[0-9A-Z]{16}\b/g

/** Read and validate the substitution map. */
function readMap(file) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`could not read the map at ${file}: ${error.message}`)
  }
  const substitutions = parsed.substitutions
  if (!Array.isArray(substitutions) || substitutions.length === 0) {
    fail(`${file} needs a non-empty "substitutions" array of [from, to] pairs`)
  }
  for (const pair of substitutions) {
    if (!Array.isArray(pair) || pair.length !== 2
      || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      fail(`${file}: every substitution must be a [from, to] pair of strings`)
    }
    if (pair[0].length === 0) {
      fail(`${file}: a substitution cannot rewrite an empty string`)
    }
  }
  const rename = Array.isArray(parsed.rename) ? parsed.rename : []
  // Longest first, so a shorter value cannot consume part of a longer one.
  return {
    substitutions: [...substitutions].sort((left, right) => right[0].length - left[0].length),
    rename: new Map(rename),
  }
}

/**
 * Apply every substitution, in both cases.
 *
 * A MAC appears upper-case in the REST device list and lower-case in the
 * topics, and a map that names only one spelling would leave the other
 * behind. Handled here rather than asking the operator to write each value
 * twice, because that is a step someone will forget exactly once.
 */
function rewrite(text, substitutions) {
  let out = text
  for (const [from, to] of substitutions) {
    out = out.split(from).join(to)
    const upper = from.toUpperCase()
    const lower = from.toLowerCase()
    if (upper !== from) {
      out = out.split(upper).join(to)
    }
    if (lower !== from) {
      out = out.split(lower).join(to)
    }
  }
  return out
}

/**
 * Audit a rewritten file.
 *
 * Two questions: did any mapped value survive (a bug in the rewrite, and a
 * leak), and what identifiers remain at all. The operator has to eyeball
 * those, since only they know which values are fictional.
 */
function audit(body, substitutions) {
  const survived = substitutions
    .filter(([from]) => body.toLowerCase().includes(from.toLowerCase()))
    .map(([from]) => from)
  const remaining = new Set([
    ...(body.match(BARE_MAC) || []),
    ...(body.match(COLON_MAC) || []),
    ...(body.match(EMAIL) || []),
    ...(body.match(JWT) || []),
    ...(body.match(AWS_KEY) || []),
  ])
  return { survived, remaining: [...remaining] }
}

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) {
    fail(`${dir} does not exist. Capture something first with scripts/capture-fixture.js.`)
  }
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith('.json') && entry !== 'MANIFEST.json')
    .sort()
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), OPTIONS)
  const checkOnly = flags.check === true
  if (!checkOnly && flags.map === undefined) {
    fail('--map is required unless you pass --check. See scripts/README.md.')
  }

  const inDir = flags.in === undefined ? DEFAULT_IN : path.resolve(flags.in)
  const outDir = flags.out === undefined ? inDir : path.resolve(flags.out)
  const { substitutions, rename } = flags.map === undefined
    ? { substitutions: [], rename: new Map() }
    : readMap(path.resolve(flags.map))

  fs.mkdirSync(outDir, { recursive: true })

  const leaks = []
  const identifiers = new Set()
  for (const entry of jsonFiles(inDir)) {
    const body = fs.readFileSync(path.join(inDir, entry), 'utf8')
    const rewritten = checkOnly ? body : rewrite(body, substitutions)
    const target = rename.get(entry) || entry
    // The map is the operator's own file, but a rename target is joined onto
    // the output directory, so it has to be a filename and not a path.
    if (target.includes('/') || target.includes('\\') || target.includes('..')) {
      fail(`rename target "${target}" must be a plain filename, not a path`)
    }

    if (!checkOnly) {
      fs.writeFileSync(path.join(outDir, target), rewritten)
      if (target !== entry && outDir === inDir) {
        fs.unlinkSync(path.join(inDir, entry))
      }
    }

    const result = audit(rewritten, substitutions)
    for (const value of result.survived) {
      leaks.push(`${target}: "${value}" survived the rewrite`)
    }
    for (const value of result.remaining) {
      identifiers.add(value)
    }
    console.log(checkOnly ? `  checked ${entry}` : `  ${entry} -> ${target}`)
  }

  console.log('\n=== identifiers present in the output ===')
  if (identifiers.size === 0) {
    console.log('  none')
  }
  for (const value of [...identifiers].sort()) {
    console.log(`  ${value}`)
  }
  console.log('\nEvery value above will be published. Confirm each one is fictional:')
  console.log('anything your account or gateway actually uses needs a substitution in the map.')

  if (leaks.length > 0) {
    for (const leak of leaks) {
      console.log(`  LEAK ${leak}`)
    }
    throw new Error(`${leaks.length} mapped value(s) survived the rewrite`)
  }
}

run(main)
