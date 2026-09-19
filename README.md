# homebridge-navilink

[![Tests](https://github.com/tbaur/homebridge-navilink/actions/workflows/test.yml/badge.svg)](https://github.com/tbaur/homebridge-navilink/actions/workflows/test.yml) [![npm version](https://img.shields.io/npm/v/homebridge-navilink?style=flat-square)](https://www.npmjs.com/package/homebridge-navilink) [![npm downloads](https://img.shields.io/npm/dt/homebridge-navilink?label=downloads&style=flat-square)](https://www.npmjs.com/package/homebridge-navilink) [![Node.js](https://img.shields.io/badge/node-22%20%7C%7C%2024%20%7C%7C%2026-green)](https://nodejs.org) [![Homebridge](https://img.shields.io/badge/homebridge-2.x-purple)](https://homebridge.io) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Navien combi boilers and water heaters in Apple HomeKit.** Hot water and space-heating thermostats, recirculation, faults and temperature probes, with changes arriving as they happen rather than on a polling loop. Verified against an NCB-240E (firmware 4352).

Scheduling, weekly programmes and commissioning stay in the NaviLink app, which does them properly. This plugin adds the tile, the scene, the automation and the spoken command. It also adds a fault sensor that tells you the boiler has stopped before the shower does.

> **This plugin talks to Navien's cloud, not to your boiler.** There is no local API on a NaviLink gateway. It needs your NaviLink account. See [Supported devices](#supported-devices) and [Security](#security) before you install it.

## Features

### Per appliance

- **Hot water thermostat:** the domestic hot water setpoint, reading the actual outlet temperature. Respects the range your installer set
- **Heating thermostat:** the space-heating flow temperature. This is the boiler's water temperature, not a room thermostat. Your room thermostat still decides when heat is called for
- **Power switch:** on and off, with switching *off* refused by default because it stops central heating too
- **Recirculation switch:** starts the on-demand pump, so hot water reaches the tap without running it first. Only offered where a pump is fitted. The appliance runs the pump for a fixed period and then stops; the tile turns itself off when that happens
- **Fault sensor:** a contact sensor that opens on an error code, so HomeKit can notify you. The code goes to the log
- **Temperature sensors:** hot water in and out, heating flow and return, and the outdoor probe if one is fitted. Each disables itself if the appliance does not report it

### Reliability

- **Push, not polling.** The gateway sends changes as they happen, so a setpoint changed at the wall controller or in the NaviLink app reaches HomeKit in about a second. The poll is only a backstop
- **A rejected password is never retried.** Repeating a wrong password at a cloud is how an account gets locked. The plugin stops, says so once, and waits for you
- **Credentials are renewed on a clock,** a few minutes before they expire, so the connection is not already dead in the middle of the night
- **A connected socket is not a live appliance.** Readings carry the time they were taken, and a stale one becomes No Response instead of yesterday's setpoint
- **Honest state:** No Response until the appliance has actually been read, never a value it cannot confirm
- **Never loses your rooms:** a broken config disables the platform without unregistering anything

### Quality

- **Strict TypeScript,** with `noUncheckedIndexedAccess` and type-aware lint
- **Tested:** a behavioural Jest suite against fixtures recorded from real hardware, with a guard that fails the build if anything identifying reaches them
- **No analytics:** nothing is sent anywhere except Navien's own service
- **One runtime dependency,** Homebridge's own UI helper. The MQTT client is a small in-repo codec, not a `mqtt.js` dependency tree

Every accessory, field and log line is documented in [Detailed documentation](docs/README-DETAILED.md).

## Quick Start

### 1. Install

**Homebridge UI** (recommended): Plugins → Search `homebridge-navilink` → Install

```bash
npm install -g homebridge-navilink
```

### 2. Prepare your appliance

Your NaviLink gateway must be connected and showing as online in the NaviLink app. Nothing needs enabling: the plugin uses the same service the app does. If the app cannot see the appliance, neither can this.

### 3. Configure

**Homebridge UI** (recommended): open the plugin settings, enter your NaviLink email and password, and press **Sign in**. Every appliance on the account is listed, along with the accessories it can actually support. A recirculation switch is only offered where a pump is fitted. Tick what you want and press the Homebridge Save button.

Or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "NaviLink",
      "name": "NaviLink",
      "email": "you@example.com",
      "password": "your-navilink-password",
      "devices": [
        {
          "id": "a1b2c3d4e5f6:1",
          "name": "Boiler",
          "dhw": true,
          "heating": true,
          "fault": true
        }
      ]
    }
  ]
}
```

The `id` is your gateway's MAC address and the channel. The settings page writes it for you; finding it by hand is not worth the effort.

See the [full configuration reference](docs/README-DETAILED.md#full-configuration-reference) for every option.

### 4. Restart Homebridge

Accessories appear in the Home app after restart, showing No Response for the few seconds it takes to sign in and read the first status frame.

## Supported Devices

Any Navien appliance that the NaviLink app controls. The cloud interface is the same for all of them; what differs is which capabilities an appliance reports.

| Verified against | Notes |
|---|---|
| **NCB-240E (NG)** | Combi: hot water and space heating, firmware 4352 |

Other families are decoded from the same table the NaviLink app uses and are expected to work, but nobody has confirmed them here:

| Family | Expected |
|---|---|
| **NPE, NPE2, NPN** | Tankless water heaters. Hot water only; the heating thermostat disables itself |
| **NCB-H** | Combi with a buffer tank |
| **NHB** | Boiler. Space heating only |
| **NFB, NFC** | Boilers with hot water and space heating |
| **NVW** | Water heater with a tank |

If yours is not listed, it will most likely work. Please open an issue with the output of `node scripts/capture-fixture.js --redact` either way, so the table can say so with confidence.

## Configuration Options

Only one `NaviLink` platform block is supported. It can hold as many appliances as the account owns.

| Option | Required to run | Description |
|---|:-:|---|
| `name` | ✓ | Plugin instance name shown in Homebridge logs |
| `email` | ✓ | Your NaviLink account address. Needed before the plugin signs in |
| `password` | ✓ | Your NaviLink password. Needed before the plugin signs in |
| `devices` | ✓ | List of appliances. Needed before the plugin signs in |
| `options.statusIntervalSec` | | Backstop refresh, 30–3600 seconds (default 120) |
| `options.readOnly` | | Report everything, change nothing (default false) |
| `options.allowPowerOff` | | Let HomeKit switch the appliance off (default false) |

Each entry in `devices[]` takes `id` and `name`, plus an optional `channel` and one flag per accessory: `dhw`, `heating`, `power`, `recirculation`, `fault`, `temperatureSensors` and `outdoorSensor`. The [detailed documentation](docs/README-DETAILED.md#devices-entries) describes each one.

## Not Working?

1. **"NaviLink rejected the email address or password."** Sign in to the NaviLink app with the same credentials. The plugin has stopped trying on purpose, so fix the password and restart Homebridge
2. **Everything shows No Response.** Check the log for `the NaviLink platform is disabled`, which means the configuration could not be read
3. **The heating thermostat says it has no loop.** Your appliance reports no space-heating circuit. Turn the accessory off in the settings
4. **A recirculation switch that is not offered.** No pump is fitted, or it is not commissioned. Check the NaviLink app
5. **"The appliance refused a command for arriving too soon."** The cloud rate-limits control. The plugin pauses and retries on your next press

The [full troubleshooting list](docs/README-DETAILED.md#troubleshooting) covers more, including what Off on the hot water tile does once you allow power-off.

## Security

This plugin needs your NaviLink password, stores it in the Homebridge configuration file as every Homebridge credential is stored, and sends it to Navien to sign in. It is never written to the Homebridge log, never put into an accessory's cache, and redacted from anything the plugin prints. That is the honest summary; [SECURITY.md](SECURITY.md) has the detail, including what a capture contains and why the fixtures in this repository are pseudonymised.

## Requirements

- Homebridge 2.x
- Node.js 22, 24 or 26, matching what Homebridge 2.x itself supports
- A North American NaviLink account (`nlus`). Other Navien regions use different hosts and will look like a rejected password
- A NaviLink account with at least one gateway online
- A working internet connection

## More Info

- [Detailed documentation](docs/README-DETAILED.md)
- [Features](docs/FEATURES.md)
- [Protocol reference](docs/PROTOCOL.md): what the NaviLink cloud actually does
- [Development](DEVELOPMENT.md)
- [Report Issues](https://github.com/tbaur/homebridge-navilink/issues)
- [Changelog](CHANGELOG.md)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
