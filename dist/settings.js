"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Plugin-wide constants and the plugin version reader.
 *
 * NaviLink has no published specification, so every number here came from one
 * of two places: a measurement against a real appliance, or a judgement call
 * about how hard to lean on a vendor's cloud. Each says which, so a future
 * reader can tell an observed fact from a policy we chose and are free to
 * change. Protocol constants (topics, command codes, payload shapes) live in
 * `api/protocol.ts` instead, next to the code that builds the frames.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_PASSWORD_LENGTH = exports.MAX_NAME_LENGTH = exports.MAX_LOG_FIELD_LENGTH = exports.MAX_UNITS = exports.MAX_CHANNEL = exports.MIN_CHANNEL = exports.STALE_OBSERVATION_INTERVALS = exports.SETPOINT_COALESCE_MS = exports.HOMEKIT_WRITE_BUDGET_MS = exports.CONTROL_LOCKOUT_MS = exports.CONTROL_INTERVAL_FAIL_CODE = exports.CONTROL_RATE_LIMIT_MS = exports.DISCOVERY_BUDGET_MS = exports.UNREACHABLE_REWARN_MS = exports.MIN_REFRESH_DELAY_MS = exports.CREDENTIAL_REFRESH_MARGIN_MS = exports.MAX_STATUS_INTERVAL_SEC = exports.MIN_STATUS_INTERVAL_SEC = exports.DEFAULT_STATUS_INTERVAL_SEC = exports.RECONNECT_BACKOFF_MAX_MS = exports.RECONNECT_BACKOFF_BASE_MS = exports.MQTT_PING_TIMEOUT_MS = exports.MQTT_KEEPALIVE_SEC = exports.STATUS_RESPONSE_TIMEOUT_MS = exports.MQTT_SUBSCRIBE_TIMEOUT_MS = exports.MQTT_CONNECT_TIMEOUT_MS = exports.MAX_REST_BYTES = exports.REST_TIMEOUT_MS = exports.CONNECT_TIMEOUT_MS = exports.IOT_REGION = exports.IOT_ENDPOINT = exports.API_BASE = exports.DEFAULT_MODEL = exports.MANUFACTURER = exports.UNKNOWN_PLUGIN_VERSION = exports.UUID_PREFIX = exports.PLATFORM_NAME = exports.PLUGIN_NAME = void 0;
exports.readPluginVersion = readPluginVersion;
/** npm package name. Must match `package.json` `name` for Homebridge to load us. */
exports.PLUGIN_NAME = 'homebridge-navilink';
/** Platform alias used in `config.json` and `config.schema.json`. */
exports.PLATFORM_NAME = 'NaviLink';
/**
 * Namespace for generated accessory UUIDs.
 *
 * Deliberately does not include the account: a user who changes their NaviLink
 * email address, or moves an appliance to a second account, must not lose
 * every room, scene and automation built on these accessories.
 */
exports.UUID_PREFIX = 'homebridge-navilink:';
/** Reported when `package.json` cannot be read. */
exports.UNKNOWN_PLUGIN_VERSION = '0.0.0';
/** Manufacturer shown in Accessory Information. */
exports.MANUFACTURER = 'Navien';
/** Model shown when the cloud does not name one. */
exports.DEFAULT_MODEL = 'NaviLink appliance';
// --- Cloud endpoints -------------------------------------------------------
/**
 * REST base for the North American service.
 *
 * `nlus` is the region prefix. Navien runs separate stacks per region and the
 * others use different hostnames; this plugin has only been verified against
 * the US one, which is why the host is a constant rather than a setting. A
 * setting would imply a choice that has been tested.
 */
exports.API_BASE = 'https://nlus.naviensmartcontrol.com/api/v2';
/** AWS IoT data endpoint for the same stack, and the region that signs it. */
exports.IOT_ENDPOINT = 'a1t30mldyslmuq-ats.iot.us-east-1.amazonaws.com';
/** @see IOT_ENDPOINT */
exports.IOT_REGION = 'us-east-1';
// --- Timing ----------------------------------------------------------------
/** Connect timeout for a REST call. Short, so an outage fails startup quickly. */
exports.CONNECT_TIMEOUT_MS = 5_000;
/** Total timeout for a REST call. */
exports.REST_TIMEOUT_MS = 30_000;
/** Largest REST response accepted. A device list for a large account is a few KiB. */
exports.MAX_REST_BYTES = 262_144;
/** How long to wait for the WebSocket upgrade and CONNACK. */
exports.MQTT_CONNECT_TIMEOUT_MS = 15_000;
/** How long to wait for a SUBACK before treating the session as broken. */
exports.MQTT_SUBSCRIBE_TIMEOUT_MS = 10_000;
/**
 * How long to wait for the status frame that answers a request.
 *
 * Generous because the round trip is phone-to-cloud-to-gateway-to-appliance
 * and back, over whatever the appliance's wifi is doing. Measured at roughly
 * 1.2 s on a healthy connection; this is the point at which we stop believing
 * an answer is coming.
 */
exports.STATUS_RESPONSE_TIMEOUT_MS = 20_000;
/**
 * MQTT keepalive.
 *
 * The NaviLink app uses 30 s, and the broker's idle policy is the vendor's
 * rather than something we can read, so matching the app is the conservative
 * choice. A PINGREQ every 30 s over a WebSocket costs nothing.
 */
exports.MQTT_KEEPALIVE_SEC = 30;
/**
 * How long to wait for a PINGRESP before deciding the connection is dead.
 *
 * A WebSocket can stay open with nothing behind it: a NAT that dropped the
 * mapping, or a broker that went away without a close frame. The only way to
 * notice is an unanswered ping. Without this a session can appear healthy for
 * hours while every accessory quietly goes stale.
 */
exports.MQTT_PING_TIMEOUT_MS = 10_000;
/** First reconnect delay after a dropped session. Doubles up to the ceiling. */
exports.RECONNECT_BACKOFF_BASE_MS = 2_000;
/**
 * Ceiling for reconnect backoff.
 *
 * Five minutes, which is longer than a LAN plugin would use. The far end is a
 * vendor's shared service: if it is down, every installation in the region is
 * retrying at once, and a short ceiling makes us part of the problem rather
 * than shortening the outage.
 */
exports.RECONNECT_BACKOFF_MAX_MS = 300_000;
/**
 * Default gap between unprompted status requests.
 *
 * The gateway pushes state changes without being asked, so this is a floor on
 * staleness rather than how state normally arrives. Two minutes is unhurried
 * on purpose: it is someone else's cloud, and the push path is the one that
 * matters.
 */
exports.DEFAULT_STATUS_INTERVAL_SEC = 120;
/** Shortest configurable status interval. */
exports.MIN_STATUS_INTERVAL_SEC = 30;
/** Longest configurable status interval. */
exports.MAX_STATUS_INTERVAL_SEC = 3_600;
/**
 * Refresh the session this long before its credentials expire.
 *
 * The sign-in response says how long the AWS credentials last. Reconnecting on
 * the deadline itself would mean a window where the signature is already
 * invalid, so the timer is pulled forward by this much.
 */
exports.CREDENTIAL_REFRESH_MARGIN_MS = 300_000;
/**
 * Floor on how soon a refresh may be scheduled.
 *
 * Guards against a cloud that reports a very short or zero lifetime, which
 * would otherwise turn the refresh timer into a sign-in loop.
 */
exports.MIN_REFRESH_DELAY_MS = 60_000;
/**
 * How often a continuing outage is allowed to warn again.
 *
 * The first failure warns and the recovery answers it. In between, an outage
 * that lasts a week must not write a warning every reconnect attempt: the
 * log is the thing a user reads to find the *next* problem, and an hour is
 * often enough to show an outage is ongoing without burying anything.
 */
exports.UNREACHABLE_REWARN_MS = 60 * 60 * 1_000;
/**
 * How long the settings page waits for the whole account to describe itself.
 *
 * Generous, because it covers a sign-in, an MQTT handshake and one round trip
 * per gateway against someone else's cloud. Bounded all the same: this runs
 * inside a page a user is looking at, and a spinner that never stops is worse
 * than a list that came back short.
 */
exports.DISCOVERY_BUDGET_MS = 45_000;
/** Minimum gap between two control commands to one appliance. */
exports.CONTROL_RATE_LIMIT_MS = 1_000;
/**
 * The `failCode` meaning "you sent that too soon after the last one".
 *
 * The only value the vendor's own app branches on, and the only one whose
 * meaning is established. Everything else is logged with its number.
 */
exports.CONTROL_INTERVAL_FAIL_CODE = 2;
/**
 * How long to stop sending after the appliance reports a control lockout.
 *
 * The cloud does not say how long its own lockout lasts, so this is a policy
 * choice rather than a measurement. Thirty seconds is long enough to clear a
 * burst from a HomeKit scene and short enough that a deliberate press a
 * moment later still works.
 */
exports.CONTROL_LOCKOUT_MS = 30_000;
/**
 * How long a HomeKit write may block before HAP gives up on it.
 *
 * HAP-NodeJS warns at `Accessory.TIMEOUT_WARNING` (3 s) and abandons the write
 * at 9 s total, returning `OPERATION_TIMED_OUT` and discarding whatever the
 * handler eventually returns. A set therefore has to answer well inside that
 * window and finish any slower work in the background. That matters more
 * here than on a LAN, because a cloud round trip can legitimately outlast it.
 */
exports.HOMEKIT_WRITE_BUDGET_MS = 2_500;
/**
 * Window for coalescing the writes HomeKit sends when a thermostat is adjusted.
 *
 * Dragging the Home app's temperature dial emits a write per step. Sending
 * each one would be a burst of control commands at a vendor cloud for a single
 * gesture, and the appliance would chase the intermediate values. Waiting
 * briefly lets the last one win.
 */
exports.SETPOINT_COALESCE_MS = 800;
/**
 * How stale an observation may be before it stops being reported as truth.
 *
 * A cloud session can stay connected while the *appliance* behind it has gone
 * offline. The gateway stops answering but the broker does not care. Without
 * this the plugin would report a setpoint from yesterday as the current state,
 * which is the failure mode that makes a HomeKit integration untrustworthy.
 * Three missed status intervals, computed at runtime from the configured one.
 */
exports.STALE_OBSERVATION_INTERVALS = 3;
// --- Limits ----------------------------------------------------------------
/** Lowest channel number on a gateway. */
exports.MIN_CHANNEL = 1;
/**
 * Highest channel number accepted.
 *
 * A single appliance is channel 1. A cascade exposes one channel per group of
 * units, and the protocol's channel list is bounded by the frame it arrives
 * in; this is a sanity cap on configuration, not a protocol limit.
 */
exports.MAX_CHANNEL = 32;
/** Most units accepted in one channel, bounding how many probes we iterate. */
exports.MAX_UNITS = 32;
/** Longest untrusted string interpolated into a log line. */
exports.MAX_LOG_FIELD_LENGTH = 100;
/** Longest accepted HomeKit display name. */
exports.MAX_NAME_LENGTH = 64;
/**
 * Longest accepted password.
 *
 * Not a security control. The cloud enforces whatever it enforces. This is a
 * guard against a configuration file that has had a whole certificate pasted
 * into the field, which would otherwise be sent to the vendor verbatim.
 */
exports.MAX_PASSWORD_LENGTH = 256;
let cachedVersion;
/**
 * Read this plugin's version from `package.json`.
 *
 * Reported to HomeKit as FirmwareRevision, which makes the version visible in
 * the Home app and therefore in bug reports.
 */
function readPluginVersion(log) {
    if (cachedVersion !== undefined) {
        return cachedVersion;
    }
    try {
        const pkg = require('../package.json');
        cachedVersion = typeof pkg.version === 'string' && pkg.version.length > 0
            ? pkg.version
            : exports.UNKNOWN_PLUGIN_VERSION;
    }
    catch (error) {
        log?.debug(`could not read plugin version: ${String(error)}`);
        cachedVersion = exports.UNKNOWN_PLUGIN_VERSION;
    }
    return cachedVersion;
}
