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
import type { DeviceGauges, DiagnosticsSnapshot, MqttTransportState, NaviLinkPlatformConfig, SessionMetrics } from '../types';
/**
 * Accessors the collector calls to read live in-memory state. All are
 * synchronous and must never block on the network.
 */
export interface DiagnosticsReaders {
    devices: () => DeviceGauges;
    mqttState: () => MqttTransportState;
    lastMqttEventAgeSec: () => number | null;
    tokenExpiresInSec: () => number | null;
    tokenLastRefreshAt: () => number | null;
    pollingCadenceSec: () => number;
}
interface CollectorOptions {
    pluginVersion: string;
    config: NaviLinkPlatformConfig;
    now?: () => number;
}
/** Health classification result. */
export interface HealthRollup {
    health: 'healthy' | 'degraded';
    reasons: string[];
}
/** Accumulates diagnostics counters and renders heartbeat/snapshot reports. */
export declare class DiagnosticsCollector implements SessionMetrics {
    private readonly now;
    private readonly startedAtMs;
    private readonly pluginVersion;
    private readonly configEcho;
    private apiRequests;
    private apiErrors;
    private pollOk;
    private pollFailed;
    private sessionRefreshes;
    private mqttReconnects;
    private commands;
    private pushes;
    private lastPollDurationMs;
    private readonly latencies;
    private readonly recentOutcomes;
    private marker;
    constructor(options: CollectorOptions);
    apiRequest(durationMs: number, ok: boolean): void;
    mqttReconnect(): void;
    pollCycle(ok: number, failed: number, durationMs: number): void;
    command(): void;
    sessionRefresh(): void;
    push(): void;
    /** Nearest-rank percentile (0..100) over the recent-latency window. */
    percentile(p: number): number;
    /**
     * Classify current health. Degraded when the MQTT session has been down
     * longer than the grace window, credentials were rejected, or recent REST
     * calls are failing at a high rate.
     */
    rollup(readers: DiagnosticsReaders): HealthRollup;
    buildHeartbeat(readers: DiagnosticsReaders): DiagnosticsSnapshot;
    snapshot(msg: string, readers: DiagnosticsReaders): DiagnosticsSnapshot;
    private uptimeSec;
    private captureCounters;
    private buildReport;
}
export {};
