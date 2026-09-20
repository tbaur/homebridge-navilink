/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import { labelAppliance } from '../../src/utils/labels'

describe('labelAppliance', () => {
  it('uses the configured name when there is one', () => {
    expect(labelAppliance({ name: 'Boiler', mac: 'a1b2c3d4e5f6' })).toBe('Boiler')
  })

  it('falls back to a labelled masked gateway when there is no name', () => {
    expect(labelAppliance({ mac: 'a1b2c3d4e5f6' })).toBe('gateway \u2026E5F6')
    expect(labelAppliance({ name: '   ', mac: 'a1b2c3d4e5f6' })).toBe('gateway \u2026E5F6')
  })
})
