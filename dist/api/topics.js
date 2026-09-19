"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.responseTopic = responseTopic;
exports.buildTopics = buildTopics;
exports.classifyTopic = classifyTopic;
/** Build the gateway prefix. */
function gatewayPrefix(identity) {
    return `cmd/${identity.deviceType}/navilink-${identity.macAddress}/`;
}
/** Build the session prefix. */
function sessionPrefix(identity) {
    return `cmd/${identity.deviceType}/${identity.homeSeq}/${identity.userSeq}/${identity.clientId}/res/`;
}
/** The response topic a request nominates for its answer. */
function responseTopic(identity, kind) {
    return `${sessionPrefix(identity)}${kind}`;
}
/** Build every topic one session needs for one gateway. */
function buildTopics(identity) {
    const gateway = gatewayPrefix(identity);
    const session = sessionPrefix(identity);
    return {
        start: `${gateway}status/start`,
        statusRequest: `${gateway}status/channelstatus`,
        control: `${gateway}control`,
        subscriptions: [
            // The gateway prefix first, because that is where answers actually
            // arrive, and because it is the path a change made elsewhere reaches us
            // on.
            `${gateway}res/channelinfo`,
            `${gateway}res/channelstatus`,
            `${gateway}res/controlfail`,
            `${gateway}connection`,
            // The session prefix, for a firmware that honours the nominated
            // response topic. Subscribing to both costs one SUBSCRIBE.
            `${session}channelinfo`,
            `${session}channelstatus`,
            `${session}controlfail`,
        ],
        appConnection: `evt/${identity.deviceType}/navilink-${identity.macAddress}/app-connection`,
    };
}
/**
 * Classify an inbound topic by its last segment.
 *
 * Deliberately not an exact match against the subscribed list. The two
 * prefixes produce two topics per frame kind, a gateway can answer on either,
 * and matching exactly would mean a frame arriving on the unexpected prefix is
 * silently dropped. That looks exactly like an appliance that has stopped
 * reporting.
 */
function classifyTopic(topic) {
    const last = topic.slice(topic.lastIndexOf('/') + 1);
    switch (last) {
        case 'channelinfo':
        case 'channelstatus':
        case 'controlfail':
        case 'connection':
            return last;
        default:
            return 'other';
    }
}
