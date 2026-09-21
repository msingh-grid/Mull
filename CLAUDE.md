# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Mull is a macOS voice-first "thinking layer": hold a key, speak, and the words
either get typed instantly (dictation) or sent to a model that proposes an
edit/draft/answer/navigation step, shown as a card the user must approve. Three
processes: an Electron main process (TypeScript/Node), a Swift sidecar
(`mull-mac/`) that does everything the Accessibility APIs require, and a React
renderer (the HUD/journal/settings UI). Read `README.md` first — it is
long and current, and covers the architecture, the safety model, and the
per-lane behavior in detail. Don't duplicate it here; this file only adds what
you need to *work* in the repo.

`docs/DEVELOPER-GUIDE.md` is the long-form version of this file: setup from
zero, an annotated repo map, the full RPC verb table, testing seams, packaging,
and the conventions list. `docs/USER-GUIDE.md` covers the same app from the
outside — reach for it when you need to know what a surface is supposed to do.

## Commands

```bash
npm run dev                # Electron + Vite, hot reload for renderer
npm run build               # build both bundles
npm run build:sidecar       # swift build -c release — MANUAL, run after any mull-mac/ change
npm test                    # vitest run — the whole suite (863 tests / 49 files)
npx vitest run path/to/file.test.ts        # single file
npx vitest run -t "test name substring"    # single test by name
npm run typecheck           # tsc --noEmit for both tsconfig.node.json and tsconfig.web.json
npm run check:applescript   # osacompile-validates every generated AppleScript
npm run check:native        # verifies native modules load inside Electron
npm run fetch:model         # downloads whisper ggml-small.en.bin (~466MB)
npm run fetch:vad           # Silero VAD for whisper --vad (~900KB, optional)
npm run probe:asr <dir>     # word error rate per model/flag set over a corpus
npm run bench:engine        # measures subscription lane vs API-key lane
npm run smoke                # tsx scripts/smoke.ts — headless E2E sanity pass
npm run pack:local          # ad-hoc-signed local DMG (build:sidecar + build + package)
npm run notarize:dryrun     # check notarization readiness without uploading
```

`npm run dev` does **not** rebuild the sidecar. After any change under
`mull-mac/`, or after pulling a change that bumps `SIDECAR_PROTOCOL_VERSION`,
run `npm run build:sidecar` or the app starts with no accessibility at all —
the handshake in `Verbs.swift` is strict equality, and a mismatch fails `init`
and takes the whole sidecar down (not a partial degrade).

`scripts/probe-*.ts` (`probe-targets`, `probe-harvest`, `probe-agent`,
`probe-router`, `probe-asr`) drive the real sidecar against real applications and print
numbers rather than pass/fail — they exist because several architecture
decisions here came from measurements that contradicted the obvious guess (see
README "How this codebase is tested"). Run them manually when touching
accessibility-facing code; they aren't part of `npm test`.

Swift unit tests exist under `mull-mac/Tests/` but need full Xcode
(`swift test` fails with "no such module 'XCTest'" under command-line-tools
alone) — the sidecar is verified by the probes on this machine, not by a
Swift test target.

## Architecture

```
src/
  shared/          contracts BOTH the main process and the model/sidecar validate against
    sidecar-api.ts   zod RPC map + SIDECAR_PROTOCOL_VERSION (currently 8)
    agent.ts         the agent's whole tool vocabulary, and its safety closure
    nav.ts           the step vocabulary for the questionnaire-style nav lane
    settings.ts      settings schema + defaults
  main/
    pipeline/      one file per lane (dictation, sculpt=edit, ask, navigate, agent) + the executor
    engine/        which model serves a turn (classify/navigate/answer/transform/compose), and every prompt
    services/      hotkeys, HUD, insertion, undo, AppleScript bridges, sidecar client
    store/         SQLite journal, captures, settings, credentials
  renderer/        HUD, journal, settings, onboarding (React) — non-activating floating panel
  preload/         the IPC surface, and nothing else

mull-mac/Sources/MullMacCore/
  AXHarvest.swift    reading a window's words
  AXTargets.swift    enumerating/acting on controls (model sees integers, never element names)
  RealSystem.swift   keys, insertion, activation
  Verbs.swift        RPC surface + protocol handshake

docs/agent/          the agent lane in depth (README.md has all 7 safety seams with file:line refs; AGENT-V2.md has milestones + the unbuilt budget gate)
docs/DESIGN*.md       frozen design system + per-surface behavior spec
docs/M*-VERIFY.md     what was checked at each milestone
```

### The two hotkeys decide everything downstream

⌥Space = "this is the message" → typed instantly, no model in the loop, ever.
Fn = "this is a request" → always goes through `classify` (pinned to
`claude-sonnet-5`) which routes to one of four lanes: **edit** (`sculpt.ts`,
needs a text selection, streams a diff card), **compose** (draft from screen
context), **ask** (answers in a card, writes nothing), **navigate** (goes
elsewhere — either the turn-based questionnaire lane `pipeline/navigate.ts`, or
the tool-calling loop `pipeline/agent.ts`, gated behind `settings.agentLoop`).
There is deliberately no keyword/verb table trying to infer intent from words
— that was tried, is documented as having failed, and was replaced by the key
press itself (see the docstring at the top of `pipeline/router.ts`).

### Engine calls are never an "agent loop" at the SDK level

Every model session (classify/navigate/answer/transform/compose) is created
via the Agent SDK with `tools: [], settingSources: [], maxTurns: 1,
thinking: { type: 'disabled' }` (`engine/agent.ts`) — i.e. it is a plain model
call, not a tool-using agent. The one place a real tool loop exists is
`pipeline/agent.ts` / `engine/agent-loop.ts`, where **Mull's own code** holds
the ~15 in-process tools and the model only picks from a closed vocabulary
(`src/shared/agent.ts`) that cannot express Return (⏎) — see README "The
safety model" for the full 7-point structural argument and
`docs/agent/README.md` §4 for file:line references. When touching anything in
`pipeline/agent.ts`, `pipeline/actions.ts`, `src/shared/agent.ts`, or
`services/undo.ts`, read the docstrings there first — each one records a
prior version of the constraint that was tried and rejected, and widening the
vocabulary without reading that history is how the safety argument quietly
erodes.

### The sidecar boundary

Electron main ↔ Swift sidecar talk ndjson JSON-RPC over stdio, both directions
validated against the single zod map in `src/shared/sidecar-api.ts`, so a
Swift-side shape change fails at the boundary instead of three layers
downstream. `FakeSidecar` (`src/main/services/sidecar.ts`) stands in for the
real process in tests — none of the 829 vitest tests need a Mac, a subprocess,
or a permission dialog. Prefer AppleScript over a new sidecar verb for
anything that doesn't need `AXUIElement`/`CGEvent`/screen capture, given the
manual-rebuild + strict-handshake cost described above (see
`src/main/services/apps.ts` docstring for a worked example of that tradeoff).

### Engine selection

`settings.engine: 'auto' | 'subscription' | 'api-key'`. Default is the user's
own Claude subscription via `AgentEngine` (Agent SDK); `ApiKeyEngine` (plain
Messages API, same prompts, `cache_control: ephemeral` on the system prompt)
is the explicit opt-in escape hatch. Both implement the same `Engine`
interface (`engine/types.ts`); `resolveEngine` (`engine/select.ts`) picks
between them. `npm run bench:engine` measures whether the API-key lane is
worth selecting.
