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

export { NaviLinkDiscovery, type CapturedFrame } from './discovery'
export { parseDeviceId } from './api/identity'
export { isValidEmail, resolveStatusIntervalSec } from './utils/validators'
export { maskMac } from './utils/redact'
export {
  DEFAULT_STATUS_INTERVAL_SEC,
  MAX_PASSWORD_LENGTH,
  MAX_STATUS_INTERVAL_SEC,
  MIN_STATUS_INTERVAL_SEC,
  PLATFORM_NAME,
} from './settings'
export type { DiscoveredDevice } from './types'
