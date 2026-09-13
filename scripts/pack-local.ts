/**
 * Local DMG — no Apple account, no notarisation, no publishing.
 *
 *   npm run pack:local
 *
 * What this produces is a real, installable Mull.app inside a real DMG. What it
 * cannot produce is a *distributable* one: without a Developer ID certificate
 * the app is signed ad-hoc (`codesign --sign -`), which macOS accepts on this
 * machine and rejects on anybody else's the moment the file carries a download
 * quarantine flag. For a personal build on the Mac that built it, that is the
 * whole difference — see docs/LOCAL-BUILD.md.
 *
 * Ad-hoc signing is not optional on Apple Silicon: arm64 refuses to execute a
 * completely unsigned binary, so "skip signing" is not a build that launches.
 * electron-builder does the packaging; the signing below is ours, because
 * electron-builder with `identity: null` skips it entirely.
 *
 * Env:
 *   MULL_LOCAL_HARDENED=0   drop the hardened runtime (try this if the packaged
 *                           app dies instantly on launch; it is only needed for
 *                           notarisation, which is not happening here)
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { build, Arch, Platform, type AfterPackContext, type Configuration } from 'electron-builder'
import { resolveSidecarPath } from '../src/main/locations'
import { SIDECAR_PROTOCOL_VERSION } from '../src/shared/sidecar-api'

const ENTITLEMENTS = 'build/entitlements.mac.plist'
const HARDENED = process.env['MULL_LOCAL_HARDENED'] !== '0'

let failures = 0

function check(name: string, ok: boolean, detail = ''): boolean {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {}
): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        input: opts.input
      })
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` || (e.message ?? 'failed') }
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Sign one Mach-O file or bundle, ad-hoc.
 *
 * `--entitlements` is worth applying even ad-hoc: the hardened runtime honours
 * allow-jit and disable-library-validation regardless of who signed, and those
 * two are what let Electron's JIT and better-sqlite3's .node load at all.
 */
function sign(target: string, withEntitlements: boolean): boolean {
  const args = ['--force', '--sign', '-', '--timestamp=none']
  if (HARDENED) args.push('--options', 'runtime')
  if (withEntitlements) args.push('--entitlements', ENTITLEMENTS)
  args.push(target)
  const result = run('codesign', args)
  if (!result.ok) console.log(`       codesign failed: ${basename(target)} — ${result.out.trim()}`)
  return result.ok
}

/** Files that need their own signature, deepest first. */
function collect(dir: string, matches: (path: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    let entry
    try {
      entry = statSync(path)
    } catch {
      continue // a broken symlink inside a framework's Versions tree
    }
    if (entry.isDirectory()) {
      if (name.endsWith('.framework') || name.endsWith('.app')) continue // signed as bundles
      collect(path, matches, out)
    } else if (matches(path)) {
      out.push(path)
    }
  }
  return out
}

function childBundles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name))
}

/**
 * Only Mach-O objects need signing. The check matters because npm packages ship
 * prebuilds for every platform — better-sqlite3 carries a `win32-x64.node` that
 * codesign will happily "sign" into an extended attribute for no reason.
 */
function isMachO(path: string): boolean {
  const MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    if (readSync(fd, head, 0, 4, 0) < 4) return false
    return MAGIC.has(head.readUInt32BE(0)) || MAGIC.has(head.readUInt32LE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const isLoadable = (path: string): boolean =>
  (path.endsWith('.node') || path.endsWith('.dylib') || path.endsWith('.so')) && isMachO(path)

/**
 * Sign the bundle inside-out.
 *
 * Order is the whole game: a signature seals everything beneath it, so signing
 * the .app first and a helper second invalidates the app. Apple's `--deep` does
 * this walk for you and is documented as an emergency repair tool rather than a
 * build step; enumerating is longer but says out loud what got signed. The
 * verify at the end is the safety net either way.
 */
function signApp(appPath: string): void {
  const frameworks = join(appPath, 'Contents', 'Frameworks')
  const resources = join(appPath, 'Contents', 'Resources')
  const electronFw = join(frameworks, 'Electron Framework.framework', 'Versions', 'A')

  const targets: Array<{ path: string; entitlements: boolean }> = []

  // 1. The Swift sidecar and every native module the app loads.
  const sidecar = join(resources, 'mull-mac')
  if (existsSync(sidecar)) targets.push({ path: sidecar, entitlements: true })
  for (const path of collect(resources, isLoadable)) {
    targets.push({ path, entitlements: false })
  }

  // 2. Electron's own nested payload — crashpad handler and bundled dylibs.
  for (const path of collect(join(electronFw, 'Helpers'), () => true)) {
    targets.push({ path, entitlements: false })
  }
  for (const path of collect(join(electronFw, 'Libraries'), isLoadable)) {
    targets.push({ path, entitlements: false })
  }

  // 3. Frameworks, then the helper apps that link them.
  for (const path of childBundles(frameworks, '.framework')) {
    targets.push({ path, entitlements: false })
  }
  for (const path of childBundles(frameworks, '.app')) {
    targets.push({ path, entitlements: true }) // renderer/GPU helpers inherit the JIT entitlements
  }

  // 4. The app last.
  targets.push({ path: appPath, entitlements: true })

  console.log(`\nad-hoc signing ${targets.length} objects (hardened runtime: ${HARDENED ? 'on' : 'off'})`)
  let signed = 0
  for (const target of targets) {
    if (sign(target.path, target.entitlements)) signed += 1
  }
  check(`signed ${signed}/${targets.length} objects`, signed === targets.length)

  // The net: --deep --strict walks everything, including anything missed above.
  const verified = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  if (!verified.ok) {
    console.log(`  ..   verify found an unsigned object, re-signing with --deep`)
    console.log(`       ${verified.out.trim().split('\n').slice(-2).join(' / ')}`)
    const args = ['--force', '--deep', '--sign', '-', '--timestamp=none']
    if (HARDENED) args.push('--options', 'runtime')
    args.push('--entitlements', ENTITLEMENTS, appPath)
    run('codesign', args)
    const second = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    check('the signature verifies (after --deep repair)', second.ok, second.out.trim().split('\n').pop() ?? '')
  } else {
    check('the signature verifies', true, verified.out.trim().split('\n').pop() ?? '')
  }
}

// ---------------------------------------------------------------------------
// Structural checks — the things that make a packaged app differ from `dev`
// ---------------------------------------------------------------------------

function inspectApp(appPath: string): void {
  console.log('\nbundle contents')
  const resources = join(appPath, 'Contents', 'Resources')

  check('the sidecar shipped', existsSync(join(resources, 'mull-mac')), 'Contents/Resources/mull-mac')
  check('the renderer shipped', existsSync(join(resources, 'app.asar')), 'app.asar')

  // better-sqlite3 is a native module: it must be *outside* the asar, or the
  // journal (and therefore undo) is dead in the packaged app only.
  const unpacked = join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3')
  check('better-sqlite3 is unpacked from the asar', existsSync(unpacked))

  const plist = join(appPath, 'Contents', 'Info.plist')
  const mic = run('plutil', ['-extract', 'NSMicrophoneUsageDescription', 'raw', plist])
  check('the microphone usage string is in Info.plist', mic.ok, mic.out.trim().slice(0, 48))
  const agent = run('plutil', ['-extract', 'LSUIElement', 'raw', plist])
  check('LSUIElement is set (no Dock icon)', agent.ok && agent.out.trim() === 'true')
  const id = run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])
  console.log(`       bundle id: ${id.out.trim()} — TCC grants attach to this; keep it stable`)
}

/**
 * Does the signed bundle actually execute?
 *
 * This is the question a local build turns on, and it can be answered without
 * launching the app (which would take the ⌥Space hotkey and raise TCC prompts
 * for a build we are about to throw away). `ELECTRON_RUN_AS_NODE` runs the very
 * same signed binary as a plain node process, so the hardened runtime, the
 * ad-hoc signature and the entitlements are all in force — and loading a native
 * module inside it is exactly the thing library validation would refuse if
 * disable-library-validation were missing or the .node went unsigned.
 */
function smokeApp(appPath: string): void {
  console.log('\nruntime')
  const binary = join(appPath, 'Contents', 'MacOS', basename(appPath, '.app'))
  if (!check('the app binary is where Info.plist says', existsSync(binary), binary)) return

  const boot = run(binary, ['-e', 'process.stdout.write(process.versions.node)'], {
    env: { ELECTRON_RUN_AS_NODE: '1' }
  })
  check('the signed binary runs', boot.ok, boot.ok ? `node ${boot.out.trim()}` : boot.out.trim())

  // Foreign-arch prebuilds ship in the same directory; they are Mach-O too and
  // will not load here, which says nothing about the signature.
  const natives = collect(join(appPath, 'Contents', 'Resources', 'app.asar.unpacked'), isLoadable)
    .filter((path) => !/win32|linux|x64|ia32/.test(path))
  for (const native of natives) {
    const loaded = run(binary, ['-e', 'require(process.argv[1])', native], {
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    check(
      `${basename(native)} loads under the hardened runtime`,
      loaded.ok,
      loaded.ok ? '' : loaded.out.trim().split('\n')[0] ?? ''
    )
  }

  // The sidecar is a separate signed executable with its own entitlements; if
  // the signature were wrong it would die on exec rather than answer.
  const sidecar = join(appPath, 'Contents', 'Resources', 'mull-mac')
  const handshake = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'init',
    params: { protocolVersion: SIDECAR_PROTOCOL_VERSION }
  })
  const init = run(sidecar, [], { input: `${handshake}\n` })
  check(
    'the bundled sidecar answers init',
    init.out.includes(`"protocolVersion":${SIDECAR_PROTOCOL_VERSION}`),
    init.out.trim().split('\n').pop() ?? ''
  )
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('mull local package (no Apple account)')

  const sidecar = resolveSidecarPath({ repoRoot: process.cwd() })
  if (!existsSync(sidecar)) {
    console.error(`\nsidecar missing at ${sidecar}\n  run: npm run build:sidecar`)
    process.exitCode = 1
    return
  }
  if (!existsSync('out/main/index.js')) {
    console.error('\nout/main/index.js missing\n  run: npm run build')
    process.exitCode = 1
    return
  }

  // Belt and braces: without this electron-builder hunts the keychain for an
  // identity and can pick up something unrelated.
  process.env['CSC_IDENTITY_AUTO_DISCOVERY'] = 'false'

  const overrides: Configuration = {
    // We sign in afterPack instead — electron-builder would skip arm64's
    // mandatory ad-hoc signature entirely.
    mac: { identity: null, notarize: false },
    dmg: { sign: false },
    afterPack: async (context: AfterPackContext) => {
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      signApp(appPath)
      inspectApp(appPath)
      smokeApp(appPath)
    }
  }

  const artifacts = await build({
    targets: Platform.MAC.createTarget('dmg', Arch.arm64),
    config: overrides
  })

  const dmg = artifacts.find((path) => path.endsWith('.dmg'))
  console.log('\nartifacts')
  for (const path of artifacts) console.log(`  ${path}`)
  check('a DMG was produced', dmg !== undefined)

  if (dmg !== undefined) {
    // Nothing built locally is quarantined; a DMG that travels (AirDrop, a
    // download) picks the flag up and Gatekeeper then rejects an ad-hoc app.
    const quarantined = run('xattr', ['-p', 'com.apple.quarantine', dmg]).ok
    check('the DMG is not quarantined', !quarantined)
  }

  console.log('\nnot proven by this build (needs a Developer ID):')
  console.log('  · Gatekeeper acceptance on any other Mac — `spctl -a` rejects ad-hoc by design')
  console.log('  · the M6 insertion-matrix pass, which must run on a notarised bundle')

  if (failures === 0) {
    console.log('\nnext:')
    console.log(`  open "${dmg}"   # drag Mull to Applications`)
    console.log('  then re-grant Microphone, Accessibility and Input Monitoring to Mull')
    console.log('  (see docs/LOCAL-BUILD.md — the grants do not carry over from dev)')
  }

  console.log(failures === 0 ? '\nPACK_OK' : `\nPACK_FAILED (${failures})`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main()
