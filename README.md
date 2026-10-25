# homebridge-navilink

[![Tests](https://github.com/tbaur/homebridge-navilink/actions/workflows/test.yml/badge.svg)](https://github.com/tbaur/homebridge-navilink/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/homebridge-navilink?style=flat-square)](https://www.npmjs.com/package/homebridge-navilink)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-navilink?label=downloads&style=flat-square)](https://www.npmjs.com/package/homebridge-navilink)
[![Node.js](https://img.shields.io/badge/node-22%20%7C%7C%2024%20%7C%7C%2026-green)](https://nodejs.org)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![Homebridge](https://img.shields.io/badge/homebridge-2.x-purple)](https://homebridge.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Navien combi boilers and water heaters in Apple HomeKit.** Hot water and space-heating thermostats, recirculation, faults and temperature probes, with changes arriving as they happen rather than on a polling loop. Verified against an NCB-240E (firmware 4352).

Scheduling, weekly programmes and commissioning stay in the NaviLink app, which does them properly. This plugin adds the tile, the scene, the automation and the spoken command. It also adds a fault sensor that tells you the boiler has stopped before the shower does.

## Features

- **Hot water thermostat:** the domestic hot water setpoint, reading the actual outlet temperature
- **Heating thermostat:** the space-heating flow temperature. This is the boiler's water temperature
- **Power switch:** on and off, with switching *off* refused by default because it stops central heating
- **Recirculation switch:** starts the on-demand pump, so hot water reaches the tap without running it first. Only offered where a pump is fitted
- **Fault sensor:** a contact sensor that opens and logs on an error code, so HomeKit can notify you
- **Temperature sensors:** hot water in and out, heating flow and return, and the optional outdoor probe
- **Push, not polling.** A change at the wall controller or in the NaviLink app reaches HomeKit in about a second. A rejected password is never retried
- **No analytics.** Nothing is sent anywhere except Navien's own service
- **PagerDuty** *(optional)*: pages through [homebridge-pagerduty](https://github.com/tbaur/homebridge-pagerduty) on a boiler fault or a rejected sign-in. See [setup](docs/README-DETAILED.md#pagerduty)

The [detailed documentation](docs/README-DETAILED.md) describes every accessory, setting and log line.

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

The `id` is your gateway's MAC address and the channel. The settings page writes it for you. The [configuration reference](docs/README-DETAILED.md#full-configuration-reference) lists every option.

### 4. Restart Homebridge

Accessories appear in the Home app after restart, showing No Response for the few seconds it takes to sign in and read the first status frame.

## Supported devices

Any Navien appliance that the NaviLink app controls. Confirmed on an NCB-240E (firmware 4352). Other families are decoded from the same table the app uses. The [device table](docs/README-DETAILED.md#supported-devices) lists what each family is expected to expose.

## Not Working?

1. **"NaviLink rejected the email address or password."** Sign in to the NaviLink app with the same credentials. The plugin has stopped trying on purpose, so fix the password and restart Homebridge
2. **Everything shows No Response.** Check the log for `platform disabled`, which means the configuration could not be read
3. **The heating thermostat says it has no loop.** Your appliance reports no space-heating circuit
4. **A recirculation switch that is not offered.** No pump is fitted, or it is not commissioned
5. **`rate limited`.** The cloud rate-limits control. The plugin pauses and retries on the next press
6. **`Circuit breaker CLOSED -> OPEN`.** Sign-in is paused; tiles stay No Response until the cloud recovers

The [full troubleshooting list](docs/README-DETAILED.md#troubleshooting) covers more, including what Off on the hot water tile does once you allow power-off.

## Security

This plugin needs your NaviLink password, stores it in the Homebridge configuration file as every Homebridge credential is stored, and sends it to Navien to sign in. It is never written to the Homebridge log, never put into an accessory's cache, and redacted from anything the plugin prints. [SECURITY.md](SECURITY.md) has the detail, including what a capture contains and why the fixtures in this repository are pseudonymised.

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

## Trademarks

homebridge-navilink is an independent project. It is not affiliated with or endorsed by Navien. Navien and NaviLink are trademarks of Kyungdong Navien Co., Ltd.

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
