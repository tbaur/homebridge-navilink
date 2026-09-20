/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The session owns the plugin's whole relationship with someone else's cloud,
 * so its mistakes are not local. Retrying a rejected password locks a user out
 * of their own account; presenting a stale reading as current lets an
 * automation fire on a number from yesterday; and ignoring the cloud's own
 * control lockout means hammering a channel that is already refusing.
 */

import { Command } from '../../src/api/protocol'
import { buildTopics } from '../../src/api/topics'
import { NaviLinkSession, type ControlSpec } from '../../src/session'
import { CONTROL_LOCKOUT_MS } from '../../src/settings'
import type { ChannelObservation, RefreshReason, ResolvedDevice, SessionMetrics } from '../../src/types'
import { AuthenticationError, ControlRejectedError } from '../../src/utils'
import {
  DEVICE_ID,
  FakeConnection,
  fakeRest,
  IDENTITY,
  listedDevice,
  MAC,
  tokens,
  type FakeRest,
} from '../helpers/cloud'
import { fakeLogger } from '../helpers/hap'

const NOW = 1_700_000_000_000

const device: ResolvedDevice = {
  id: DEVICE_ID,
  name: 'Boiler',
  channel: 1,
  dhw: true,
  heating: false,
  power: false,
  recirculation: false,
  fault: false,
  temperatureSensors: false,
  outdoorSensor: false,
}

interface Built {
  session: NaviLinkSession
  connection: FakeConnection
  rest: FakeRest
  log: ReturnType<typeof fakeLogger>
  observed: { deviceId: string; observation: ChannelObservation; reason: RefreshReason }[]
  unreachable: unknown[]
  stale: string[]
  setNow(value: number): void
}

function build(overrides: {
  rest?: FakeRest
  devices?: readonly ResolvedDevice[]
  statusIntervalSec?: number
  metrics?: SessionMetrics
} = {}): Built {
  const log = fakeLogger()
  const rest = overrides.rest ?? fakeRest()
  let connection: FakeConnection | undefined
  let now = NOW

  const session = new NaviLinkSession({
    log,
    account: { email: 'someone@example.com', password: 'hunter2' },
    devices: overrides.devices ?? [device],
    statusIntervalSec: overrides.statusIntervalSec ?? 60,
    rest: rest.rest,
    createConnection: (options) => {
      connection = new FakeConnection(options)
      return connection.asConnection()
    },
    now: () => now,
    random: () => 0.5,
    ...(overrides.metrics === undefined ? {} : { metrics: overrides.metrics }),
  })

  const observed: Built['observed'] = []
  const unreachable: unknown[] = []
  const stale: string[] = []
  session.onObservation((deviceId, observation, reason) => {
    observed.push({ deviceId, observation, reason })
  })
  session.onUnreachable((error) => unreachable.push(error))
  session.onStale((deviceId) => stale.push(deviceId))

  return {
    session,
    get connection() {
      if (connection === undefined) {
        throw new Error('no connection was created')
      }
      return connection
    },
    rest,
    log,
    observed,
    unreachable,
    stale,
    setNow: (value) => {
      now = value
    },
  }
}

/** Start a session and let sign-in, connect and the first request settle. */
async function started(overrides: Parameters<typeof build>[0] = {}): Promise<Built> {
  const built = build(overrides)
  built.session.start()
  await drain()
  return built
}

/** Let the session's promise chain run to quiescence. */
async function drain(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

afterEach(() => {
  jest.useRealTimers()
})

describe('establishing a session', () => {
  it('signs in, lists, connects and then asks what the appliance is', async () => {
    const built = await started()
    expect(built.rest.calls.signIn).toHaveLength(1)
    expect(built.rest.calls.listDevices).toBe(1)
    expect(built.connection.connectCalls).toBe(1)
    // Channel info before status, because the status frame cannot be decoded
    // until the appliance has said which temperature scale it speaks.
    expect(built.connection.published[0]?.topic).toBe(buildTopics(IDENTITY).start)
    expect(built.log.calls.some((line) => line.includes('Boiler firmware 4352'))).toBe(true)
    expect(built.log.calls.some((line) => line.includes('\u2026E5F6'))).toBe(false)
    await built.session.stop()
  })

  it('masks the account in the log rather than naming it', async () => {
    const built = await started()
    const line = built.log.calls.find((entry) => entry.includes('signed in as'))
    expect(line).toBe('debug signed in as s\u2026e@example.com')
    expect(built.log.calls.some((entry) => entry.startsWith('info ') && entry.includes('signed in')))
      .toBe(false)
    expect(line).not.toContain('someone@example.com')
    await built.session.stop()
  })

  it('never puts the password in the log, at any level', async () => {
    const built = await started()
    expect(built.log.calls.some((line) => line.includes('hunter2'))).toBe(false)
    await built.session.stop()
  })

  it('subscribes to the gateway prefix, which is where answers actually arrive', async () => {
    const built = await started()
    expect(built.connection.subscribed)
      .toContain(`cmd/1/navilink-${MAC}/res/channelstatus`)
    await built.session.stop()
  })

  it('ignores a gateway the user did not configure', async () => {
    const rest = fakeRest({
      devices: [listedDevice(), listedDevice({ macAddress: 'ffffffffffff' })],
    })
    const built = await started({ rest })
    expect(built.connection.subscribed.some((topic) => topic.includes('ffffffffffff')))
      .toBe(false)
    await built.session.stop()
  })

  it('says so when a configured appliance is not on the account any more', async () => {
    const rest = fakeRest({ devices: [listedDevice({ macAddress: 'ffffffffffff' })] })
    const built = build({ rest })
    built.session.start()
    await drain()
    expect(built.log.calls.some((line) => line.includes('not on this account')))
      .toBe(true)
    await built.session.stop()
  })

  it('carries on without a firmware version rather than failing the session', async () => {
    const rest = fakeRest({ firmware: undefined })
    const built = await started({ rest })
    expect(built.connection.isConnected).toBe(true)
    expect(built.session.firmwareFor(DEVICE_ID)).toBeUndefined()
    await built.session.stop()
  })

  it('does not treat a refused first signature as an outage', async () => {
    const connections: FakeConnection[] = []
    const log = fakeLogger()
    const rest = fakeRest()
    const unreachable: unknown[] = []
    const session = new NaviLinkSession({
      log,
      account: { email: 'someone@example.com', password: 'hunter2' },
      devices: [device],
      statusIntervalSec: 60,
      rest: rest.rest,
      createConnection: (options) => {
        const connection = new FakeConnection(options)
        if (options.signHostWithPort !== true) {
          connection.failConnect = new Error('upgrade rejected')
        }
        connections.push(connection)
        return connection.asConnection()
      },
      now: () => NOW,
      random: () => 0.5,
    })
    session.onUnreachable((error) => unreachable.push(error))
    session.start()
    await drain()

    expect(connections).toHaveLength(2)
    expect(unreachable).toEqual([])
    expect(log.calls.some((line) => line.includes('mqtt up'))).toBe(true)
    await session.stop()
  })
})

describe('a rejected credential', () => {
  it('stops for good rather than retrying until the account locks', async () => {
    const rest = fakeRest()
    rest.failSignIn(new AuthenticationError(
      'NaviLink rejected the email address or password',
      { credentialsRejected: true },
    ))
    const built = build({ rest })
    built.session.start()
    await drain()

    expect(built.session.hasStoppedPermanently).toBe(true)
    expect(rest.calls.signIn).toHaveLength(1)
  })

  it('says once what the user has to do about it', async () => {
    const rest = fakeRest()
    rest.failSignIn(new AuthenticationError('NaviLink rejected the email address or password', {
      credentialsRejected: true,
    }))
    const built = build({ rest })
    built.session.start()
    await drain()
    const errors = built.log.calls.filter((line) => line.startsWith('error '))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('sign-in stopped')
  })

  it('treats an unrecognised failure as transient, so a cloud blip recovers', async () => {
    const rest = fakeRest()
    rest.failNextSignIn(new Error('socket hang up'))
    const built = build({ rest })
    built.session.start()
    await drain()
    expect(built.session.hasStoppedPermanently).toBe(false)
    expect(built.unreachable).toHaveLength(1)
    await built.session.stop()
  })
})

describe('observations', () => {
  it('decodes a status frame into an observation for the configured device', async () => {
    const built = await started()
    built.connection.deliverChannelInfo()
    built.connection.deliverChannelStatus()
    await drain()

    expect(built.observed).toHaveLength(1)
    expect(built.observed[0]?.deviceId).toBe(DEVICE_ID)
    expect(built.observed[0]?.observation.family).toBe('NCB')
    expect(built.observed[0]?.reason).toBe('startup')
    await built.session.stop()
  })

  it('labels a later unsolicited frame as a push', async () => {
    const built = await started()
    built.connection.deliverChannelInfo()
    built.connection.deliverChannelStatus()
    built.connection.deliverChannelStatus()
    await drain()

    expect(built.observed.map((entry) => entry.reason)).toEqual(['startup', 'push'])
    await built.session.stop()
  })

  it('says so when a configured channel is not on the gateway', async () => {
    const built = await started({
      devices: [{ ...device, id: `${MAC}:2`, channel: 2 }],
    })
    built.connection.deliverChannelInfo()
    await drain()

    expect(built.log.calls.some((line) => (
      line.includes('channel 2') && line.includes('not on gateway')
    ))).toBe(true)
    await built.session.stop()
  })

  it('logs family= once the gateway has described the channel', async () => {
    const built = await started()
    built.connection.deliverChannelInfo()
    await drain()

    const family = built.log.calls.find((line) => line.includes('family=NCB'))
    expect(family).toBe('info Boiler channel 1 family=NCB')
    built.log.calls.length = 0
    built.connection.deliverChannelInfo()
    await drain()
    expect(built.log.calls.filter((line) => line.startsWith('info ') && line.includes('family=')))
      .toEqual([])
    expect(built.log.calls.some((line) => line === 'debug Boiler channel 1 family=NCB')).toBe(true)
    await built.session.stop()
  })

  it('warns when the cloud says the gateway is offline', async () => {
    const rest = fakeRest({ devices: [listedDevice({ connected: 0 })] })
    const built = await started({ rest })

    expect(built.log.calls.some((line) => line.includes('cloud reports offline')))
      .toBe(true)
    await built.session.stop()
  })

  it('drops observations as soon as the session is unreachable', async () => {
    const built = await started()
    built.connection.deliverChannelInfo()
    built.connection.deliverChannelStatus()
    await drain()
    expect(built.session.observationFor(DEVICE_ID)).toBeDefined()

    built.connection.drop()
    await drain()

    expect(built.session.observationFor(DEVICE_ID)).toBeUndefined()
    expect(built.unreachable.length).toBeGreaterThan(0)
    await built.session.stop()
  })

  it('asks for the channel description when a status frame arrives undescribed', async () => {
    const built = await started()
    built.connection.deliverChannelStatus()
    await drain()
    const starts = built.connection.published
      .filter((entry) => entry.topic === buildTopics(IDENTITY).start)
    // One at startup, one prompted by the orphan status frame.
    expect(starts).toHaveLength(2)
    expect(built.observed).toHaveLength(0)
    await built.session.stop()
  })

  it('stops presenting a reading once it is too old to be current', async () => {
    const built = await started({ statusIntervalSec: 60 })
    built.connection.deliverChannelInfo()
    built.connection.deliverChannelStatus()
    await drain()
    expect(built.session.observationFor(DEVICE_ID)).toBeDefined()

    // Far enough past the poll interval that the last frame is history, not
    // state. An automation firing on it would be acting on yesterday.
    built.setNow(NOW + 60_000 * 20)
    expect(built.session.observationFor(DEVICE_ID)).toBeUndefined()
    await built.session.stop()
  })

  it('does not treat an optimistic write as a fresh reading', async () => {
    const built = await started({ statusIntervalSec: 60 })
    built.connection.deliverChannelInfo()
    built.connection.deliverChannelStatus()
    await drain()
    built.session.applyOptimisticWrite(DEVICE_ID, { dhwSetpoint: 130 })
    built.setNow(NOW + 60_000 * 4)
    expect(built.session.observationFor(DEVICE_ID)).toBeUndefined()
    await built.session.stop()
  })

  it('notifies after a poll when the last frame is now too old', async () => {
    const polls: Array<() => void> = []
    const realSetInterval = global.setInterval.bind(global)
    jest.spyOn(global, 'setInterval').mockImplementation((handler, ms) => {
      if (ms === 60_000) {
        polls.push(handler as () => void)
        const handle = { unref() { return this } }
        return handle as unknown as ReturnType<typeof setInterval>
      }
      return realSetInterval(handler, ms as number)
    })
    const built = await started({ statusIntervalSec: 60 })
    built.connection.deliverChannelInfo()
    built.connection.deliverChannelStatus()
    await drain()
    built.setNow(NOW + 60_000 * 4)
    expect(polls).toHaveLength(1)
    polls[0]!()
    await drain()
    expect(built.stale).toContain(DEVICE_ID)
    await built.session.stop()
    jest.restoreAllMocks()
  })

  it('counts a poll cycle as ok when every status request is sent', async () => {
    const polls: Array<() => void> = []
    const cycles: { ok: number; failed: number }[] = []
    const realSetInterval = global.setInterval.bind(global)
    jest.spyOn(global, 'setInterval').mockImplementation((handler, ms) => {
      if (ms === 60_000) {
        polls.push(handler as () => void)
        const handle = { unref() { return this } }
        return handle as unknown as ReturnType<typeof setInterval>
      }
      return realSetInterval(handler, ms as number)
    })
    const built = await started({
      statusIntervalSec: 60,
      metrics: {
        apiRequest() {},
        mqttReconnect() {},
        pollCycle(ok, failed) { cycles.push({ ok, failed }) },
        command() {},
        sessionRefresh() {},
        push() {},
      },
    })
    built.connection.deliverChannelInfo()
    await drain()
    polls[0]!()
    await drain()
    expect(cycles).toEqual([{ ok: 1, failed: 0 }])
    await built.session.stop()
    jest.restoreAllMocks()
  })

  it('counts a poll cycle as failed when a status request is refused', async () => {
    const polls: Array<() => void> = []
    const cycles: { ok: number; failed: number }[] = []
    const realSetInterval = global.setInterval.bind(global)
    jest.spyOn(global, 'setInterval').mockImplementation((handler, ms) => {
      if (ms === 60_000) {
        polls.push(handler as () => void)
        const handle = { unref() { return this } }
        return handle as unknown as ReturnType<typeof setInterval>
      }
      return realSetInterval(handler, ms as number)
    })
    const built = await started({
      statusIntervalSec: 60,
      metrics: {
        apiRequest() {},
        mqttReconnect() {},
        pollCycle(ok, failed) { cycles.push({ ok, failed }) },
        command() {},
        sessionRefresh() {},
        push() {},
      },
    })
    built.connection.deliverChannelInfo()
    await drain()
    built.connection.failPublish = new Error('publish refused')
    polls[0]!()
    await drain()
    expect(cycles).toEqual([{ ok: 0, failed: 1 }])
    await built.session.stop()
    jest.restoreAllMocks()
  })

  it('ignores a frame it does not recognise rather than logging a fault for it', async () => {
    const built = await started()
    // The gateway publishes several frame types nobody here has needed. One
    // arriving must not produce a warning on every push.
    built.connection.deliver(`cmd/1/navilink-${MAC}/res/somethingelse`, { hello: true })
    expect(built.log.calls.some((line) => line.startsWith('warn '))).toBe(false)
    expect(built.observed).toHaveLength(0)
    await built.session.stop()
  })

  it('reports an optimistic write so the tile settles before the appliance answers', async () => {
    const built = await started()
    built.connection.deliverChannelInfo()
    built.connection.deliverChannelStatus()
    await drain()
    built.observed.length = 0

    const observedAt = built.session.observationFor(DEVICE_ID)?.observedAt
    built.setNow(NOW + 5_000)
    built.session.applyOptimisticWrite(DEVICE_ID, { dhwSetpoint: 130 })
    expect(built.observed).toHaveLength(1)
    expect(built.observed[0]?.reason).toBe('post-set')
    expect(built.observed[0]?.observation.dhwSetpoint).toBe(130)
    expect(built.observed[0]?.observation.observedAt).toBe(observedAt)
    await built.session.stop()
  })

  it('does not invent state when an optimistic write arrives before any frame', async () => {
    const built = await started()
    built.session.applyOptimisticWrite(DEVICE_ID, { dhwSetpoint: 130 })
    expect(built.observed).toHaveLength(0)
    await built.session.stop()
  })
})

describe('publishing control', () => {
  const powerSpec: ControlSpec = {
    command: Command.POWER,
    what: 'a power change',
    build: (input) => ({
      topic: input.topics.control,
      payload: JSON.stringify({ request: { control: { mode: 'power' } } }),
    }),
  }

  async function ready(): Promise<Built> {
    const built = await started()
    built.connection.deliverChannelInfo()
    built.connection.deliverChannelStatus()
    await drain()
    return built
  }

  it('publishes to the control topic and then asks for the new state', async () => {
    const built = await ready()
    const before = built.connection.published.length
    await built.session.publishControl(DEVICE_ID, powerSpec)

    const after = built.connection.published.slice(before)
    expect(after[0]?.topic).toBe(buildTopics(IDENTITY).control)
    // A PUBACK only means the broker has it. Asking closes the loop in a
    // second rather than at the next poll.
    expect(after[1]?.topic).toBe(buildTopics(IDENTITY).statusRequest)
    await built.session.stop()
  })

  it('does not fail the write when the follow-up status request fails', async () => {
    const built = await ready()
    const original = built.connection.publish.bind(built.connection)
    built.connection.publish = (topic: string, payload: string): Promise<void> => {
      if (topic === buildTopics(IDENTITY).statusRequest) {
        return Promise.reject(new Error('status ask failed'))
      }
      return original(topic, payload)
    }

    await expect(built.session.publishControl(DEVICE_ID, powerSpec)).resolves.toBeUndefined()
    await built.session.stop()
  })

  it('refuses a command for a device that is not connected', async () => {
    const built = build()
    await expect(built.session.publishControl(DEVICE_ID, powerSpec))
      .rejects.toThrow(ControlRejectedError)
  })

  it('refuses a device id that is not one of ours', async () => {
    const built = await ready()
    await expect(built.session.publishControl('nonsense', powerSpec))
      .rejects.toThrow(ControlRejectedError)
    await built.session.stop()
  })

})

describe('the cloud control lockout', () => {
  const spec: ControlSpec = {
    command: Command.POWER,
    what: 'a power change',
    build: (input) => ({ topic: input.topics.control, payload: '{}' }),
  }

  async function ready(): Promise<Built> {
    const built = await started()
    built.connection.deliverChannelInfo()
    built.connection.deliverChannelStatus()
    await drain()
    return built
  }

  it('stops sending after the appliance refuses one for arriving too soon', async () => {
    const built = await ready()
    built.connection.deliverControlFailure(2)
    await expect(built.session.publishControl(DEVICE_ID, spec))
      .rejects.toThrow(/rate limited/)
    await built.session.stop()
  })

  it('warns, because a control that silently did nothing is undiagnosable', async () => {
    const built = await ready()
    built.connection.deliverControlFailure(2)
    expect(built.log.calls.some((line) => line.includes('rate limited'))).toBe(true)
    await built.session.stop()
  })

  it('starts sending again once the lockout has passed', async () => {
    const built = await ready()
    built.connection.deliverControlFailure(2)
    built.setNow(NOW + CONTROL_LOCKOUT_MS + 1)
    await expect(built.session.publishControl(DEVICE_ID, spec)).resolves.toBeUndefined()
    await built.session.stop()
  })

  it('reports an unfamiliar refusal with its number rather than guessing', async () => {
    const built = await ready()
    built.connection.deliverControlFailure(7)
    expect(built.log.calls.some((line) => line.includes('failCode 7'))).toBe(true)
    // Not a lockout: only code 2 has an established meaning, and pausing on a
    // code we cannot read would be inventing a rule.
    await expect(built.session.publishControl(DEVICE_ID, spec)).resolves.toBeUndefined()
    await built.session.stop()
  })
})

describe('shutting down', () => {
  it('closes the connection and stops the timers', async () => {
    const built = await started()
    await built.session.stop()
    expect(built.connection.closeCalls).toBeGreaterThanOrEqual(1)
    expect(built.connection.isConnected).toBe(false)
  })

  it('does nothing on a second start', async () => {
    const built = await started()
    built.session.start()
    await drain()
    expect(built.rest.calls.signIn).toHaveLength(1)
    await built.session.stop()
  })
})

describe('credential lifetime', () => {
  it('re-establishes before the credentials expire rather than after', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] })
    const rest = fakeRest({ tokens: tokens({ expiresAt: NOW + 3_600_000 }) })
    const built = build({ rest })
    built.session.start()
    await drain()
    expect(rest.calls.signIn).toHaveLength(1)

    // Past the refresh margin but well inside the credential lifetime, which
    // is the whole point: an expiry we do not control would drop the
    // connection in the middle of the night.
    jest.advanceTimersByTime(3_600_000)
    await drain()

    expect(rest.calls.signIn.length).toBeGreaterThan(1)
    // A close this session asked for is not an outage: no backoff, no
    // unreachable, no second boot log.
    expect(built.unreachable).toEqual([])
    expect(built.log.calls.filter((line) => line.startsWith('info ') && line.includes('firmware')))
      .toHaveLength(1)
    expect(built.log.calls.filter((line) => (
      line.startsWith('info ') && line.includes('mqtt up')
    ))).toHaveLength(1)
    expect(built.log.calls.some((line) => line.includes('reconnect in'))).toBe(false)

    // `stop` waits a beat for the DISCONNECT to reach the broker, and under
    // fake timers that beat has to be granted explicitly or the test hangs.
    const stopping = built.session.stop()
    jest.advanceTimersByTime(100)
    await stopping
  })
})

describe('an unexpected drop', () => {
  it('treats a broker close as an outage and says it is reconnecting', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] })
    const built = build()
    built.session.start()
    await drain()
    built.log.calls.length = 0

    built.connection.drop()
    await drain()

    expect(built.unreachable).toHaveLength(1)
    expect(built.log.calls.some((line) => line === 'info reconnect in 1s')).toBe(true)

    jest.advanceTimersByTime(1_000)
    await drain()

    expect(built.log.calls.some((line) => line === 'info mqtt up')).toBe(true)

    const stopping = built.session.stop()
    jest.advanceTimersByTime(100)
    await stopping
  })
})
