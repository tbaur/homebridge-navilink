# Fixtures

Recorded responses from a real installation, with every identifying value
replaced. The parser is tested against what the cloud actually sends, not
against what the shapes in `docs/PROTOCOL.md` imply.

## What is here

| File | Recorded from |
| --- | --- |
| `ncb-240e.channelinfo.json` | An NCB-240E (NG) combi, gateway firmware 4352, on a single-appliance account |
| `ncb-240e.channelstatus.json` | The same appliance, idle: hot water enabled, space heating enabled, nothing firing |

The appliance is worth describing, because several of its readings are only
meaningful in context. It has **no recirculation pump** (`onDemandUse` and
`recirculationUse` both read `2`) and **no outdoor sensor**
(`outdoorTemperature` reads `0`), which is what makes it the right fixture for
testing that absent hardware is detected rather than reported as zero. It
reports in **Fahrenheit** (`temperatureType: 2`), which is the harder of the
two scales to convert for HomeKit.

## The values that were replaced

Every fixture uses the same substitutions, which are the ones the
documentation uses too:

| Real value | In a fixture |
| --- | --- |
| Gateway MAC | `a1b2c3d4e5f6` |
| Account sequence number | `100000` |
| Home sequence number | `200000` |
| Device name | `Zone One` |
| Email address | `someone@example.com` |

**A raw capture must never be committed.** It carries the gateway MAC, which
is the appliance's address in every MQTT topic, so it is a capability as well
as an identifier. From `device/info` it also carries the installation's street
address and coordinates. `scripts/capture-fixture.js` writes to
`tests/fixtures/raw/`, which is git-ignored, and `scripts/pseudonymise.js`
rewrites a capture and then proves that no mapped value survived.

`clientID` embeds the gateway MAC in a different form from
`response.macAddress`. The pseudonymiser checks its own output instead of
trusting the list of fields it was told about, and
`tests/unit/fixtures.test.ts` fails the build if a MAC that is not the
documented example appears anywhere in this directory.
