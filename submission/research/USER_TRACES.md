# Real users — observations and decision traces

Users recruited, and interviews run, by Lay Naik (PM). Traces written by
Saaketh Koduri (Sales). Protocol for further sessions: [INTERVIEW_SCRIPT.md](INTERVIEW_SCRIPT.md) §B

> Anonymised (U1…Un). No private or client data, and nothing seen on
> participants' screens, is recorded here. **Three real users.** The
> brief asks for 3–5, and this meets the minimum.

## Users

| ID | Date | Profile (generalised) | What they did with the prototype | Consent | Interview |
|---|---|---|---|---|---|
| U1 | 25 Sep 2026 | HR professional (= P1) | Dictation with ⌥Space, messaging people in Slack, the other features | Y | P1 |
| U2 | 25 Sep 2026 | Delivery manager, IT services (= P2) | Dictation with ⌥Space, messaging people in Slack, the other features | Y | P2 |
| U3 | 27 Sep 2026 | Manager at a product company (= P3) | ⌥Space dictation; Fn requests in normal and auto-run modes; on the Codex engine lane | Y | P3 (free-form feedback) |

## What the prototype trials showed

Task-by-task timings, retries and errors were **not recorded** for any of the
three. For U3 one observation was recorded: **first key reached for: ⌥Space
(dictation)**. What they said straight after using it:

| Question | U1 (HR) | U2 (delivery manager) | U3 (product-company manager) |
|---|---|---|---|
| Most useful workflow | "regularly" | Transcript or spoken notes → summary → the right Slack thread, 1–2×/day; spoken team messages, 10+×/day; quick replies, several×/day | Dictating long emails, Slack messages and research prompts, with screen context |
| What they need before approving | The exact proposed change; comfortable approving | The full final text with changes highlighted, plus the destination: channel, thread, people tagged | Wants Fn to send automatically, as a later feature |
| What Mull may read | Selected text they approve | Selected text; the active window only when triggered; never the whole screen | Not asked; liked that dictation used on-screen context |
| What would stop them adopting | It must save time on repetitive tasks | Security review and client-data rules; name accuracy; it must beat a chatbot tab | Not asked |
| Engine and speed | Claude lane | Claude lane | Codex lane: "seamless"; voice "felt instant" |

For the next sessions, record per task: success (Y / with help / N), time,
retries, and which key the user reached for first (§B of the script). H3
(two keys learnable) has one observation in favour (U3). H6 (permission
drop-off) was not measured for any user.

## Decision traces — hypothesis → evidence → decision

Each trace links to a decision in [DECISION_LOG.md](../DECISION_LOG.md) or an
item in [ROADMAP.md](../ROADMAP.md). Negative results are kept. Evidence so
is **three users (U1–U3) who tried the prototype** and then gave interviews
or feedback (P1–P3, [INTERVIEWS.md](INTERVIEWS.md)).

### T1 · Read less of the screen by default
- **Hypothesis:** users will accept Mull reading the active window plus a
  screenshot whenever they press Fn, as long as a chip says so (our default,
  `settings.context = 'text+screen'`, decision D13).
- **Evidence:**
  - 0 of 2 would allow the entire screen.
  - P1 allows only "selected text approved by me".
  - P2 allows selected text and the active window only when they trigger it,
    and wants to block specific apps and channels (HR, finance, contracts,
    client documents).
- **Decision (changed):** propose the default `context: 'text'` (no
  screenshot), and expose the per-app "never read" list in Settings. The list
  already exists in the engine as `contextExcluded`, but no screen offers it.
- **Status:** on roadmap, **N5** (owner: engineering).

### T2 · Show the destination, not just the text
- **Hypothesis:** the diff card (what changes) is enough to approve safely.
- **Evidence:**
  - Both ranked "the exact proposed change" most valuable (2/2).
  - P2 also needs "which channel, which thread, and which people it will
    tag". A client-facing message in the wrong channel "would be a serious
    problem".
- **Decision (added):** the preview card will name the target app,
  conversation or thread and the people mentioned before ⏎ applies.
  Mull still does not send (D3, D6).
- **Status:** on roadmap, **X6**.

### T3 · Lead the pitch with the preview, not with undo
- **Hypothesis (H2):** preview *and* undo are both core reasons to trust
  Mull.
- **Evidence:**
  - The preview was the top choice for both participants (2/2).
  - The journal and undo were "very important" to P2, for reversibility and
    accountability. P1 was "not sure". **Negative for undo as a headline.**
- **Decision (changed):** the pitch and value proposition lead with "see the
  exact change before it happens". Undo stays as a supporting feature.
- **Status:** done: deck "problem", "demo" and "evidence" slides; BMC §2.

### T4 · Test an employer-paid team plan sooner
- **Hypothesis (H5):** individuals pay $12/month themselves.
- **Evidence:**
  - Neither gave a price; we did not ask, which is a gap in our script.
  - Both framed value as time saved (P1: repetitive tasks; P2: "45 minutes
    to an hour a day").
  - P2: "a team license would be easier to justify than paying personally".
  - P2 says adoption is gated by company security review.
- **Decision (changed):**
  - Move a team-pilot offer from "Later" to a "Next" pricing test.
  - Add a one-page data-handling statement to "Now": what is read, what
    leaves the Mac, retention, no training.
  - Add a price question to the script.
- **Status:** PRICING §2–3; ROADMAP **N6**, **X1**.

### T5 · Don't sell "dictate everything"
- **Hypothesis (H1):** knowledge workers want to replace typing with voice.
- **Evidence:**
  - Neither used voice before trying Mull.
  - P1 prefers typing for nuance and recalls no case where voice would be
    easier.
  - P2 wants voice for short outward messages after calls (10+ a day), but
    not for sensitive wording or exact IDs and dates.
- **Decision (changed):** position ⌥Space for quick messages and Fn for
  context-aware edits and replies, rather than as a typing replacement.
  Target coordination-heavy roles (e.g. delivery managers) as a candidate
  beachhead. **That rests on one interview, so it is a hypothesis to test,
  not a finding.**
- **Status:** PRICING §6, BMC §1.

### T6 · Name accuracy is a keep-or-drop issue
- **Hypothesis:** feeding on-screen names to speech recognition (D9, commit
  6cdbb4b) matters to real users, not just to our test phrase.
- **Evidence:**
  - P2's team spans several countries: "if Mull keeps getting people's names
    wrong, I'll stop using it".
  - P2 avoids voice for IDs and dates "unless the accuracy is very good".
  - P2's AI summaries have assigned updates to the wrong person.
- **Decision (confirmed):** keep screen-aware prompting. Add a measured name
  and number accuracy check, on a corpus of the team's own names and IDs, to
  the reliability work.
- **Status:** ROADMAP **X4** (extended).

### T7 · Users want sending; Mull still won't, yet
- **Hypothesis:** drafting and previewing is enough; users will press ⏎
  themselves.
- **Evidence:**
  - 2 of 3 want Mull to send or post. U2's top workflow is posting a summary
    to the right Slack thread with people tagged, *with approval*. U3 wants
    "auto send" in Fn mode and "would definitely want to try it if built as a
    later feature".
  - U1 wants to see results first.
  - U3 volunteered that they understood why it is absent ("security
    reasons"): the trust framing landed.
- **Decision (changed):** sending stays off (D3, D6). The **budget-based send
  design** (`docs/agent/AGENT-V2.md` §7: sending allowed only within a budget
  granted from the user's own words, with the destination shown per T2) moves
  from "Later" to a **"Next" design spike**. Building it still waits on a
  threat-model review.
- **Status:** ROADMAP **X7**; L1 keeps the build.

### T8 · Managers who write a lot, on either engine
- **Hypothesis:** the beachhead is coordination-heavy roles (T5, from one
  interview).
- **Evidence:**
  - U3, a product-company manager, writes long emails, Slack messages and
    prompts, and says dictation "would save a lot of time".
  - With U2, that makes 2 of 3 users managers who value voice for written
    communication.
  - U3 ran the whole session on the Codex lane and called it "seamless".
- **Decision (confirmed):** the beachhead is managers who write a lot, across
  Slack, email and AI prompts. The Codex lane is kept as a supported engine,
  not an experiment. Our 10 Sep Sales plan targeted product and engineering
  managers; U3 is the first of them.
- **Status:** BMC §1; DECISION_LOG D18.
