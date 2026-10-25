/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Tests for the homebridge-pagerduty signal store writer, run
 * against a real SQLite file
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Sqlite from 'node:sqlite'

import { PagerDutySignals } from '../../src/pagerduty-signals'

const sqlite = typeof process.getBuiltinModule === 'function'
  ? process.getBuiltinModule('node:sqlite') as typeof Sqlite | undefined
  : undefined
const describeWithSqlite = sqlite === undefined ? describe.skip : describe

const PLUGIN = 'homebridge-navilink'

interface SignalRow {
  plugin: string
  signal: string
  active: number
  severity: string
  summary: string
  updated_at: number
}

describeWithSqlite('PagerDutySignals', () => {
  let storagePath: string
  let warn: jest.Mock
  let signals: PagerDutySignals

  const storeDir = (): string => join(storagePath, 'homebridge-pagerduty')
  const interfaceDir = (): string => join(storeDir(), 'signals-2026-10-24')
  const storeFile = (): string => join(interfaceDir(), 'signals.sqlite')

  const readRows = (): SignalRow[] => {
    const db = new sqlite!.DatabaseSync(storeFile())
    try {
      return db.prepare('SELECT * FROM signals ORDER BY signal').all() as unknown as SignalRow[]
    } finally {
      db.close()
    }
  }

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'navilink-signals-'))
    warn = jest.fn()
    signals = new PagerDutySignals({ plugin: PLUGIN, storagePath, log: { warn } })
  })

  afterEach(() => {
    signals.close()
    rmSync(storagePath, { recursive: true, force: true })
  })

  it('creates both store directories with mode 0700 and the file with mode 0600', () => {
    signals.write('auth-failed', { active: false, severity: 'error', summary: 'Sign-in rejected' })

    expect(statSync(storeDir()).mode & 0o777).toBe(0o700)
    expect(statSync(interfaceDir()).mode & 0o777).toBe(0o700)
    expect(statSync(storeFile()).mode & 0o777).toBe(0o600)
  })

  it('writes a row that a separate connection reads back', () => {
    signals.write('auth-failed', { active: true, severity: 'error', summary: 'Sign-in rejected' })

    expect(readRows()).toEqual([
      expect.objectContaining({
        plugin: PLUGIN,
        signal: 'auth-failed',
        active: 1,
        severity: 'error',
        summary: 'Sign-in rejected',
      }),
    ])
  })

  it('does not rewrite a signal whose state has not changed', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    signals.write('auth-failed', { active: true, severity: 'error', summary: 'Sign-in rejected' })
    nowSpy.mockReturnValue(2_000)
    signals.write('auth-failed', { active: true, severity: 'error', summary: 'Sign-in rejected' })

    expect(readRows()[0]?.updated_at).toBe(1_000)
    nowSpy.mockRestore()
  })

  it('stores a newline in a summary as a space', () => {
    signals.write('auth-failed', { active: true, severity: 'error', summary: 'Sign-in\nrejected' })

    expect(readRows()[0]?.summary).toBe('Sign-in rejected')
  })

  it('creates nothing and warns once when node:sqlite is unavailable', () => {
    const builtin = jest.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
    try {
      signals.write('auth-failed', { active: true, severity: 'error', summary: 'Sign-in rejected' })
      signals.write('fault.boiler', {
        active: true,
        severity: 'critical',
        summary: 'Navien Boiler is reporting a fault',
      })

      expect(existsSync(storeDir())).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Node 22.13'))
    } finally {
      builtin.mockRestore()
    }
  })

  it('lists nothing and creates nothing before the first write', () => {
    expect(signals.list()).toEqual([])
    expect(existsSync(storeDir())).toBe(false)
  })

  it('lists this plugin\'s rows and not another plugin\'s', () => {
    signals.write('fault.boiler', {
      active: true,
      severity: 'critical',
      summary: 'Navien Boiler is reporting a fault',
    })
    signals.write('auth-failed', { active: false, severity: 'error', summary: 'Sign-in rejected' })
    const other = new PagerDutySignals({
      plugin: 'homebridge-other',
      storagePath,
      log: { warn: jest.fn() },
    })
    other.write('fault.other', { active: true, severity: 'critical', summary: 'Other' })
    other.close()

    expect(signals.list()).toEqual([
      { signal: 'auth-failed', active: false, summary: 'Sign-in rejected' },
      { signal: 'fault.boiler', active: true, summary: 'Navien Boiler is reporting a fault' },
    ])
  })
})
