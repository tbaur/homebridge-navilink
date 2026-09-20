# Security Policy

## Supported Versions

| Version | Supported              |
| ------- | ---------------------- |
| 1.x.x   | ✅ Active support      |
| 0.x.x   | ❌ No longer supported |

## Reporting a Vulnerability

Do not open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/tbaur/homebridge-navilink/security/advisories/new), and include a description, how to reproduce it, and the impact.

## The honest summary

**This plugin needs your NaviLink password and stores it in plain text in the Homebridge configuration file.** That is how every Homebridge plugin that talks to a cloud service works, because Homebridge offers no secret store. It deserves saying plainly.

What follows from that:

- Anyone who can read your Homebridge config can sign in to your NaviLink account, which controls your boiler.
- The plugin uses an interface Navien has never published. Navien can change or withdraw it at any time, without notice, and would be within their rights to.
- There is no local fallback. A NaviLink gateway has no LAN interface, so this stops working when your internet does.

If those are not acceptable, this plugin is not for you, and that is a reasonable conclusion.

## Security Measures

- **Credentials in one place.** The password is read from configuration, used to sign in, and held only in memory. It is never written to a log, never placed in an accessory's cache, never sent anywhere except Navien's sign-in endpoint over HTTPS, and never passed to a script as a command-line argument.
- **Redaction by shape, not by name.** `src/utils/redact.ts` matches JWTs, AWS key ids, signed-URL parameters and credential-shaped JSON fields by their *form*. A field name list would miss a token in a response shape nobody anticipated; this does not.
- **Masked identifiers in the log.** The account address is debug only, and appears as `s…e@example.com`. Appliance lines use the name you configured. A gateway MAC is logged only as a fallback, as `gateway …E5F6` (last four characters). Discovery warnings use that fallback too: the cloud's own appliance label is often a room, so it stays on the settings page and out of the log. Both the configured name and the masked MAC identify you, and a Homebridge log gets pasted into issues. `options.accessoryPrefix` is a room-shaped name: it is length-capped and stripped of control characters the same way, and it never appears in structured diagnostics (those emit a boolean: set or not).
- **The accessory cache holds identity, not credentials.** Homebridge persists `{mac}:{channel}` as `deviceId` so a restart adopts the same tile. That file is plain JSON and is included in diagnostic bundles, so it must never hold the password, a token or a signed AWS URL. The MAC is the appliance's address in every MQTT topic. HomeKit serial numbers are opaque generated values, not the MAC.
- **HomeKit serial numbers are opaque generated values,** not the gateway MAC. The Home app displays them, so they reach screenshots.
- **Input validation.** Config is checked at startup. A missing account, or a `devices` value that is not a list, disables the platform without unregistering accessories. A bad appliance entry is skipped. Appliance names and `options.accessoryPrefix` are stripped of control characters and length-capped before they reach a log line or a characteristic.
- **Bounded I/O.** Separate connect and total timeouts on every request, a capped HTTP response size, and a capped MQTT packet size, so a hostile or broken response cannot exhaust memory.
- **A rejected credential stops the session.** Retrying a wrong password is how an account gets locked; the plugin declines to do it.
- **Minimal dependencies.** One at runtime: Homebridge's own UI helper. The MQTT client is in this repository, for a protocol reason ([PROTOCOL.md](docs/PROTOCOL.md)) that also reduces supply-chain surface.
- **Dependencies audited.** CI runs `npm audit` on the runtime tree and OSV-Scanner on the full tree.
- **A CI step rejects credential-shaped strings** in the published docs, fixtures, schema and issue templates, so a token cannot be committed by accident. Unit tests that hold fake JWTs are outside that scan on purpose.
- **Opt-in diagnostics are logs only.** `options.diagnosticsInterval` writes a periodic health line from in-memory counters. It never makes a network call, never appears in HomeKit, and the structured JSON (`options.structuredLogs`) omits credentials, appliance names and the accessory prefix string.

## The settings page

The configuration UI runs in its own short-lived process and is the one place that handles a typed password.

- The password is used for the sign-in of the request that carried it. It is not cached between requests and not written to a file by that process.
- Nothing from a sign-in response reaches the browser. The page receives appliances; the tokens and AWS credentials stay in the UI process and die with the request.
- Diagnostic output handed back on failure is the plugin's own redacted log, filtered a second time on the way out, because a line that reaches a browser can end up in a screenshot in a public issue.

## Captures and fixtures

A raw frame from the NaviLink cloud carries your gateway's MAC address and your account's sequence numbers. The `device/info` endpoint also returns your installation's **street address and coordinates**, which is why the plugin reads only the firmware version from it and nothing else is available to callers.

- Raw captures go to `tests/fixtures/raw/`, which is git-ignored.
- `scripts/pseudonymise.js` rewrites them and then audits its own output. It reports every identifier that remains. It does not trust a list of field names. A MAC appears twice in two spellings in these frames, and a name-driven rewrite misses the second.
- `tests/unit/fixtures.test.ts` fails the build if a MAC, email address, JWT or AWS key that is not the documented example appears in `tests/fixtures/`.
- `scripts/capture-fixture.js --redact` is the form to paste into a bug report. Read it before you paste it: the redaction is good, and it is not a promise.

## Best Practices for Users

1. Keep Homebridge and this plugin updated.
2. Run Homebridge with minimal privileges, and do not expose it to the internet.
3. Protect the Homebridge configuration file and any backup of it as you would a password file, because it contains one.
4. Use `options.readOnly` if you want the readings without the plugin being able to change anything.
5. Leave `options.allowPowerOff` off unless you have thought about what "turn everything off" means in February.
6. Consider a NaviLink account used only for this, if you would rather not have your primary one in a config file.

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity
  - Critical: 24-48 hours
  - High: 1 week
  - Medium: 2 weeks
  - Low: Next release
