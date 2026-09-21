# Mull — Developer Guide

Setting up, finding your way around, and the constraints you must not erode.

This guide is for working on Mull. For using it, read
[USER-GUIDE.md](USER-GUIDE.md). For *why* the project exists,
[REPORT.md](REPORT.md) and [05-electron-architecture.md](05-electron-architecture.md).

---

## Contents

- [Orientation](#orientation)
- [Setup from zero](#setup-from-zero)
- [Repository map](#repository-map)
- [How an utterance flows](#how-an-utterance-flows)
- [The sidecar boundary](#the-sidecar-boundary)
- [The engine layer](#the-engine-layer)
- [The safety model](#the-safety-model)
- [Every npm script](#every-npm-script)
- [Testing](#testing)
- [Build and packaging](#build-and-packaging)
- [Environment variables](#environment-variables)
- [Conventions](#conventions)
- [Gotchas](#gotchas)
- [Where to read next](#where-to-read-next)

---

## Orientation

Three processes, and the split is about **capability**, not tidiness.

```
┌─────────────────────────────────────────────────────────────┐
│  Electron main  (TypeScript, Node)                          │
│                                                             │
│   pipeline/   the lanes: dictation, sculpt, ask, navigate,  │
│               agent — and the executor that performs steps  │
│   engine/     which model serves a turn, and the prompts    │
│   services/   hotkeys, HUD, insertion, undo, AppleScript    │
│   store/      SQLite journal, captures, settings            │
└───────────┬──────────────────────────────┬──────────────────┘
            │ ndjson JSON-RPC over stdio   │ IPC
            ▼                              ▼
┌───────────────────────────┐  ┌───────────────────────────────┐
│  mull-mac  (Swift)        │  │  Renderer  (React)            │
│                           │  │                               │
│  Accessibility: reading   │  │  HUD — a frameless,           │
│  windows, enumerating     │  │  non-activating floating      │
│  controls, pressing them  │  │  panel that never takes focus │
│  Synthetic keys, screen   │  │  Journal · Settings ·         │
│  capture, hotkey tap      │  │  Onboarding windows           │
└───────────────────────────┘  └───────────────────────────────┘
```

**Why a Swift sidecar at all:** everything the Accessibility APIs can do is
unavailable from Node. The sidecar is the only part of Mull that touches
`AXUIElement`, posts a `CGEvent`, or reads the screen.

**Read first:** [README.md](../README.md), then `CLAUDE.md`, then this file. Most
source files open with a docstring explaining why the code is shaped the way it
is, usually including what was tried first and why it failed. **Those are
load-bearing history, not decoration.**

---

## Setup from zero

### Prerequisites

| | |
|---|---|
| macOS on Apple silicon | arm64 only; the Swift package needs **macOS 14+** |
| Node | Developed against v24 |
| Xcode command line tools | `swift build` must work. *Full* Xcode is only needed to run the Swift tests |
| `brew install whisper-cpp` | Provides `whisper-cli` |

Optionally, a Claude Code login already on the Mac, or a token from
`claude setup-token`, or an `ANTHROPIC_API_KEY`.

### Install, in this order

```bash
npm install
npm run build:sidecar     # Swift — MANUAL, and required
npm run fetch:model       # ~466 MB, ggml-small.en.bin
npm run dev
```

### What breaks if you skip a step

| Skipped | Symptom |
|---|---|
| `build:sidecar` | **The #1 trap.** `npm run dev` never builds it. Without the binary the app silently falls back to `FakeSidecar`: it launches, it looks fine, and there is **no accessibility at all** — no insertion, no window reading, no Fn key. Check the boot log |
| Rebuilding after a Swift change | Worse than missing. See below |
| `fetch:model` / whisper-cli | ASR degrades to `FakeAsrProvider`, which returns a fixed line. Settings → About reports Speech as `fake (degraded)` |
| `npm run rebuild:native` after an Electron bump | `better-sqlite3` fails to load, the journal never opens, and undo is silently disabled — dictation keeps working |

> ### A stale sidecar is worse than a missing one
>
> The `init` handshake is **strict equality** on `SIDECAR_PROTOCOL_VERSION`
> (currently **8**). A binary built against 7 fails `init` and takes the **whole
> sidecar down** — not a partial degrade. Any pull that touches
> `src/shared/sidecar-api.ts` or `mull-mac/` means running `npm run build:sidecar`
> again.
>
> Because of that cost, several features here were deliberately built on
> AppleScript instead of a new verb. See `src/main/services/apps.ts` for that
> reasoning written out.

Permissions (Accessibility, Input Monitoring, Microphone, and optionally Screen
Recording) must be granted separately in System Settings. The boot log line
`permissions {...}` reports what macOS actually granted and which `hotkeyMode`
was reached.

---

## Repository map

### `src/shared/` — contracts both sides validate against

Two definitions would mean a thing was true in one file and a hope in the other.

| File | |
|---|---|
| `sidecar-api.ts` | **Source of truth for the Electron↔Swift boundary.** Every zod param/result schema, `SIDECAR_PROTOCOL_VERSION = 8`, the method map, and the protocol changelog 2→8 |
| `agent.ts` | The agent loop's **entire tool vocabulary** — 15 tool schemas, `AgentKeySchema` (the closed enum that never contained ⏎), the browser table, and the budget constants. The densest safety docstring in the repo |
| `nav.ts` | The step vocabulary for the questionnaire nav lane. The union *is* the safety argument — no `send`, no `keyChord`, no free-text insert |
| `hud.ts` | What the HUD renders, as data. The renderer computes nothing |
| `ipc.ts` | Every IPC channel name and payload, so the preload allow-list and the main handlers cannot drift |
| `settings.ts` | The settings schema, `DEFAULT_SETTINGS`, and `MODEL_IDS`. Every field carries a paragraph of rationale |
| `context.ts` | What Mull may see, as data, so the HUD can name it while you are still speaking |
| `engine.ts` | `EngineStatus` (crosses IPC) vs `EngineCredentials` (**main-process only, never over IPC**) |
| `permissions.ts` · `model.ts` · `about.ts` | Permission, speech-model and version shapes |
| `types.ts` | Core domain types. `ClassifiedIntent` **has no `send` variant** — safety seam #1 |

### `src/main/`

| File | |
|---|---|
| `index.ts` | The whole main process: five windows, `bootstrap()` wiring, ~40 IPC handlers, tray, lifecycle. ~1285 lines, **no tests** |
| `locations.ts` | Every on-disk path. Deliberately free of `electron` imports so `scripts/` resolve identically. Also `resolveClaudeCliPath` — read that docstring before touching packaging |
| `bench.ts` | Latency ledger; one JSON line per utterance into `bench.jsonl` |
| `trace.ts` | One log line per step per utterance — `⟨u7⟩ +467ms context.read …` |

#### `src/main/pipeline/` — one file per lane, plus the executor

| File | |
|---|---|
| `dictation.ts` | The loop: hold → capture → transcribe → clean → route → insert. Enforces "dictation never waits" |
| `router.ts` | What to do when the model cannot be asked. **Contains the post-mortem on the deleted verb table** — read it before adding any keyword heuristic |
| `intent.ts` | `IntentRouter`; only ever reached on the Fn key |
| `sculpt.ts` | The edit lane: engine → diff card → apply. Three rules, all refusals |
| `ask.ts` | Read the screen, answer in a card, **write nothing, no Apply** |
| `navigate.ts` | The turn-based questionnaire nav lane; interruptible, restores the window |
| `agent.ts` | The tool-calling lane, gated by `settings.agentLoop` |
| `agent-tools.ts` | The 15 in-process tool implementations. Every handler re-checks the stop flag |
| `actions.ts` | `ActionExecutor` — **the only place Mull drives someone else's UI.** Almost entirely guards |
| `context.ts` | Builds the window context (AX harvest + optional screenshot) |
| `selection.ts` | The focus/selection snapshot taken during the hold, re-checked before the write. **No test file** |
| `cleanup.ts` · `diff.ts` | Deterministic local transcript cleanup; word-level diff (char-level "produces confetti") |

#### `src/main/engine/`

| File | |
|---|---|
| `types.ts` | The `Engine` seam — built before any engine existed, so the UI could be judged first |
| `select.ts` | `resolveEngine()`, `SignedOutEngine`, `EngineHolder`, `detectClaudeCodeLogin()` |
| `agent.ts` | `AgentEngine` — the Claude subscription via the Agent SDK. **No test file** |
| `api-key.ts` | `ApiKeyEngine` — the Messages API directly. **No test file** |
| `agent-loop.ts` | The **one real tool loop** |
| `prompts.ts` | Every system prompt, exported once so both engines send identical bytes |
| `classify.ts` · `health.ts` · `fake.ts` | Routing, remembered engine health, and a deterministic stand-in |

#### `src/main/services/`

| File | |
|---|---|
| `sidecar.ts` | `SidecarClient` (framing, typed calls, crash/restart) **and `FakeSidecar`** (a full simulated Mac) |
| `hotkey.ts` · `ptt-machine.ts` · `chords.ts` | The four-rung hotkey ladder, the ⌥Space state machine, and the global ⏎/Esc scope |
| `hud.ts` · `hud-position.ts` | The single place that decides what the HUD shows; drag position with an asymmetric clamp |
| `insertion.ts` · `insertion-table.ts` | The insertion chain and the per-app strategy table (source: [INSERTION-MATRIX.md](INSERTION-MATRIX.md)) |
| `undo.ts` | ⌥Z. **Severity-asymmetric: refuses by default** |
| `sender.ts` · `send-table.ts` | Pressing send, and the per-app chord. **An unknown app has no chord and Mull offers no send** |
| `osascript.ts` | The AppleScript runner. One rule: **outside input travels in `argv`, never spliced into script text** |
| `apps.ts` · `browser.ts` · `menus.ts` | System Events, browser tabs, and the menu bar (safety seam #7, the weakest) |
| `permissions.ts` | What macOS *actually* granted. **A ✓ never comes from the click** |
| `turns.ts` | Short-term memory so "and what about Priya" is not classified alone |
| `model.ts` · `tray.ts` · `tray-icon.ts` | Speech-model download; menu bar; the generated icon module — **do not hand-edit** |

#### `src/main/store/`, `asr/`, `audio/`

| File | |
|---|---|
| `store/sqlite.ts` | The narrow `SqlDatabase` interface — `better-sqlite3` in the app, `node:sqlite` in tests |
| `store/journal.ts` | Every action, **including failures**. `undoable` is earned, never assumed |
| `store/captures.ts` | The window transcript and screenshot **as rendered into the prompt**, as a receipt |
| `store/settings.ts` · `store/credentials.ts` | Atomic JSON settings; `safeStorage`-encrypted secrets that **throw rather than fall back to plaintext** |
| `asr/` | The `AsrProvider` seam, whisper-cli subprocess, and a fake that never pretends to have heard you |
| `audio/wav.ts` | 16-bit PCM WAV writer, mono only |

### `src/preload/` and `src/renderer/`

`preload/index.ts` is the whole bridge: renderers get exactly `window.mull` — no
`ipcRenderer`, no node.

The renderer has **five HTML entry points**: `index` (HUD), `capture` (a hidden
1×1 window that owns the microphone, because main has no `getUserMedia`),
`journal`, `settings`, `onboarding`.

The decisions live in **pure functions**, which is why they are the only tested
parts: `hud/view-model.ts` (all HUD decisions as one function), `hud/pet.ts`
(when the panel is worth raising), `journal/row-model.ts` (`undoAffordance` says
*why* a row cannot be undone rather than hiding the button).

Styling goes through `tokens.css` — **frozen, and no raw hex in component CSS**,
so dark mode needs no rules of its own. See [DESIGN.md](DESIGN.md).

### `mull-mac/` — the Swift sidecar

| File | |
|---|---|
| `Sources/mull-mac/main.swift` | Unbuffered stdout, lock-serialized writer, stdin on a background thread while the **main thread runs `CFRunLoopRun()`** for the event tap |
| `MullMacCore/Rpc.swift` | ndjson JSON-RPC 2.0 framing and error codes (plus `-32000` = NotImplemented) |
| `MullMacCore/Verbs.swift` | All 21 verb registrations, `SIDECAR_PROTOCOL_VERSION = 8`, `SIDECAR_VERSION`. Guard order is fixed: **secure input → accessibility → act** |
| `MullMacCore/RealSystem.swift` | Keys, insertion, activation |
| `MullMacCore/AXText.swift` · `AXHarvest.swift` | Reads/writes on the focused element; reading a window's words in reading order |
| `MullMacCore/AXTargets.swift` | Enumerating and acting on controls — **why the model sees integers, not names** |
| `MullMacCore/HotkeyTap.swift` · `Screenshot.swift` · `Frontmost.swift` | The `CGEventTap`, JPEG capture to disk (never base64 on the wire), and who is in front |

### `scripts/`

`fetch-model` · `smoke` · `bench-engine` · `check-applescript` · `native-check`
· `make-icons` · `pack-local` · `notarize-dryrun`, plus four **probes**
(`probe-targets`, `probe-harvest`, `probe-agent`, `probe-router`) that drive the
real sidecar against real applications.

---

## How an utterance flows

```
key down  ──►  services/hotkey.ts        (tap | ptt | ptt-passive | toggle)
               services/ptt-machine.ts   (repeat, release order, chord hygiene)
    │
    ▼
capture   ──►  renderer/capture.ts       (hidden window; the only getUserMedia)
               public/pcm-worklet.js     (128-frame quanta → 80ms chunks)
    │
    ▼
transcribe ─►  asr/whisper-cli.ts        (subprocess, on device)
               pipeline/cleanup.ts       (fillers, whitespace, sentence case)
    │
    ▼
route     ──►  ⌥Space ─────────────────────────────────────► pipeline/dictation.ts
               Fn ──► pipeline/intent.ts ──► engine/classify.ts
                           │ (on failure, timeout, or rules-only)
                           └──────────────► pipeline/router.ts   [local fallback]
    │
    ▼
lane      ──►  sculpt.ts | ask.ts | navigate.ts | agent.ts
    │              └─ engine/*  ── the model turn
    ▼
card      ──►  services/hud.ts ──► IPC ──► renderer/components/Cards.tsx
    │              services/chords.ts claims ⏎ / Esc while it is open
    ▼
apply     ──►  pipeline/selection.ts     (re-read and compare, or refuse)
               services/insertion.ts     (ax → paste → type)
               services/sidecar.ts ──► Swift
    │
    ▼
record    ──►  store/journal.ts + store/captures.ts
```

Two invariants visible in that diagram:

- **Dictation never waits on a model.** Nothing in `pipeline/dictation.ts` calls
  an `Engine`. ⌥Space works with zero credentials, offline, signed out.
- **The renderer computes nothing.** Main sends a finished picture.

---

## The sidecar boundary

**Transport.** ndjson JSON-RPC 2.0 over the child's stdio — one UTF-8 message per
line. stdout is the protocol channel; **stderr is diagnostics only**.

```
-> {"jsonrpc":"2.0","id":1,"method":"insertText","params":{...}}\n
<- {"jsonrpc":"2.0","id":1,"result":{...}}\n
```

**Validation** runs both ways against the single zod map in
`src/shared/sidecar-api.ts`, so a Swift-side shape change fails **at the
boundary** rather than three layers downstream.

**The handshake.** `start()` spawns the binary and immediately calls
`init` with the host's protocol version. It is idempotent, and every typed call
awaits it, so `init` is always the first message on a fresh child.

**Version mismatch** is strict equality, with no forward or backward tolerance.
Swift throws `-32602` — `protocol version mismatch: host=N sidecar=M` — `start()`
rejects, and every subsequent call fails.

**Crash handling.** Per-call timeout 5s; lines over 4 MiB are discarded with an
error; on close every pending call rejects, then a backoff-delayed restart
(200ms, 500ms, 1.5s, 5s) replays `init` before anything else goes out. After
**8 restarts** it gives up. Unparseable lines, unknown ids and schema-invalid
notifications are **logged loudly, never silently dropped**.

### The 21 verbs

| Verb | |
|---|---|
| `init` | Handshake; rejects on version mismatch |
| `checkPermissions` | Accessibility + Input Monitoring + Screen Recording |
| `promptAccessibility` · `promptScreenRecording` | Present the system prompt / open the pane, then re-read honestly |
| `frontmostApp` | Which app is in front, and its window title |
| `focusedElement` | What the caret is in: role, editable, surrounding text, selection |
| `selectedText` | What is highlighted, wherever it is; reports its `source` |
| `windowContext` | The window as blocks (AX transcript) plus an optional screenshot **path** |
| `uiTargets` | The window as a numbered list of controls under a `harvestId`. Still a pure read |
| `pressTarget` · `focusTarget` · `scrollTarget` | Act on target `index`, quoting back the expected role and title; refuse on mismatch |
| `navKey` | **One** navigation key, no composable modifiers. **Structurally cannot express ⏎** |
| `insertText` | Insert at the caret via `ax` / `paste` / `type`; returns `strategyUsed`, `verified` (null = honest "don't know"), `caret` |
| `replaceSelection` | Replace the selection; also returns the `before` half of a journal entry |
| `replaceRange` | Write to an explicit range with an optional `expect` guard. **AX-only by design** — this is how undo removes exactly what Mull inserted |
| `secureInputState` | When true, all insertion is hard-disabled |
| `activateApp` | Bring a bundle id to the front |
| `keyChord` | An arbitrary key plus modifiers — **the unconstrained one**, deliberately kept separate from `navKey` |
| `startHotkeyTap` · `stopHotkeyTap` | Install/tear down the `CGEventTap` |

**Notifications** (sidecar → host, no reply): exactly one — `hotkey`, carrying
`{phase, chord}`.

> `navKey` and `keyChord` are two verbs rather than one filtered verb on purpose.
> A filter is one edit away from letting ⏎ through; a separate, closed list is one
> where it was never present.

---

## The engine layer

### Selection

`resolveEngine()` in `src/main/engine/select.ts`:

| `settings.engine` | Credential | Result |
|---|---|---|
| `subscription` | token **or** detected Claude Code login | `AgentEngine` |
| `subscription` | neither | `SignedOutEngine` — **never falls back to a saved API key** |
| `api-key` | key present | `ApiKeyEngine` |
| `api-key` | absent | `SignedOutEngine` — **never falls back to the subscription** |
| `auto` *(default)* | — | subscription → API key → signed out |

The explicit modes refuse rather than quietly using the credential the user did
not pick. `auto` prefers the subscription because someone who pasted both has
told us they have one.

`EngineHolder` is a swappable proxy, so signing in or changing a model takes
effect on the **next utterance** rather than after a relaunch; the swap disposes
the previous engine so a warm subprocess never outlives the credential that
started it.

`EngineHealth` is **remembered, not probed**, and distinguishes "do something"
from "wait": 401/403 → `signed-out` (never expires); 429 → back off 60s; 529/5xx
→ 20s; offline → 10s.

### How the subscription lane authenticates

`AgentEngine` drives the Agent SDK's `query()`, which **spawns the Claude Code
CLI as a subprocess**. Authentication is purely by environment variable:

```ts
env: this.options.oauthToken
  ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: this.options.oauthToken }
  : { ...process.env }
```

So there are exactly two paths: a **pasted token** from `claude setup-token`, or
— when nothing is stored — the environment passes through unchanged and the
spawned binary uses **whatever Claude Code login already exists on the Mac**.

That second case is detected by asking the keychain whether the item exists,
**without ever reading its value**:

```ts
execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], …)
```

There is **no OAuth flow inside the app** — no browser redirect, no PKCE, no
device code. The "login UI" is a password field and a button that copies
`claude setup-token` to the clipboard.

**Credentials** live in `~/Library/Application Support/mull/credentials.json`,
encrypted with Electron `safeStorage`, written to a `0600` temp file and renamed.
If encryption is unavailable, `set()` **throws rather than storing plaintext**.
Nothing is ever logged — not the value, not a prefix, not a length. Only
`{hasSubscription, hasApiKey}` crosses IPC.

Each `AgentEngine` holds five single-purpose sessions (edit, classify, compose,
navigate, answer); edit and classify are pre-warmed. **Every one is created with
`tools: [], settingSources: [], maxTurns: 1`** — a plain model call, not an agent.

### The API-key lane

`ApiKeyEngine` calls the Messages API directly with the same prompts and
`cache_control: ephemeral` on the system block. It is the lower-latency lane —
there is no Claude Code subprocess — and it is the only lane that caps output
tokens.

**It has no `runAgent` method at all.** That absence *is* the gate:
`EngineHolder.canRunAgent` is a `typeof` check, and the routing decision reads it
per utterance. With an API key selected, `agentLoop: true` silently does nothing
and navigation falls to the questionnaire lane.

### Models

One table, `MODEL_IDS` in `src/shared/settings.ts`:
`haiku → claude-haiku-4-5`, `sonnet → claude-sonnet-5`, `opus → claude-opus-5`.

| Setting | Default | Chooses the model for |
|---|---|---|
| `editModel` | `sonnet` | transform, compose, navigate, answer |
| `classifierModel` | `sonnet` | routing only |
| `agentModel` | **`opus`** | the tool loop only |

`agentModel` defaults higher than the others deliberately: a rewrite lands in a
diff card and is read; a press just happens.

> **Doc drift:** `docs/agent/README.md` still says the classifier is "always
> Haiku 4.5". It is not — `src/main/engine/classify.ts` pins it to Sonnet. The
> code is correct.

---

## The safety model

Mull types into other people's applications and presses buttons in them. The
controls that make that defensible are **structural wherever possible** — shapes
that make the bad act *unsayable* rather than rules asking a model not to say it.

There are seven. `docs/agent/README.md` §4 has all of them with file and line
references; this is the contributor's summary.

1. **The model cannot ask to send.** `ClassifiedIntent` has no `send` variant.
   Whether Mull offers to send is decided by two predicates shown **nothing but
   the user's own transcript** — never the screen, never the model's output.
2. **Nothing is applied that was not previewed**, and nothing is applied to text
   that moved. The selection is re-read and compared character for character
   immediately before the write.
3. **Undo refuses by default.** `services/undo.ts` only ever removes text it has
   just confirmed is still exactly where it left it; any doubt ends in a sentence
   naming which check failed.
4. **A press quotes back what it thinks it is pressing.** The model never names
   an element — it gets a numbered scan and answers with an integer. The sidecar
   re-reads the element before acting and refuses on mismatch.
5. **The agent cannot express Return.** ⏎ is the actuator in Slack, Messages,
   Mail and Discord. `AgentKeySchema` is a closed enumeration that never contained
   it, and `navKey` is a separate verb from `keyChord` rather than a filter over
   it.
6. **An agent can only go where you already are.** `switchApp` refuses any bundle
   id that did not come back from an `apps` call in the same run; `openUrl`
   refuses a query string for any host not already open in a tab. The authority is
   always **a thing Mull observed, not a string the model supplied.**
7. **The menu bar, where the structure runs out.** The agent can read and choose
   from any application's menu bar — the largest capability in the project, and
   the first the keystroke closure does not cover. *Mail sends from a menu item.*
   What holds it is weaker and is **documented as weaker**: the command must have
   come from a real `menus` call (structural), the card draws it before it runs
   (observable), and a deny-list on its name (a regex, and fallible — it has
   already been wrong once, refusing "Block Quote" as though it were blocking a
   person).

### Budgets

| Constant | Value | File |
|---|---|---|
| `MAX_AGENT_TURNS` | 40 | `src/shared/agent.ts` |
| `AGENT_BUDGET_USD` | 1.5 | `src/shared/agent.ts` |
| `AGENT_DEADLINE_MS` | 180_000 | `src/shared/agent.ts` |
| `MAX_NAV_STEPS` | 20 | `src/shared/nav.ts` |

The user's Escape is checked **before every tool executes** and outranks every
other outcome on the way out.

### What is deliberately not claimed

None of the above is an exfiltration proof, and the docs say so at each point
rather than letting a green test suite imply otherwise. The complete answer — a
budget granted from the user's own words before a run starts, which nothing on a
page can reach — is specified in `docs/agent/AGENT-V2.md` §7 and **is not built**.
Until it exists, Mull does not send anything, and that is enforced by the shape
of its vocabulary rather than by its good intentions.

---

## Every npm script

| Script | Runs | When, and what to watch for |
|---|---|---|
| `dev` | `electron-vite dev` | Daily driver. **Does not build the sidecar** |
| `build` | `electron-vite build` | Both bundles. Also does not build the sidecar |
| `build:sidecar` | `cd mull-mac && swift build -c release` | **Manual, and required** before the first run and after every `mull-mac/` change or protocol bump |
| `typecheck` | `tsc` over both projects | Pre-commit. **Two** projects — running one is not enough |
| `test` | `vitest run` | 47 files / 834 tests / ~3.5s |
| `rebuild:native` | `electron-rebuild -f -m .` | After `npm install`, an Electron bump, or a Node change |
| `check:native` | Electron + `scripts/native-check.cjs` | Proves native modules load against **Electron's** ABI, and that FTS5 is compiled in. Prints `NATIVE_OK` |
| `check:applescript` | `osacompile` over every generated script | After touching `browser.ts`, `apps.ts`, `menus.ts`, `osascript.ts`. Compile-only — no Apple Events, no consent prompt |
| `icons` | Electron + `make-icons.cjs` | **Not part of `build`.** Run manually after editing `icons/*.svg`; never hand-edit `tray-icon.ts` |
| `fetch:model` | `scripts/fetch-model.ts` | ~466 MB. Idempotent; writes `.part` then renames |
| `fetch:vad` | `scripts/fetch-model.ts vad` | ~900 KB Silero VAD. Optional; absence just skips `--vad` |
| `probe:asr` | `scripts/probe-asr.ts` | Word error rate per model/flag set over a corpus of real holds |
| `smoke` | `scripts/smoke.ts` | Headless E2E over real ndjson plus fakes. `todo` lines never fail |
| `bench:engine` | `scripts/bench-engine.ts` | Subscription vs API-key first-token latency. **Costs real tokens.** Reads credentials from **env only** |
| `notarize:dryrun` | `scripts/notarize-dryrun.ts` | Proves everything provable without an Apple account; uploads nothing |
| `pack:local` | sidecar → build → `pack-local.ts` | The full local DMG. ~4 min, ~235 MB |

---

## Testing

**834 tests across 47 files** at the time of writing, all Vitest, **none of them
needing a Mac, a subprocess, or a permission dialog.** Three seams make that
possible:

- **`FakeSidecar`** stands in for Swift. It models a real text field — value,
  caret, selection — so the full write path, read-back verification and undo's
  read-then-replace all run without macOS. Its defaults are **deliberately
  pessimistic** (no permissions, insertion refused) so the app must stay honest
  when the real sidecar is missing. It can also stage the hard cases: an AX write
  that is accepted and silently dropped, text the app will not report back, and
  `retarget()` — the row moved between the scan and the press.
- **An injected `run`** for every AppleScript bridge.
- **A narrow `SqlDatabase` interface**, backed by `node:sqlite` in tests so vitest
  never touches the Electron-ABI native module.

```bash
npm test
npx vitest run src/main/pipeline/sculpt.test.ts      # one file
npx vitest run -t "refuses when the text moved"      # one test by name
npx vitest                                           # watch
```

### The three checks a unit test cannot do

**`check:applescript`** — AppleScript resolves an application's vocabulary at
*compile* time, so a script can be syntactically fine, pass every unit test, and
fail on every real invocation. That actually happened: twelve green tests, and
four of six scripts could not compile. Note it **skips browsers that are not
installed and says so** — a green run on a Mac with only Safari covers less.

**`check:native`** — proves `better-sqlite3` loads against Electron's ABI, which
a vitest run can never catch because tests deliberately use `node:sqlite`.

**The probes** (`scripts/probe-*.ts`) drive the **real** sidecar against **real**
applications and print numbers rather than pass/fail. Each has a pass bar written
down before the numbers arrive. Run them manually when touching
accessibility-facing code — and note **`probe-agent` and `probe-targets` really
press things**, so point them at an app you do not mind being navigated.

```bash
npx tsx scripts/probe-targets.ts Slack --press 3
npx tsx scripts/probe-harvest.ts "Slack"
npx tsx scripts/probe-agent.ts Slack "what did Anil say"
npx tsx scripts/probe-router.ts
npx tsx scripts/probe-asr.ts ~/mull-corpus
```

They exist because the questions that matter most here are empirical, and
guessing at them has been wrong repeatedly: 575 targets surveyed across six
applications and exactly one AX action was ever performed; every text field in
every application advertises `AXPress` (32 of 32) which a client-side gate had
been refusing categorically; a menu-bar read takes 0.55s written one way and
**6.3s** written the obvious way. Each of those changed a decision.

### What is not covered

Stated plainly, because a green suite that implies more than it checks is worse
than a smaller one:

- **`src/main/index.ts`** — 1285 lines, the whole main process and ~40 IPC
  handlers. Zero tests.
- **`src/preload/index.ts`** — the bridge and its allow-list.
- **The entire React layer** except the three pure modules. `vitest.config.ts`
  does not include `.tsx` at all, so a component test file would be **silently
  ignored**.
- **The real engines** — `engine/agent.ts` and `engine/api-key.ts`.
- `pipeline/selection.ts`, `services/osascript.ts`, `services/model.ts`,
  `services/tray.ts`, the whole `asr/` directory.
- **The Swift sidecar.** `mull-mac/Tests/` exists, but `swift test` fails with
  *"no such module 'XCTest'"* under command-line-tools alone — it needs full
  Xcode. On this machine the sidecar is verified by probe.
- Everything the fakes stand in for by definition: the microphone, whether
  ⌥Space is actually seen, whether text lands in Mail, whether a real app honours
  an AX write. That is what the `docs/M*-VERIFY.md` manual checklists are for.

---

## Build and packaging

`npm run pack:local` chains `build:sidecar` → `build` → `pack-local.ts`, producing
`release/Mull-0.0.1-arm64.dmg`.

`pack-local.ts` forces `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder
cannot pick a stray keychain identity, then **signs the bundle itself** — because
electron-builder with `identity: null` skips signing entirely, and arm64 refuses
to execute an unsigned binary. Ad-hoc (`codesign --sign -`) is not the same as
unsigned.

Its `afterPack` runs three phases, and the third is the interesting one:
**it proves the app works before a DMG is built.** The binary is where Info.plist
says; `ELECTRON_RUN_AS_NODE=1` boots it; every unpacked native module is
`require`d under the hardened runtime; and the bundled sidecar is handed a real
`init` line on stdin and must answer with the matching protocol version.

### `electron-builder.yml`, the parts that matter

- **`asarUnpack`** for `@anthropic-ai/claude-agent-sdk-darwin-arm64` — the SDK
  spawns `claude` as a subprocess, and a path through `app.asar` fails with
  `ENOTDIR` because asar is a file, not a directory. The failure mode is nasty:
  Electron patches `fs.existsSync` to see *into* asar, so the SDK thinks it found
  the binary, but it does not patch `spawn`. `resolveClaudeCliPath()` points the
  SDK at the unpacked copy.
- **`mac.binaries`** listing the sidecar — this is what makes electron-builder
  *sign* it rather than copying it in unsigned and failing notarisation.
- **`LSUIElement: true`** — menu-bar resident, no Dock icon, no window on launch.
- `NSMicrophoneUsageDescription` and `NSAppleEventsUsageDescription` (one string
  covering both a browser and System Events, so it names the *reading* rather
  than the control).

**Entitlements** (`build/entitlements.mac.plist`) are five, each justified in a
comment block longer than the plist. The app sandbox is **deliberately absent** —
Accessibility control of other apps is impossible inside it.

### Ad-hoc vs Developer ID

| | Local (ad-hoc) | Notarised |
|---|---|---|
| Installs into /Applications | ✅ | ✅ |
| Mic, Accessibility, Input Monitoring | ✅ | ✅ |
| Survives a rebuild without re-granting | ❌ | ✅ |
| Opens on another Mac after download | ❌ | ✅ |
| Costs $99/yr | no | yes |

**A Developer ID buys exactly one thing: the right to hand the app to somebody
else.** See [LOCAL-BUILD.md](LOCAL-BUILD.md) for the full table.

### The TCC tax

macOS files a permission grant against the **code signature**. A Developer ID
signature is stable across builds; an ad-hoc one is a hash of the binary, so
**every rebuild is a different app to TCC**.

The symptom is specific and confusing: Mull still appears in Privacy & Security →
Accessibility with its switch **on**, and the API still reports no access. After
replacing the app:

```bash
tccutil reset Accessibility net.mull.app
tccutil reset ListenEvent   net.mull.app   # Input Monitoring
tccutil reset Microphone    net.mull.app
```

Then relaunch and re-grant — the checks run at boot.

Other documented failure modes: the app quits instantly on launch →
`MULL_LOCAL_HARDENED=0 npm run pack:local`; *"Mull is damaged"* →
`xattr -dr com.apple.quarantine /Applications/Mull.app`.

The packaged app shares `~/Library/Application Support/mull/` with dev — same
model, same journal, same settings.

---

## Environment variables

| Variable | Effect | Default |
|---|---|---|
| `MULL_SIDECAR_PATH` | Absolute override for the sidecar binary | `mull-mac/.build/release/mull-mac` in dev |
| `MULL_WHISPER_CLI` | Absolute override for whisper-cli; **skips the candidate search entirely** | First of four homebrew / usr-local candidates |
| `MULL_CLAUDE_CLI_PATH` | Override for the `claude` binary the Agent SDK spawns | unset in dev (the SDK self-resolves) |
| `MULL_ASR` | `=fake` forces the fake transcriber — how smoke runs with no model on disk | unset |
| `MULL_ASR_KEEP_AUDIO` | Directory to copy each utterance's WAV + transcript into, for replay through `probe:asr`. **The one thing that defeats "audio never outlives the transcription"** — no UI can set it, so shipped builds cannot | unset |
| `MULL_LOCAL_HARDENED` | `=0` drops the hardened runtime from a local build | hardened **on** |
| `MULL_BENCH_RUNS` · `MULL_BENCH_MODEL` | Bench passes per fixture; bench model id | `3` · `claude-sonnet-5` |
| `MULL_PROBE_MODEL` | Model for the streaming-router probe | `claude-haiku-4-5` |
| `ANTHROPIC_API_KEY` · `CLAUDE_CODE_OAUTH_TOKEN` | Read from env **by the bench only**; the token is *injected into* the spawned SDK subprocess by the engines | unset |
| `ELECTRON_RENDERER_URL` | Set by `electron-vite dev`; selects the dev server over built HTML | unset in production |

`CSC_NAME`, `CSC_LINK` and `APPLE_TEAM_ID` are consumed by electron-builder for a
real signed build, and are **deliberately absent from the repo**.

---

## Conventions

1. **Docstring-first.** Nearly every file opens by explaining *why the code is
   shaped this way*, usually including what was tried first and why it failed.
2. **Shared contracts are single-definition.** `sidecar-api.ts`, `nav.ts`,
   `agent.ts`, `settings.ts`, `ipc.ts` exist so two layers cannot drift.
3. **Change `src/shared/sidecar-api.ts` first, then mirror it in Swift.** It is
   the declared source of truth, and the version constant lives in two files that
   must stay in step.
4. **Pure functions where the decisions live** — `hud/view-model.ts`, `pet.ts`,
   `row-model.ts`, `ptt-machine.ts`, `cleanup.ts`, `diff.ts` — so rules are
   testable under plain node and the React layer stays declarative.
5. **Refuse by default.** Undo, presses, applies, sends, secure input and
   credentials are each written as a refusal with a named reason, not a
   best-effort.
6. **Structural over promissory safety.** Prefer a shape that makes the bad act
   *unsayable* over a rule asking a model not to say it.
7. **Inject anything that touches the machine** — `spawnFn`, `RunScript`,
   `SqlDatabase`, `safeStorage`, `openExternal`, `log`.
8. **No `electron` import in anything `scripts/` needs.** `locations.ts` and
   `sidecar.ts` are deliberately electron-free.
9. **Positional `?` SQL parameters only** — the two drivers disagree on named
   ones.
10. **No raw hex in component CSS.** Style through `tokens.css`.
11. **Prefer AppleScript over a new sidecar verb** for anything not needing
    `AXUIElement` / `CGEvent` / screen capture, given the manual-rebuild and
    strict-handshake cost. `services/apps.ts` is the worked example.
12. **Outside input travels in `argv`, never spliced into script text.**
13. `strict`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax` everywhere;
    import shared code as `@shared/…`.

### Read the docstring before touching these

Ranked. Widening a vocabulary without reading its history is how a safety
argument quietly erodes.

- **`src/shared/agent.ts`** — the agent vocabulary, and an honest running account
  of every time its safety closure was widened.
- **`src/main/pipeline/actions.ts`** — the only place Mull drives someone else's
  UI.
- **`src/main/services/undo.ts`** — severity-asymmetric design, worked through.
- **`src/main/pipeline/router.ts`** — the post-mortem on the deleted verb table.
  Read before adding any keyword heuristic.
- **`mull-mac/Sources/MullMacCore/AXTargets.swift`** — why the model is shown
  integers rather than names.
- **`src/shared/sidecar-api.ts`** — the protocol changelog, and `navKey` vs
  `keyChord`.
- **`src/main/locations.ts`** (`resolveClaudeCliPath`) — the asar/ENOTDIR trap.
- **`src/shared/settings.ts`** — notably the `thinking` default, which was
  accidentally on through M4 and M5 at a measured cost of p50 954ms → 20086ms.

---

## Gotchas

- `npm run dev` never builds the sidecar; the handshake is strict equality; a
  mismatch is total, not partial.
- **`FakeSidecar` silently substitutes when the binary is missing** — the app
  "works" with no accessibility at all. Check the boot log.
- `vitest.config.ts` includes only `src/**/*.test.ts`. A `.tsx` test file is
  silently ignored.
- `npm run typecheck` runs **two** projects.
- `check:applescript` is only as complete as the browsers installed on the
  machine running it.
- `swift test` needs full Xcode, not just command-line tools.
- **`npm run bench:report` is referenced in `src/main/bench.ts` but does not
  exist** in `package.json`.
- `appId: net.mull.app` is a placeholder and must match the Team ID's prefix
  before the first notarised build — but **do not change it locally**, because
  TCC files your grants under it.
- Every ad-hoc rebuild invalidates TCC grants *while still appearing granted*.
- `bench:engine` and the probes cost real model tokens and drive real
  applications.
- The `hotkey` setting is vestigial — kept only so stored files still parse.

---

## Where to read next

| | |
|---|---|
| [USER-GUIDE.md](USER-GUIDE.md) | What the app does, from the outside |
| [DESIGN.md](DESIGN.md) | The frozen design system. §6.1 HUD states, §6.3 diff card, §6.5 journal. **Do not re-derive visual rules** |
| [DESIGN-BRIEF.md](DESIGN-BRIEF.md) | What must be shown and how it must behave, independent of visual style |
| [agent/README.md](agent/README.md) | **The agent lane in full**, including all seven seams with file:line references |
| [agent/AGENT-V2.md](agent/AGENT-V2.md) | The agent architecture and milestones; §7 is the unbuilt budget gate |
| [agent/RESEARCH.md](agent/RESEARCH.md) | Why the questionnaire lane could not be tuned |
| [INSERTION-MATRIX.md](INSERTION-MATRIX.md) | Twelve apps × six behaviours — the source for `insertion-table.ts` |
| [LOCAL-BUILD.md](LOCAL-BUILD.md) | Shipping a DMG without an Apple account |
| [05-electron-architecture.md](05-electron-architecture.md) | Why Electron, why a Swift sidecar, why the Agent SDK |
| [PLAN.md](PLAN.md) | The v0.1 build plan and the latency budgets |
| `M*-VERIFY.md` | What was checked by hand at each milestone, and what it showed |
