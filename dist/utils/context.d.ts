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
import type { PlatformAccessory } from 'homebridge';
import type { AccessoryContext, ResolvedAccessory } from '../types';
/** A cached context, or undefined when it is unusable. */
export declare function parseAccessoryContext(value: unknown): AccessoryContext | undefined;
/**
 * Write a resolved accessory's identity into its context.
 *
 * Returns the context it wrote, so a caller can use the same object it just
 * persisted rather than reading it back and re-parsing.
 */
export declare function bindAccessoryContext(input: {
    accessory: PlatformAccessory;
    resolved: ResolvedAccessory;
    model: string;
}): AccessoryContext;
