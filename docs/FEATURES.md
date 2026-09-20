# Features

**homebridge-navilink**

A checklist of what is built. The plugin aims to cover everything about a Navien appliance that HomeKit can express well, so this list is expected to grow. See the [roadmap](README-DETAILED.md#roadmap) for what is coming, and [PROTOCOL.md](PROTOCOL.md) for the interface already mapped.

## Built

### Per appliance

- ✅ **Hot water thermostat:** the domestic hot water setpoint, reading the actual outlet temperature, bounded by the range the installer set
- ✅ **Heating thermostat:** the space-heating flow temperature. This is the boiler's water temperature, not a room thermostat. Opt-in, because inventing a heating control nobody asked for is how a house gets cold
- ✅ **Power switch:** on and off, with switching *off* refused unless `options.allowPowerOff` is on
- ✅ **Recirculation switch:** starts the on-demand pump, so hot water reaches the tap without running it first. Offered only where a pump is fitted and commissioned. The tile turns itself off when the appliance stops the pump
- ✅ **Fault sensor:** a contact sensor that opens and logs on an error code, so HomeKit can notify you. The code and sub-code go to the log once per change (`error 12.3`, then `fault cleared`)
- ✅ **Temperature sensors:** hot water in and out, heating flow and return. Each disables itself if the appliance does not report it
- ✅ **Outdoor temperature sensor,** for an installation with a probe fitted for weather compensation
- ✅ Appliance family decoded from `unitType`, so capabilities are read from the hardware rather than assumed from the model number
- ✅ A heating loop is only exposed when the family, the commissioning flag and the installer's setpoint bounds all agree. A water heater that reports placeholder heating fields does not get a thermostat

### Reliability

- ✅ **Push, not polling.** A change made in the NaviLink app or at the wall controller reaches HomeKit in about a second. The poll is only a backstop
- ✅ **A rejected password is never retried.** The session stops and logs `NaviLink rejected the email address or password; sign-in stopped`
- ✅ **Credentials are renewed on a clock,** a few minutes before they expire. A planned refresh is not logged as an outage; tiles stay current
- ✅ **A connected socket is not a live appliance.** Readings carry the time they were taken, and a stale one becomes No Response
- ✅ **State:** No Response until the appliance has actually been read, and not a value it cannot confirm
- ✅ **Never loses your rooms:** a broken config disables the platform without unregistering anything (`platform disabled; cached accessories kept`)
- ✅ Control rate-limited per gateway. When the cloud answers `failCode 2`, the log is `rate limited` and the plugin pauses
- ✅ Exponential backoff with jitter on reconnect, to a capped ceiling. A real drop says so once, then `reconnect in Ns`
- ✅ REST circuit breaker for sustained cloud outages: fail-fast while open; a single half-open probe after cooldown. Transitions log as `Circuit breaker CLOSED -> OPEN` (warn) and `HALF_OPEN` / `CLOSED` (info). Firmware reads do not trip it.
- ✅ Accessory identity is `{gateway MAC}:{channel}:{kind}`, never the address or the name, so nothing about your network or your naming can orphan a tile
- ✅ Cached accessories adopted by identity, never replaced, so rooms, scenes and automations survive
- ✅ An unusable configuration disables the platform and keeps every accessory registered. Nothing is deleted
- ✅ Per-appliance validation: one bad entry is skipped with a warning instead of stopping the rest
- ✅ Read-only mode: every accessory reports state, and no control command is ever sent (`readOnly; write ignored`)
- ✅ Power-off guard, on by default, because a combi's power state governs central heating as well as hot water (`power-off disabled (allowPowerOff is off)`)
- ✅ Accessory name prefix (`options.accessoryPrefix`): one editable stem for every HomeKit tile, without changing accessory identity
- ✅ Opt-in diagnostics (`options.diagnosticsInterval`, default 0 / off): a periodic heartbeat (`Health: healthy | devices n/n | mqtt live | api p50/p95 (req, err)`), with `breaker OPEN` / `breaker HALF_OPEN` only when the REST circuit is not closed, and optional structured JSON (`options.structuredLogs`)
- ✅ Secrets redacted from every log line by shape, not by field name, so an unfamiliar response cannot leak a token
- ✅ HomeKit serial numbers are opaque generated values, never the gateway MAC
- ✅ Bounded I/O: separate connect and total timeouts, a capped response size, and a capped MQTT packet size

### Quality

- ✅ **Strict TypeScript,** with `noUncheckedIndexedAccess` and type-aware lint
- ✅ **Tested:** a behavioural Jest suite against fixtures recorded from real hardware, with a guard that fails the build if anything identifying reaches them
- ✅ **No analytics:** nothing is sent anywhere except Navien's own service
- ✅ **One runtime dependency,** Homebridge's own UI helper. The MQTT client is a small in-repo codec, not a `mqtt.js` dependency tree
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
| `heating` | Thermostat, heat-only. Setpoint is the flow target (the boiler's water temperature); current is the supply temperature |
| `power` | Switch |
| `recirculation` | Switch |
| `fault` | ContactSensor, open on an error code |
| `temperatureSensors` | Four TemperatureSensors: hot water out and in, heating flow and return |
| `outdoorSensor` | TemperatureSensor |

Tiles are named from the appliance (`Boiler Hot Water`) unless `options.accessoryPrefix` is set (`Zone One Hot Water`). Two appliances on one prefix keep the appliance name in the tile.

## Protocol surface

What the NaviLink cloud actually does: [PROTOCOL.md](PROTOCOL.md).

## Architecture

See [DEVELOPMENT.md](../DEVELOPMENT.md) for how to build, test and add a capability.
