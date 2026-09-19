/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The Homebridge verification checker (`homebridge/plugins` `/check`) installs
 * the published package and fails the run if `config.schema.json` is not valid
 * draft-07, or if package.json is missing the fields that page lists. These
 * tests are that contract, so a local `npm test` catches the same mistakes.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PLATFORM_NAME } from '../../src/settings'

interface SchemaNode {
  required?: unknown
  maxLength?: number
  properties?: Record<string, SchemaNode>
  items?: SchemaNode | SchemaNode[]
  oneOf?: SchemaNode[]
  anyOf?: SchemaNode[]
  allOf?: SchemaNode[]
}

interface ConfigSchema {
  pluginAlias: string
  pluginType: string
  schema: SchemaNode & { properties: Record<string, SchemaNode> }
}

interface PackageManifest {
  homepage?: string
  bugs?: { url?: string }
  keywords?: string[]
  scripts?: Record<string, string>
  engines?: { node?: string; homebridge?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, unknown>
  bundledDependencies?: string[]
  bundleDependencies?: string[]
  files?: string[]
}

function collectRequiredValues(node: SchemaNode | undefined, found: unknown[]): void {
  if (!node || typeof node !== 'object') {
    return
  }
  if ('required' in node) {
    found.push(node.required)
  }
  if (node.properties) {
    for (const child of Object.values(node.properties)) {
      collectRequiredValues(child, found)
    }
  }
  if (Array.isArray(node.items)) {
    for (const item of node.items) {
      collectRequiredValues(item, found)
    }
  } else {
    collectRequiredValues(node.items, found)
  }
  for (const branch of [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])]) {
    collectRequiredValues(branch, found)
  }
}

function loadSchema(): ConfigSchema {
  const raw = readFileSync(resolve(__dirname, '../../config.schema.json'), 'utf8')
  return JSON.parse(raw) as ConfigSchema
}

function loadPackage(): PackageManifest {
  const raw = readFileSync(resolve(__dirname, '../../package.json'), 'utf8')
  return JSON.parse(raw) as PackageManifest
}

describe('config.schema.json (Homebridge verification CI)', () => {
  const schema = loadSchema()

  it('declares the platform alias the plugin registers under', () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME)
    expect(schema.pluginType).toBe('platform')
  })

  it('declares a name property so the settings UI and Homebridge 2.x have one', () => {
    expect(schema.schema.properties.name).toEqual(expect.any(Object))
  })

  it('never declares `required` as a boolean (invalid draft-07; AJV will not compile)', () => {
    const requiredValues: unknown[] = []
    collectRequiredValues(schema.schema, requiredValues)
    expect(requiredValues.length).toBeGreaterThan(0)
    for (const value of requiredValues) {
      expect(Array.isArray(value)).toBe(true)
    }
  })

  it('requires the platform name, which Homebridge 2.x and /check both look for', () => {
    expect(schema.schema.required).toEqual(['name'])
  })

  it('does not require devices at the platform level (platform-only config must still start)', () => {
    expect(schema.schema.required).not.toEqual(expect.arrayContaining(['devices']))
  })

  it('requires the fields a saved appliance cannot be missing', () => {
    expect(schema.schema.properties.devices?.items).toEqual(
      expect.objectContaining({ required: ['id', 'name'] }),
    )
  })

  it('caps the password at the same length the runtime accepts', () => {
    expect(schema.schema.properties.password).toEqual(
      expect.objectContaining({ maxLength: 256 }),
    )
  })

  it('matches the runtime default and floor for the status interval', () => {
    expect(schema.schema.properties.options?.properties?.statusIntervalSec).toEqual(
      expect.objectContaining({ default: 120, minimum: 30, maximum: 3600 }),
    )
  })
})

describe('package.json (Homebridge verification CI)', () => {
  const manifest = loadPackage()

  it('has an https homepage', () => {
    expect(manifest.homepage).toEqual(expect.stringMatching(/^https:\/\//))
  })

  it('has an https bugs.url the checker can read a GitHub repo from', () => {
    expect(manifest.bugs?.url).toEqual(
      expect.stringMatching(/^https:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/),
    )
  })

  it('declares homebridge-plugin, a transport keyword, and at least one more keyword', () => {
    const keywords = manifest.keywords ?? []
    expect(keywords).toContain('homebridge-plugin')
    expect(keywords.some((keyword) => ['supports-hap', 'supports-matter'].includes(keyword))).toBe(true)
    expect(keywords.length).toBeGreaterThan(1)
  })

  it('has no install-time scripts that mutate the host', () => {
    for (const script of ['preinstall', 'install', 'postinstall']) {
      expect(manifest.scripts?.[script]).toBeUndefined()
    }
  })

  it('declares engines the /check accepts for Node 22, Node 24 and Homebridge 2', () => {
    const node = manifest.engines?.node ?? ''
    expect(node).toContain('^22')
    expect(node).toContain('^24')
    expect(manifest.engines?.homebridge).toMatch(/\^2/)
  })

  it('does not declare homebridge or hap-nodejs as a runtime, peer, or bundled dependency', () => {
    const declared = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
      ...manifest.peerDependenciesMeta,
    }
    const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies ?? []
    for (const dep of ['homebridge', 'hap-nodejs']) {
      expect(dep in declared).toBe(false)
      expect(bundled).not.toContain(dep)
    }
  })

  it('does not ship strings the /check flags as environment files or private keys', () => {
    // The checker greps the installed package for `/\.env/` and
    // `/private[_-]?key/i`. Those are manual-review only, but a first-run
    // pass should not hand the reviewer a false positive from our own docs.
    const root = resolve(__dirname, '../..')
    const packed = listPackedSourceFiles(root, manifest.files ?? [])
    expect(packed.length).toBeGreaterThan(0)
    for (const file of packed) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/\.env/)
      expect(text).not.toMatch(/private[_\-]?key/i)
    }
  })
})

const PACKED_SOURCE = /\.(?:js|ts|json|md)$/

function listPackedSourceFiles(root: string, globs: string[]): string[] {
  const files: string[] = []
  for (const entry of globs) {
    const rel = entry
      .replace(/\/\*\*\/\*$/, '')
      .replace(/\/\*\*$/, '')
      .replace(/\/\*$/, '')
    collectPacked(join(root, rel), files)
  }
  return files
}

function collectPacked(path: string, files: string[]): void {
  let stats
  try {
    stats = statSync(path)
  } catch {
    return
  }
  if (stats.isFile()) {
    if (PACKED_SOURCE.test(path)) {
      files.push(path)
    }
    return
  }
  if (!stats.isDirectory()) {
    return
  }
  for (const name of readdirSync(path)) {
    collectPacked(join(path, name), files)
  }
}
