# Role evidence — Mohit Singh

**Role:** Engineer. Accountable for architecture, implementation, reliability,
tests, deployment and telemetry.
**Team:** Mohit Singh (Engineer) · Lay Naik (PM) · Saaketh Koduri (Sales)
**Product:** Mull, a voice layer for macOS · repository `msingh-grid/Mull` ·
this archive.

> Drafted by Saaketh Koduri on 26 Sep from the git history, the docs and the
> team's meeting transcripts; reviewed and completed by Mohit Singh on 27 Sep.
> Nothing here is claimed without a pointer to where it can be checked.

---

## 1 · Deliverables I owned

| Deliverable | Where | Evidence |
|---|---|---|
| The working product: Electron main + React renderer + Swift Accessibility sidecar over validated JSON-RPC | `src/`, `mull-mac/` | 61 commits, 13–23 Sep (`git log --author=msingh --no-merges`), plus PR merges #1 and #3 |
| Architecture and its trade-offs | [README](README.md) "Architecture"; [docs/05-electron-architecture.md](docs/05-electron-architecture.md); [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | decisions D1–D17 in [DECISION_LOG](submission/DECISION_LOG.md) |
| Safety model: seven structural seams. The model cannot ask to send; the agent cannot press Return; undo refuses when unsure; and four more | [README](README.md) "The safety model"; [docs/agent/README.md](docs/agent/README.md) §4 | tests for each seam |
| Tests | 1,071 Vitest tests across 59 files, none needing a Mac | [evidence/test-run.txt](evidence/test-run.txt) |
| Reliability probes against real apps | `scripts/probe-*.ts` | measurements that changed decisions: menu reads 0.55 s vs 6.3 s; `AXScrollToVisible` on 519 of 575 targets |
| Telemetry | per-utterance trace log (`src/main/trace.ts`); latency ledger (`src/main/bench.ts`); journal of every action with undo | [evidence/bench-report.txt](evidence/bench-report.txt) |
| Deployment | ad-hoc-signed local DMG (`npm run pack:local`); DMG packaging agreed by the team 16 Sep | [docs/LOCAL-BUILD.md](docs/LOCAL-BUILD.md) |
| Market and technical research, and the design system | `docs/01`–`05`, `docs/REPORT.md` (Claude deep research), `docs/DESIGN.md` (Studio Paper, picked from four boards) | shared with the team 13 Sep |
| Onboarding, sign-in and browser automation (Arc as a third AppleScript dialect) | `src/renderer/onboarding.tsx`, `src/main/services/` | 609ee62 (22 Sep), merged as PR #3 |
| Run memory and learned per-app skills (both off by default, listed and deletable in Settings) | `src/main/store/turns.ts`, `src/main/store/skills.ts` | 1a4a411 (23 Sep); [docs/MEMORY-SKILLS-PLAN.md](docs/MEMORY-SKILLS-PLAN.md) |
| User and developer guides | [docs/USER-GUIDE.md](docs/USER-GUIDE.md), [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | |

## 2 · Decisions I drove (from the decision log)

- **D1 · Two keys, not a verb table** (14 Sep). The verb table typed six
  unlisted requests verbatim into Slack. Model routing on every utterance
  measured p50 2.5 s, max 19.8 s.
- **D2 · Electron plus a Swift sidecar** (13 Sep; agreed by the team). I chose
  TypeScript over Python to avoid running a separate server under the time
  limit (16 Sep meeting).
- **D3–D6 · Structural safety.** No `send` in the model's vocabulary. No ⏎ in
  the agent's key list. Undo refuses by default. The agent loop is off by
  default until a go/no-go bar passes.
- **D10 · Extended thinking off:** p50 20,086 ms fell to 954 ms.
- **D21 · Automatic mode as a switch, off by default.** I kept permission
  prompts when removing them was proposed on 16 Sep, and shipped Saaketh's
  two-mode idea as the auto-run toggle on 22 Sep (933d0d8).

**Where my thinking changed:**
- The research recommended native Swift; I moved to Electron (D2).
- A one-key verb table became two keys (D1).
- A one-step "questionnaire" navigation lane became a model-run agent loop
  (D5; `docs/agent/RESEARCH.md`).
- Each change is written up in the code's docstrings with the measurement
  that caused it.

**Reported failures:**
- "Send" shipped and did nothing, three times.
- A merge dropped four definitions without a typecheck (933d0d8).
- The Swift XCTest suite has never run.
- See DECISION_LOG §D.

## 3 · Cross-functional work

| With | What | Evidence |
|---|---|---|
| Team | Researched Alma, Perplexity's Personal Computer and Manus's My Computer; shared the first product idea with a prototype | community posts, ≈ late Aug |
| Team | Shared the research and design docs, committed progress to GitHub, and set the Tuesday review | community post, 13 Sep |
| Team / compliance | Moved the code to a company GitHub ID with collaborators, as agreed 13 and 16 Sep (D22) | meeting transcripts |
| Sales (Saaketh) | Pushed the latest code so Saaketh could build the Codex lane on a branch (16 Sep); merged the work | 00f8398 |
| Sales (Saaketh) | Fixed issues from Saaketh's testing (assigned 16 Sep): cold-browser detection, Arc support, tab handling, false "press failed" reports, the answer turn claiming it could not act; then `find`, `press` retry and `uiTargets` fixes found in use | 609ee62 (22 Sep), 1a4a411 (23 Sep) |

## 4 · Community discussion posts

All project discussion took place in one community thread, as posts and
replies under it:
**[Community discussion thread](https://learnhouse-production-31e5.up.railway.app/community/e6ec61d3-f455-4643-a2f3-0237d99f8071/discussion)**
Dates below are approximate; each post's exact
timestamp is shown in the thread.

| ≈ Date | Post |
|---|---|
| ≈ 26 Aug | Research: Alma overlaps with Perplexity's Personal Computer and Manus's My Computer; proposed referencing them |
| ≈ late Aug | Reply: little public material on Alma; will share a doc |
| ≈ late Aug | Initial product idea and prototype doc for review |
| ≈ 13 Sep | Shared the research and design docs; all progress committed to GitHub; review set for Tuesday |

## 5 · AI use in my work

Built with **Claude Code on the company Claude Team plan**, "iteratively
through multiple prompts rather than a single generation step" (16 Sep
meeting). Five commits carry `Co-Authored-By: Claude Fable 5`; the rest carry
no trailer. Research used Claude deep research.

**Verification:** the test suite, typecheck, `check:applescript`, the probe
scripts against real applications, and the manual M1–M4 checklists (not
ticked; see DECISION_LOG §D).

Reviewed by Mohit, 27 Sep: accurate as written.

## 6 · Open items for Mohit

- [x] Cat sprite source: "Marmalade" by danielvictorino, downloaded from
      [codexpets.net/gallery/marmalade](https://codexpets.net/gallery/marmalade)
      (commit dfff485). Its terms allow personal, non-commercial use only and
      forbid redistribution, so the sprite must be replaced before any public
      release. Recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- [x] Community posts: linked to the discussion thread (§4).
- [x] Reviewed and agreed the engineering roadmap items N1–N5 in
      [ROADMAP.md](submission/ROADMAP.md) (27 Sep).
