/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opaque HomeKit serial numbers.
 *
 * The gateway's MAC address is the obvious candidate and the wrong one.
 * HomeKit shows SerialNumber in the Home app, so it ends up in screenshots and
 * in bug reports, and here it would be worse than a leak of hardware identity:
 * the MAC *is* the appliance's address in every NaviLink MQTT topic. Anyone
 * holding it and a NaviLink account is a step closer to addressing someone
 * else's boiler. A random value generated once and persisted in accessory
 * context is stable across restarts without disclosing anything.
 */
/** Generate a fresh opaque serial number. */
export declare function newAccessorySerialNumber(): string;
