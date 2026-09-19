"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Reading and writing accessory context.
 *
 * Homebridge persists `PlatformAccessory.context` to disk and hands it back as
 * `any` on the next start. Everything in it is therefore untrusted input: it
 * may have been written by an older version of this plugin, hand-edited, or
 * restored from a backup taken before a field existed.
 *
 * Parsing it in one place means the rest of the plugin can hold a typed value,
 * and means there is a single answer to "what happens when the cache is from
 * two versions ago".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAccessoryContext = parseAccessoryContext;
exports.bindAccessoryContext = bindAccessoryContext;
const settings_1 = require("../settings");
const types_1 = require("../types");
const serial_1 = require("./serial");
/** A cached context, or undefined when it is unusable. */
function parseAccessoryContext(value) {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const context = value;
    if (!(0, types_1.isAccessoryKind)(context.kind) || typeof context.deviceId !== 'string') {
        return undefined;
    }
    const parsed = {
        kind: context.kind,
        deviceId: context.deviceId,
        model: typeof context.model === 'string' && context.model.length > 0
            ? context.model
            : settings_1.DEFAULT_MODEL,
        // Regenerated rather than rejected. A cache written before serial numbers
        // were persisted is still a valid accessory, and discarding it would cost
        // the user the room and automations attached to it.
        serialNumber: typeof context.serialNumber === 'string' && context.serialNumber.length > 0
            ? context.serialNumber
            : (0, serial_1.newAccessorySerialNumber)(),
        adoptedLegacyUuid: context.adoptedLegacyUuid === true,
    };
    if (context.scale === 'celsius' || context.scale === 'fahrenheit') {
        parsed.scale = context.scale;
    }
    return parsed;
}
/**
 * Write a resolved accessory's identity into its context.
 *
 * Returns the context it wrote, so a caller can use the same object it just
 * persisted rather than reading it back and re-parsing.
 */
function bindAccessoryContext(input) {
    const { accessory, resolved, model } = input;
    const existing = parseAccessoryContext(accessory.context);
    const context = {
        kind: resolved.kind,
        deviceId: resolved.deviceId,
        model,
        serialNumber: existing?.serialNumber ?? (0, serial_1.newAccessorySerialNumber)(),
        adoptedLegacyUuid: existing?.adoptedLegacyUuid ?? false,
    };
    if (existing?.scale !== undefined) {
        context.scale = existing.scale;
    }
    Object.assign(accessory.context, context);
    return context;
}
