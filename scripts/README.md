# Maintenance scripts

Tools for the things CI cannot do: talk to a real NaviLink account and real hardware. They are not part of the published package (`files` in `package.json` excludes this directory) and they are not part of the test suite.

Everything here loads the compiled plugin from `dist/`, so a result says something about the code that actually ships. It is not a reimplementation of the protocol. Run `npm run build` first.

No script has a built-in account. Credentials come from `NAVILINK_EMAIL` and `NAVILINK_PASSWORD`, or from a prompt that does not echo. **Neither script takes a password as a command-line argument**, because that puts it in your shell history and, on most systems, in the process list for any other user on the machine.

| Script | Writes to the appliance? | What it is for |
| --- | --- | --- |
| `smoke.js` | No | End-to-end check before a release: sign-in, MQTT handshake, identity uniqueness, a redacted `channelinfo` / `channelstatus` pair |
| `capture-fixture.js` | No | Record raw `channelinfo` and `channelstatus` frames, or print a redacted pair for a bug report |
| `pseudonymise.js` | No | Rewrite a capture's real values, then prove none survived |

Neither network script publishes to the control topic, so neither can change a setpoint, a power state or recirculation. `pseudonymise.js` never talks to the cloud. To capture a particular state, set it in the NaviLink app first.

There is deliberately no script that sends a control command. The appliance heats a house and burns gas. A tool whose only purpose is to poke it from a terminal is not worth the accident it eventually causes. Use the Home app, and read the result here.

## Before a release

```bash
npm run build
node scripts/smoke.js
node scripts/pseudonymise.js --in tests/fixtures --check
```

`smoke.js` confirms the whole path still works end to end against a live account: sign-in, the AWS credential exchange, the MQTT handshake, identity uniqueness, and both read commands. `pseudonymise.js --check` confirms nothing identifying has crept into the committed fixtures.

## Reporting a bug

```bash
node scripts/capture-fixture.js --redact
```

Prints both frames with the account, the tokens and the MAC addresses removed, and nothing else touched. That last part is the point: the field that explains a problem is usually one nobody thought to copy by hand, so paste the whole thing, not a subset.

Read it before you paste it. The redaction is good and it is not a promise.

## Capturing a fixture

```bash
# Put the appliance in the state you want to record first, in the NaviLink app.
node scripts/capture-fixture.js --label recirculating
node scripts/pseudonymise.js --map ~/navilink.map.json
```

Captures land in `tests/fixtures/raw/`, which is git-ignored, because an unredacted frame carries your gateway's MAC address and your account's sequence numbers. Only pseudonymised files belong in `tests/fixtures/`.

### The substitution map

A JSON file of *your* real values, so it must never be committed. Keep it outside the repository, or name it `*.map.json` here, which is git-ignored.

```json
{
  "substitutions": [
    ["<your gateway's MAC, 12 hex characters>", "a1b2c3d4e5f6"],
    ["<your account sequence number>", "100000"],
    ["<your home sequence number>", "200000"],
    ["<your appliance's name>", "Zone One"]
  ],
  "rename": [
    ["navilink-ch1.channelinfo.json", "ncb-240e.channelinfo.json"]
  ]
}
```

Left-hand values are literal strings from your own capture; the placeholders above are only there because this file is published and your values must not be.

Substitutions are applied longest-first, so no replacement can be a prefix of another, and each is applied in both upper and lower case. That is not tidiness. The REST device list spells a MAC in upper case and the MQTT topics spell the same MAC in lower case, so a map that names only one of them leaves the other in the file.

Replace like with like. A MAC for a MAC, a six-digit sequence for a six-digit sequence. That keeps the shapes the parser is tested against realistic.

### Read the audit

Afterwards the script lists every MAC, email address, JWT and AWS key still present in the output, and fails if a mapped value survived. Only you can tell whether a remaining value is fictional, so read that list. Do not trust the exit code on its own.

The audit reads the *output*, not the list of fields it was told about. That difference matters. A NaviLink frame carries the gateway MAC twice in two spellings: once in `response.macAddress`, and again inside `clientID` and both topic strings. A rewrite driven by field names alone misses the second. `tests/unit/fixtures.test.ts` fails the build if a MAC that is not the documented example appears anywhere in `tests/fixtures/`.

```bash
# Audit what is already committed, without rewriting anything:
node scripts/pseudonymise.js --in tests/fixtures --check
```

## Note on output

`smoke.js` prints masked MACs. `capture-fixture.js` prints live addresses unless you pass `--redact`. Either way the output describes your home and your account: read it before attaching it to a public issue.
