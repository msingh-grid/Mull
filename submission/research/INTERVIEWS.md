# Stakeholder / client interviews — synthesis

P1 and P2: interviews led and run by **Lay Naik (PM)**, 25 Sep 2026, after
each participant tried the prototype. P3: prototype session with free-form
feedback, 27 Sep 2026. Synthesis into hypotheses, decisions and the
business documents by **Saaketh Koduri (Sales)**, with Lay's agreement to use
the data. Script as asked: [INTERVIEW_SCRIPT.md](INTERVIEW_SCRIPT.md) §A

Participants are anonymised (P1, P2…). Employer, client, project and colleague
names mentioned in the interviews have been removed or generalised. Quotes are
short and kept only where they carry the finding.

> Both participants gave consent (confirmed by the team, 26 Sep). They are
> still referred to as P1 and P2 here: naming them adds nothing to the
> evidence, and anonymity is the safer default for a document others will
> read.

## Participants and consent

| ID | Date | Role / context (generalised) | Tools they live in | Uses AI today | Used voice before Mull | Notes consent | Named? | Quote OK? |
|---|---|---|---|---|---|---|---|---|
| P1 | 25 Sep 2026 | HR professional; data and query management | Gmail, HR information systems, a BI/dashboard tool | Yes, typed prompts | **No** | Y | Consented; anonymised here | Y |
| P2 | 25 Sep 2026 | Delivery manager at an IT services company; runs several enterprise client teams | Slack (most), calendar, video calls, email, Jira, Confluence, shared spreadsheets, an internal staffing tool; Claude in a browser tab all day | Yes, daily: meeting summaries, drafts, thread summaries | **Rarely** | Y | Consented; anonymised here | Y |
| P3 | 27 Sep 2026 | Manager at a product company; writes long emails, Slack messages and research prompts | Email, Slack, AI prompts for research, Codex CLI | Yes | Not stated | Y | Consented; anonymised here | Y |

**Both used the working prototype before the interview.** They dictated with
⌥Space, messaged people in Slack, and tried the other features. They are
therefore also users U1 and U2 in [USER_TRACES.md](USER_TRACES.md). Task-level
timings and error counts were not recorded during those trials; what they
said about the prototype is in Q9–Q15 below.

**P3 was a shorter session** (27 Sep). They used the prototype with the Codex
engine lane: ⌥Space dictation, and Fn requests in both normal (manual Run)
and auto-run modes. They gave free-form feedback rather than answers to the
15 questions, so P3 counts toward the questions it speaks to, and the "n" is
stated for each finding. Their feedback in full (consented):

> "I liked the intuition behind Mull, especially, I write long emails and
> messages in Slack and prompts for my research purposes, so the dictation
> part would save a lot of time for me, that too context based dictation, but
> one thing I also want in Fn mode, is auto send, I know Mull does not do it
> because of security reasons, but I felt I would definitely want to try it
> if built as a later feature, and the seamless integration with Codex is
> very nice, the voice also felt instant after giving prompt."

Observed: P3 reached for **⌥Space first**, for dictation, and singled out
that dictation used what was on screen.

## Findings by hypothesis

| Hyp. | Supported by | Contradicted / complicated by | Verdict (n = 2) |
|---|---|---|---|
| **H1** Knowledge workers have tried and dropped dictation over errors and cleanup cost | — | Before trying Mull, neither had ever adopted voice, so neither "dropped" it. P1 prefers typing: "I can express my thoughts, requirements, and nuances more clearly in writing", and could recall no case where speaking would be easier. P2 avoids voice for sensitive or exact-value content. | **Not supported as stated.** The barrier is not bad dictation. People don't reach for voice at all, except for specific short messages (P2). |
| **H1′** *(emerged)* Voice is valuable for managers' written communication: short coordination messages (P2) and long emails, Slack messages and prompts (P3) | P2: ~10+ short messages a day after calls. P3: "the dictation part would save a lot of time for me, that too context based dictation" | P1: prefers typing, no such situation | **Supported by 2 of 3**, both managers. |
| **H3** Two explicit keys are learnable in one session | P3 reached for ⌥Space first for dictation, then used Fn in both modes | — (not observed for P1, P2) | **Early support, 1 observed.** |
| **H2** Users will let AI change text only if they see the exact change first and can undo it | Both rank the **exact proposed change** as most valuable (2/2). P2 needs "the full final text exactly as it will appear, with changes highlighted". P1: "I would prefer to see the results first and then decide." | P1 says they are "pretty much comfortable approving" and is "not sure" about a journal and undo. P2 calls journal and undo "very important", including for accountability ("who changed something and when"). | **Preview: supported (2/2). Undo and journal: split (1/2).** |
| **H2′** *(emerged)* The preview must show **where** a message will go, not just what it says | P2: "which channel, which thread, and which people it will tag". Posting client-facing text in the wrong channel "would be a serious problem". | — (P1 not asked about destinations) | **New requirement, 1 of 2, high severity.** |
| **H7** *(emerged)* Users want Mull to send or post, not just draft | P2's top workflow is posting a summary to the right thread with people tagged, *with approval*. P3 wants "auto send" in Fn mode, understands why it is absent, and would "definitely want to try it if built as a later feature" | P1 wants to "see the results first and then decide" | **Supported by 2 of 3.** The most-requested missing capability, and the one Mull withholds on purpose (D3, D6) |
| **H4** Local-only audio is a purchase driver | P1 avoids voice for privacy | Both frame privacy around **screen and data access**, not audio. P1 permits only "selected text approved by me". P2 permits selected text and the active window only when triggered, never the whole screen, and wants per-app and per-channel blocking plus a clear statement of whether data leaves the laptop, is stored, or is used for training. | **Reframed.** The privacy question is "what do you read and send", more than "where does audio go". |
| **H5** WTP is ~$8–15/month; many prefer one-time or BYOK | P1 would adopt "if it helps save time and reduces the effort involved in repetitive tasks". P2 sets a threshold: saving "45 minutes to an hour a day" means daily use, and "a team license would be easier to justify than paying personally". | **No price points were asked**, so there is no dollar figure in either interview | **Unvalidated on price.** Value is framed as time saved. Evidence for a **team/employer-paid** purchase path (1 of 2). |

## Other findings

- **Re-explaining context is the #1 friction.** P2 named "providing context"
  as the biggest cost, re-given every new conversation or section, and said
  more time went to "re-explaining context, switching between [documents],
  and reformatting, rather than actually thinking about the solution". P1
  named "switching applications, providing context". (2/2)
- **Polished AI output hides errors.** P2's example: the AI rewrote a status
  as "in progress" when the team had said it was blocked. "The output always
  looks polished and confident, so mistakes are easy to miss." P1 re-prompts
  when the AI misunderstands. (2/2 hit errors)
- **Name and number accuracy is a deal-breaker for voice.** P2's team spans
  several countries: "if Mull keeps getting people's names wrong, I'll stop
  using it". P2 would avoid voice for demand IDs, ticket numbers and dates
  "unless the accuracy is very good".
- **The approval line is clear and outward-facing.** P2 is fine without
  confirmation for grammar fixes, template formatting, private summaries and
  private drafts. P2 always wants approval for posting, sending, tagging,
  invites, ticket updates and shared-tracker edits. P1 wants to "see the
  results first" for everything.
- **What it heard matters for names and numbers only.** P2 wants the change
  and destination most prominent and the interpretation second. The
  transcript is useful "mainly for checking names and numbers".
- **Enterprise security review gates adoption.** P2: Mull "has to pass our
  security review and respect client data restrictions". Client contracts
  "may not even allow it otherwise".
- **It must beat a chatbot tab.** P2: "it needs to do more than Claude in a
  browser, especially knowing my team and project context without me
  re-explaining it every day, and posting directly in the right place in the
  right format."

## What P3 confirmed about the build

- **Context-aware dictation works for them.** This is the on-screen name
  prompting shipped on 21 Sep (6cdbb4b, D9).
- **The Codex engine lane is usable end to end by an outside user:** "the
  seamless integration with Codex is very nice" (00f8398, D18).
- **Latency felt instant** after a prompt, though this is a perception, not a
  measurement.
- **Auto-run mode was used, and not rejected** (D21).

## Workflows and frequency they named (Q14)

| Workflow | Who | Stated frequency | Can Mull do it today? |
|---|---|---|---|
| Transcript or spoken notes → formatted summary → posted to the right Slack thread with the right people tagged | P2 | 1–2 × day | **Partly.** Compose drafts from what's on screen into the focused field. Mull cannot post or tag by design (it cannot send; D3, D6). |
| Short spoken team messages and reminders | P2 | 10+ × day | **Yes**: ⌥Space dictation, no model, free tier |
| Quick replies to selected Slack messages and emails | P2 | several × day | **Yes**: Fn compose, previewed |
| Rewording, shortening, restructuring visible text | P1 | "regularly" | **Yes**: Fn edit with diff card |
| Dictating long emails, Slack messages and research prompts, using on-screen context | P3 | not stated ("would save a lot of time") | **Yes**: ⌥Space with screen-aware prompting |
| Fn request that sends automatically | P3 | — | **No, by design.** A spec exists (`docs/agent/AGENT-V2.md` §7); ROADMAP L1 |

## Negative findings, kept

- Neither participant used voice before trying Mull. Even after trying
  dictation in the prototype, P1 still saw no situation where they would
  prefer it to typing.
- P1 is unsure a journal and undo matter to them, although it is a headline
  feature in our pitch.
- The most-wanted missing capability, for 2 of 3 users (P2 posting with
  tags, P3 auto-send), is the one thing Mull deliberately cannot do.
- Mull's default reads the active window **and a screenshot** on every Fn
  press (`settings.context = 'text+screen'`). That is more than either
  participant said they would allow by default.
- We did not ask for price points, so willingness-to-pay remains unmeasured.

## What changed because of these interviews

| Change | Artifact updated | Trace |
|---|---|---|
| Default context narrowed to text only (no screenshot); expose the per-app "never read" list in Settings | ROADMAP N5 (engineering); DECISION_LOG D13 note | T1 |
| Preview card to show the destination (app, channel/thread, people mentioned) before apply | ROADMAP X6 | T2 |
| Pitch leads with the exact proposed change, not undo | Pitch deck; BMC value proposition | T3 |
| Team/employer-paid path moved from "Later" to a "Next" test; a security/data-handling one-pager added to Now | PRICING §2–3; ROADMAP N6, X1 | T4 |
| Positioning: voice for quick messages, Fn for context-aware edits; not "dictate everything" | PRICING §6; BMC segments | T5 |
| Screen-aware name recognition confirmed as a keep-and-measure priority | ROADMAP X4 note; DECISION_LOG D9 | T6 |
| Sending stays off, but the send-budget design moves from "Later" to a "Next" design spike, because 2 of 3 users asked for it | ROADMAP X7, L1 | T7 |
| Beachhead confirmed as managers who write a lot (2 of 3); the Codex lane kept as a supported engine | BMC §1; DECISION_LOG D18 | T8 |
