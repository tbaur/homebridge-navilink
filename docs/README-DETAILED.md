# homebridge-navilink: detailed documentation

Everything the [README](../README.md) summarises, in full.

## Table of Contents

- [Scope](#scope)
- [Accessories in detail](#accessories-in-detail)
- [Reliability in detail](#reliability-in-detail)
- [Full configuration reference](#full-configuration-reference)
- [Accessory identity](#accessory-identity)
- [Reading the log](#reading-the-log)
- [Apple Shortcuts](#apple-shortcuts)
- [Roadmap](#roadmap)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Quality](#quality)
- [More](#more)

## Scope

This plugin exposes the parts of a Navien appliance that HomeKit can express as a tile, a scene, an automation or a spoken command. That set is smaller than the protocol, on purpose. It talks to the North American NaviLink stack (`nlus`) only.

Scheduling is the clearest example. The appliance has a weekly programme and the protocol has a command to set it, but HomeKit has no way to render a schedule and no vocabulary for one. A second scheduler would disagree with the one in the NaviLink app. That is worse than not having it.

HomeKit is good at noticing. The NaviLink app is not. A contact sensor that opens when the boiler faults will tell you before the shower does.

## Accessories in detail

Each tile is named from the appliance (`Boiler Hot Water`) unless you set `options.accessoryPrefix`. Then every tile uses that stem instead (`Zone One Hot Water`). Two appliances on one prefix keep the appliance name in the tile so Siri can tell them apart.

### Hot water thermostat (`dhw`)

A heat-only HomeKit thermostat.

- **Target temperature** is the DHW setpoint, clamped to the range your installer configured, which the appliance reports as `setupDHWTempMin` and `setupDHWTempMax`
- **Current temperature** is the outlet temperature, which is what is actually coming out
- **Current state** shows Heating while the appliance is powered, Off when it is not. There is no per-demand enable for hot water on the families this plugin supports, so the tile cannot show a draw in progress

Setting it to **Off is declined unless `options.allowPowerOff` is on.** On a combi that would stop central heating too, so the request is refused with one explanatory line. With the option on, Off on this tile powers the whole appliance down, the same as the power switch. Setting it to Heat while the appliance is off turns the unit on, including the heating side.

Dragging the slider sends one command. Writes are coalesced over a short window. The value that sticks is whatever the appliance reports afterwards. A setpoint outside the installer's range snaps to the limit, so you can see the clamp.

### Heating thermostat (`heating`)

A heat-only HomeKit thermostat for the **space-heating flow temperature**. This is the boiler's water temperature, not a room thermostat.

It sets how hot the water going to your radiators or underfloor loop is. Your existing room thermostat still decides *when* heat is called for. Raising this makes the house warm up faster and costs more. Lowering it is usually the efficiency win people are after.

- **Target temperature** is the flow setpoint, clamped to `setupHeatTempMin` and `setupHeatTempMax`
- **Current temperature** is the supply temperature
- **Off** disables the space-heating loop, which is a real thing the appliance supports and is not the same as switching it off

Off by default in configuration. An appliance with no heating loop disables this accessory on its first status frame and logs `no heating loop`.

### Power switch (`power`)

The appliance's own power state.

Switching it **on** works. Switching it **off** is refused unless `options.allowPowerOff` is on. The first refusal logs `power-off disabled (allowPowerOff is off)`. The guard exists because "turn off the water heater", said to Siri or swept up by a scene that turns everything off, would stop central heating in a house that may be empty and freezing.

### Recirculation switch (`recirculation`)

Starts the on-demand hot water recirculation pump, so hot water reaches a distant tap without running it first. The appliance runs the pump for a fixed period and then stops; the tile turns itself off when that happens.

The settings page offers this only where the appliance reports a pump (`onDemandUse` or `recirculationUse`). If you configure it by hand on an appliance without one, it disables itself and logs `no recirculation pump`.

### Fault sensor (`fault`)

A ContactSensor that reads **open** when the appliance reports a non-zero error code, and closed otherwise. Contact sensors are the right shape for this because the Home app will notify on them without any setup.

The code and sub-code go to the log once per change (`error 12.3`, then `fault cleared`). Look the number up in your installation manual; naming them in the plugin is on the [roadmap](#roadmap).

### Temperature sensors (`temperatureSensors`)

One tick, four sensors:

| Sensor | Field |
| --- | --- |
| Hot Water Out | `avgOutletTemp` |
| Hot Water In | `avgInletTemp` |
| Heating Flow | `avgSupplyTemp` |
| Heating Return | `avgReturnTemp` |

Each one disables itself and reports No Response if the appliance does not report it (`no outlet temp`, `no inlet temp`, `no flow temp`, `no return temp`). The flow-and-return pair is genuinely useful: the difference between them is how much heat the system is actually delivering.

### Outdoor sensor (`outdoorSensor`)

The outdoor probe, on an installation with one fitted for weather compensation. Most do not have one, which is why this is separate from the four above and off by default.

An appliance with no probe reports `0`. The plugin treats that as absent, not as 0 °F, and logs `no outdoor sensor`. The heuristic is wrong for an installation that really is at 0 °F. The trade is deliberate: a missing sensor is common, an exact zero is rare, and a permanent hard freeze in the Home app is worse than a missing tile.

## Reliability in detail

**Push, not polling.** The plugin subscribes to the gateway's own topics, not only to answers addressed to itself. A setpoint changed in the NaviLink app or at the wall controller therefore reaches HomeKit in about a second. The poll interval is a backstop for a push that was missed, not the normal path.

**A rejected password is fatal, once.** NaviLink answers a wrong password with HTTP 200 and the error in the body. A plugin that checks the status code treats that as transient and retries every few seconds until the account locks. This one decides on whether a token came back, stops for good on a rejected credential, and logs `NaviLink rejected the email address or password; sign-in stopped`. Any error it does not recognise stays retryable.

**Credentials are renewed on a clock.** The AWS credentials behind the MQTT connection are temporary and there is no working refresh endpoint, so the plugin signs in again from the top a few minutes before they expire. That close is expected: the tiles stay current and the log stays at debug. A brief reconnect at a time we choose is better than an expiry we do not control at three in the morning.

**A connected socket is not a live appliance.** The broker will hold a connection open for a gateway that has gone offline. Observations carry the time they were taken. One older than several poll intervals stops being reported as current: the tiles go to No Response instead of showing yesterday's setpoint.

**State is No Response** until the appliance has actually been read, and not a value it cannot confirm.

**Never loses your rooms.** A broken config disables the platform without unregistering anything (`platform disabled; cached accessories kept`).

**Control is rate-limited, and the cloud's own limit is honoured.** Commands to one gateway are spaced out. When the cloud refuses one for arriving too soon, the log is `rate limited` and the plugin pauses for 30 seconds. It does not keep sending to a channel that is already refusing.

**Backoff has jitter.** Reconnects use exponential backoff with full jitter to a capped ceiling, so a regional outage does not produce a synchronised stampede when it ends. A real drop logs the close, then `reconnect in Ns`, then `Publish-subscribe (mqtt) recovered` when the session is up again.

**REST outages fail fast.** After five connection or protocol failures in a minute, the REST circuit breaker opens (`Circuit breaker CLOSED -> OPEN` at warn). Sign-in is not sent again until a cooldown, then a single probe: `HALF_OPEN` and `CLOSED` at info if the cloud answers. A rejected password does not trip it, and a firmware read does not either. MQTT stays on the session reconnect loop.

## Full configuration reference

### Platform options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `platform` | string | — | Must be `NaviLink` |
| `name` | string | `NaviLink` | Shown in the Homebridge log |
| `email` | string | — | Your NaviLink account address |
| `password` | string | — | Your NaviLink password |
| `options.statusIntervalSec` | integer | `120` | Backstop refresh, 30–3600. Clamped with a warning if out of range |
| `options.readOnly` | boolean | `false` | Report everything, send nothing |
| `options.allowPowerOff` | boolean | `false` | Let HomeKit switch the appliance off |
| `options.diagnosticsInterval` | integer | `0` | Health heartbeat in the log, in seconds. `0` is off; otherwise `30`–`3600` |
| `options.structuredLogs` | boolean | `false` | With diagnostics, also emit each report as JSON |
| `options.accessoryPrefix` | string | *(blank)* | HomeKit names become `Prefix Hot Water`, `Prefix Heating`, and so on. Blank uses each appliance's name. Two appliances with the same prefix keep the appliance name in the tile so Siri can tell them apart |

A trailing space on the password is trimmed. A password manager will happily paste one. The trim is mentioned once in the log. Without that, the cloud rejects a password that looks right and the failure is unexplainable.

### `devices[]` entries

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | string | — | `{12 hex}:{channel}`, written by the settings page |
| `name` | string | — | The appliance's name. Accessories are named from it unless `options.accessoryPrefix` is set |
| `channel` | integer | `1` | Channel on the gateway. A cascade uses one per appliance |
| `dhw` | boolean | `true` | Hot water thermostat |
| `heating` | boolean | `false` | Space-heating thermostat |
| `power` | boolean | `false` | Power switch |
| `recirculation` | boolean | `false` | Recirculation switch |
| `fault` | boolean | `false` | Fault contact sensor |
| `temperatureSensors` | boolean | `false` | The four probe sensors |
| `outdoorSensor` | boolean | `false` | Outdoor probe |

Hot water is the only one on by default. Everything else is opt-in, including space heating.

### A complete example

```json
{
  "platforms": [
    {
      "platform": "NaviLink",
      "name": "NaviLink",
      "email": "you@example.com",
      "password": "your-navilink-password",
      "options": {
        "statusIntervalSec": 120,
        "readOnly": false,
        "allowPowerOff": false
      },
      "devices": [
        {
          "id": "a1b2c3d4e5f6:1",
          "name": "Boiler",
          "channel": 1,
          "dhw": true,
          "heating": true,
          "power": true,
          "recirculation": false,
          "fault": true,
          "temperatureSensors": true,
          "outdoorSensor": false
        }
      ]
    }
  ]
}
```

That produces eight accessories: two thermostats, a power switch, a fault sensor and four temperature sensors. Leave `options.accessoryPrefix` unset unless you want one stem on every tile. Leave `options.diagnosticsInterval` at `0` unless you want a periodic `Health:` line.

## Accessory identity

An accessory's identity is `{gateway MAC}:{channel}:{kind}`, hashed into its HomeKit UUID.

Nothing about your account, your network or your naming is in it. That is the point: renaming an appliance, changing `options.accessoryPrefix`, moving house, changing router or re-pairing the gateway all leave your tiles attached to their rooms, scenes and automations.

**Changing `id` by hand detaches everything.** HomeKit treats the result as new hardware, in no room, in no automation. The settings page writes `id` for you; there is no reason to edit it.

Serial numbers shown in the Home app are opaque generated values, not the gateway MAC. The Home app displays them, so they end up in screenshots and bug reports.

## Reading the log

Startup, in order:

```
adding Boiler Hot Water
adding Boiler Heating
Boiler firmware 4352
Publish-subscribe (mqtt) up
Boiler channel 1 family=NCB
1 appliance(s), 8 accessory(ies)
```

`family=` is once, when the gateway first describes the channel. A later channelinfo (poll, reconnect, credential refresh) stays at debug.

`adding` and `removing` name each accessory, the same way the other plugins in this family do. A rename is a line of its own (`Boiler Hot Water is now named Downstairs Hot Water`). That keeps the tile in its room; a remove-and-add would not.

The account address is debug only, and masked. Appliance lines use the name you configured. A gateway with no name is logged as `gateway …E5F6` (last four of the MAC), only as a fallback.

A HomeKit write that was accepted:

```
Boiler Hot Water: SET 120 °F
```

(The number and unit are whatever the appliance speaks. A Celsius unit would log `SET 49.0 °C`.)

A write that was declined by a rule rather than by the appliance:

```
Boiler Hot Water: readOnly; write ignored
```

An outage, and its recovery. Every outage warns on the way in so that it gets a matching line on the way out; without one, a log shows the cloud failing and never recovering:

```
NaviLink broker closed the connection (code 1006)
reconnect in 2s
Publish-subscribe (mqtt) up
Publish-subscribe (mqtt) recovered
```

A continuing outage repeats at most hourly, at debug in between.

A REST cloud outage, as opposed to a broker drop:

```
Circuit breaker CLOSED -> OPEN
reconnect in 30s
Circuit breaker OPEN -> HALF_OPEN
Circuit breaker HALF_OPEN -> CLOSED
```

The OPEN line is the warn. While the breaker is open, sign-in is not sent. Diagnostics, if on, add `breaker OPEN` to the heartbeat until the probe succeeds.

A credential refresh is not an outage. The plugin closes the socket itself a few minutes before the AWS credentials expire, signs in again, and the tiles stay current. That is debug only. `family=`, firmware and `Publish-subscribe (mqtt) up` do not repeat at info.

### Diagnostics (optional)

Set `options.diagnosticsInterval` to a value between `30` and `3600` seconds to turn on an opt-in health heartbeat. It is **off by default** (`0`) and is **logs only — nothing is exposed in HomeKit**. It reads in-memory state; it never makes a network call.

It pairs with `options.structuredLogs: true`, which adds a JSON line next to the human one.

```
Health: healthy | devices 1/1 | mqtt live | api p50 80ms p95 120ms (req 3, err 0)
```

When the REST breaker is not closed, it appears on that line:

```
Health: degraded [circuitBreakerOpen] | devices 1/1 | breaker OPEN | mqtt connecting | api p50 80ms p95 120ms (req 3, err 5)
```

| `msg` | Level | When |
| --- | --- | --- |
| `diagnostics.start` / `diagnostics.stop` | info | Boot and shutdown, with a redacted config echo |
| `health` | info | Every `diagnosticsInterval` seconds |
| `health.degraded` / `health.recovered` | warn / info | When the rollup flips |

Health is `degraded` when the MQTT session has been down for more than a minute, the account was rejected, the REST circuit breaker is open or probing (`circuitBreakerOpen`), or recent REST calls are failing at a high rate. A non-CLOSED breaker also appears on the human line as `breaker OPEN` or `breaker HALF_OPEN`. Counters on a `health` line are per-interval deltas; the start/stop snapshots are session totals. Credentials, appliance names and the accessory prefix are never in the JSON (the prefix is a boolean: set or not).

## Apple Shortcuts

Everything here is an ordinary HomeKit accessory, so it works in Shortcuts and in Home automations without anything special.

Combinations worth knowing:

- **"Set hot water to 49"**: a spoken command the NaviLink app cannot offer
- **Fault sensor → notification**, which is the single most useful thing here. You find out the boiler has stopped when it stops, not when the shower runs cold
- **Away scene lowers the heating flow temperature.** That is cheaper and safer in winter than switching heating off entirely
- **Recirculation on a morning schedule**, so the tap is hot when you get up, without the pump running all night
- **Heating flow and return into a chart**, via any accessory-logging app, which shows how hard your system is working

## Roadmap

In rough order, matching [FEATURES.md](FEATURES.md#not-built-yet):

1. Recirculation setpoint (`0x02000007`)
2. A "warming up" recirculation mode, the third value `onDemand` takes
3. Hot water flow as a sensor, so "someone is showering" can trigger an automation
4. Gas usage, once there is a way to present a cumulative counter that the Home app does not render as nonsense
5. A cascade-aware summary accessory
6. Fault-code names in the log instead of a number to look up

Weekly schedules, commissioning settings and descaling reminders are [not planned](FEATURES.md#not-planned).

## Troubleshooting

**1. "NaviLink rejected the email address or password."**
The plugin has stopped trying on purpose, so the account is not locked out. Sign in to the NaviLink app with the same credentials to confirm, then fix the password in the plugin settings and restart Homebridge.

**2. "NaviLink does not recognise that email address."**
The account does not exist. Check for a typo, and note that the plugin trims surrounding whitespace but cannot fix a wrong address.

**3. Everything shows No Response and stays that way.**
Look for `platform disabled` in the log. That means the configuration could not be read; the error above it says which part. `Circuit breaker CLOSED -> OPEN` is a cloud outage, not a config error; see 13.

**4. Accessories exist but never get a reading.**
Check the gateway shows as connected in the NaviLink app. The plugin cannot see anything the app cannot.

**5. The heating thermostat reports no loop.**
Look for `no heating loop` in the log. Your appliance reports `heatControl` off, or an empty setpoint range. That is a water heater, or a combi whose heating side was never commissioned. Turn the accessory off in the settings.

**6. The heating thermostat accepts a change and nothing happens.**
Check the gateway still shows as connected in the NaviLink app, and look at the log around the write. Please open an issue with the surrounding lines if it stays stuck.

**7. The hot water thermostat will not turn the appliance off.**
By default. On a combi that stops central heating too. Turn on `options.allowPowerOff` if that is genuinely what you want: Off on the hot-water tile then powers the whole appliance down, and Heat while it is off turns it back on.

**8. `rate limited`**
The cloud rate-limits control, usually after a scene touched several tiles at once. The plugin pauses for 30 seconds; press again after that.

**9. A temperature sensor shows No Response.**
The appliance is not reporting that probe. The first observation logs which one (`no outlet temp`, `no inlet temp`, `no flow temp`, `no return temp`, `no outdoor sensor`).

**10. The outdoor sensor never works.**
Most installations have no outdoor probe. An appliance without one reports `0`, which is treated as absent (`no outdoor sensor`).

**11. Setpoints snap to a different value.**
Expected. The appliance clamps to the range your installer set, and a Fahrenheit appliance only accepts whole degrees, so HomeKit's Celsius value lands on the nearest one. The plugin adopts what the appliance reports, not what was asked for.

**12. A tile lost its room after an update.**
Should not happen; identity is stable by design. If `id` was edited by hand, that will do it. Otherwise please open an issue, because it is a bug.

**13. `Circuit breaker CLOSED -> OPEN`**
NaviLink REST is being treated as down. Sign-in is paused until the cooldown; tiles stay No Response. When the cloud answers again the log is `HALF_OPEN` then `CLOSED`. A firmware line that never arrives is not this: firmware is optional and does not trip the breaker.

**14. It all stops when the internet does.**
There is no local interface on a NaviLink gateway. Nothing can be done about this from here.

## Security

The plugin needs your NaviLink password and stores it in the Homebridge configuration file, as every Homebridge credential is stored. It is never written to the log, never placed in an accessory's cache, and redacted by shape from anything the plugin prints. An unfamiliar response that carries an unexpected token is still redacted.

See [SECURITY.md](../SECURITY.md) for the detail, including what a raw capture contains and why the fixtures here are pseudonymised.

## Quality

- **Strict TypeScript,** with `noUncheckedIndexedAccess` and type-aware lint; warnings are failures
- **Tested:** a behavioural Jest suite against fixtures recorded from real hardware, gated at 80% of statements, with a guard that fails the build if a MAC address, email or token that is not the documented example appears in `tests/fixtures/`
- A CI step that rejects credential-shaped strings in the published docs, fixtures, schema and issue templates. Unit tests that hold fake JWTs are outside that scan on purpose
- `npm audit` on the runtime tree on every PR; OSV-Scanner on the full tree, weekly and on every PR
- **No analytics:** nothing is sent anywhere except Navien's own service
- **One runtime dependency:** Homebridge's own UI helper. The MQTT client is a small in-repo codec, not a `mqtt.js` dependency tree

## More

- [Features](FEATURES.md)
- [Protocol reference](PROTOCOL.md)
- [Development](../DEVELOPMENT.md)
- [Security policy](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)
