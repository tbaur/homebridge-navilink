/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Human-readable formatting for diagnostics reports.
 */
import type { DiagnosticsSnapshot, MqttTransportState } from '../types';
/** Short operator-facing label for the MQTT session lifecycle. */
export declare function formatMqttTransportState(state: MqttTransportState): string;
/** Human-readable label for a diagnostics channel (structured JSON keeps `msg`). */
export declare function diagnosticLabel(msg: string): string;
/** Render the bracketed reason list shown after the health state. */
export declare function formatReasons(reasons: string[]): string;
/**
 * Concise summary matching the sibling plugins:
 * `Health: healthy | devices 1/1 | mqtt live | api p50 12ms p95 40ms (req 3, err 0)`.
 */
export declare function formatDiagnosticLine(report: DiagnosticsSnapshot): string;
/** State-only line for a healthy/degraded flip. The heartbeat already has the body. */
export declare function formatHealthTransitionLine(report: DiagnosticsSnapshot): string;
