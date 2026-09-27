# Roadmap — now / next / later

Owner: Lay Naik (PM) · with Mohit Singh (Engineer) and Saaketh Koduri (Sales)
· Draft 26 Sep 2026.

**How this is ordered:** by which risk would kill the business first, and by
dependency — not by which features are most fun. Each item names the evidence
that put it there and the exit criterion that moves it to done. Items marked
Items marked **T1–T8**
were added or moved because of the interviews ([research/USER_TRACES.md](research/USER_TRACES.md)).

The three risks, in order:

1. **Can we legally and profitably charge?** The engine and pricing risk.
2. **Can anyone outside the team install and keep it?** The distribution and
   onboarding risk.
3. **Will they pay, and for which part?** The willingness-to-pay risk.

Features that deepen the product come after those.

---

## Now — before the first outside user (≈ 4 weeks)

| # | Item | Why now (evidence) | Risk retired | Done when |
|---|---|---|---|---|
| N1 | **Commercial engine path.** API-key lane is the default for distributed builds (`ApiKeyEngine` already exists); stop reusing Claude Code's OAuth client for sign-in; ask Anthropic about approval if subscription login is still wanted | The Agent SDK docs forbid third-party products offering claude.ai login without approval. Our default engine does exactly that (`src/main/engine/oauth.ts:40-53`, `select.ts`) | Partner / legal (1) | A fresh install makes every Fn request through an API key we control or the user supplies; no claude.ai login offered |
| N2 | **Per-request cost telemetry.** Record input/output/cached tokens per Fn call in `bench.jsonl` (lengths only, as today) | Unit economics rest on prompt-size estimates. Token usage is recorded nowhere outside the agent loop (PRICING §4) | Margin (1) | `npm run bench:report` prints real $/request and $/user/day |
| N3 | **Notarised Developer ID build + auto-update.** Fix the placeholder `appId` | Today's DMG is ad-hoc signed and can't be handed to anyone (`docs/LOCAL-BUILD.md`; D16). Blocks every outside user | Distribution (2) | A tester downloads, opens and updates without Terminal workarounds |
| N5 | **Read less by default.** `context: 'text'` (no screenshot) as the default; a Settings list of apps Mull must never read (the engine already honours `contextExcluded`, but no screen exposes it) | 0 of 2 interviewees would allow the whole screen; P1 allows selected text only, P2 the active window only on trigger plus app/channel blocking (trace **T1**) | Trust / adoption | Default is text-only; a user can add an app to "never read" from Settings |
| N6 | **One-page data-handling statement**: what is read, what leaves the Mac, retention, training | P2: adoption is gated by company security review and client contracts; wants to know whether data "leaves my laptop, is stored, or is used for training" (**T4**) | Enterprise adoption | Page exists and matches the code (`AI_DISCLOSURE.md` §2 is the draft) |
| N4 | **Onboarding and "no field focused" recovery** | 5 of 26 dictations in our own ledger failed with `no-focused-element`, and 11 were discarded as too short or silent (`evidence/bench-report.txt`). Four permissions to grant (README "Permissions"). Permission drop-off (H6) was not measured in the three user sessions; measure it with the next cohort. | Activation (2) | ≥ 80% of session users reach a first successful dictation unaided |

**Explicitly not now:** the agent loop by default, sending, and new lanes.
None of them matter if nobody outside the team can install and pay.

## Next — with 20–50 beta users (≈ 2–3 months)

| # | Item | Why next (evidence) | Risk retired | Done when |
|---|---|---|---|---|
| X1 | **Willingness-to-pay test.** Paywall the Fn key at $12 with a 400-request allowance; offer Own Key $99; **plus one employer-paid team pilot**; measure conversion | No price point from interviews yet (not asked). P2: "a team license would be easier to justify than paying personally" (**T4**). Needs N1–N3 first | WTP (3) | ≥ 4% Free→Pro in 30 days, or a documented re-price |
| X2 | **Cut Fn routing latency.** Try the classifier on Haiku 4.5, cache its 3.6k-token prompt, keep the rules path | The classifier took median 2.8 s (max 6.6 s) before any work began (`evidence/bench-report.txt`). It is also half the cost per request (PRICING §4) | Retention + margin | Median Fn classify < 1 s with no drop in routing accuracy on the fixture set |
| X3 | **Run the agent-loop go/no-go bar** (`probe:agent`) and decide whether navigation ships in Pro | The bar was written first and never run (1ef272f); `agentLoop` is still off. Opus runs cost up to $1.50 each (`src/shared/agent.ts:626`) | Product scope + margin | A recorded pass/fail and a decision in DECISION_LOG |
| X4 | **Fill the insertion matrix** for the top 12 apps with real users' apps, **and measure name/ID accuracy** on the team's own names | The tables are blank (`docs/INSERTION-MATRIX.md:57`). P2 will quit if names are wrong, and avoids voice for IDs and dates (**T6**) | Reliability | Each app has a recorded strategy and pass rate; name accuracy reported |
| X7 | **Design spike: sending within a budget.** Turn `docs/agent/AGENT-V2.md` §7 into a reviewed design: sending allowed only within a budget granted from the user's own words, destination shown (X6), journalled. Design and threat model only; no build | 2 of 3 users asked for it: P2 posting to a thread with tags, with approval; P3 "auto send… would definitely want to try it" (**T7**) | Product scope vs safety | Design reviewed against the seven safety seams; go/no-go for L1 recorded |
| X6 | **Destination on the preview card**: target app, conversation/thread, people mentioned | P2 needs "which channel, which thread, and which people it will tag" before approving (**T2**) | Trust | Card shows destination for Slack and Mail compose |
| X5 | **Positioning test.** "See the exact change first" vs "faster than typing", aimed at coordination-heavy roles | Preview was the top-valued element for 2 of 2 interviewees; voice-for-everything was not wanted (**T3**, **T5**) | Positioning | A/B click-through or interview preference recorded |

## Later — once people pay and stay

| # | Item | Why later | Gate to start |
|---|---|---|---|
| L1 | **Build sending within a budget** (`docs/agent/AGENT-V2.md` §7) | The largest capability and the largest safety risk; Mull deliberately cannot send today (D3, D6). Demand is now evidenced, 2 of 3 users (T7), so the design moves up to X7 | X7 design passes review; retained users; destination preview (X6) shipped |
| L2 | Working memory across sessions (the "P3" pillar in `docs/REPORT.md`) | Re-explaining context was the #1 friction for 2 of 2 interviewees, and P2's bar is "knowing my team and project context without me re-explaining it every day". Still privacy-heavy, so it waits for N5/N6 | Trust signal from X5; N5/N6 shipped |
| L3 | Teams tier at scale (shared vocabulary, admin, invoicing) | A single team pilot runs in X1 first (T4) | X1 pilot renews |
| L4 | Local-LLM private mode for regulated users | Opens a segment cloud-only rivals can't serve (`docs/REPORT.md` §4) | Demand from interviews / inbound |
| L5 | Windows | Accessibility layer is Mac-only by nature | Mac product-market fit |

---

## What evidence would change this order

- **Interviews say price, not trust, is the blocker:** X1 moves ahead of X2,
  and Own Key becomes the lead offer.
- **Session users fail at permissions more than at dictation:** N4 grows, and
  the onboarding redesign moves ahead of N2.
- **Anthropic approves subscription login for Mull:** N1 shrinks, and the
  COGS model in PRICING §4 changes (the user's plan pays for inference).
- **The agent go/no-go bar fails:** navigation leaves the Pro pitch, and the
  deck stops demoing it.
