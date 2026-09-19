# The NaviLink cloud: what this plugin relies on

Navien publishes no interface. This is the wire the NaviLink app uses, as this plugin talks to it. Fixtures come from an NCB-240E.

## Transport

Two protocols, in sequence.

**REST over HTTPS** for sign-in and the device list, at `https://nlus.naviensmartcontrol.com/api/v2`. This is also where the AWS credentials come from.

**MQTT 3.1.1 over WebSockets** to AWS IoT Core at `a1t30mldyslmuq-ats.iot.us-east-1.amazonaws.com`, authenticated with SigV4 using the temporary credentials the sign-in returned. This carries all state and all control.

There is **no local interface.** The gateway is a cloud client; nothing on the LAN answers.

### The authorization header has no `Bearer`

```
authorization: eyJraWQiOi...
```

Lower-case, and the bare token. Adding the `Bearer` prefix that every other API in the world wants gets a 401.

### Sign-in failures arrive as HTTP 200

```json
{ "code": 1001, "msg": "INVALID_USER_PASSWORD" }
```

A rejected password is **not** a 401. It is a 200 with the failure in the body. Code that branches on the status code treats a wrong password as a transient fault and retries it. That is how an account gets locked out. This plugin decides on whether a token came back, never on the status.

`src/api/rest.ts` maps `USER_NOT_FOUND` and `INVALID_USER_PASSWORD` to a fatal error that stops the session for good. Anything else stays retryable, because guessing that an unfamiliar error is a bad credential would stop the plugin recovering from something temporary.

### There is no usable token refresh

The sign-in response carries a `refreshToken`, and `/auth/refresh` exists on the v2.1 path. Neither helps: the AWS IoT credentials are what the MQTT connection actually needs, and no refresh path has been found that reissues them.

So the plugin re-signs in from the top before the credentials expire. The timer is `min(authorizationExpiresIn, authenticationExpiresIn)` minus five minutes, with a 60-second floor. If the cloud's lifetime is not believable (outside 5 minutes to 24 hours), it falls back to 50 minutes. A full sign-in is the only sequence known to produce a working credential set. A brief reconnect on a clock we choose is better than an expiry we do not control.

### SigV4 is signed with the bare host

The pre-signed WebSocket URL signs `host` without `:443`. Both readings of the SigV4 rule for a default port are defensible. The wrong one fails as a silently rejected upgrade that looks exactly like a bad password. The bare host is what this endpoint wants. The plugin tries the other form second, so a user does not have to guess.

### The MQTT client is hand-rolled, for a reason

`mqtt.js` does not work here. It rebuilds the WebSocket path when it opens the connection and **drops the signed query string**, so the upgrade is rejected and the connection closes without a diagnosable error.

`src/api/mqtt-codec.ts` is a minimal MQTT 3.1.1 encoder and decoder over Node's built-in `WebSocket`. It is a small in-repo codec, it is fully tested, and it keeps the signed URL intact.

## Topics

Two prefixes, and which one a message uses is not arbitrary.

| Prefix | Shape | Carries |
| --- | --- | --- |
| Gateway | `cmd/{deviceType}/navilink-{mac}/...` | Everything sent *to* an appliance |
| Session | `cmd/{deviceType}/{homeSeq}/{userSeq}/{clientId}/res/...` | Answers back to this client |

```
cmd/1/navilink-a1b2c3d4e5f6/status/start            channel info request
cmd/1/navilink-a1b2c3d4e5f6/status/channelstatus    status request
cmd/1/navilink-a1b2c3d4e5f6/control                 every control command
cmd/1/200000/100000/{clientId}/res/channelinfo      channel descriptions
cmd/1/200000/100000/{clientId}/res/channelstatus    state
cmd/1/200000/100000/{clientId}/res/controlfail      a refused command
```

### Answers arrive for requests you did not make

The gateway publishes to the response topic of whichever client asked. But the plugin also subscribes to the gateway prefix, which is how a setpoint changed **in the NaviLink app or at the wall controller** reaches HomeKit in about a second without being polled for.

This is why the plugin feels live, not laggy. It is worth not breaking.

## The request envelope

```json
{
  "clientID": "a-uuid",
  "protocolVersion": 1,
  "sessionID": "1700000000000",
  "requestTopic": "cmd/1/navilink-a1b2c3d4e5f6/control",
  "responseTopic": "cmd/1/200000/100000/{clientId}/res/channelstatus",
  "request": {
    "additionalValue": "5089",
    "command": 33554435,
    "deviceType": 1,
    "macAddress": "a1b2c3d4e5f6",
    "control": { "channelNumber": 1, "mode": "DHWTemperature", "param": [120] }
  }
}
```

### `sessionID` cannot be used to correlate

The cloud echoes it back **truncated from milliseconds to seconds**. A client that matches a response to its request on this value silently never matches. Responses are attributed by topic instead.

### `additionalValue` is a string, and it matters

Observed as `"5089"` on one gateway and empty on another. It is echoed in every request as the string the gateway sent.

## Reading state

Two commands.

| Command | Code | Answered on |
| --- | --- | --- |
| Channel info | `0x01000001` (16777217) | `res/channelinfo` |
| Channel status | `0x01000004` (16777220) | `res/channelstatus` |

**Order matters.** `channelinfo` carries `temperatureType`. Without it a status frame cannot be decoded at all: every temperature in it is ambiguous by a factor of two. The plugin asks for `channelinfo` first and treats a status frame for an undescribed channel as a prompt to ask again.

### Temperatures are scaled by the unit's own setting

| `temperatureType` | Wire value | Means |
| --- | --- | --- |
| 1 | half-degrees Celsius | `95` is 47.5 °C |
| 2 | whole degrees Fahrenheit | `120` is 120 °F |

A Celsius appliance therefore has twice the resolution of a Fahrenheit one. HomeKit is Celsius-only, so a Fahrenheit appliance moves in 0.56 °C steps. The plugin publishes a 0.5 °C step and adopts whatever the appliance answers with. It does not pretend it landed on the requested value.

### Booleans are 1 and 2, not 1 and 0

`1` is on, `2` is off, and **`0` means unknown**. Every disabled feature on the test appliance reported `2`. A command carrying `0` is asking for nothing.

### Zero is a real temperature

`outdoorTemperature: 0` on the test appliance means no sensor is fitted, not 0 °F. Several probe fields do this. The plugin treats a zero in a probe field as absent and disables that sensor with one explanatory line, because publishing it would put a permanent hard freeze on somebody's Home app.

This is a heuristic and it is wrong for an installation that really is at 0 °F. That trade is deliberate: a missing sensor is common and a reading of exactly zero is rare.

### A water heater fills in the heating fields anyway

An NPE-2 answers the same frames as a combi and reports `setupHeatTempMin` and `setupHeatTempMax` **both as 32**. That is not a one-degree range, it is "there is nothing here".

So the plugin requires three things to agree before it exposes a heating thermostat: the family can heat a loop, `heatControl` is on, and the installer's bounds describe a real range. Any one of those alone would put a working-looking thermostat on an appliance with no radiators attached to it.

### Field names, as observed

| Field | Meaning |
| --- | --- |
| `DHWSettingTemp` | Hot water setpoint |
| `heatSettingTemp` | Space-heating flow setpoint |
| `avgOutletTemp`, `avgInletTemp` | Hot water out and in |
| `avgSupplyTemp`, `avgReturnTemp` | Heating flow and return |
| `powerStatus`, `heatStatus` | Power, and whether space heating is enabled. `heatStatus` is not a burner-firing signal; no field on the verified frame distinguishes "heating is on" from "the burner is firing" |
| `onDemandUseFlag` | Recirculation running now |
| `errorCode`, `subErrorCode` | Per unit, inside `unitInfo.unitStatusList` |

Note that `avg*` fields are the channel average across units, while `current*` inside each unit entry is that unit's own reading. On a single-unit appliance they agree.

## Control

Published to `cmd/{deviceType}/navilink-{mac}/control`, with `responseTopic` set to the **channel-status** response topic: a control is answered with a status frame, not an acknowledgement.

| Command | Code | `mode` | Param |
| --- | --- | --- | --- |
| Power | `0x02000001` (33554433) | `power` | `[1]` on, `[2]` off |
| Heating enable | `0x02000002` (33554434) | `heat` | `[1]` on, `[2]` off |
| Hot water setpoint | `0x02000003` (33554435) | `DHWTemperature` | `[value]` |
| Heating setpoint | `0x02000004` (33554436) | `heatTemperature` | `[value]` |
| Recirculation | `0x02000005` (33554437) | `onDemand` | `[1]` on, `[2]` off, `[3]` warm up |
| Recirculation setpoint | `0x02000007` (33554439) | `recirculation` | `[value]` (not implemented) |

The high byte is the class: `0x01` reads, `0x02` writes. The low byte is an index into an enumeration that survived a protocol generation. The pre-MQTT TCP implementation numbered the same operations 1 through 7 in the same order.

### The mode string is not derivable from the command

`DHWTemperature` but `heatTemperature`. `power` but not `Power`. The gateway dispatches on the string and the capitalisation is inconsistent between them, so this table spells each one out.

### `param` is always an array

Even for a single scalar. The gateway parses the field as a list and rejects a bare number.

### Setpoints encode exactly as they decode

Same scaling as the read side. If the two ever disagree, a setpoint written as 120 reads back as 60 and the thermostat appears to halve itself on every write.

## `res/controlfail`

```json
{ "response": { "failCode": 2 } }
```

### `failCode` 2 means "too soon"

The one value whose meaning is established, and the only one the vendor app branches on. Commands sent in quick succession are refused and the channel is locked out of control for a while afterwards.

The plugin answers this by pausing control for 30 seconds. The lockout's real duration is not documented anywhere; 30 seconds is long enough to clear a burst from a HomeKit scene and short enough that a deliberate press a moment later still works.

### A failure cannot be routed back to the command that caused it

The frame names no command, and `sessionID` does not survive the round trip intact (see above). So a refusal is logged, not thrown. That is why the log line matters: a control that silently did nothing is otherwise undiagnosable.

## What this plugin does not use

- **Weekly schedules.** `0x02000006` exists. The NaviLink app does this properly and HomeKit has no vocabulary for it
- **Energy and water usage.** `accumulatedGasUsage` and `DHWFlowRate` are present on the wire. They are not copied onto the observation and are not exposed; the Home app renders neither well
- **Commissioning and DIP-switch settings.** Present in `channelinfo`, read-only here, and not something a home-automation plugin should offer
- **`device/firmware/info`.** Answers 403 on the test account. Firmware comes from `device/info` instead

Fixtures recorded from an NCB-240E are in [`tests/fixtures/`](../tests/fixtures/), pseudonymised. See [`scripts/README.md`](../scripts/README.md) for how to record and publish one safely.
