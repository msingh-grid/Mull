# Role evidence — Saaketh Koduri

**Role:** Sales. Accountable for stakeholder and client interviews, pricing,
positioning, pipeline, and the pitch.
**Team:** Mohit Singh (Engineer) · Lay Naik (PM) · Saaketh Koduri (Sales)
**Product:** Mull, a voice layer for macOS (working name "Relay" until mid-September)
· repository `msingh-grid/Mull` · this archive.

> Nothing in this file is claimed without a pointer to where it can be
> checked.

---

## 1 · Deliverables I owned

| Deliverable | Where | Status |
|---|---|---|
| Pricing and go-to-market: packaging, price metric, unit economics, rejected alternative | [submission/PRICING.md](submission/PRICING.md) | done; **agreed by the team 26 Sep** |
| Positioning ("voice that shows its work"; lead with the exact change) | PRICING §6; D20 and trace T3 | done |
| Pitch deck, 13 slides | [submission/PITCH_DECK.pdf](submission/PITCH_DECK.pdf) | done; shared with the team 26 Sep |
| Synthesis of the three user sessions into hypotheses, decisions and the business documents. P1 and P2 were **run by Lay Naik**; I used them with Lay's agreement. P3 was a prototype session with free-form feedback on 27 Sep | [research/INTERVIEWS.md](submission/research/INTERVIEWS.md), [research/USER_TRACES.md](submission/research/USER_TRACES.md) T1–T8 | done |
| Buyer / approver interview script (10 questions, hypotheses B1–B5, notes template) | [research/BUYER_INTERVIEW_SCRIPT.md](submission/research/BUYER_INTERVIEW_SCRIPT.md) | script done; **no buyer interview run yet**. It is the next step for a dollar price figure |
| Real users: 3 (U1–U3), meeting the 3–5 requirement | [research/USER_TRACES.md](submission/research/USER_TRACES.md) | done |
| Pipeline | PRICING §6. One warm lead: the delivery manager (P2) offered to recommend Mull to peers if it saves 45–60 min a day. The product-company manager (P3) would "definitely want to try" a send feature | two leads; no paid commitment yet |

## 2 · Decisions I drove, and where my thinking changed

**Re-pricing around what we can legally and profitably ship** (D19; agreed by
the team 26 Sep).

- **My first idea was wrong.** At the 16 Sep meeting I proposed pricing by
  token usage or tool calls, and said cost optimisation could wait.
- **What changed it (26 Sep):**
  - **Terms:** Anthropic's Agent SDK docs do not allow third-party products to
    offer claude.ai login without approval, and that is our prototype's
    default engine.
  - **Cost:** costed from our real prompt sizes, one Fn request is
    ~$0.013–0.020, and a heavy user ~$8.60/month.
- **Outcome:**
  - Free local dictation · Pro $12 with 400 requests · Own Key $99 once ·
    a $15-per-seat team pilot.
  - Per-use pricing became the rejected alternative, because it meters the
    thinking.
- **Handoffs:** "AI on API keys" and "per-request cost logging" moved to the
  top of the roadmap (N1, N2).

**Interview senior people, not interns** (D23, 13 Sep). I first suggested
interviewing interns, because they are easy to reach. Lay argued that the
buying decision and the value sit with senior people, and I agreed.
Afterwards, the delivery manager's interview produced the team-licence and
security-review findings (T4), which interns could not have given us.

**Manual and automatic modes** (D21). On 16 Sep, Mohit was reluctant to
remove permission prompts. I proposed two modes: manual permission, and an
automated mode with warnings. It shipped on 22 Sep as the HUD auto-run
toggle, off by default (933d0d8, Mohit).

**Speech recognition uses what is already on screen** (D9; commit 6cdbb4b,
21 Sep).

- **Evidence:** measured on "open the eng platform channel". `base.en` alone
  gave "the end platform"; given the on-screen names it gave
  "#eng-platform", beating a model 3× larger.
- **Also shipped:** voice-activity trimming and a launch-time audio warm-up.
  Our ledger showed 320 ms of speech lost on the first utterance after every
  launch.

**A second model vendor, opt-in only** (D18; assigned to me 16 Sep, shipped
26 Sep in 00f8398).

- **Why:** the team had no direct company API keys. I suggested an API
  gateway (Bifrost), which was not adopted, and took on the Codex lane
  instead.
- **Rules:** explicit opt-in, never a silent fallback to Anthropic, and no
  agent loop, because Codex has no hard "no tools" switch.

**Decisions drawn from the user interviews** (traces in
[USER_TRACES.md](submission/research/USER_TRACES.md)):

- **T1:** 0 of 2 would allow a tool to read the whole screen. Proposed a
  text-only default and exposing the existing "never read" app list (N5).
- **T2:** show the message's destination on the preview card (X6).
- **T3:** lead the pitch with the preview. Preview was valued 2 of 2; undo
  split them 1 of 2.
- **T4:** an employer-paid team pilot, plus a data-handling one-pager for
  security review.
- **T5:** retired "replace typing"; the target segment moved to
  coordination-heavy roles (to test).
- **T7:** 2 of 3 users want Mull to send or post. Sending stays off, but I
  moved the send-within-a-budget design up to a "Next" design spike (X7).
- **T8:** 2 of 3 users are managers who write a lot, so that is the
  beachhead. The Codex lane I built ran a whole outside user's session, and
  they called it "seamless".
- **Negative:** no user was asked a price. I added price questions to the
  buyer script, but no buyer interview has run yet.

## 3 · Cross-functional work

| With | What | Evidence |
|---|---|---|
| Engineering (Mohit) | Two product commits: screen-aware speech prompting; the Codex engine lane (+2,240 lines, incl. tests) | `git log --author=saakethkodurigrid`: 6cdbb4b (21 Sep), 00f8398 (26 Sep) |
| Engineering (Mohit) | Tested the build on my Mac, 17–25 Sep (my task from the 16 Sep meeting): 32 logged utterances. Findings: 10 of 26 dictations landed; 5 failed with no text field focused; Fn routing a median 2.8 s | [evidence/bench-report.txt](evidence/bench-report.txt) |
| Engineering (Mohit) | Submission hardening: `npm run setup` (one command), `npm run bench:report`, saved test/typecheck/smoke evidence, corrected stale README figures | [scripts/](scripts/), [evidence/](evidence/) |
| Engineering (Mohit) | Licence audit: restored the stripped icon credits; flagged the LGPL component and the unrecorded cat-sprite source | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| PM (Lay) | Advised cutting the interview script from 40+ questions to 15–20 (Lay shipped 15 on 23 Sep); asked before using the interview data | team huddle summary |
| PM (Lay) | Drafted the Business Model Canvas and roadmap for Lay's review, each cell tagged by evidence strength | [BUSINESS_MODEL_CANVAS.md](submission/BUSINESS_MODEL_CANVAS.md), [ROADMAP.md](submission/ROADMAP.md) |
| Team | Scheduled the knowledge-transfer session (proposed 12 Sep, sent the invite; held 13 Sep) | team huddle summary |
| Team / programme | Proposed the one-week project extension on 18 Sep, after checking with the programme leads; Lay agreed | team huddle summary |
| Team | Consolidated the decision log (23 decisions, with a section on what failed) and the AI disclosure | [DECISION_LOG.md](submission/DECISION_LOG.md), [AI_DISCLOSURE.md](submission/AI_DISCLOSURE.md) |
| Team | Sales collateral, assigned 13 and 16 Sep | The pitch deck is the collateral delivered | [submission/PITCH_DECK.pdf](submission/PITCH_DECK.pdf) |

## 4 · Community discussion posts

All posts are in the team's thread on the company-internal community
platform, so the links open only for signed-in company users. They are
available to the programme on request.

| Date | Week | Post |
|---|---|---|
| 26 Aug | 3 | Reply to Mohit's research post on Alma, Perplexity and Manus: tried Alma (waitlisted); took the Perplexity references |
| 1 Sep | 4 | Reply on Mohit's first product doc: reviewing the computer-use approach |
| 10 Sep | 5 | **Sales role plan and interview plan:** who to talk to (product managers, Product Ops, engineering managers who live in Slack and Jira); test the prototype with them; probe trust and permission concerns; collect willingness to try or pay; feed positioning, pricing, target customer, pilot pipeline and pitch |
| 16 Sep | — | Posted the 13 Sep meeting transcript: Electron decision, company GitHub, customer profile, next steps |
| 16 Sep | — | Posted the 16 Sep meeting transcript: DMG packaging, manual/automatic modes, first pricing idea, Codex branch |
| 27 Sep | final | Checkpoint: validation result from three users, the pricing decision that changed, remaining risk |

**My honest read of these posts:**
- My Week 3 and Week 4 posts were short replies to Mohit, not evidence-backed
  checkpoints.
- My Week 5 post was a plan, not a result.
- The final checkpoint is where evidence and a changed decision appear.
- My plan named product and engineering managers. The users we reached were
  an HR professional, a delivery manager and a product-company manager, so
  one of three matched the plan exactly.

## 5 · AI use in my work

- **My commits:** written with Claude Code (Claude Opus 5, Claude Opus 5.5)
  on the company Claude Team plan, as the commit trailers record.
- **This archive's documents:** drafted with Claude Code (Claude Opus 5.5)
  from the code, docs, history, meeting transcripts and our interview notes.

**What I checked:**
- Every figure is cited to a file, commit, transcript or measurement.
- The Agent SDK terms were read from Anthropic's published documentation.
- One AI-drafted claim, that failed edits meant "not signed in", was checked
  against the code, found wrong and corrected.
- An early draft credited the interviews to me. It was corrected when the
  team record showed Lay ran them.

Full detail: [submission/AI_DISCLOSURE.md](submission/AI_DISCLOSURE.md).
