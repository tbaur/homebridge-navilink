/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The maintenance scripts take a real NaviLink password. The one thing they
 * must not do is print it, including when someone pastes it as a positional
 * argument or as `--password secret`.
 */

import { join } from 'node:path'

const COMMON = join(__dirname, '..', '..', 'scripts', 'lib', 'common.js')

interface CommonLib {
  parseFlags(argv: string[], known: Record<string, string>): Record<string, unknown>
  consumeHiddenChunk(
    value: string,
    chunk: string | Buffer,
  ): { value: string; done: boolean; cancelled: boolean }
}

function load(): CommonLib {
  return require(COMMON) as CommonLib
}

describe('script flag parsing', () => {
  const errors: string[] = []

  beforeEach(() => {
    errors.length = 0
    jest.spyOn(console, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message))
    })
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code ?? 0}`)
    }) as never)
  })

  it('does not echo a positional password', () => {
    const { parseFlags } = load()
    expect(() => parseFlags(['hunter2'], { verbose: 'boolean' })).toThrow(/exit 1/)
    const printed = errors.join('\n')
    expect(printed).not.toContain('hunter2')
    expect(printed).toMatch(/unexpected argument/)
  })

  it('does not echo an unknown --password flag or its value', () => {
    const { parseFlags } = load()
    expect(() => parseFlags(['--password', 'hunter2'], { verbose: 'boolean' })).toThrow(/exit 1/)
    const printed = errors.join('\n')
    expect(printed).not.toContain('hunter2')
    expect(printed).not.toContain('--password')
  })
})

describe('the hidden password prompt', () => {
  it('keeps characters that arrive as utf8 strings, the way readline leaves stdin', () => {
    // The email prompt uses readline, which sets stdin to utf8. The next
    // `data` events are then strings, not Buffers. The old reader ran each
    // character through `String.fromCharCode`, which turns `"s"` into a NUL,
    // and the cloud rejected the body as COMMON_BAD_REQUEST.
    const { consumeHiddenChunk } = load()
    const typed = consumeHiddenChunk('', 'secret')
    const submitted = consumeHiddenChunk(typed.value, '\r')
    expect(typed).toEqual({ value: 'secret', done: false, cancelled: false })
    expect(submitted).toEqual({ value: 'secret', done: true, cancelled: false })
  })

  it('keeps the same password when the chunk is still a Buffer', () => {
    const { consumeHiddenChunk } = load()
    const typed = consumeHiddenChunk('', Buffer.from('secret\r'))
    expect(typed).toEqual({ value: 'secret', done: true, cancelled: false })
  })

  it('does not treat a string keystroke as a byte offset', () => {
    // `String.fromCharCode('s')` is NUL. That is the exact corruption that
    // made a correctly typed password look like a malformed request.
    const { consumeHiddenChunk } = load()
    expect(consumeHiddenChunk('', 's').value).toBe('s')
    expect(consumeHiddenChunk('', 's').value).not.toBe('\u0000')
  })
})
