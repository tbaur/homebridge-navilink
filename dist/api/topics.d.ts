/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview NaviLink MQTT topic construction.
 *
 * Two prefixes, and the difference between them is the thing to understand.
 *
 * The **gateway prefix**, `cmd/{deviceType}/navilink-{mac}/`, addresses one
 * appliance. Requests are published under it, and the gateway publishes its
 * answers under it too, below `res/`. It contains nothing about who is asking,
 * so every client watching that appliance sees every answer, including
 * answers to somebody else's request, such as the NaviLink app on a phone.
 * That is a feature, not a hazard: a setpoint changed on the wall
 * controller or in the app reaches this plugin without it asking.
 *
 * The **session prefix**, `cmd/{deviceType}/{homeSeq}/{userSeq}/{clientId}/res/`,
 * is private to one client. A request nominates it as its response topic.
 *
 * Both are subscribed. Measured against an NCB-240E: the answers arrived on
 * the gateway prefix, not the session prefix. Relying on the session prefix
 * alone would produce a plugin that connects cleanly, subscribes successfully
 * and then waits forever. So both are taken, and a frame is matched on its
 * last path segment, not on an exact topic.
 */
/** Everything needed to address one gateway. */
export interface TopicIdentity {
    /** Gateway MAC, lower-case hex with no separators, as the cloud spells it. */
    macAddress: string;
    /** Gateway kind. `1` for every NaviLink gateway seen so far. */
    deviceType: number;
    /** Home grouping id from the device list. */
    homeSeq: string;
    /** Account sequence number from sign-in. */
    userSeq: string;
    /** This client's MQTT client identifier. */
    clientId: string;
}
/** The topics one session uses for one gateway. */
export interface GatewayTopics {
    /** Where a channel-info request goes, and where a session announces itself. */
    start: string;
    /** Where a channel-status request goes. */
    statusRequest: string;
    /** Where a control command goes. */
    control: string;
    /** Everything to subscribe to, in one list. */
    subscriptions: readonly string[];
    /** The gateway's own last-will topic, announcing an app coming or going. */
    appConnection: string;
}
/**
 * The response kinds this plugin understands.
 *
 * `other` is not an error: the gateway publishes several frame types nobody
 * here has needed yet, and an unrecognised one should be ignored quietly
 * rather than logged as a fault on every arrival.
 */
export type FrameKind = 'channelinfo' | 'channelstatus' | 'controlfail' | 'connection' | 'other';
/** The response topic a request nominates for its answer. */
export declare function responseTopic(identity: TopicIdentity, kind: FrameKind): string;
/** Build every topic one session needs for one gateway. */
export declare function buildTopics(identity: TopicIdentity): GatewayTopics;
/**
 * Classify an inbound topic by its last segment.
 *
 * Deliberately not an exact match against the subscribed list. The two
 * prefixes produce two topics per frame kind, a gateway can answer on either,
 * and matching exactly would mean a frame arriving on the unexpected prefix is
 * silently dropped. That looks exactly like an appliance that has stopped
 * reporting.
 */
export declare function classifyTopic(topic: string): FrameKind;
