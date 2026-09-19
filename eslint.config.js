/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * ESLint configuration for homebridge-navilink.
 * Uses the ESLint flat config format (ESLint 10).
 */
const globals = require('globals')
const tsParser = require('@typescript-eslint/parser')
const tsPlugin = require('@typescript-eslint/eslint-plugin')

/** Correctness and style rules that apply to every source file, JS or TS. */
const sharedRules = {
  'no-undef': 'error',
  'no-redeclare': 'error',
  'eqeqeq': ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-throw-literal': 'error',
  'no-return-await': 'error',
  'no-console': 'off',
  'curly': ['error', 'all'],
  'max-depth': ['error', 4],
  // Matches the project guidance: past four, take an options object.
  'max-params': ['error', 4],
  'semi': ['error', 'never'],
  'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
  'comma-dangle': ['error', 'always-multiline'],
}

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      ...sharedRules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        // Type-aware linting: without a project, the rules that catch the real
        // defects here (floating promises, misused promises) cannot run.
        // The test config extends the production one and covers both trees.
        project: './tsconfig.test.json',
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.node,
        ...globals.jest,
        // The MQTT transport runs on the runtime's own WebSocket. `lib: ["DOM"]`
        // in tsconfig is what types it; this is what stops `no-undef` rejecting it.
        WebSocket: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...sharedRules,
      // Superseded by the TypeScript-aware versions.
      'no-redeclare': 'off',
      'no-throw-literal': 'off',
      'no-return-await': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // `lib: ["DOM"]` is in tsconfig for the WebSocket type alone. Without this
      // the whole browser surface becomes available to `src/`, and a stray
      // `document` or `localStorage` would type-check in a Node process and
      // fail at runtime.
      'no-restricted-globals': ['error',
        { name: 'document', message: 'This runs in Node. DOM is in lib only for WebSocket.' },
        { name: 'window', message: 'This runs in Node. DOM is in lib only for WebSocket.' },
        { name: 'localStorage', message: 'This runs in Node. DOM is in lib only for WebSocket.' },
        { name: 'navigator', message: 'This runs in Node. DOM is in lib only for WebSocket.' },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests assert on values they just constructed; a non-null assertion there
      // documents an invariant of the fixture rather than hiding an unknown.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // A stand-in has to keep the signature of the thing it stands in for, and
      // most of them answer from a table rather than awaiting anything. Kept on
      // in src/, where a needless async is a real smell.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Config files are linted, but they are CommonJS and outside the TS project.
    files: ['*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  {
    // The settings page runs in the Homebridge UI's browser context, where the
    // host injects `homebridge` as a global.
    files: ['homebridge-ui/public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        homebridge: 'readonly',
      },
    },
  },
]
