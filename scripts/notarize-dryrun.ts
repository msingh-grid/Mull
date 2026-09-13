/**
 * Sign/notarise dry run (M2, de-risking M6).
 *
 * Notarisation fails late and expensively: you find out at the end of a release
 * build that an entitlement is missing, a nested binary is unsigned, or the
 * credentials were never set up. docs/PLAN.md therefore pulls the discovery
 * forward to M2. This script proves everything that can be proven without an
 * Apple Developer account, and names precisely what is left:
 *
 *   - the entitlements plist is well-formed and says what we think it says
 *   - the builder config asks for the hardened runtime and signs the sidecar
 *   - the sidecar can actually be signed and verified (ad-hoc if no identity)
 *   - whether a Developer ID identity and a notarytool profile exist here
 *
 *   npm run notarize:dryrun
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSidecarPath } from '../src/main/locations'

let failures = 0
const pending: string[] = []

function check(name: string, ok: boolean, detail = ''): boolean {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function todo(name: string, done: boolean, fix: string): void {
  if (done) {
    check(name, true)
    return
  }
  pending.push(`${name} — ${fix}`)
  console.log(`  todo ${name} — ${fix}`)
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` || (e.message ?? 'failed') }
  }
}

async function checkEntitlements(): Promise<void> {
  console.log('\nentitlements')
  const path = 'build/entitlements.mac.plist'
  if (!check('plist present', existsSync(path), path)) return

  check('plist is well-formed', run('plutil', ['-lint', path]).ok)

  const text = await readFile(path, 'utf8')
  const required = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.device.audio-input'
  ]
  for (const key of required) {
    check(`declares ${key}`, text.includes(key))
  }
  // The sandbox and Accessibility control of other apps are mutually exclusive.
  check('is NOT sandboxed', !text.includes('com.apple.security.app-sandbox'))
}

async function checkBuilderConfig(): Promise<void> {
  console.log('\nelectron-builder config')
  const path = 'electron-builder.yml'
  if (!check('config present', existsSync(path))) return
  const text = await readFile(path, 'utf8')

  check('hardened runtime is on', /hardenedRuntime:\s*true/.test(text))
  check('entitlements are wired in', text.includes('build/entitlements.mac.plist'))
  check('inherited entitlements set (helpers)', text.includes('entitlementsInherit'))
  check('the sidecar is listed for signing', text.includes('Contents/Resources/mull-mac'))
  check('the sidecar is copied into the bundle', text.includes('mull-mac/.build/release/mull-mac'))
  check(
    'mic usage string present (macOS kills the process without it)',
    text.includes('NSMicrophoneUsageDescription')
  )
  check('appId is set', /appId:\s*\S+/.test(text))
  if (/appId:\s*net\.mull\.app/.test(text)) {
    pending.push('appId is still the placeholder — set it to your Team ID’s bundle prefix')
    console.log('  todo appId is a placeholder — set it before the first notarised build')
  }
}

/**
 * The real test: can the sidecar be signed with these entitlements and pass
 * verification? Ad-hoc signing (`-`) needs no certificate and still exercises
 * the entitlement plist, the binary's format and the verifier.
 */
function checkSigning(): void {
  console.log('\nsigning')
  const sidecar = resolveSidecarPath({ repoRoot: process.cwd() })
  if (!check('sidecar built', existsSync(sidecar), sidecar)) {
    console.log('       run: npm run build:sidecar')
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'mull-signcheck-'))
  const copy = join(dir, 'mull-mac')
  try {
    copyFileSync(sidecar, copy)
    const signed = run('codesign', [
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      'build/entitlements.mac.plist',
      '--timestamp=none',
      copy
    ])
    if (!check('ad-hoc signs with the hardened runtime', signed.ok, signed.out.trim())) return

    const verified = run('codesign', ['--verify', '--strict', '--verbose=2', copy])
    check('the signature verifies', verified.ok, verified.out.trim().split('\n').pop() ?? '')

    const shown = run('codesign', ['--display', '--entitlements', '-', copy])
    check(
      'the entitlements survive into the binary',
      shown.out.includes('allow-jit') || shown.out.includes('disable-library-validation'),
      shown.out.includes('disable-library-validation') ? 'library validation disabled' : ''
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function checkCredentials(): void {
  console.log('\ncredentials (only you can supply these)')
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning'])
  const hasDeveloperId = identities.out.includes('Developer ID Application')
  todo(
    'Developer ID Application certificate',
    hasDeveloperId,
    'enrol in the Apple Developer Program, then download the cert into the login keychain'
  )
  if (hasDeveloperId) {
    const line = identities.out.split('\n').find((l) => l.includes('Developer ID Application'))
    console.log(`       ${line?.trim()}`)
  }

  const profile = run('xcrun', ['notarytool', 'history', '--keychain-profile', 'mull'])
  todo(
    'notarytool keychain profile "mull"',
    profile.ok,
    'xcrun notarytool store-credentials mull --apple-id <you> --team-id <TEAM> --password <app-specific-password>'
  )
}

async function main(): Promise<void> {
  console.log('mull sign/notarise dry run')
  await checkEntitlements()
  await checkBuilderConfig()
  checkSigning()
  checkCredentials()

  console.log('\nnot exercised here (needs a real identity):')
  console.log('  · electron-builder --mac dmg with CSC_NAME set')
  console.log('  · xcrun notarytool submit --wait, then stapler staple')
  console.log('  · re-running the insertion matrix on the *notarised* build — TCC treats a')
  console.log('    signed, stable bundle id differently from a dev-mode Electron binary')

  if (pending.length > 0) {
    console.log('\nstill to do by hand — only if the app is to be distributed:')
    for (const item of pending) console.log(`  · ${item}`)
    console.log('  for a build that only runs on this Mac, none of the above is needed:')
    console.log('    npm run pack:local   → an ad-hoc signed DMG (docs/LOCAL-BUILD.md)')
  }

  console.log(failures === 0 ? '\nDRYRUN_OK' : `\nDRYRUN_FAILED (${failures})`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main()
