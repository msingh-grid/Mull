# Mull — Design & Build Plan (v0.1, all four pillars)

## Context

Research is complete (`research/docs/`): Mull is a macOS voice-first "thinking layer" — differentiated from Alma/Wispr by local-first processing, cross-app working memory, and a transparent intent→action pipeline (intent chips, diff previews, plan previews, undoable journal). Architecture is settled in `docs/05-electron-architecture.md`; the interactive mock (`docs/mock/mull-playground.html`) validated the interaction model.

Decisions made with the user:
- **v0.1 scope: all four pillars** (dictation, Sculpt edits, whitelisted commands, working-memory v0).
- **Design path: fresh exploration** — 3–4 distinct visual directions via the installed design skills; user picks; codified before UI code.
- **Rename `research/` → `mull/`** (user request); the app repo lives inside it.

## Phase 0 — Folder rename (first action)

`mv ~/Desktop/think-with-alma/research ~/Desktop/think-with-alma/mull`. Skill symlinks in `.claude/skills` are relative (verified) so they survive. **Caveat:** this session's cwd/memory/scratchpad paths are keyed to `…/research` — after the rename the user should restart Claude Code inside `~/Desktop/think-with-alma/mull`. Repo root = `mull/` (git init), with `docs/` already present; app source added per layout below.

## Phase D — Design exploration (before UI code)

Skills: `impeccable` (new-work flow + craft floor), `frontend-design`, `design-taste-frontend`/`high-end-visual-design` (taste guardrails), `industrial-brutalist-ui`/`minimalist-ui` (two of the directions), `stitch-design-taste` (DESIGN.md format), `web-design-guidelines` (a11y audit of the winner).

- **D1 — Design brief** (`mull/docs/DESIGN-BRIEF.md`): surfaces = HUD (non-activating panel: orb/waveform, transcript, chips, diff card, plan card), Journal window, Onboarding wizard, Settings, menu-bar presence. Personality: *trustworthy instrument*; the UI's job is to make AI behavior legible. Constraints: legible over any wallpaper, macOS light+dark, sub-second state transitions, reduced-motion.
- **D2 — Four direction boards** (static HTML in `mull/design/directions/`, published as artifacts): each renders the same 3 HUD states (idle/listening/diff) + one journal entry + palette/type specimen in a distinct world: ① **Instrument** (dark optical glass, precision hairlines, mono data voice) ② **Studio paper** (warm light editorial, ink-on-paper diffs) ③ **Signal brutalist** (industrial terminal grid) ④ **Quiet minimal** (type-only hierarchy, muted monochrome).
- **D3 — Codify winner**: user picks → `mull/docs/DESIGN.md` (tokens, type scale, motion rules, component specs) + `src/renderer/tokens.css`; run `web-design-guidelines` audit before freezing. M3 consumes these.

## Phase M — Build milestones (from Plan-agent output; full detail retained in agent report)

**Stack:** electron-vite + electron-builder/electron-updater; React 18 + TS renderers (HUD, journal, settings, onboarding, hidden capture window); Swift SPM sidecar `mull-mac` (zero deps; ndjson JSON-RPC over stdio; signed via `binaries:`); `better-sqlite3` (journal + FTS5 memory); `smart-whisper` in an Electron `utilityProcess` behind an `ASRProvider` interface; `uiohook-napi` PTT (M1) migrating to sidecar CGEventTap (M3); `@anthropic-ai/claude-agent-sdk` (pin exact) + `@anthropic-ai/sdk`; `zod`, `diff`, `electron-log`, `vitest`, Playwright.

**Agent's deviations from the architecture doc (accepted):** mic capture via hidden renderer + AudioWorklet (no SoX/native module); `safeStorage` not keytar; dictate-by-default routing invariant (plain dictation never waits on the engine); explicit `checkPermissions`/`promptAccessibility` RPCs.

**Key contracts** (build to these; full signatures in agent report): `src/shared/sidecar-api.ts` (typed RPC map — source of truth), `Engine` interface (`ready/transform/intent/session`, `emit_intent` in-process MCP tool, warm sessions per lane, guard the MCP-connect race — SDK issue #368), `InsertionService` (`ax→paste→type` chain + per-app `insertion-table.ts`), `IntentRouter.fastPath` (rules table; `null` = insert immediately), `JournalStore`/`UndoService`, `MemoryStore` (FTS5 + simhash dedup + `brief()` with citations), `HudController` (panel window: `type:'panel'`, transparent, `focusable:false`, screen-saver level).

**Milestones — each independently demoable, exit criteria in agent report:**
- **M1 (wk 1)** Pipeline skeleton: scaffold + prove native-module rebuilds day 1; ⌥Space PTT → mic → whisper → paste into frontmost app; sidecar v0; secure-input block; p50 < 1.5s key-up→inserted.
- **M2 (wk 2)** Insertion done right: full AX sidecar, 12-app insertion matrix (`docs/INSERTION-MATRIX.md`), cleanup transforms, journal + undo; **sign/notarize dry-run here** (de-risk M6).
- **M3 (wk 3)** HUD per DESIGN.md: all HUD states, journal drawer, settings, Fn via sidecar event tap, DiffCard/PlanCard driven by `FakeEngine`.
- **M4 (wks 4–5)** Engine + Sculpt: `claude setup-token` flow (safeStorage), warm Agent SDK sessions (tools off), intent router, selection→streamed diff→apply/undo; bench vs ApiKeyEngine; rate-limit → "local-only" chip.
- **M5 (wk 6)** Commands + memory v0: six whitelisted verbs w/ zod validation, plan preview → per-step execution → journal; FTS5 context capture w/ exclusions, memory chip citations, timeline+prune UI, dictionary editor.
- **M6 (wk 7)** Packaging + onboarding: hardened runtime, notarized DMG, auto-update; wizard (mic → Accessibility live-verified → model download → engine sign-in or "skip: local-only") ; zero-network mode works.

**Top risks & where validated:** native-module ABI (M1 day 1); Electron-app AX writes no-op (M2 matrix; paste default for Electron targets); Agent SDK latency (M4 bench; flip edit lane to ApiKeyEngine if >1.2s p50 first-token); Fn key (⌥Space default, Fn opt-in); token expiry/limits (M4 `ready()` states; structural local-only degrade); notarization surprises (M2 dry-run).

## Verification

- **Unit (vitest, CI):** cleanup transforms, intent-router fixture table (~60 cases — protects "dictation never waits"), journal/memory against `:memory:` DB, verb whitelist rejects unknown verbs, diff segments, `emit_intent` payload validation. Sidecar XCTest: RPC framing, verb validation.
- **Sidecar smoke (`scripts/smoke.ts`):** drives `mull-mac` JSON-RPC directly per milestone: init → permissions → insertText per strategy w/ re-read verification → replaceSelection → secure-input.
- **Manual insertion matrix:** 12 apps × 6 behaviors, re-run at M2/M4/M6 (on the notarized build — TCC differs for signed apps).
- **E2E (Playwright + FakeSidecar/FakeEngine/fixture audio):** HUD state machine, diff apply/cancel keys, journal contents.
- **Latency:** stage timings to `bench.jsonl`; milestone exits quote p50/p95.
- **Milestone demos:** M1 "it hears me and types" → M6 stranger-installable DMG; each exit criteria list is the acceptance test.

## Execution order

0. Rename `research/`→`mull/` (user restarts Claude Code there) → git init.
1. Phase D (D1 brief → D2 four boards → user picks → D3 DESIGN.md + tokens). ~2–3 days.
2. M1 → M6 as above (~7 weeks), design-independent work (M1/M2) can start in parallel with D2/D3 review.
