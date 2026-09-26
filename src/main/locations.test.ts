import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCodexCliPath } from './locations'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function executable(name = 'codex'): string {
  const directory = mkdtempSync(join(tmpdir(), 'mull-locations-'))
  temporary.push(directory)
  const path = join(directory, name)
  writeFileSync(path, '#!/bin/sh\n', { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

describe('resolveCodexCliPath', () => {
  it('prefers the explicit override', () => {
    const override = executable()
    expect(resolveCodexCliPath({ MULL_CODEX_CLI: override, PATH: '' }, '/no-home')).toBe(override)
  })

  it('searches PATH without invoking a shell', () => {
    const path = executable()
    expect(resolveCodexCliPath({ PATH: path.slice(0, -'/codex'.length) }, '/no-home')).toBe(path)
  })

  it('finds the ordinary user-local installation when a GUI PATH is sparse', () => {
    const home = mkdtempSync(join(tmpdir(), 'mull-home-'))
    temporary.push(home)
    const directory = join(home, '.local', 'bin')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'codex')
    writeFileSync(path, '#!/bin/sh\n', { mode: 0o700 })
    expect(resolveCodexCliPath({ PATH: '' }, home)).toBe(path)
  })

  it('ignores stale and non-executable candidates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mull-locations-'))
    temporary.push(directory)
    const path = join(directory, 'codex')
    writeFileSync(path, 'not executable', { mode: 0o600 })
    expect(resolveCodexCliPath({ MULL_CODEX_CLI: path, PATH: '' }, '/no-home')).toBeNull()
  })
})
