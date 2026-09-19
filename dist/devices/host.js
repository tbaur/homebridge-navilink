"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The contract between an accessory and the platform.
 *
 * An explicit interface rather than a reference to the platform class, for two
 * reasons. It breaks the import cycle that would otherwise exist between the
 * platform and the accessories it creates. And it is the whole surface an
 * accessory is allowed to reach, so a test can supply a dozen-line stand-in
 * instead of standing up a platform, a cloud session and a socket.
 *
 * Note what an accessory cannot do through this interface: it cannot reach the
 * MQTT connection, build a frame, or see the account. Every write goes through
 * one of the named intents below, so the rules that govern writes (read-only
 * mode, the power-off guard, rate limiting) are enforced in one place, not in
 * each accessory that might forget. Setpoint coalescing is thermostat-only
 * and lives on {@link ThermostatAccessory}.
 */
Object.defineProperty(exports, "__esModule", { value: true });
