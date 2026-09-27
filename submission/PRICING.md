# Pricing and go-to-market

Owner: Saaketh Koduri (Sales) · Status: **agreed by the team, 26 Sep 2026**.
Evidence: two users who tried the prototype and were interviewed on 25 Sep
([research/](research/)). Nothing below is a measured customer number unless
it cites one.

---

## 1 · What we learned that forced a re-price

The original pricing in [`docs/REPORT.md`](../docs/REPORT.md) §4 (13 Sep, desk
research) was **Free / Pro $10 mo / Believer $179 one-time**, with Pro
"including cloud reasoning". Two facts found since make that package
unworkable as written:

1. **We cannot ship "sign in with your Claude subscription" commercially.**
   Mull's default engine today is the user's own Claude subscription through
   the Agent SDK (`src/main/engine/oauth.ts`, `select.ts`). Anthropic's Agent SDK
   documentation states: *"Unless previously approved, Anthropic does not allow
   third party developers to offer claude.ai login or rate limits for their
   products, including agents built on the Claude Agent SDK."*
   ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
   checked 26 Sep 2026). Our 13 Sep architecture doc assumed that "each user
   logs into *their own* Claude account is the sanctioned shape" and already
   said a commercial launch needs BYOK or our own API billing
   (`docs/05-electron-architecture.md` §3 caveat 1); the published policy is
   stricter than that assumption. The subscription lane is fine for our own
   dogfooding; it is not a business. A paid product must use an API key: **ours** (we pay per token)
   or **the customer's** (BYOK).
2. **Cloud reasoning is not free for us, and Pro at $10 is underwater for a
   heavy user.** See §4: at our default model a heavy user costs ~$10/month in
   tokens alone.

## 2 · Packaging (proposed)

| Tier | Price | What's in it | Who it's for | Why this shape |
|---|---|---|---|---|
| **Free** | $0 | Unlimited ⌥Space dictation (on-device whisper.cpp), journal, undo | Anyone trying it | Costs us nothing — it runs on the user's own silicon (`docs/REPORT.md` §4). Undercuts every metered free tier (Wispr 2,000 words/wk, Aqua 1,000 words once: `docs/04-positioning-business-model.md` §1) |
| **Pro** | **$12 / month** or $120 / year | Fn requests (edit, compose, ask, navigate) on **our** API key, **400 requests / month included**, then a soft cap (slows to Haiku) | Individuals who want the "thinking layer", not just dictation | Sits in the converged $12–15 band; allowance keeps worst-case COGS bounded (§4) |
| **Own Key** | **$99 one-time** | Everything in Pro, unlimited, on the customer's own Anthropic API key | Developers and subscription-fatigued power users | Directly answers the "why a subscription for on-device work" complaint (`docs/04…` §2.1). Zero COGS for us, so a one-time price is safe |
| Team pilot (next) | $15 / seat / month, employer-invoiced | Pro + shared vocabulary, admin, "never read" app list managed centrally, data-handling statement | A team whose manager pays | P2: "a team license would be easier to justify than paying personally", and adoption goes through company security review ([research/USER_TRACES.md](research/USER_TRACES.md) T4). One pilot in ROADMAP X1 before a full Teams tier |

**Price metric:** per user per month for managed AI, with an included request
allowance; one-time licence where the customer pays their own inference.
A "request" = one Fn press that reaches a model. ⌥Space dictation is never
metered, because it never touches a model (`README.md` "The two keys").

## 3 · Willingness-to-pay evidence

| Source | What it says | Strength |
|---|---|---|
| Market pricing (desk, 13 Sep) | Cloud dictation converged on **$12–15/mo**; local tools sell **$29–249 one-time**; superwhisper lifetime $249.99, MacWhisper €59 (`docs/04…` §1) | Secondary — what others charge, not what our users pay |
| Market sentiment (desk) | Loud subscription resentment for on-device work; Wispr Flow 2.7/5 Trustpilot on privacy (`docs/04…` §2) | Secondary |
| Interviews P1, P2 (Q15) | **No price was asked**, so there is no dollar figure. Value is framed as time saved: P1 "if it helps save time and reduces the effort involved in repetitive tasks"; P2 would use it daily if it saved "45 minutes to an hour a day". P2: "a team license would be easier to justify than paying personally" | **Primary, qualitative** — WTP in dollars still unmeasured (`research/INTERVIEWS.md`) |
| Interviews P2 (Q14) | Stated use: 10+ short messages a day (⌥Space, free), 1–2 summaries and several replies a day (Fn) | Primary, n = 1 — informs the usage row in §4 |
| Third user P3 (27 Sep) | No price asked; values dictation for long emails, Slack messages and prompts ("would save a lot of time") | Primary, qualitative |
| Buyer / approver interview | **Not yet run.** Script ready with price questions ([BUYER_INTERVIEW_SCRIPT](research/BUYER_INTERVIEW_SCRIPT.md) Q7–Q8). It is the next step for a dollar WTP figure | — |

> If interview WTP comes in below $12, the fix is the allowance (fewer included
> requests at $8), not dropping the price below COGS. If most participants
> prefer one-time, Own Key becomes the lead offer.

## 4 · Unit economics (assumptions, labelled)

**Token prices** (Anthropic API list, per million tokens): Sonnet 5 $2 in /
$10 out; Haiku 4.5 $1 / $5; Opus 5 $5 / $25; cached input reads ≈ 0.1× input.

**Prompt sizes, measured from the code** (26 Sep, chars ÷ 4):

| Call | System prompt | Model (default) | Source |
|---|---|---|---|
| Classifier (every Fn press) | ~3,570 tokens | Sonnet 5 | `src/main/engine/classify.ts:58` |
| Edit / compose / answer | ~380 / 450 / 600 tokens | Sonnet 5 (`editModel` default) | `src/main/engine/prompts.ts`, `src/shared/settings.ts` |
| Agent loop (off by default) | ~3,280 tokens, up to 40 turns | Opus 5, capped at **$1.50/run** | `src/shared/agent.ts:617,626` |

**Cost per Fn request (estimate).** Classifier: 3.6k system + ~1k context in,
~50 out. Lane call: ~0.5k system + ~3k screen context in, ~300 out.

| | Uncached | System prompts cached |
|---|---|---|
| Classifier | ~$0.0097 | ~$0.0032 |
| Lane call | ~$0.0100 | ~$0.0093 |
| **Per request** | **~$0.020** | **~$0.013** |

**Per user per month** (assumption: working days = 22):

| Usage (Fn requests / workday) | Requests / month | COGS @ $0.013 | vs Pro $12 (after ~30% store/payment fees → ~$8.40 net) |
|---|---|---|---|
| Light — 5 | 110 | $1.43 | 83% gross margin |
| Typical — 15 (P2's stated Fn-type use: 1–2 summaries + several replies ≈ 5–10; heavier if summaries take several turns — measure in sessions) | 330 | $4.29 | 49% |
| Heavy — 30 | 660 | $8.58 | **~0% — underwater without the 400 cap** |
| 400 cap reached | 400 | $5.20 | 38% floor |

Levers if margins are thin, cheapest first: cache the classifier prompt
(already done on the API-key lane: `cache_control: ephemeral`, `CLAUDE.md`
"Engine selection"); move the classifier to Haiku 4.5 (routes to one of four
words — `settings.routing` exists for this); skip the classifier on the
"rules" path. The agent lane stays off in Pro until its per-run cost is
measured (`npm run bench:engine`).

**Fixed costs** (first year, assumptions): Apple Developer Program $99/yr
(required to notarise and distribute — `docs/LOCAL-BUILD.md`); code-signing
and a download host; no servers — Mull has no backend, the journal is local
SQLite.

## 5 · Rejected alternative — pure usage credits

**Rejected: credits / pay-per-request (the Raycast AI model).** This was our own
first idea: at the 16 Sep team meeting we proposed pricing by token usage or
tool calls. It matches our costs exactly and can never go underwater, but:

- it meters the *thinking* — the thing we want people to do more of — and
  makes every Fn press feel like spending money;
- it is the opposite of the trust story: the category's loudest complaint is
  about surprise charges and opaque metering (`docs/04…` §2);
- the allowance in Pro gets 90% of the cost protection with a flat price.

Also rejected: **the $179 lifetime licence that includes cloud AI** from the
original plan — it is an unbounded liability: every token a lifetime customer
ever uses is paid by us, for ever.

## 6 · Go-to-market (first 90 days after launch)

- **Channel:** direct download from our site (Mac apps using Accessibility
  cannot be sandboxed, so no Mac App Store — `docs/REPORT.md` §4). Launch on
  Hacker News / Product Hunt, where the privacy-audit threads about competitors
  already live (`docs/04…` §2).
- **Positioning line:** *"Voice that shows its work."* Lead with the exact
  change, shown before anything happens: the top-valued element for 2 of 2
  interviewees (T3). The journal, undo and local audio support the line;
  they are not the headline.
- **Beachhead (revised after users):** managers on Apple silicon who write a
  lot (delivery, project and product managers, team leads) and already use AI
  daily in Slack, email and prompts. 2 of 3 users fit and valued voice for
  exactly that (T5, T8). The original guess, people who had "tried and
  dropped" dictation, was not supported.
- **Pipeline:** P2 said they would "recommend it to other [delivery managers]"
  if it saved 45–60 minutes a day. That is one warm lead for a team pilot,
  conditional on security review. A second lead: the product-company manager (P3) "would definitely want to try" a send feature if built. Neither is a paid commitment yet.
- **Conversion goal to test:** Free → Pro ≥ 4% within 30 days (typical
  freemium consumer range; an assumption to beat, not a forecast).
