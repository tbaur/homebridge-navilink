/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * GitHub secret scanning reads the checkout, not the running process. A
 * redaction test that writes `ASIA` plus sixteen letters as one string is
 * enough for it to open a public leak alert. This guard is the same grep CI
 * runs, so `npm test` fails before that happens.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')

const SKIP_DIRS = new Set(['node_modules', 'coverage', '.git'])

const PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'AWS access key id', regex: /\b(?:ASIA|AKIA)[0-9A-Z]{16}\b/g },
  { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{20,}\./g },
  { name: 'signed query token', regex: /X-Amz-Security-Token=[A-Za-z0-9]/g },
  { name: 'STS token prefix', regex: new RegExp(['Fwo', 'GZXIvYXdz'].join(''), 'g') },
]

const ROOTS = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'DEVELOPMENT.md',
  'RELEASING.md',
  'CHANGELOG.md',
  'config.schema.json',
  'docs',
  'src',
  'tests',
  'homebridge-ui',
  'scripts',
  'dist',
  '.github',
]

function walk(path: string, files: string[]): void {
  const info = statSync(path)
  if (info.isDirectory()) {
    if (SKIP_DIRS.has(path.split(/[/\\]/).pop() ?? '')) {
      return
    }
    for (const name of readdirSync(path)) {
      walk(join(path, name), files)
    }
    return
  }
  files.push(path)
}

describe('committed text', () => {
  const files: string[] = []
  for (const entry of ROOTS) {
    walk(join(ROOT, entry), files)
  }

  it('has files to scan', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(PATTERNS)('contains no $name as a contiguous literal', ({ regex }) => {
    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (regex.test(text)) {
        hits.push(relative(ROOT, file))
      }
      regex.lastIndex = 0
    }

    expect(hits).toEqual([])
  })
})
