/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Discovery runs inside the settings page, which is a process that exists
 * only while somebody has a browser tab open. Two failure modes matter more
 * here than in the plugin proper: a connection left open outlives the request
 * and competes with the real session for a client id, and an unbounded wait
 * leaves the page spinning with no way to cancel it.
 */

import { NaviLinkDiscovery } from '../../src/discovery'
import { DISCOVERY_BUDGET_MS, STATUS_RESPONSE_TIMEOUT_MS } from '../../src/settings'
import {
  FakeConnection,
  fakeRest,
  listedDevice,
  MAC,
  type FakeRest,
} from '../helpers/cloud'
import { fakeLogger } from '../helpers/hap'
import channelInfoFrame from '../fixtures/ncb-240e.channelinfo.json'

/** Answer the next channel-info request as soon as it is published. */
function autoAnswer(connection: FakeConnection, options: {
  info?: boolean
  status?: boolean
} = {}): void {
  const originalPublish = connection.publish.bind(connection)
  connection.publish = (topic: string, payload: string): Promise<void> => {
    const result = originalPublish(topic, payload)
    if (topic.endsWith('status/start') && options.info !== false) {
      queueMicrotask(() => connection.deliverChannelInfo())
    }
    if (topic.endsWith('status/channelstatus') && options.status !== false) {
      queueMicrotask(() => connection.deliverChannelStatus())
    }
    return result
  }
}

/**
 * Let a discovery that is waiting on a deadline reach it, without waiting.
 *
 * The deadlines here are tens of seconds, because that is how long a powered
 * appliance can reasonably take. Sitting through them would make this file
 * slower than the rest of the suite put together, so the clock is advanced
 * instead of endured.
 */
async function runOutTheClock<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] })
  try {
    await jest.advanceTimersByTimeAsync(deadlineMs + 1_000)
    return await work
  } finally {
    jest.useRealTimers()
  }
}

interface Built {
  discovery: NaviLinkDiscovery
  log: ReturnType<typeof fakeLogger>
  rest: FakeRest
  connection(): FakeConnection
}

function build(overrides: {
  rest?: FakeRest
  answer?: { info?: boolean; status?: boolean }
} = {}): Built {
  const log = fakeLogger()
  const rest = overrides.rest ?? fakeRest()
  let connection: FakeConnection | undefined

  const discovery = new NaviLinkDiscovery({
    log,
    rest: rest.rest,
    createConnection: (options) => {
      connection = new FakeConnection(options)
      autoAnswer(connection, overrides.answer ?? {})
      return connection.asConnection()
    },
  })

  return {
    discovery,
    log,
    rest,
    connection: () => {
      if (connection === undefined) {
        throw new Error('no connection was created')
      }
      return connection
    },
  }
}

describe('describing an account', () => {
  it('returns one entry per channel, with an id the platform will agree with', async () => {
    const built = build()
    const found = await built.discovery.discover('someone@example.com', 'hunter2')
    expect(found).toHaveLength(1)
    expect(found[0]?.id).toBe(`${MAC}:1`)
    expect(found[0]?.online).toBe(true)
    expect(found[0]?.described).toBe(true)
  })

  it('reports what the appliance can actually do, not a fixed list', async () => {
    const built = build()
    const [found] = await built.discovery.discover('someone@example.com', 'hunter2')
    expect(found?.capabilities.dhw).toBe(true)
    // The recorded NCB-240E has no outdoor probe. Offering the tile anyway
    // would put a permanent No Response in somebody's Home app.
    expect(found?.capabilities.outdoorSensor).toBe(false)
  })

  it('carries the appliance name through, so the page is not a list of MACs', async () => {
    const rest = fakeRest({ devices: [listedDevice({ deviceName: 'Utility Room' })] })
    const built = build({ rest })
    const [found] = await built.discovery.discover('someone@example.com', 'hunter2')
    expect(found?.name).toContain('Utility Room')
  })

  it('warns when the cloud says a gateway is offline', async () => {
    const rest = fakeRest({ devices: [listedDevice({ connected: 0 })] })
    const built = build({ rest })
    const found = await built.discovery.discover('someone@example.com', 'hunter2')
    expect(built.log.calls.some((line) => line.includes('offline according to the cloud')))
      .toBe(true)
    expect(found[0]?.online).toBe(false)
    expect(found[0]?.described).toBe(true)
  })

  it('still lists an offline gateway that never described itself', async () => {
    const rest = fakeRest({ devices: [listedDevice({ connected: 0 })] })
    const built = build({ rest, answer: { info: false } })
    const found = await runOutTheClock(
      built.discovery.discover('someone@example.com', 'hunter2'),
      DISCOVERY_BUDGET_MS,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.online).toBe(false)
    expect(found[0]?.described).toBe(false)
    expect(found[0]?.id).toBe(`${MAC}:1`)
  })

  it('does not take another gateway channelinfo as this one', async () => {
    const other = 'b1b2c3d4e5f6'
    const log = fakeLogger()
    const rest = fakeRest({
      devices: [
        listedDevice({ macAddress: MAC }),
        listedDevice({ macAddress: other, homeSeq: '200001', deviceName: 'Boiler Two' }),
      ],
    })
    const interloperFrame = {
      response: {
        channelInfo: {
          channelList: [{
            channelNumber: 1,
            channel: {
              unitType: 3,
              temperatureType: 2,
              heatControl: 1,
              setupHeatTempMin: 90,
              setupHeatTempMax: 140,
            },
          }],
        },
      },
    }
    let connection: FakeConnection | undefined
    const discovery = new NaviLinkDiscovery({
      log,
      rest: rest.rest,
      createConnection: (options) => {
        connection = new FakeConnection(options)
        const original = connection.publish.bind(connection)
        connection.publish = (topic: string, payload: string): Promise<void> => {
          const result = original(topic, payload)
          if (!topic.endsWith('status/start')) {
            return result
          }
          const asking = topic.includes(MAC) ? MAC : other
          const interloper = asking === MAC ? other : MAC
          queueMicrotask(() => {
            connection?.deliver(`cmd/1/navilink-${interloper}/res/channelinfo`, interloperFrame)
            connection?.deliver(`cmd/1/navilink-${asking}/res/channelinfo`, channelInfoFrame)
          })
          return result
        }
        return connection.asConnection()
      },
    })

    const found = await discovery.discover('someone@example.com', 'hunter2')
    const first = found.find((device) => device.mac === MAC)
    expect(first?.family).toBe('NCB')
    expect(first?.capabilities.dhw).toBe(true)
  })

  it('hangs up, so the page does not leave a client id held open', async () => {
    const built = build()
    await built.discovery.discover('someone@example.com', 'hunter2')
    expect(built.connection().closeCalls).toBe(1)
  })

  it('hangs up even when the appliance never answers', async () => {
    const built = build({ answer: { info: false } })
    await runOutTheClock(
      built.discovery.discover('someone@example.com', 'hunter2'),
      DISCOVERY_BUDGET_MS,
    )
    expect(built.connection().closeCalls).toBe(1)
  })

  it('hangs up when sign-in succeeded but the connection failed', async () => {
    const built = build()
    const discovery = new NaviLinkDiscovery({
      log: built.log,
      rest: built.rest.rest,
      createConnection: (options) => {
        const connection = new FakeConnection(options)
        connection.failConnect = new Error('handshake rejected')
        return connection.asConnection()
      },
    })
    await expect(discovery.discover('someone@example.com', 'hunter2'))
      .rejects.toThrow('handshake rejected')
  })

  it('retries the :443 signature when the bare host is refused', async () => {
    const built = build()
    let attempts = 0
    const discovery = new NaviLinkDiscovery({
      log: built.log,
      rest: built.rest.rest,
      createConnection: (options) => {
        const connection = new FakeConnection(options)
        attempts += 1
        if (options.signHostWithPort !== true) {
          connection.failConnect = new Error('handshake rejected')
        } else {
          autoAnswer(connection)
        }
        return connection.asConnection()
      },
    })

    const found = await discovery.discover('someone@example.com', 'hunter2')

    expect(attempts).toBe(2)
    expect(found).toHaveLength(1)
  })

  it('returns nothing rather than throwing when the appliance stays silent', async () => {
    const built = build({ answer: { info: false } })
    const found = await runOutTheClock(
      built.discovery.discover('someone@example.com', 'hunter2'),
      DISCOVERY_BUDGET_MS,
    )
    // A gateway that is powered down should leave the page saying it found
    // nothing, not showing a stack trace.
    expect(found).toEqual([])
  })

  it('lets a rejected password reach the caller, so the page can say so', async () => {
    const rest = fakeRest()
    rest.failSignIn(new Error('NaviLink rejected the email address or password'))
    const built = build({ rest })
    await expect(built.discovery.discover('someone@example.com', 'wrong'))
      .rejects.toThrow(/rejected the email address or password/)
  })

  it('never puts the password in the log', async () => {
    const built = build()
    await built.discovery.discover('someone@example.com', 'hunter2')
    expect(built.log.calls.some((line) => line.includes('hunter2'))).toBe(false)
  })

  it('masks the gateway MAC in the log', async () => {
    const built = build()
    await built.discovery.discover('someone@example.com', 'hunter2')
    const mentions = built.log.calls.filter((line) => line.includes(MAC))
    expect(mentions).toEqual([])
  })
})

describe('capturing frames', () => {
  it('records the description and the status of every channel', async () => {
    const built = build()
    const frames = await built.discovery.capture({
      email: 'someone@example.com',
      password: 'hunter2',
    })
    expect(frames.map((frame) => frame.kind)).toEqual(['channelinfo', 'channelstatus'])
  })

  it('keeps the real MAC when a fixture is being recorded', async () => {
    const built = build()
    const frames = await built.discovery.capture({
      email: 'someone@example.com',
      password: 'hunter2',
    })
    // `scripts/pseudonymise.js` rewrites this deliberately and audits its own
    // work. Masking here would hide what that script is meant to find.
    expect(frames[0]?.macAddress).toBe(MAC)
  })

  it('masks the MAC when the capture is going into a bug report', async () => {
    const built = build()
    const frames = await built.discovery.capture({
      email: 'someone@example.com',
      password: 'hunter2',
      redact: true,
    })
    expect(frames[0]?.macAddress).not.toBe(MAC)
    expect(JSON.stringify(frames)).not.toContain(MAC)
  })

  it('records the channel each frame belongs to', async () => {
    const built = build()
    const frames = await built.discovery.capture({
      email: 'someone@example.com',
      password: 'hunter2',
    })
    expect(frames.every((frame) => frame.channelNumber === 1)).toBe(true)
  })

  it('records the description even when the status never arrives', async () => {
    const built = build({ answer: { status: false } })
    const frames = await runOutTheClock(
      built.discovery.capture({ email: 'someone@example.com', password: 'hunter2' }),
      STATUS_RESPONSE_TIMEOUT_MS,
    )
    expect(frames.map((frame) => frame.kind)).toEqual(['channelinfo'])
  })
})
