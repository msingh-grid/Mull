# Mull — knowledge transfer

Written 2026-09-14, at commit `7c13fae`. 514 tests, typecheck and build clean,
working tree clean.

**To hand this to a new session, say:** *"Read
`.knowledge_base/HANDOVER.md` before doing anything. §3 is the invariants and §4
is the mistakes not to repeat."*

This is not documentation of the code — the code documents itself, at length and
on purpose. This is the part that does not survive in a diff: **what we decided
and why, what we tried that was wrong, and which mistakes are cheap to repeat.**

Read §3 before changing anything. Read §4 before debugging anything.

---

## 1. What Mull is, in one page

A macOS dictation and instruction tool. Electron main + renderers, plus a Swift
**sidecar** (`mull-mac/`) that owns every interaction with the operating system —
Accessibility reads, keystrokes, screenshots. They speak ndjson JSON-RPC 2.0
over stdio. **Protocol 7, sidecar 0.7.0.** Both halves assert the version at
handshake; bump them together or nothing starts.

**Two keys, and the key is the intent** (M5b — `cdd1aff`):

- **⌥Space — dictate.** Types what it hears. Never reaches an engine, never
  reads the window, never photographs anything. This is an invariant, not a
  performance note (§3).
- **Fn — ask.** Reads the window during the hold, then routes.

**The routes** (`ClassifiedIntent` in `src/main/engine/types.ts`):

| route      | means                                   | ends in                     |
|------------|-----------------------------------------|-----------------------------|
| `dictate`  | the words are the message               | text typed at the caret     |
| `edit`     | do something TO the text on screen      | DiffCard + **Apply**        |
| `compose`  | WRITE something new from what is on screen | DiffCard + **Apply**     |
| `ask`      | TELL me something about what is on screen | AnswerCard, **no Apply**  |
| `navigate` | it is not on this screen — go and look  | PlanCard, then an answer    |
| `send`     | send what is already in the composer    | SendCard + ⌘⏎               |

`send` is **not** a thing the model can choose. See §3.

**The engine seam** (`Engine` in `src/main/engine/types.ts`) has five methods:
`classify`, `transform`, `compose`, `navigate`, `answer`. Three implementations
(`agent.ts` — the user's Claude subscription via the Agent SDK; `api-key.ts` —
the Messages API; `fake.ts` — deterministic, no model) plus `SignedOutEngine`
and `EngineHolder` in `select.ts`. **Adding a method means touching all five.**

**The lanes** (`src/main/pipeline/`): `dictation.ts` owns the hold and the HUD
state; it hands off to `sculpt.ts` (edit/compose/send), `navigate.ts` (the walk),
`ask.ts` (answer, writes nothing). `intent.ts` decides which. `actions.ts` is the
only code in Mull that presses things in other people's applications.

---

## 2. The commands that matter

```bash
npm test                 # vitest, 514 tests, ~4s
npm run typecheck        # both tsconfigs
npm run build            # electron-vite
npm run build:sidecar    # swift build -c release  — REQUIRED after any .swift change
npm run dev              # the app
npx tsx scripts/probe-targets.ts    # what can be pressed, per app
npx tsx scripts/probe-harvest.ts    # what the AX harvest sees
npx tsx scripts/probe-router.ts     # routing latency
```

**`swift test` does not work in this environment** — Command Line Tools without
Xcode, so `XCTest` is missing. `mull-mac/Tests/MullMacCoreTests` exists and is
written; it has never been executed. Do not claim it passes.

The app's own log is at `~/Library/Logs/mull/main.log` and it is the best
debugging tool in the project. See §5.

---

## 3. Invariants — the things that are load-bearing

Each of these is a property someone can rely on. Breaking one is not a bug you
can fix later; it changes what the product promises.

1. **Dictation never waits on an engine.** `src/main/pipeline/dictation.ts`
   calls no `Engine` on the ⌥Space path. The router answers synchronously when
   there is nothing to edit.

2. **⌥Space does not read the window.** Not the text, not a screenshot. A read
   with no consumer and no journal row to account for it is a capture nobody
   asked for.

3. **`ClassifiedIntent` has no `send` field.** Whether Mull offers to send is
   decided in `pipeline/router.ts` from *the user's own transcript* (`wantsSend`,
   `justSend`) and nowhere else. The model is shown other people's writing on
   every context-carrying turn; anything it can set is something a message on
   screen can try to talk it into. This missing field is the seam.

4. **The navigator cannot send.** Not by policy — by vocabulary. `@shared/nav`
   has no verb for it; `navKey` has a *separate key map* from `keyChord` that
   never contained `return`; `ActionExecutor` will type only into a search
   field. A message on screen saying "press Send" cannot be obeyed because
   there is nothing to obey it with. **Do not add a general `keyChord` to the
   nav union.**

5. **A press addresses the element we saw.** The sidecar retains the
   `AXUIElement` under a `harvestId`; `pressTarget` re-reads role and title and
   **refuses on mismatch** before acting. Never re-find an element by label.
   There is no mouse fallback — a synthetic click moves the cursor and breaks
   on scroll.

6. **Every capture has a journal row.** If Mull read or photographed a window,
   there is a row that can show it ("What Mull saw"). This is why a *cancelled*
   navigation still journals (`206f509`, and again in `e434bc9`).

7. **Logs carry lengths, never other people's content.** The one exception is
   the user's own transcript and their own instruction. Content is inspectable
   in the journal, which the user opens on purpose.

8. **An answer card has no Apply.** `AnswerCard` has no commit, no target and
   no text to insert, and `acceptsApply` in `services/hud.ts` refuses it.

---

## 4. What went wrong — read this before debugging

The expensive mistakes, roughly in order of how much time they cost.

### 4.1 Extended thinking was the entire latency problem

Nothing had ever told the Agent SDK not to think. Same prompt, same model, same
warm session:

```
thinking: harness default    p50 20086ms   min 3866ms   max 33438ms
thinking: disabled           p50   954ms   min  845ms   max  1219ms
```

**Consequence: I set the classifier budget wrong twice, in opposite directions,
by measuring the symptom.** 4.5s (stale) → 20s (treating a 20s p50 as a fact
about the world) → **8s** (the truth, once thinking was off).

`thinking: {type: 'disabled'}` is now the default; the HUD has a toggle that
arms `adaptive` for the writing lanes only. The classifier and navigator never
get it — they choose between four words and an index in a list.

**Lesson: when a number is bad, find out what produces it before tuning around
it.** A budget fitted to a broken measurement encodes the breakage.

### 4.2 The classifier had never once been consulted

The user's log showed `fallbackReason: 'too-slow'` on fourteen consecutive
utterances. Three settings multiplied together: a budget below the measured
median, demote-after-**2** timeouts, and **permanent** demotion. Local rules made
every decision — and `navigate` is reachable only through the model, so the
entire feature was unreachable by construction while appearing to be built.

Now: `DEFAULT_TIMEOUT_MS = 8_000`, `DEMOTE_AFTER_TIMEOUTS = 5`, `DEMOTION_MS =
5 min` (expiring, not permanent).

**Lesson: a fallback that fires silently and always is indistinguishable from a
feature that does not exist.** Check `by: 'model'` vs `by: 'rules'` in the log
before believing any route is live.

### 4.3 Fakes that lie by omission

Twice, and both times the test passed for the wrong reason.

- `FakeSidecar` did not record `windowContext`, `uiTargets` or
  `promptScreenRecording` into `calls`. The test "⌥Space does not read the
  window" **passed before the gate existed.**
- `FakeSidecar.frontmostApp` returned `windowTitle: null` unconditionally. The
  new press-evidence code (§4.9) would have been completely untested while every
  assertion went green.

**Lesson: before trusting a test, check the fake actually models the thing.** If
the fake cannot represent the failure, the test cannot see it. `FakeSidecar` now
has a settable `windowTitle` and a `moveTo()` for exactly this.

### 4.4 A probe's TCC identity is not the app's

Debugging "the screenshots are missing", a probe run from the terminal failed
with `SCStreamError -3801 "The user declined TCCs for application, window,
display capture"` — while `CGPreflightScreenCaptureAccess()` returned **true**.
That looked exactly like a permissions bug.

It was not. Screen Recording is granted to the *responsible process*; a
`tsx` script launched from iTerm has iTerm's identity, not Mull's. The app's own
log showed `image=115KB` on every utterance the whole time. **The capture path
was never broken.**

**Lesson: cross-check any permission or TCC finding against
`~/Library/Logs/mull/main.log` before changing code.**

### 4.5 Prompts that invent things

Two separate occasions, same failure shape: told to write a complete instruction,
the model completes it from whatever is on screen.

- **navigate goal.** Given *"may we get to Anil Turaga"* it produced *"…and find
  out what he has said about **the terms doc redlines**"*. The user never
  mentioned the terms doc; it was in `<screen>`. The navigator would then have
  gone hunting for it. **An invention is worse than a bare name** — a name is
  useless, an invention is confidently wrong.
- **ask question.** *"summarize this thread"* became *"What is the status of the
  terms doc redlines?"* — narrowing a whole-thread summary to the first specific
  topic visible.

Both prompts now carry an explicit anti-invention rule **with that exact pair as
a counter-example**. Generic instructions ("do not invent") did not work;
counter-examples did.

`usableGoal()` in `intent.ts` is a code backstop: a goal of ≤2 words, or with no
verb, falls back to the user's transcript.

### 4.6 Tuning a prompt against a bad fixture

The first classifier fixture scored 6/8 — and **both failures were the
fixture's fault** (no `<field>` on an edit case; a Slack thread on screen for a
question about email). Fixing the fixture gave 9/9 with no prompt change.

**Lesson: when a case fails, first ask whether the case is right.** Tuning a
prompt against a wrong fixture bakes the wrongness in permanently.

### 4.7 Bulk regex edits

`plan:\s*[^,\n]*` destroyed four test files. Recovered with `git checkout`.
**Use exact string replacement.** If a change must be mechanical across files,
do it with a Python script that asserts the replacement count.

### 4.8 Committed with a failing test

Once. `journal.test.ts` round-trip: `append()` returned no `capture` while
`get()` returned `capture: null`. Fixed in the store and `git commit --amend`.
**Run `npm test` before every commit, not after.**

### 4.9 `AXPress` reports acceptance, not effect

The navigator pressed the same Slack sidebar row twice, then stopped with
*"pressing Anil Turaga repeatedly did not change the displayed conversation."*
It was right and had no way to know sooner — history told it only the label it
had itself chosen:

```
press 37 "Anil Turaga" — ok: Anil Turaga
press 37 "Anil Turaga" — ok: Anil Turaga
```

A press now reads the window title on both sides of itself, so history says
`Anil Turaga → Anil Turaga (DM) - Slack` or `the window is still "Prahastha…"`.

**Still unresolved:** in that trace the press was accepted and Slack did not
move. Root cause unknown. See §7.

### 4.10 Smaller traps, each of which cost real time

- **macOS grants a background process one `osascript … activate` and ignores
  the rest.** A probe reported Finder seven times. Use the sidecar's own
  `activateApp`.
- **Electron CSP.** `default-src 'self'` does **not** admit `data:` for images.
  `journal.html` needs `img-src 'self' data:` — and only journal.html does.
- **Chromium builds no AX tree until asked.** `AXManualAccessibility` plus a
  poll loop (`tree-warming`); a cold Slack takes ~1s, cold Claude Desktop ~2s.
- **Swift: `Result<Found, Outcome>` requires `Outcome: Error`.** Use a private
  `enum Resolution { case found; case refused }` instead.
- **`AXUIElementCopyActionNames` is a separate IPC** — actions are not
  attributes and cannot join the batched multi-attribute read. Call it only for
  candidate roles or the 3000-node walk gets expensive.
- **Trace tests that feed `now` a list of values** encode how many times each
  method happens to call the clock. Wrong on first run. Use a clock the test
  advances explicitly.
- **New dictation tests that drive no audio or clock** are discarded as
  `too-short`. Every utterance test needs `pushChunk(speech(1.2))` +
  `clock.advance(1_200)`.
- **`stage(null)` immediately before a phase transition** emitted a working
  phase with no line — the exact state the mechanism exists to prevent. Let the
  transition clear it.
- **Pre-existing breakage found in passing:** `scripts/smoke.ts` used `chord`
  where M5b renamed it `chords` (broken since M5b); `scripts/probe-router.ts`
  had collapsed to `never` under closure narrowing, concealing a typo. Scripts
  are not typechecked by CI — check them when you touch the APIs they use.

---

## 5. The trace — use it before guessing

`src/main/trace.ts`. Every utterance gets a short id and every step a line:

```
⟨u2⟩     +0ms  hold.begin       key=Fn
⟨u2⟩   +310ms  context.read     blocks=50 chars=5976 truncated=true image=115KB harvestMs=27
⟨u2⟩  +4313ms  asr.done         ms=535 chars=35 said="May we get to Anil's chat."
⟨u2⟩  +6079ms  classify.done    kind=navigate ms=1411
⟨u2⟩  +6081ms  lane.navigate    goal="open the conversation with Anil Turaga…"
⟨u2⟩  +2881ms  step.chosen      n=1 what="press 37 'Anil Turaga'" askMs=2570
⟨u2⟩  +6494ms  plan.restore     ok=true detail="back in Prahastha Shankesi"
```

Elapsed is cumulative from key-down — the number the user actually feels.
`fork()` restarts the clock while keeping the id, for work that outlives the
utterance (a plan card the user reads for ninety seconds before pressing Run).

**Where it stops tells you which half is broken:**

| last line seen | what it means |
|---|---|
| `classify.done`, no `lane.*` | routing |
| `classify.failed` | the classifier timed out — check `by=` on the `route` line |
| `compose.ask` / `edit.ask`, no `engine.done` | wedged engine (a 60s watchdog now ends it with `engine.failed`) |
| `engine.done`, no card | the card path |
| `plan.run`, no `scan` | the sidecar |
| `step.refused` | the executor or sidecar refused — the reason is on the line |

The full set of step names, so you can grep for one: `hold.begin` `hold.end`
`focus.read` `context.read` `asr.start` `asr.done` `classify.ask`
`classify.done` `classify.failed` `route` `lane.ask` `lane.send`
`lane.navigate` `compose.ask` `edit.ask` `engine.done` `engine.failed`
`insert.done` `insert.failed` `ask.ask` `ask.done` `ask.failed`
`plan.propose` `plan.run` `plan.cancelled` `plan.stopped` `plan.threw`
`plan.restore` `scan` `step.chosen` `step.done` `step.refused`
`step.unusable` `answer.done` `answer.failed` `card.action`.

Ask the user for the `⟨u…⟩` lines of one failing utterance. It is faster than
any amount of reading, and this session's two real bugs were both diagnosed from
the log rather than from the source.

---

## 6. Measurements that are facts — do not re-derive

```
classifier, thinking disabled, warm      p50  954ms   (was 20086ms)
classify in production, Haiku            771–1018ms
answer turn, Sonnet                      2.0–2.9s
uiTargets scan                           9–106ms

uiTargets across seven apps (the gate that justified the whole design):
  Finder   press  11  type 0  search  1   36ms
  Notes    press  11  type 0  search  1   64ms
  Mail     press   3  type 0  search  0   46ms   (sign-in sheet)
  Messages press   4  type 0  search  0   26ms   (sign-in sheet)
  Slack    press 138  type 1  search 12  106ms
  Code     press   0  type 0  search  0    9ms   (no window)
  Chrome   press 116  type 2  search  6   55ms

Slack: pressing Search collapses 138 targets → 6. This is why the model gets a
fresh scan every step and why a stale index must refuse.

ask-vs-compose routing, 14 utterances across Notes/Slack/Mail:  14/14
answer prompt, 4 cases incl. a prompt injection:                4/4
```

---

## 7. Open work, honestly stated

**Never verified end to end with a real model and a real key press.** Task #22.
Navigation has been exercised from the trace of the user's own session and from
probes, but nobody has pressed Fn and watched a full navigation succeed in
Slack, Mail *and* Finder. Do this before calling M5a done.

**The press that pressed nothing.** In one trace Slack accepted the `AXPress`
and did not change conversation. The new window-title evidence means the model
will now *notice*, but the underlying cause is unknown. Hypothesis worth testing:
Slack sidebar rows may need a child button pressed rather than the row.

**Stage 6 — disclosure (task #20), partially done.** The Screen Recording
permission row exists. Still outstanding: the Settings → Privacy pane for
`context` mode and the exclusion list; onboarding pages 1 and 4 privacy copy;
`bench.jsonl` gaining `contextChars` / `screenshotBytes` / `contextMs`;
`docs/M5-VERIFY.md`; updating `docs/PLAN.md`.

**Target-list cost.** Slack returns 120–138 targets, of which roughly 50 are
navigation and the rest are message rows (three each: group, author button,
timestamp link). The model pays for that list in tokens on **every step**.
Trimming it is real, unstarted work.

**Task #11 — M5 proper:** whitelisted commands + working memory v0.

**A decision the user has not made.** The answer card deliberately offers no
"Insert". They were told, and have not asked for one. "Write a summary of this
at the top of my notes" routes to `compose` and gets a proper Apply, which
measured correctly — so the capability exists by another path.

---

## 8. How this user works

These are not preferences to be inferred; they were stated or corrected.

- **No `Co-Authored-By: Claude` trailer on commits.** Write the body and stop.
  (Recorded in memory as `no-coauthor-trailer-in-commits`.)
- **Do not use the Agent tool, workflows, or deep-research unless asked.** All
  exploration in this session was Read/Bash/Grep.
- **Measure, then decide.** Every prompt change in this session was verified
  against the real model before being committed, and two of them were wrong on
  the first attempt and caught that way (§4.5). A prompt change that has not
  been measured is a guess.
- **Commit messages are prose.** A real sentence as the title (`"Anil Turaga" is
  a name, not a goal`), then an explanation of *why* — including the
  measurement, and including what was tried and thrown away. Look at
  `git log` for the register.
- **Code comments explain why, and record what failed.** The codebase is
  unusually heavily commented and that is deliberate. When you fix something,
  the comment says what the old behaviour was and why it was wrong. See
  `pipeline/ask.ts` or `pipeline/navigate.ts` for the house style.
- **Do not report success you have not seen.** The user asked "verify if it's
  working" and the honest answer was "I can't press your Fn key from here — send
  me the trace." Say that rather than inferring.

---

## 9. Design decisions and the arguments behind them

Kept short. The code says the rest.

**The model reads the screen; tables do not.** M4's verb table (`tighten`,
`proofread`, `reply`, `summarise`) typed every unlisted phrasing verbatim into
the composer. It is gone. Stage 5 originally proposed `navigation-table.ts` — a
per-app search chord, Slack → ⌘K — and it was rejected for the same reason one
layer down: *"general purpose" and "a table of bundle IDs" cannot both be true.*

**The model returns an index, not a name.** The old objection to AX clicking was
"two buttons named Send is a guess". It stops being a guess when Mull enumerates
the pressable elements, numbers them, and the model answers with an integer.
Exact-match-or-refuse becomes trivially satisfiable.

**One nav step at a time.** A UI is a moving target; see the 138→6 measurement.
A three-step plan decided against the first window has a second step that refers
to nothing.

**Deny-list, not allow-list, for destructive presses.** An allow-list that
misses a case fails *silently and uselessly* — that is what killed the verb
tables. A deny-list that misses a case fails open, which is worse in principle,
but one that fires wrongly merely refuses. Different bets, and the plan card
plus Escape are the actual defence.

**`answer` is not `compose`.** Both read the screen and produce sentences. The
composer's central rule is *"reply with the message itself, in the user's voice,
for them to send"* — point that at "what did Anil say about the terms doc" and
it drafts a message **to Anil**. The audience is inverted. There is a second
inversion about not knowing: a draft missing a fact writes around it; an answer
missing a fact must say so.

**`ask` is not `compose`.** Same distinction, one layer up, and the reason this
matters is a button: "summarize all my tasks" produced a diff card with **Apply**
offering to paste a summary of the user's notes back into those notes — one
reflexive ⏎ from doing it. The discriminator is *would the user want this put
into their document?*

**Restore always runs.** Finished, cancelled, failed, out of budget. Leaving
someone's Slack on a stranger's DM is rude in a way no correctness elsewhere
makes up for.
