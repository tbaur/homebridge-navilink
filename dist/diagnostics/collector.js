"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opt-in diagnostics collector for health and activity metrics.
 *
 * One collector per platform. It accumulates counters and a bounded latency
 * window, and turns them into:
 *   - `buildHeartbeat()` — per-interval counter deltas + absolute gauges
 *   - `snapshot()`       — session cumulative totals + redacted config echo
 *   - `rollup()`         — `{ health, reasons[] }`
 *
 * NaviLink variant of the sibling collectors: REST sign-in plus an MQTT
 * session, no circuit breaker. It only reads in-memory state via `readers`;
 * it never touches the network.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiagnosticsCollector = void 0;
const settings_1 = require("../settings");
/** Maximum number of recent request latencies retained for percentile math. */
const LATENCY_WINDOW = 200;
/** Recent request outcomes retained for the rollup error-rate calculation. */
const OUTCOME_WINDOW = 50;
/** Minimum recent requests before the API error rate can mark health degraded. */
const API_ERROR_MIN_SAMPLES = 10;
/** Recent error rate (0..1) at or above which health is considered degraded. */
const API_ERROR_RATE_THRESHOLD = 0.5;
/** Accumulates diagnostics counters and renders heartbeat/snapshot reports. */
class DiagnosticsCollector {
    now;
    startedAtMs;
    pluginVersion;
    configEcho;
    apiRequests = 0;
    apiErrors = 0;
    pollOk = 0;
    pollFailed = 0;
    sessionRefreshes = 0;
    mqttReconnects = 0;
    commands = 0;
    pushes = 0;
    lastPollDurationMs = null;
    latencies = [];
    recentOutcomes = [];
    marker;
    constructor(options) {
        this.now = options.now ?? Date.now;
        this.startedAtMs = this.now();
        this.pluginVersion = options.pluginVersion;
        this.configEcho = redactConfig(options.config);
        this.marker = this.captureCounters();
    }
    apiRequest(durationMs, ok) {
        this.apiRequests += 1;
        if (!ok) {
            this.apiErrors += 1;
        }
        if (Number.isFinite(durationMs) && durationMs >= 0) {
            this.latencies.push(durationMs);
            if (this.latencies.length > LATENCY_WINDOW) {
                this.latencies.shift();
            }
        }
        this.recentOutcomes.push(ok);
        if (this.recentOutcomes.length > OUTCOME_WINDOW) {
            this.recentOutcomes.shift();
        }
    }
    mqttReconnect() {
        this.mqttReconnects += 1;
    }
    pollCycle(ok, failed, durationMs) {
        this.pollOk += ok;
        this.pollFailed += failed;
        if (Number.isFinite(durationMs) && durationMs >= 0) {
            this.lastPollDurationMs = durationMs;
        }
    }
    command() {
        this.commands += 1;
    }
    sessionRefresh() {
        this.sessionRefreshes += 1;
    }
    push() {
        this.pushes += 1;
    }
    /** Nearest-rank percentile (0..100) over the recent-latency window. */
    percentile(p) {
        if (this.latencies.length === 0) {
            return 0;
        }
        const sorted = [...this.latencies].sort((left, right) => left - right);
        const clamped = Math.min(100, Math.max(0, p));
        const rank = Math.ceil((clamped / 100) * sorted.length);
        const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
        return sorted[index] ?? 0;
    }
    /**
     * Classify current health. Degraded when the MQTT session has been down
     * longer than the grace window, credentials were rejected, or recent REST
     * calls are failing at a high rate.
     */
    rollup(readers) {
        const reasons = [];
        const mqttState = readers.mqttState();
        if (mqttState === 'auth-failed') {
            reasons.push('authFailed');
        }
        else if (mqttState !== 'running') {
            const age = readers.lastMqttEventAgeSec();
            const uptime = this.uptimeSec();
            const beenDownLongEnough = age === null
                ? uptime >= settings_1.MQTT_DOWN_GRACE_SEC
                : age >= settings_1.MQTT_DOWN_GRACE_SEC;
            if (beenDownLongEnough) {
                reasons.push('mqttDown');
            }
        }
        const total = this.recentOutcomes.length;
        if (total >= API_ERROR_MIN_SAMPLES) {
            const errors = this.recentOutcomes.filter((ok) => !ok).length;
            if (errors / total >= API_ERROR_RATE_THRESHOLD) {
                reasons.push('apiErrorRateHigh');
            }
        }
        return {
            health: reasons.length > 0 ? 'degraded' : 'healthy',
            reasons,
        };
    }
    buildHeartbeat(readers) {
        const current = this.captureCounters();
        const report = this.buildReport('health', {
            refreshes: current.sessionRefreshes - this.marker.sessionRefreshes,
            pollOk: current.pollOk - this.marker.pollOk,
            pollFailed: current.pollFailed - this.marker.pollFailed,
            requests: current.apiRequests - this.marker.apiRequests,
            errors: current.apiErrors - this.marker.apiErrors,
            reconnects: current.mqttReconnects - this.marker.mqttReconnects,
            commands: current.commands - this.marker.commands,
            pushes: current.pushes - this.marker.pushes,
        }, readers);
        this.marker = current;
        return report;
    }
    snapshot(msg, readers) {
        const report = this.buildReport(msg, {
            refreshes: this.sessionRefreshes,
            pollOk: this.pollOk,
            pollFailed: this.pollFailed,
            requests: this.apiRequests,
            errors: this.apiErrors,
            reconnects: this.mqttReconnects,
            commands: this.commands,
            pushes: this.pushes,
        }, readers);
        report.config = { ...this.configEcho };
        return report;
    }
    uptimeSec() {
        return Math.round((this.now() - this.startedAtMs) / 1_000);
    }
    captureCounters() {
        return {
            apiRequests: this.apiRequests,
            apiErrors: this.apiErrors,
            pollOk: this.pollOk,
            pollFailed: this.pollFailed,
            sessionRefreshes: this.sessionRefreshes,
            mqttReconnects: this.mqttReconnects,
            commands: this.commands,
            pushes: this.pushes,
        };
    }
    buildReport(msg, counters, readers) {
        const { health, reasons } = this.rollup(readers);
        return {
            msg,
            lifecycle: {
                health,
                reasons,
                uptimeSec: this.uptimeSec(),
                pluginVersion: this.pluginVersion,
            },
            devices: readers.devices(),
            transport: { mqttState: readers.mqttState() },
            polling: {
                cadenceSec: readers.pollingCadenceSec(),
                lastDurationMs: this.lastPollDurationMs,
                ok: counters.pollOk,
                failed: counters.pollFailed,
            },
            token: {
                expiresInSec: readers.tokenExpiresInSec(),
                lastRefreshAt: readers.tokenLastRefreshAt(),
                refreshes: counters.refreshes,
            },
            api: {
                p50Ms: this.percentile(50),
                p95Ms: this.percentile(95),
                requests: counters.requests,
                errors: counters.errors,
            },
            activity: {
                reconnects: counters.reconnects,
                commands: counters.commands,
                pushes: counters.pushes,
            },
        };
    }
}
exports.DiagnosticsCollector = DiagnosticsCollector;
/** Credentials and appliance names stay out of the snapshot echo. */
function redactConfig(config) {
    const options = config.options;
    return {
        diagnosticsInterval: options?.diagnosticsInterval ?? 0,
        statusIntervalSec: options?.statusIntervalSec ?? null,
        structuredLogs: options?.structuredLogs ?? false,
        readOnly: options?.readOnly === true,
        allowPowerOff: options?.allowPowerOff === true,
        accessoryPrefix: typeof options?.accessoryPrefix === 'string'
            && options.accessoryPrefix.trim().length > 0,
        devices: Array.isArray(config.devices) ? config.devices.length : 0,
    };
}
