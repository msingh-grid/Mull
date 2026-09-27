# AI-collaboration disclosure

Mull was built with heavy use of AI coding assistants, and it calls AI models
at runtime. This page states which models and tools were used, for what, how
the output was checked, and what it cost.

> Sources: git commit trailers, the code, and the team's 16 Sep meeting
> transcript (posted to the community thread). All AI tools used were
> company-provided; the programme lead had approved company-provided AI
> subscriptions, which is why AI attribution was kept in commits (16 Sep).

## 1 · AI used to build Mull

| Where | Tool / model | Evidence in the repo | Who |
|---|---|---|---|
| Codebase (Electron, Swift sidecar, tests, docs) | Claude Code with Claude Fable 5 | `Co-Authored-By: Claude Fable 5` on 5 commits (8818362 repo init, e301086 M1 skeleton, design boards/tokens/onboarding) | Mohit Singh |
| Remaining engineering commits (58 of 61 by Mohit carry no trailer) | Claude Code, company Claude Team plan. Built "iteratively through multiple prompts using Claude Code rather than a single generation step" (Mohit, 16 Sep meeting) | `CLAUDE.md` ("guidance to Claude Code"), `.knowledge_base/HANDOVER.md` (a session handover written for the next AI session) | Mohit Singh |
| ASR prompting and model change (6cdbb4b) | Claude Code, Claude Opus 5 | commit trailer | Saaketh Koduri |
| Codex engine lane (00f8398, +2,240 lines) | Claude Code, Claude Opus 5.5 | commit trailer | Saaketh Koduri |
| Front-end design exploration | Agent "skills" (prompt packs) for Claude Code / Codex | `.agents/skills/`, `skills-lock.json` (17 skills; sources in [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)) | Mohit Singh |
| Market and competitor research (`docs/01`–`05`, `docs/REPORT.md`, 13 Sep) | Claude deep research | Docs cite public URLs; binary inspection of the Alma DMG is described in `docs/01`. Claims used in the business docs were re-checked against the cited source where they drive a decision | Mohit Singh (shared with the team 13 Sep) |
| **This submission package** (26 Sep): pricing, canvas, roadmap, decision log, this page, notices, setup script, `bench:report`, evidence files, pitch deck, role evidence | Claude Code, Claude Opus 5.5 (1M context) | This disclosure; files under `submission/`, `evidence/`, `scripts/setup.sh`, `scripts/bench-report.ts` | Saaketh Koduri, with Claude |
| Interview and user-session synthesis | Claude Code, Claude Opus 5.5 — structuring and anonymising **notes taken by Lay Naik in interviews Lay ran on 25 Sep**; no participant data was invented | `research/INTERVIEWS.md`, `research/USER_TRACES.md` | Saaketh Koduri (synthesis), Lay Naik (interviews) |

**What the AI did not do:** run interviews, observe users, choose which
decisions the team made, or supply any customer number. Willingness-to-pay
figures, quotes and observations come only from the team's own notes.

## 2 · AI inside the product (runtime)

| Job | Default model | Where set |
|---|---|---|
| Speech-to-text | whisper.cpp, `ggml-small.en` — **on-device, no cloud** | `src/shared/model.ts` |
| Routing an Fn request (dictate / edit / compose / ask / navigate) | `claude-sonnet-5` | `src/main/engine/classify.ts:58` |
| Edit, compose, answer, navigate | `claude-sonnet-5` (user may pick Haiku 4.5 or Opus 5) | `src/shared/settings.ts` `editModel` |
| Agent loop (off by default) | `claude-opus-5`, ≤ 40 turns, **$1.50 hard cap per run**, 180 s deadline | `src/shared/agent.ts:596-635` |
| Skill notebook (off by default) | `claude-haiku-4-5` | `src/main/engine/skills.ts:52` |
| Experimental Codex lane (opt-in) | `gpt-5.6-terra` via the user's Codex CLI | `src/main/engine/codex.ts` |
| ⌥Space dictation | **No model, ever** | `src/main/pipeline/dictation.ts` (no Engine import — `engine/types.ts` invariant) |

What leaves the Mac, and when: audio never does. On an Fn request, the
transcript and (by default) the focused window's text and a screenshot go to
the selected model. A chip on the HUD says so while the user is speaking
(`src/main/pipeline/context.ts` reads it, `dictation.ts` shows the chip; decision D13 in [DECISION_LOG](DECISION_LOG.md)).
Credential apps and secure-input fields are never read. The latency ledger
records lengths and timings, never text (`src/main/bench.ts`).

## 3 · How AI-generated work was verified

| Check | What it proves | Result (26 Sep) |
|---|---|---|
| `npm test` — 1,071 Vitest tests, 59 files | Pipeline logic, safety seams (no ⏎, no model-initiated send, undo refusals), sidecar contract | 1,071 passed, 5 skipped — [`evidence/test-run.txt`](../evidence/test-run.txt) |
| `npm run typecheck` — both TS projects | Types across main, shared and renderer | clean — [`evidence/typecheck.txt`](../evidence/typecheck.txt) |
| `npm run smoke` — headless end-to-end | Real Swift sidecar over ndjson, real whisper-cli, pipeline with fakes | `SMOKE_OK` — [`evidence/smoke.txt`](../evidence/smoke.txt) |
| `npm run check:applescript` | Every generated AppleScript compiles with `osacompile` (unit tests cannot catch this) | run by engineering during development |
| Probe scripts (`scripts/probe-*.ts`) | Real apps, real sidecar; produced the measurements that changed decisions D7–D11 | recorded in docs and commit messages |
| Human use + latency ledger | Real behaviour on a real Mac | [`evidence/bench-report.txt`](../evidence/bench-report.txt) — includes failures |

**Known gaps in verification, stated rather than hidden:** the Swift XCTest
suite has never run (needs full Xcode); the manual M1–M4 checklists are
unticked; AI-generated tests were twice found to pass for the wrong reason (a
fake that satisfied a safety test before the gate existed — HANDOVER:170-173).

**Checks applied to this submission package:** every number in PRICING,
DECISION_LOG and the deck was traced to a file, commit or measurement cited
next to it; the Agent SDK terms were read from Anthropic's documentation
rather than recalled; one claim drafted by the AI (that edit failures meant
"not signed in") was found wrong against `src/main/engine/types.ts` and
corrected before submission.

## 4 · Total AI spend

| Item | Period | Cost (USD) | Source of figure |
|---|---|---|---|
| Claude Team plan seats (company-provided): Mohit Singh, Saaketh Koduri (Claude Code: development, this package) and Lay Naik | ≈ 1 month (late Aug – 27 Sep) | ≈ $60 (≈ $20 per person per month × 3; the team's estimate of the plan price) | company plan (approved by programme lead) |
| Claude deep research (market and competitor research) | 13 Sep | Included in the Claude plan | same plan |
| Claude Code budget noted by the team | 16 Sep onward | $20 | 16 Sep meeting transcript |
| Codex credits (Codex engine lane development and testing) | 16–26 Sep | up to $125 allocated | 16 Sep meeting transcript |
| Anthropic API key usage | — | $0: no direct API key was available (16 Sep); the product ran on the subscription lanes | 16 Sep meeting transcript |
| **Personal / out-of-pocket spend by the team** | | **$0** | all tools company-provided |
| **Total AI spend (upper bound)** | | **≈ $205**: ≈ $60 plan seats + ≤ $20 Claude Code budget + ≤ $125 Codex credits | seat price is the team's estimate; budgets from the 16 Sep transcript |

The runtime cost of the product itself is not included here, because Mull
has no users paying for inference yet.

Runtime cost to operate (per user) is estimated separately in
[PRICING.md](PRICING.md) §4.
