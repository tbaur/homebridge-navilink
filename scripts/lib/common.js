/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Shared plumbing for the maintenance scripts in this directory.
 *
 * These talk to a real account on Navien's cloud, so nothing here has a
 * built-in address or credential: the account comes from the environment or
 * from a prompt, and anything captured is written where the caller asks for
 * it. `pseudonymise.js` is the step that makes such a capture publishable.
 *
 * The prompt is the reason this file exists rather than each script reading
 * `process.argv`. **A password must never be a command-line argument**: it
 * would sit in the shell history, and on most systems it is readable by any
 * other process on the machine for as long as the script runs.
 */
const readline = require('node:readline')
const path = require('node:path')

/** Print a message and exit non-zero. Scripts are tools, not libraries. */
function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

/**
 * Parse `--key value` and `--flag` arguments into an object.
 *
 * Deliberately minimal, and unknown keys are rejected rather than ignored,
 * so a typo in `--label` cannot silently leave the default in place.
 */
function parseFlags(argv, known) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      // The raw token is not echoed: a password pasted as a positional
      // argument is the thing these scripts exist not to put on a command
      // line, and printing it here would undo that.
      fail('unexpected argument (not a --flag). A password must not be a command-line argument')
    }
    const key = token.slice(2)
    if (!Object.prototype.hasOwnProperty.call(known, key)) {
      fail(`unknown option. Known options: ${Object.keys(known).map((name) => `--${name}`).join(', ')}`)
    }
    if (known[key] === 'boolean') {
      flags[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      fail(`--${key} needs a value`)
    }
    flags[key] = value
    index += 1
  }
  return flags
}

/**
 * Load the compiled plugin.
 *
 * The scripts use the same code the plugin runs rather than reimplementing
 * the protocol, which is the only way a script's result says anything about
 * the plugin. That means the build has to be current.
 */
function requireBuild() {
  const target = path.join(__dirname, '..', '..', 'dist', 'ui-api.js')
  try {
    return require(target)
  } catch (error) {
    fail(`could not load ${target}: ${error.message}\nRun "npm run build" first.`)
  }
}

/** A PluginLogger the plugin's own classes accept, printing to the terminal. */
function consoleLogger({ verbose = false } = {}) {
  return {
    info: (message) => console.log(`  [info]  ${message}`),
    warn: (message) => console.log(`  [warn]  ${message}`),
    error: (message) => console.log(`  [error] ${message}`),
    debug: (message) => {
      if (verbose) {
        console.log(`  [debug] ${message}`)
      }
    },
  }
}

/** Ask a question on the terminal and return the answer. */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * Turn one stdin chunk into characters.
 *
 * After `readline` has asked for the email, stdin is often left in utf8
 * mode, so `data` events carry strings. In raw mode they may still be
 * Buffers. Both must produce the same characters. Iterating a string as
 * bytes and running each through `String.fromCharCode` turns every
 * keystroke into a NUL; the cloud then rejects the sign-in as
 * `COMMON_BAD_REQUEST` rather than as a wrong password.
 */
function decodeHiddenChunk(chunk) {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
}

/**
 * Fold one chunk into the hidden password so far.
 *
 * Exported so the string-after-readline case is a unit test rather than a
 * "it works on my machine" hope. Returns `{ value, done, cancelled }`.
 */
function consumeHiddenChunk(value, chunk) {
  let next = value
  for (const character of decodeHiddenChunk(chunk)) {
    if (character === '\u0003') {
      return { value: next, done: true, cancelled: true }
    }
    if (character === '\r' || character === '\n') {
      return { value: next, done: true, cancelled: false }
    }
    if (character === '\u007f' || character === '\b') {
      next = next.slice(0, -1)
      continue
    }
    if (character < ' ') {
      continue
    }
    next += character
  }
  return { value: next, done: false, cancelled: false }
}

/**
 * Ask for a password without echoing it.
 *
 * Node has no built-in for this. The approach is the usual one: put the
 * terminal in raw mode so keystrokes arrive here instead of being printed,
 * and restore it afterwards on every path, including Ctrl-C, which would
 * otherwise leave the user's shell with echo switched off.
 */
function askHidden(question) {
  const { stdin, stdout } = process
  if (stdin.isTTY !== true) {
    // Piped input. Echo was never on, so there is nothing to suppress and the
    // ordinary reader handles it.
    return ask(question)
  }
  return new Promise((resolve, reject) => {
    stdout.write(question)
    let value = ''
    const wasRaw = stdin.isRaw === true

    const restore = () => {
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
    }
    const onData = (chunk) => {
      const outcome = consumeHiddenChunk(value, chunk)
      value = outcome.value
      if (!outcome.done) {
        return
      }
      restore()
      if (outcome.cancelled) {
        reject(new Error('cancelled'))
        return
      }
      resolve(value)
    }

    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

/**
 * Resolve the NaviLink account to use.
 *
 * The environment first, so a repeated run in a session does not mean
 * retyping, then a prompt. Never a command-line flag for the password: see
 * the file header.
 */
async function resolveAccount() {
  const email = process.env.NAVILINK_EMAIL || await ask('NaviLink email: ')
  if (email.length === 0) {
    fail('an email address is required')
  }
  const password = process.env.NAVILINK_PASSWORD || await askHidden('NaviLink password (hidden): ')
  if (password.length === 0) {
    fail('a password is required')
  }
  return { email, password }
}

/** Turn a name into a filename-safe slug. */
function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Run a script's main function, reporting a failure without a stack wall. */
function run(main) {
  main().catch((error) => {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

module.exports = {
  ask,
  askHidden,
  consumeHiddenChunk,
  consoleLogger,
  fail,
  parseFlags,
  requireBuild,
  resolveAccount,
  run,
  slug,
}
