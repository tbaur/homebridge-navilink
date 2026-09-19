# Features

**homebridge-navilink**

A checklist of what is built. The plugin aims to cover everything about a Navien appliance that HomeKit can express well, so this list is expected to grow. See the [roadmap](README-DETAILED.md#roadmap) for what is coming, and [PROTOCOL.md](PROTOCOL.md) for the interface already mapped.

## Built

- ✅ Multi-appliance platform: every appliance on one NaviLink account in one platform block, including a cascade behind one gateway. A cascade fault opens the contact sensor if any unit reports an error code
- ✅ Hot water thermostat: the DHW setpoint, reading the real outlet temperature, bounded by the range the installer set
- ✅ Space-heating thermostat: the flow-temperature setpoint, reading the real supply temperature. Opt-in, because inventing a heating control nobody asked for is how a house gets cold
- ✅ Power switch, with switching *off* refused unless `options.allowPowerOff` is on
- ✅ Recirculation switch for the on-demand pump, offered only where one is fitted and commissioned. The tile turns itself off when the appliance stops the pump
- ✅ Fault sensor: a contact sensor that opens on an error code, so HomeKit notifies you. The code and sub-code go to the log once per change
- ✅ Four temperature sensors for hot water in and out, and heating flow and return. Each disables itself if the appliance does not report it
- ✅ Outdoor temperature sensor, for an installation with a probe fitted for weather compensation
- ✅ Appliance family decoded from `unitType`, so capabilities are read from the hardware rather than assumed from the model number
- ✅ A heating loop is only exposed when the family, the commissioning flag and the installer's setpoint bounds all agree. A water heater that reports placeholder heating fields does not get a thermostat
- ✅ Real-time push: a change made in the NaviLink app or at the wall controller reaches HomeKit in about a second, because the plugin subscribes to the gateway's topics and not only to its own answers
- ✅ Polling as a backstop only, at an interval you choose, defaulting to a deliberately unhurried two minutes
- ✅ Native temperature scale handled honestly: half-degree Celsius or whole-degree Fahrenheit on the wire, converted for HomeKit. The plugin adopts the appliance's own clamped answer, not the requested value
- ✅ Setpoint writes coalesced, so dragging a slider sends one command instead of thirty
- ✅ Optimistic state after a write, corrected by the next real frame, so a tile settles instead of flicking back
- ✅ Control rate-limited per gateway. When the cloud answers `failCode 2`, the plugin pauses instead of hammering the lockout
- ✅ A rejected password stops the session permanently, with one explanation. It is never retried, because retrying is how an account gets locked
- ✅ Credentials renewed a few minutes before they expire, on a clock, so the connection has not already failed
- ✅ Exponential backoff with jitter on reconnect, to a capped ceiling
- ✅ Stale readings are not presented as current: an observation older than several poll intervals becomes No Response
- ✅ Accessory identity is `{gateway MAC}:{channel}:{kind}`, never the address or the name, so nothing about your network or your naming can orphan a tile
- ✅ Cached accessories adopted by identity, never replaced, so rooms, scenes and automations survive
- ✅ Reports HomeKit "No Response" until real state has been observed, and again once the cloud stops answering
- ✅ An unusable configuration disables the platform and keeps every accessory registered. Nothing is deleted
- ✅ Per-appliance validation: one bad entry is skipped with a warning instead of stopping the rest
- ✅ Read-only mode: every accessory reports state, and no control command is ever sent
- ✅ Power-off guard, on by default, because a combi's power state governs central heating as well as hot water
- ✅ Secrets redacted from every log line by shape, not by field name, so an unfamiliar response cannot leak a token
- ✅ HomeKit serial numbers are opaque generated values, never the gateway MAC
- ✅ Bounded I/O: separate connect and total timeouts, a capped response size, and a capped MQTT packet size
- ✅ A minimal MQTT 3.1.1 codec in this repository, because `mqtt.js` drops the signed query string that AWS IoT needs
- ✅ Custom Homebridge UI settings page that signs in and lists your appliances, plus a plain `config.schema.json` form
- ✅ Homebridge v2.0+ support
- ✅ Node.js 22, 24 and 26 support

## Not built yet

Planned, in roughly this order. None of it is committed to a date:

- ⏳ Recirculation setpoint (`0x02000007`), which is not implemented yet
- ⏳ A "warming up" recirculation mode, the third value `onDemand` takes
- ⏳ Hot water flow as a sensor, so "someone is running a shower" can trigger an automation. Needs a HomeKit service that renders acceptably
- ⏳ Gas usage, once there is a way to present a cumulative counter that the Home app does not render as nonsense
- ⏳ A cascade-aware summary accessory, for installations with several appliances behind one gateway
- ⏳ Fault-code names in the log, rather than asking you to look the number up in the manual

## Not planned

- ❌ **Weekly schedules and programmes.** The NaviLink app does these properly, and HomeKit has no vocabulary for them. A second scheduler would disagree with the app. That is worse than having none.
- ❌ **Commissioning, DIP switches and installer settings.** Present in the protocol, read-only here. A home-automation plugin has no business writing them
- ❌ **Descaling and maintenance reminders.** Better where the service history is
- ❌ **A local-only mode.** A NaviLink gateway has no local interface. If Navien ships one, this changes.

## Accessories per appliance

| Configuration | HomeKit service |
| --- | --- |
| `dhw` | Thermostat, heat-only. Setpoint is the DHW target; current is the outlet temperature |
| `heating` | Thermostat, heat-only. Setpoint is the flow target; current is the supply temperature |
| `power` | Switch |
| `recirculation` | Switch |
| `fault` | ContactSensor, open on an error code |
| `temperatureSensors` | Four TemperatureSensors: hot water out and in, heating flow and return |
| `outdoorSensor` | TemperatureSensor |

## Protocol surface

What the NaviLink cloud actually does: [PROTOCOL.md](PROTOCOL.md).

## Architecture

See [DEVELOPMENT.md](../DEVELOPMENT.md) for how to build, test and add a capability.
