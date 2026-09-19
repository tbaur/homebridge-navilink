---
name: Bug Report
about: Report a bug to help us improve
title: '[Bug] '
labels: bug
assignees: ''
---

> **Never paste your NaviLink email, password, or anything from a `sign-in`
> response.** The tokens in that response are live credentials for your account
> and for AWS IoT. The plugin redacts them from its own logs; please keep them
> out of anything you paste here.

## Description
A clear description of what the bug is.

## Environment

- **Plugin version**:
- **Homebridge version**:
- **Node.js version**:
- **Operating system**:
- **Appliance model**: e.g. NCB-240E, NPE-240A2
- **Family reported in the log**: the `family=` value on the `channel` line at startup, e.g. `NCB`
- **Firmware version**: shown in the NaviLink app under the device, or on the startup log line
- **Accessories affected**: hot water thermostat / heating thermostat / power / recirculation / fault / temperature sensor

## Steps to Reproduce

1.
2.
3.

## Expected Behavior
What you expected to happen.

## Actual Behavior
What actually happened.

## Logs

Run Homebridge with debug logging (`homebridge -D`) and include the startup
lines plus anything around the failure.

<details>
<summary>Click to expand logs</summary>

```
Paste relevant logs here
```

</details>

## Channel status

For anything to do with a temperature, a setpoint or a missing accessory, the
appliance's own status frame usually settles it:

```bash
node scripts/capture-fixture.js --redact
```

That prints a redacted `channelinfo` and `channelstatus` pair: the MAC address,
your account and the tokens are removed, and the readings are left alone. Please
paste that, not a hand-copied subset. The field that explains the problem is
usually one nobody thought to copy.

## Additional Context
Any other context about the problem. If the appliance behaves differently in the
NaviLink app than it does in HomeKit, say what the app shows.
