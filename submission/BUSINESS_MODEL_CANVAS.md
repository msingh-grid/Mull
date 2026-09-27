# Business Model Canvas — Mull

Owner: Lay Naik (PM) with Saaketh Koduri (Sales) · Draft 26 Sep 2026.

Every cell carries an evidence tag:

| Tag | Meaning |
|---|---|
| **[D]** | Desk research, secondary (`docs/02`, `docs/04`, `docs/REPORT.md`) |
| **[M]** | Measured by us, from the code, the ledger or probes |
| **[I]** | Interviews / user sessions with 3 users (`research/`) |

A cell that is only [D] is a hypothesis, not a finding.

---

## One-line model

A free, local voice-dictation layer for the Mac that wins trust. Revenue comes
from a paid tier for the AI "request" key (edit, draft, ask, navigate), sold
on the promise that every AI change is shown before it happens and can be
undone.

---

## 1 · Customer segments

| Segment | Why them | Evidence |
|---|---|---|
| **Beachhead: managers on Apple silicon who write a lot**: delivery, project and product managers and team leads who live in Slack and email, write AI prompts, and already use AI daily | Many messages a day, short (P2) or long (P3), plus AI drafts they must check before clients see them | [I] 2 of 3 users are managers who value voice for written communication. P2: 10+ short messages/day; P3: long emails, Slack messages and research prompts, "would save a lot of time" (T5, T8); [D] `docs/02` |
| **Privacy-sensitive power users** (developers, writers, consultants) | They need control over what is read and sent | [D] Wispr Flow privacy exposés (`docs/04` §2); [I] both interviewees limit screen access (P1 selected text only) |
| *Later:* small teams; regulated-industry users with a local-only mode | Cloud-only rivals can't sell to them | [D] `docs/REPORT.md` §4 — not validated |

**Not a segment:** people who want the fastest possible dictation. That race
is commoditised by Apple and Wispr (`docs/REPORT.md` §3).

## 2 · Value proposition — jobs, pains, gains

| | Customer profile | How Mull answers it | Evidence |
|---|---|---|---|
| **Job** | Get thoughts into whatever app I'm in, fast | ⌥Space: on-device dictation into any app, with no model in the loop | [M] ⌥Space dictations 0.69–0.88 s key-up→text (`evidence/bench-report.txt`) |
| **Job** | Reshape, reply to or ask about what's on screen without copy-pasting into a chatbot | Fn: edit (diff card), compose, ask, navigate | [M] working lanes; 1,071 tests |
| **Pain** | "It typed my request into the chat as text" | Two keys: the user says which job it is | [M] 6 phrasings typed verbatim under the old verb table (cdd1aff) |
| **Pain** | I can't see what the AI changed before I send it under my name | Diff preview before apply; re-check that the text hasn't moved; compose may not invent facts | [M] safety seams 2–4 (README) |
| **Pain** | I re-explain context to the AI every time, and switch apps to do it | Fn reads the focused window when you press it, so there is no copy-paste | [I] #1 friction for 2/2 ("providing context", "switching applications") |
| **Pain** | AI output looks polished, so its mistakes get past me | The diff shows exactly which words changed; compose may not invent names, dates or commitments | [I] P2: a blocker rewritten as "in progress"; [M] README compose lane |
| **Pain** | I don't want a tool reading my whole screen | Reads only on Fn; credential apps never; text-only default and "never read" list planned (ROADMAP N5) | [I] 0/2 would allow the whole screen |
| **Pain** | Subscription for work my own laptop does | Free local dictation; Own Key one-time tier | [D] `docs/04` §2.1 (not raised by interviewees; P2 prefers employer-paid) |
| **Gain** | An assistant that can act, and that I can let act | Journal of every action + ⌥Z undo; the agent physically cannot press Return or send | [M] `src/shared/agent.ts` closed key list; `services/undo.ts` |
| **Gain** | It already knows what I'm looking at | Reads the focused window (disclosed on screen); feeds on-screen names to speech recognition | [M] "#eng-platform" vs "the end platform" (6cdbb4b) |

**Value proposition statement:** *Voice that shows its work.* Speak anywhere
on your Mac and see exactly what will change, and where, before it does.
Preview is the headline; undo supports it (T3: 2/2 valued the preview most,
1/2 the undo).

## 3 · Channels

| Stage | Channel | Evidence |
|---|---|---|
| Awareness | Hacker News / Product Hunt launches; privacy-audit threads about competitors; demo videos of the diff card | [D] where the category conversation happens (`docs/04` §2) |
| Evaluation | Free tier, no account needed for local dictation | [M] dictation works fully offline |
| Purchase | Direct download and checkout on our site. Not the Mac App Store: Accessibility apps can't be sandboxed | [D] `docs/REPORT.md` §4; [M] `build/entitlements.mac.plist` |
| Delivery | Notarised DMG + auto-update | **Not built** — local ad-hoc DMG only (`docs/LOCAL-BUILD.md`) — ROADMAP "Now" |

## 4 · Customer relationships

- Self-serve, product-led. The guided onboarding self-diagnoses the four
  macOS permissions ([M] `src/renderer/onboarding.tsx`).
- Trust as the relationship: a visible journal, what Mull saw, and an undo
  record. Nothing silent ([M]).
- Early users: direct founder contact from the interview cohort (P2
  offered to recommend it to peers if it saves 45–60 min/day).
- For teams: a data-handling statement and central "never read" list, because
  company security review is the gate (P2; ROADMAP N6).

## 5 · Revenue streams

| Stream | Price | Evidence |
|---|---|---|
| Pro subscription | $12/mo or $120/yr, 400 Fn requests included | [D] market band $12–15; [M] COGS model; [I] no price point yet; value = time saved |
| Team pilot | $15/seat/mo, employer-paid | [I] P2: team licence "easier to justify than paying personally" |
| Own Key licence | $99 one-time, bring your own API key | [D] lifetime tiers $29–249 sell (`docs/04` §1) |

Details, unit economics and the rejected alternative: [PRICING.md](PRICING.md).

## 6 · Key activities

- Insertion reliability across apps: the category's shared tax ([M]
  `docs/INSERTION-MATRIX.md`, ~45-app strategy table).
- Keeping the safety structure intact as capabilities grow ([M] README "The
  safety model", seven seams).
- Measuring before deciding: probes, the latency ledger, bench runs ([M]
  decisions D7–D11).
- Distribution: notarisation, updates, permission onboarding.

## 7 · Key resources

- The structural safety design and its test suite: 1,071 tests ([M]).
- The Swift Accessibility sidecar and the per-app insertion knowledge ([M]).
- On-device speech pipeline tuned with screen-aware prompting ([M]).
- A brand and position built on legibility ([D] positioning, `docs/04` §4–5).

## 8 · Key partners

| Partner | Role | Dependency risk |
|---|---|---|
| **Anthropic** (Claude API) | Reasoning for every Fn request | **High.** The subscription-login path we use today is not permitted for third-party products without approval (Agent SDK docs). Commercial launch must use API keys. See [PRICING](PRICING.md) §1. |
| OpenAI (Codex CLI, optional) | Second vendor, so we are not locked in | Medium: the experimental lane uses the user's own ChatGPT login; terms to be reviewed before any commercial use |
| whisper.cpp / OpenAI Whisper weights (MIT) | On-device speech | Low: open source, runs locally |
| Apple | Platform, notarisation, Accessibility APIs | Medium: Apple commoditising dictation from below (`docs/REPORT.md` §3) |

## 9 · Cost structure

| Cost | Type | Figure | Evidence |
|---|---|---|---|
| Model inference for Pro users | Variable | ~$0.013–0.020 per Fn request; ~$4.30/mo at 15 requests a workday | [M] prompt sizes × list prices (PRICING §4) |
| Payment / merchant fees | Variable | ~5–30% depending on processor | assumption |
| Apple Developer Program | Fixed | $99/yr | [D] `docs/LOCAL-BUILD.md` |
| Servers | — | **None.** No backend; journal and memory are local SQLite | [M] architecture |
| Engineering and support | Fixed | team time | — |

Local dictation costs us nothing to serve. It runs on the user's silicon, and
that is what makes a generous free tier affordable.

---

## Coherence check

- **Segment ↔ value:** the beachhead has both the typing pain and the "can't
  trust AI edits" pain. The privacy segment is served by local audio, which is
  free for us.
- **Value ↔ revenue:** we charge only for the part that costs us money (model
  requests) and give away the part that builds trust (local dictation).
- **Revenue ↔ cost:** Pro's 400-request allowance keeps cost per user below
  ~$5.20. Own Key carries zero inference cost, so a one-time price is safe.
- **Weakest links:**
  1. No price point from users yet: two interviews, and price was not asked.
  2. Distribution isn't built: no notarised build.
  3. A single model vendor is a partner risk, and our dev-time engine isn't
     commercially usable.

These three set the [ROADMAP](ROADMAP.md).
