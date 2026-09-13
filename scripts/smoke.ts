/**
 * Headless smoke test for the M1 loop.
 *
 * Runs everything that does not need a window: the Swift sidecar over real
 * ndjson, the ASR provider selection, cleanup, and a full pipeline run against
 * fakes. What it cannot prove — that the microphone works, that ⌥Space is
 * seen, that text lands in Mail — is what docs/M1-VERIFY.md asks you to do by
 * hand.
 *
 *   npm run smoke
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { defaultModelPath, resolveSidecarPath, resolveWhisperCli } from '../src/main/locations'
import { SidecarClient, FakeSidecar } from '../src/main/services/sidecar'
import { InsertionService } from '../src/main/services/insertion'
import { UndoService } from '../src/main/services/undo'
import { JournalStore } from '../src/main/store/journal'
import type { SqlDatabase } from '../src/main/store/sqlite'
import { selectAsrProvider } from '../src/main/asr'
import { FakeAsrProvider } from '../src/main/asr/fake'
import { DictationPipeline } from '../src/main/pipeline/dictation'
import { cleanTranscript } from '../src/main/pipeline/cleanup'
import { encodeWav } from '../src/main/audio/wav'
import { Bench } from '../src/main/bench'
import { CAPTURE_SAMPLE_RATE, type HudState } from '../src/shared/ipc'

let failures = 0
const pending: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL'
  if (!ok) failures += 1
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * Something only the human can do (install a tool, grant a permission). Never
 * a failure — a fresh checkout should still come up green — but never silent
 * either: every pending item is repeated at the end with its command.
 */
function todo(name: string, done: boolean, fix: string): void {
  if (done) return check(name, true)
  pending.push(`${name} — ${fix}`)
  console.log(`  todo ${name} — ${fix}`)
}

/** One second of 440 Hz at a realistic speaking level. */
function tone(seconds = 1.2): Float32Array {
  const samples = new Float32Array(Math.round(CAPTURE_SAMPLE_RATE * seconds))
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / CAPTURE_SAMPLE_RATE) * 0.25
  }
  return samples
}

async function checkSidecar(): Promise<void> {
  console.log('\nsidecar')
  const binaryPath = resolveSidecarPath({ repoRoot: process.cwd() })
  if (!SidecarClient.binaryExists(binaryPath)) {
    check('binary present', false, `${binaryPath} — run: npm run build:sidecar`)
    return
  }
  check('binary present', true, binaryPath)

  const client = new SidecarClient({ binaryPath })
  try {
    await client.start()
    check('init handshake', true)

    const perms = await client.checkPermissions({})
    check('checkPermissions responds', true, JSON.stringify(perms))

    const secure = await client.secureInputState({})
    check('secureInputState responds', typeof secure.active === 'boolean', `active=${secure.active}`)

    const front = await client.frontmostApp({})
    check('frontmostApp responds', true, front.app?.name ?? 'none')

    // M2 verbs. Without Accessibility (or with focus somewhere unreadable)
    // these correctly report *why* rather than failing — the shape is what is
    // under test here; docs/M2-VERIFY.md covers the behaviour by hand.
    const focused = await client.focusedElement({ contextBytes: 512 })
    check(
      'focusedElement answers',
      focused.element !== undefined,
      focused.element ? `role=${focused.element.role} editable=${focused.element.editable}` : `null (${focused.reason})`
    )

    // M4.2: the selection, wherever it is. `allowCopy` is deliberately false —
    // smoke must never press ⌘C into whatever app happens to be frontmost.
    const selected = await client.selectedText({ allowCopy: false })
    check(
      'selectedText answers without touching the pasteboard',
      typeof selected.editable === 'boolean',
      selected.text
        ? `${selected.source}: ${selected.text.length} chars, editable=${selected.editable}`
        : `null (${selected.reason})`
    )

    // M5a: the window, read as text. Cheap and safe to run here — it presses
    // nothing and writes nothing. `screenshot: false` because smoke must not
    // photograph whatever the developer happens to have open.
    const started = Date.now()
    const context = await client.windowContext({ screenshot: false })
    const contextChars = context.blocks.reduce((n, b) => n + b.text.length, 0)
    check(
      'windowContext reads the focused window',
      Array.isArray(context.blocks),
      `${context.blocks.length} blocks, ${contextChars} chars, ${context.harvestMs}ms harvest ` +
        `(${Date.now() - started}ms round trip), stoppedBy=${context.stoppedBy}`
    )
    // The budget is the point: a walk that cannot be bounded is one that can
    // hang the utterance it was supposed to be free for.
    check(
      'and stays inside its deadline',
      context.harvestMs <= 2_000,
      `${context.harvestMs}ms`
    )
    check(
      'and does not photograph unless asked',
      context.screenshot === null && context.screenshotReason === 'not-requested'
    )
    todo(
      'Screen Recording granted',
      perms.screenRecording,
      'System Settings → Privacy & Security → Screen Recording — needed for the picture half'
    )

    // A sentinel no real document contains, so the guard is what gets
    // exercised and nothing on this machine can be edited by running smoke.
    const sentinel = 'mull-smoke-sentinel-0d6f1c4a-never-present'
    const badRange = await client.replaceRange({
      start: 0,
      length: sentinel.length,
      text: sentinel,
      expect: sentinel
    })
    check(
      'replaceRange refuses when its expectation misses',
      !badRange.replaced,
      badRange.reason ?? ''
    )

    // Deliberately an unknown key: rejected *before* anything is posted, so the
    // smoke test can never type into whatever app happens to be in front.
    const chord = await client.keyChord({ key: 'no-such-key', modifiers: ['cmd'] })
    check('keyChord rejects unknown keys without posting', !chord.sent, chord.reason ?? '')

    // The M3 event tap. Starting and stopping it is safe here: while it runs it
    // only *observes* — and it is torn down two lines later, well before anyone
    // could press the chord.
    const tap = await client.startHotkeyTap({ chord: 'opt-space', swallow: true })
    if (tap.started) {
      check('hotkey tap starts', true, tap.swallowing ? 'swallowing ⌥Space' : 'observing only')
      const stopped = await client.stopHotkeyTap({})
      check('hotkey tap stops', stopped.stopped)
    } else {
      // Not a failure: without Input Monitoring the host falls back to the M1
      // listener pair, which is the whole point of the ladder.
      todo(
        'hotkey tap starts',
        false,
        `${tap.reason ?? 'unavailable'} — grant Input Monitoring, then restart`
      )
    }

    // Fn is observable but never swallowable; the sidecar must say so rather
    // than letting the host believe the key is being consumed.
    const fn = await client.startHotkeyTap({ chord: 'fn', swallow: true })
    if (fn.started) {
      check('fn tap admits it cannot swallow', !fn.swallowing)
      await client.stopHotkeyTap({})
    }
  } catch (err) {
    check('init handshake', false, err instanceof Error ? err.message : String(err))
  } finally {
    await client.dispose()
  }
}

async function checkAsr(): Promise<void> {
  console.log('\nspeech recognition')
  todo('whisper-cli installed', existsSync(resolveWhisperCli()), 'brew install whisper-cpp')
  todo('model downloaded', existsSync(defaultModelPath()), 'npm run fetch:model')

  const { provider, degradedReason } = await selectAsrProvider()
  console.log(`  ..   selected provider: ${provider.name}${degradedReason ? ` (degraded: ${degradedReason})` : ''}`)

  if (provider.name === 'whisper-cli') {
    const started = Date.now()
    const result = await provider.transcribe(tone(1.0), CAPTURE_SAMPLE_RATE)
    check('transcribes a tone without crashing', true, `${Date.now() - started} ms, model ${result.model}`)
  }
  await provider.dispose()
}

function checkPure(): void {
  console.log('\npure functions')
  const cleaned = cleanTranscript('  um, so [BLANK_AUDIO] send the deck , uh please .  ')
  check('cleanup strips fillers + annotations', cleaned.text === 'So send the deck, please.', JSON.stringify(cleaned.text))

  const wav = encodeWav(tone(0.1), CAPTURE_SAMPLE_RATE)
  check('wav header is RIFF/WAVE', wav.subarray(0, 4).toString() === 'RIFF' && wav.subarray(8, 12).toString() === 'WAVE')
  check('wav length matches sample count', wav.length === 44 + 1600 * 2, `${wav.length} bytes`)
}

async function checkPipeline(): Promise<void> {
  console.log('\npipeline (fakes)')
  const sidecar = new FakeSidecar({ accessibility: true })
  const states: HudState[] = []
  let captureStarted = false

  const journal = new JournalStore(new DatabaseSync(':memory:') as unknown as SqlDatabase)
  const pipe = new DictationPipeline(
    {
      sidecar,
      asr: new FakeAsrProvider('um, this is the smoke test.'),
      bench: new Bench('/dev/null'),
      insertion: new InsertionService({ sidecar }),
      journal,
      onState: (s) => states.push({ ...s }),
      capture: {
        start: () => {
          captureStarted = true
        },
        stop: () => {}
      },
      appliedLingerMs: 10
    },
    CAPTURE_SAMPLE_RATE
  )

  pipe.begin()
  check('capture started on key-down', captureStarted)
  pipe.pushChunk(tone(1.0))
  await new Promise((r) => setTimeout(r, 400))
  pipe.end()
  await new Promise((r) => setTimeout(r, 400))

  const phases = states.map((s) => s.phase)
  check('phase sequence reaches applied', phases.includes('applied'), phases.join(' → '))
  check('text was inserted once', sidecar.insertions.length === 1, JSON.stringify(sidecar.insertions))
  check(
    'cleanup ran before insertion',
    sidecar.insertions[0] === 'This is the smoke test.',
    sidecar.insertions[0] ?? '(nothing)'
  )

  const entry = journal.recent(1)[0]
  check('the action was journalled', entry?.status === 'applied', entry?.summary ?? '(no entry)')
  check('and it is undoable', entry?.undoable === true, `verified=${String(entry?.verified)}`)

  const undo = new UndoService({ sidecar, journal })
  const undone = await undo.undoLast()
  check('undo removes exactly what was inserted', undone.ok && sidecar.text === '', JSON.stringify(sidecar.text))
  check('undo refuses a second time', (await undo.undoLast()).reason === 'nothing-to-undo')
  pipe.dispose()

  // Secure input must block insertion outright.
  const blockedSidecar = new FakeSidecar({ accessibility: true, secureInput: true })
  const blocked: HudState[] = []
  const guarded = new DictationPipeline(
    {
      sidecar: blockedSidecar,
      asr: new FakeAsrProvider(),
      bench: new Bench('/dev/null'),
      insertion: new InsertionService({ sidecar: blockedSidecar }),
      onState: (s) => blocked.push({ ...s }),
      capture: { start: () => {}, stop: () => {} }
    },
    CAPTURE_SAMPLE_RATE
  )
  guarded.begin()
  await new Promise((r) => setTimeout(r, 50))
  check('secure input blocks the utterance', blocked.some((s) => s.phase === 'blocked'))
  check('nothing inserted while secure input is on', blockedSidecar.insertions.length === 0)
  guarded.dispose()
}

async function main(): Promise<void> {
  console.log('mull M1 smoke')
  checkPure()
  await checkPipeline()
  await checkSidecar()
  await checkAsr()

  if (pending.length > 0) {
    console.log('\nstill to do by hand (see docs/M1-VERIFY.md):')
    for (const item of pending) console.log(`  · ${item}`)
  }

  console.log(failures === 0 ? '\nSMOKE_OK' : `\nSMOKE_FAILED (${failures})`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main()
