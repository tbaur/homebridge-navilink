"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The surface the configuration UI server is allowed to use.
 *
 * An explicit contract rather than a barrel. The UI runs in a separate
 * process and is the one consumer outside the plugin itself, so pinning what
 * it may reach means its dependencies are visible here instead of being
 * discovered by breaking it. In particular the identity helpers are shared
 * rather than reimplemented: the ids the page writes into configuration have
 * to match what the platform derives, and two implementations would
 * eventually disagree.
 *
 * Note what is *not* exported. `NaviLinkSession` is not here, and must not
 * be: it holds a connection open, refreshes credentials on a timer and
 * retries on failure, none of which belongs in a process that exists only
 * while a settings page is open.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLATFORM_NAME = exports.MIN_STATUS_INTERVAL_SEC = exports.MAX_STATUS_INTERVAL_SEC = exports.MAX_PASSWORD_LENGTH = exports.DEFAULT_STATUS_INTERVAL_SEC = exports.maskMac = exports.resolveStatusIntervalSec = exports.isValidEmail = exports.parseDeviceId = exports.NaviLinkDiscovery = void 0;
var discovery_1 = require("./discovery");
Object.defineProperty(exports, "NaviLinkDiscovery", { enumerable: true, get: function () { return discovery_1.NaviLinkDiscovery; } });
var identity_1 = require("./api/identity");
Object.defineProperty(exports, "parseDeviceId", { enumerable: true, get: function () { return identity_1.parseDeviceId; } });
var validators_1 = require("./utils/validators");
Object.defineProperty(exports, "isValidEmail", { enumerable: true, get: function () { return validators_1.isValidEmail; } });
Object.defineProperty(exports, "resolveStatusIntervalSec", { enumerable: true, get: function () { return validators_1.resolveStatusIntervalSec; } });
var redact_1 = require("./utils/redact");
Object.defineProperty(exports, "maskMac", { enumerable: true, get: function () { return redact_1.maskMac; } });
var settings_1 = require("./settings");
Object.defineProperty(exports, "DEFAULT_STATUS_INTERVAL_SEC", { enumerable: true, get: function () { return settings_1.DEFAULT_STATUS_INTERVAL_SEC; } });
Object.defineProperty(exports, "MAX_PASSWORD_LENGTH", { enumerable: true, get: function () { return settings_1.MAX_PASSWORD_LENGTH; } });
Object.defineProperty(exports, "MAX_STATUS_INTERVAL_SEC", { enumerable: true, get: function () { return settings_1.MAX_STATUS_INTERVAL_SEC; } });
Object.defineProperty(exports, "MIN_STATUS_INTERVAL_SEC", { enumerable: true, get: function () { return settings_1.MIN_STATUS_INTERVAL_SEC; } });
Object.defineProperty(exports, "PLATFORM_NAME", { enumerable: true, get: function () { return settings_1.PLATFORM_NAME; } });
