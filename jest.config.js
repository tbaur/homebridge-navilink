/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest configuration for sandboxed testing.
 * All tests run in isolation with mocked dependencies.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json',
    }],
  },

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // Mock lifecycle is handled here rather than in per-suite hooks.
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  // Barrels are listed individually: a blanket `!src/**/index.ts` would also
  // exclude `src/index.ts`, the plugin entry point, which carries real logic.
  collectCoverageFrom: [
    'src/**/*.ts',
    // Shipped to users and run by Homebridge in its own process, so it is held
    // to the same bar as the plugin itself despite living outside src/.
    'homebridge-ui/server.js',
    // Ships to users and handles their NaviLink password, so it is held to the
    // same bar even though it runs in a browser rather than in Homebridge.
    'homebridge-ui/public/index.js',
    '!src/**/*.d.ts',
    '!src/api/index.ts',
    '!src/devices/index.ts',
    '!src/types/index.ts',
    '!src/utils/index.ts',
  ],

  testMatch: [
    '**/tests/unit/**/*.test.ts',
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
  ],

  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],

  testTimeout: 10_000,
  verbose: true,
}
