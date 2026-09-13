# Positioning & Business Model Research

*Research date: 2026-09-13. Alma (alma.inc) is pre-launch/waitlist, no public pricing.*

## 1. Pricing Landscape

| Product | Free tier | Monthly | Annual (eff./mo) | Lifetime / one-time | Team / Enterprise | Notes |
|---|---|---|---|---|---|---|
| **Wispr Flow** | 2,000 words/wk | $15 | $12/mo | — | Teams $10–12/user/mo; Enterprise (SOC 2, HIPAA, ZDR, SSO) | Raised price to $15 Aug 2026 |
| **superwhisper** | Unlimited small **local** models | $8.49 | ~$7.08/mo | **$249.99** | — | One license Mac+Win+iOS |
| **Aqua Voice** | 1,000 words **once, ever** | $10 ($8 annual) | $96/yr | — | Team $12/user/mo | Max tier $24/mo (Realtime Mode) |
| **Willow** | 2,000 words/wk | $15 | $12/mo | — | Team $12/user/mo | Unlimited "Willow Scribe" on paid |
| **MacWhisper** | Free (smaller models) | — | — | **€59** / $99.99 App Store | — | Pro unlocks Large-v3, batch, diarization |
| **Raycast AI** | Free launcher | Pro $10/mo (credits); Max $50/mo | $8/mo | — | Teams ~$12/user/mo | Usage-based credits since Sept 2026 |
| **Limitless** | (was) 20 hrs/mo | (was) $19/mo | — | — | — | **Acquired by Meta Dec 2025**; "AI memory" slot now open |

**Adjacent (tools-for-thought):** Granola free (25 notes) → $14/user/mo → Enterprise $35; AudioPen free → Prime $75–99/yr; Voicenotes ~$99.99/yr; Cleft Plus $6.99/mo or $39.99/yr; Lex $16/mo or $145/yr.

**Read of the market:** Cloud-dictation subscriptions converged on **$12–15/mo individual, $10–12/seat team, free tier ~2,000 words/wk**. Local-first tools monetize via **one-time purchases ($29–$249)**. Nobody credibly bundles "dictation + memory + actions" at one price yet.

## 2. User Sentiment Themes

**Love:** speed/flow ("4x faster than your keyboard", "voicepilling"); cleanup beyond transcription (filler removal, tone); surprise at how fast local models are ([HN](https://news.ycombinator.com/item?id=45923352)).

**Hate:**
1. **Subscription resentment for on-device work.** "Whisper runs fine locally. So why are Willow ($144/year), Wisprflow ($120/year)… all subscriptions?" ([HN](https://news.ycombinator.com/item?id=45923352)).
2. **Privacy / trust collapse around cloud dictation.** Wispr Flow: audio routed through OpenAI/Meta subprocessors, retention on by default, staff posting word-frequency analyses of user dictations, ~1,183 analytics events across four telemetry services, forensic write-up of silent keyboard interception ([Wensen Wu investigation](https://www.wensenwu.com/thoughts/wispr-flow-investigation), [privacy audit](https://weesperneonflow.ai/en/blog/2026-05-21-dictation-app-privacy-audit-data-security-2026/)). Wispr at **2.7/5 Trustpilot** vs superwhisper's 4.9/5 Product Hunt. HN users literally firewall these apps.
3. **Setup complexity vs. polish trade-off.** superwhisper for privacy/power users, Wispr for polish — nobody offers both.
4. **Context-awareness is the open wish** — custom dictionaries, app-aware tone, mode-per-app are marketed precisely because users keep asking; all current "context" is shallow (active-app detection + word lists), not *what you've been working on*.
5. **Battery/latency for real-time local** — streaming-native local models are still a differentiating engineering problem.

## 3. Tools-for-Thought Adjacency

- **Lex** ($16/mo): "AI should help you think better, not replace your thinking" — thinking-partner framing has an audience; text-only and doc-bound.
- **iA Writer**: focus/anti-slop positioning; one-time purchase; aesthetic benchmark for "writing as thinking."
- **Granola**: ambient capture → structured artifact winning a category at $14/seat.
- **AudioPen** ($75–99/yr, 200k+ users): voice notes → polished text; durable solo-dev traction.
- **Voicenotes** (~$99/yr): "ask your past self" — notes as queryable memory; 100k users by Oct 2024.
- **Cleft** ($39.99/yr): voice → structured Markdown, "your voice never leaves your phone."

**Gap:** these all *end* at a note or doc; dictation tools *end* at inserted text. Nobody connects "ramble → structured thought" with "then act on it across my apps, with ongoing context." That connective tissue is unowned.

## 4. Recommended Wedges

**Wedge 1 — Trust architecture: local-first + visible, undoable actions (strongest).** Wispr's 2.7 Trustpilot, retention scandal, telemetry exposé; Cleft/Sotto winning attention on "audio never leaves the device"; superwhisper's free-local tier is its moat. Alma is cloud-only per its terms, so this is a direct structural counter. Go beyond "local Whisper" (commoditized): the differentiator is **transparent intent-to-action** — every AI edit/action shown as a diff, previewed, one-keystroke undo, full local audit log. Nobody treats *trust as UI* rather than a privacy-policy paragraph. Also unlocks buy-once/hybrid pricing against subscription fatigue.

**Wedge 2 — Cross-app working memory ("it knows what I'm working on").** Context-awareness is the loudest unmet wish; current "context" is shallow; Limitless was acquired and pulled Dec 2025, vacating the slot; Granola proved ambient context sells. A local, on-device working memory (recent docs, vocabulary, people, threads) that makes every dictation and command *already briefed* compounds over time and can't be trivially cloned by a cloud vendor whose users won't grant that data. Local-first (Wedge 1) is the *permission slip* for this wedge.

**Wedge 3 — "Thinking partner" framing vs. "typing replacement" (positioning).** Every competitor sells "4x faster than typing" — a speed commodity with converged pricing. Lex/AudioPen/Voicenotes show real willingness to pay for *thinking out loud → structured thought*, but they're trapped in note-app silos. Position as the flow-state tool: ramble at the OS level, get back structure, drafts, and next actions anywhere.

**De-prioritize:** competing on raw accuracy/latency (table stakes) and hardware (Limitless's fate; Meta owns that path).

## 5. Naming & Category Framing

Incumbent framings: "effortless voice dictation" (Wispr), "voice-first workflows," "a new operating system for work," "AI-native interface for your computer" (Alma), "personalized AI memory" (Limitless). The vacant, ownable frame: **"a thinking layer for your computer"** or **"working memory for your Mac"** — deliberately not "dictation" (commodity) and not "interface" (Alma's word).

| Name | Rationale | Collision check (best-effort, 2026-09-13) |
|---|---|---|
| **Mull** | "Mull it over" — thinking out loud; short, ownable verb | No voice/AI product found — cleanest |
| **Continuo** | The continuous line under the melody — context continuity made literal | No app/startup found |
| **Antiphon** | Call-and-response — voice dialogue with a partner | Only an art installation found |
| **Sounding** | "Sounding board" + taking soundings (depth) | No app/startup found |
| Unspool | — | **Taken** (voice journaling app); avoid |
| Sotto | — | **Taken twice**; avoid |
| Murmur | — | **Heavily taken** (5+ products); avoid |

**Top three: Mull, Continuo, Antiphon.** Full trademark/domain clearance still required.

## TL;DR strategy
The category converged on $12–15/mo cloud dictation sold as "faster than typing," and its leader has a documented trust problem. Enter as the **local-first thinking partner with cross-app working memory**, make every AI action **visible and undoable** (trust as UI, not policy), price with a **buy-once or hybrid option**, and name/frame it around thinking rather than input.
