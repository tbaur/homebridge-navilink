/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * A gateway answers on whichever of the two prefixes it feels like, so a
 * plugin that subscribed to one, or matched a reply against an exact topic,
 * would connect cleanly, subscribe successfully and then wait forever. These
 * tests pin both prefixes and the loose match that makes the difference.
 */

import {
  buildTopics,
  classifyTopic,
  responseTopic,
  type FrameKind,
  type TopicIdentity,
} from '../../src/api/topics'

const identity: TopicIdentity = {
  macAddress: 'a1b2c3d4e5f6',
  deviceType: 1,
  homeSeq: '200000',
  userSeq: '100000',
  clientId: 'client-1',
}

const GATEWAY = 'cmd/1/navilink-a1b2c3d4e5f6/'
const SESSION = 'cmd/1/200000/100000/client-1/res/'

describe('buildTopics', () => {
  const topics = buildTopics(identity)

  it('addresses requests to the gateway rather than to the session', () => {
    expect(topics.start).toBe(`${GATEWAY}status/start`)
    expect(topics.statusRequest).toBe(`${GATEWAY}status/channelstatus`)
    expect(topics.control).toBe(`${GATEWAY}control`)
  })

  it('subscribes to the gateway prefix, which is where answers actually arrive', () => {
    // Measured against an NCB-240E. Taking only the session prefix produces a
    // plugin that appears healthy and never receives a frame.
    expect(topics.subscriptions).toEqual(expect.arrayContaining([
      `${GATEWAY}res/channelinfo`,
      `${GATEWAY}res/channelstatus`,
      `${GATEWAY}res/controlfail`,
      `${GATEWAY}connection`,
    ]))
  })

  it('subscribes to the session prefix as well, for a firmware that honours it', () => {
    expect(topics.subscriptions).toEqual(expect.arrayContaining([
      `${SESSION}channelinfo`,
      `${SESSION}channelstatus`,
      `${SESSION}controlfail`,
    ]))
  })

  it('takes both prefixes in one SUBSCRIBE and asks for nothing twice', () => {
    expect(topics.subscriptions).toHaveLength(7)
    expect(new Set(topics.subscriptions).size).toBe(7)
  })

  it('subscribes to nothing it would then fail to recognise', () => {
    for (const topic of topics.subscriptions) {
      expect(classifyTopic(topic)).not.toBe('other')
    }
  })

  it('announces itself on the event tree, not the command tree', () => {
    expect(topics.appConnection).toBe('evt/1/navilink-a1b2c3d4e5f6/app-connection')
  })

  it('addresses two gateways on one account separately', () => {
    const other = buildTopics({ ...identity, macAddress: 'f6e5d4c3b2a1' })

    expect(other.control).not.toBe(topics.control)
    expect(other.start).not.toBe(topics.start)
    expect(other.appConnection).not.toBe(topics.appConnection)
    for (const topic of other.subscriptions.filter((entry) => entry.includes('navilink-'))) {
      expect(topics.subscriptions).not.toContain(topic)
    }
  })

  it('shares the session prefix between the gateways one client watches', () => {
    // The session prefix names the client, not the appliance, so a frame
    // arriving on it says nothing about which gateway sent it. That is why a
    // response is correlated by the gateway it came from rather than by the
    // topic alone.
    const other = buildTopics({ ...identity, macAddress: 'f6e5d4c3b2a1' })

    expect(other.subscriptions).toContain(`${SESSION}channelstatus`)
  })

  it('separates two clients watching one gateway', () => {
    // The gateway prefix is shared on purpose: a setpoint changed in the
    // vendor app reaches us on it. The session prefix is private.
    const second = buildTopics({ ...identity, clientId: 'client-2' })

    expect(second.subscriptions).toContain(`${GATEWAY}res/channelstatus`)
    expect(second.subscriptions).not.toContain(`${SESSION}channelstatus`)
  })
})

describe('responseTopic', () => {
  it('nominates a topic private to this client', () => {
    expect(responseTopic(identity, 'channelstatus')).toBe(`${SESSION}channelstatus`)
    expect(responseTopic(identity, 'channelinfo')).toBe(`${SESSION}channelinfo`)
    expect(responseTopic(identity, 'controlfail')).toBe(`${SESSION}controlfail`)
  })
})

describe('classifyTopic', () => {
  it('reads a frame the same way on either prefix', () => {
    // Matching exactly would drop a frame that arrived on the unexpected
    // prefix, which looks precisely like an appliance that stopped reporting.
    const kinds: FrameKind[] = ['channelinfo', 'channelstatus', 'controlfail']

    for (const kind of kinds) {
      expect(classifyTopic(`${GATEWAY}res/${kind}`)).toBe(kind)
      expect(classifyTopic(`${SESSION}${kind}`)).toBe(kind)
    }
  })

  it('recognises the gateway announcing that it came or went', () => {
    expect(classifyTopic(`${GATEWAY}connection`)).toBe('connection')
  })

  it('ignores a frame kind nobody here has needed rather than treating it as a fault', () => {
    // The gateway publishes several types this plugin has no use for, and
    // logging each arrival as an error would bury everything that matters.
    expect(classifyTopic(`${GATEWAY}res/weeklyschedule`)).toBe('other')
    expect(classifyTopic(`${GATEWAY}res/channelstatus/extra`)).toBe('other')
    expect(classifyTopic('')).toBe('other')
    expect(classifyTopic('/')).toBe('other')
    expect(classifyTopic('cmd/1/navilink-a1b2c3d4e5f6/')).toBe('other')
  })

  it('does not mistake a prefix for the whole segment', () => {
    expect(classifyTopic(`${GATEWAY}res/channelstatusreport`)).toBe('other')
    expect(classifyTopic(`${GATEWAY}res/mychannelinfo`)).toBe('other')
  })
})
