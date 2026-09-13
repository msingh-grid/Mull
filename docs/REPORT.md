# Deep Research Report: ThinkWithAlma & What We Should Build

*Prepared 2026-09-13. Supporting research: [01-alma-deep-dive.md](01-alma-deep-dive.md) · [02-competitive-landscape.md](02-competitive-landscape.md) · [03-technical-feasibility.md](03-technical-feasibility.md) · [04-positioning-business-model.md](04-positioning-business-model.md)*

---

## 1. Executive Summary

**Alma** (alma.inc, by Memfold AI Inc. — Peak XV-backed, founded by ex-Microsoft Research / ex-Sarvam AI engineers Vinod Ganesan and Nischith Shadagopan) is a waitlist-gated, free-beta macOS app that positions itself as "an AI-native interface for your computer": hold the Fn key, speak, and it dictates, generatively edits, and voice-prompts wherever your caret is, with optional screen context. It's cloud-processed by policy, but binary inspection shows it also ships on-device ASR (FluidAudio/Parakeet) — a hybrid in practice. It has no press, no reviews, no pricing, and is iterating daily. It competes on vision, not distribution.

**The category is real and crowded** — Wispr Flow leads at a ~$2B valuation, Apple is commoditizing free on-device dictation in macOS 27, and OpenAI/Anthropic own agentic action from above. But **the exact intersection named in our assignment brief — thinking/creation in flow + context continuity + transparent intent-to-action — is unoccupied**, and every major failure in the category (Wispr's trust collapse, Cluely's opacity scandal, Rewind/Limitless's shutdown) points at that intersection as the winning position.

**Recommendation: build "Mull" (working name) — a local-first thinking layer for the Mac.** Not a dictation app that's faster than typing; a voice-native instrument for drafting, sculpting, and acting on ideas anywhere on your computer, with a durable, inspectable working memory and a fully visible intent→action pipeline. Feasible as an 8-week, 2-engineer MVP on proven components.

---

## 2. What We Learned About Alma

**Confirmed (from their site, terms, privacy, and shipped app):**
- Product: real-time voice dictation with generative edits + voice prompting; "Alma acts where your caret is"; push-to-talk = hold Fn.
- Platform: Apple silicon, macOS 14+, menu-bar background app, Sparkle auto-updates from Azure; not in the App Store.
- Architecture: Swift UI layer + Rust core (SQLite + offline outbox/sync, OpenTelemetry GenAI tracing) + on-device ASR binary embedding FluidAudio/Parakeet/Nemotron CoreML models from HuggingFace, with telemetry that compares local vs cloud transcripts. Identity via Clerk, analytics via PostHog.
- Permissions: Microphone declared; Accessibility, Input Monitoring APIs present; ScreenCaptureKit linked (optional screen context is a documented setting); secure-input detection (stops in password fields).
- Privacy: three user-selectable tiers (Full data / Usage-only / Zero retention); providers contractually barred from training; personalization data (spellings, per-app preferences, style notes) stored locally unless synced.
- Business: free waitlisted beta, no payments; Peak XV-led undisclosed seed (Feb 2026); apparent pivot from an earlier "Almanac" AI-workspace product; marketing demos = voice-driven Paint clone (alma.inc/paint) and voice-built Blender scenes.

**Strategic read:** Alma is pre-product-market-fit, well-credentialed, and aimed at exactly the thesis our brief describes ("interface should begin with intent and context, not apps and menus"). Its declared bet is cloud processing; its privacy page is unusually thoughtful. Its weaknesses as an incumbent: no distribution, no trust track record, cloud-by-policy, and no visible answer yet to continuity or transparency as *product surfaces*.

## 3. What We Learned About the Market

1. **Dictation is commoditizing.** Wispr Flow ($15/mo, ~$2B, enterprise push), Aqua ($8/mo, fastest latency), superwhisper (local, $249 lifetime), Willow, Monologue, plus a 20-app long tail racing to free; Apple ships auto-formatted on-device dictation free in macOS 27. Raw accuracy and speed are table stakes.
2. **Everyone is adding the same shallow "context":** per-app tone, personal dictionaries, momentary screenshots. Nobody carries working context across apps and sessions.
3. **The trust crisis is the category's defining event.** Wispr: 2.7/5 Trustpilot, retention-on-by-default scandal, telemetry exposés, "works 60% of the time after payment" threads. Cluely: breach + inflated claims. Users firewall these apps to verify no network traffic. Meanwhile the on-device players (superwhisper 4.9/5) win trust but lose on polish.
4. **The memory layer just reset.** Meta acquired and killed Limitless/Rewind (Dec 2025); Microsoft Recall is distrusted; Screenpipe rebuilds the plumbing open-source but ships no experience. The "what was I working on" slot is vacant.
5. **Pricing converged:** $12–15/mo cloud subscription or $29–249 one-time local. Subscription fatigue for on-device workloads is a loud, documented complaint. Nobody bundles dictation + memory + actions coherently.

## 4. The Product: Mull — a thinking layer for your Mac

*(Working name; alternatives: Continuo, Antiphon. All collision-checked best-effort; trademark clearance pending.)*

**One-liner:** Hold a key and think out loud, anywhere on your Mac. Mull turns rambling into structured writing, edits by conversation, remembers what you're working on, and shows you exactly what it's about to do before it does it.

**Not** "4× faster than typing" (Wispr's commodity claim). **Not** "a new interface to your computer" (Alma's word). Mull is sold as a *thinking instrument*: the space between a voice note and a finished artifact, available at the caret in every app.

### Four product pillars

**P1 — Flow capture (table stakes, done right).** Push-to-talk, on-device streaming ASR (Parakeet/WhisperKit on the Neural Engine, <300ms, offline, zero marginal cost), app-aware formatting, personal dictionary. Audio never leaves the Mac by default — structurally, not by policy toggle.

**P2 — Sculpt mode (the flow differentiator).** A live draft you shape by voice: ramble for 20 minutes, then "tighten the second argument," "move that example up," "make the intro punchier." Generative editing as a creative loop, not a cleanup pass. Works in-place in any app on selected text, or in Mull's own drafting surface for longer sessions that then export anywhere. This is the "thinking and creation in flow" pillar — the use case Aqua abandoned, Lex trapped in a doc, and nobody serves at OS level.

**P3 — Working memory (context continuity).** A local-first, inspectable context store: recent documents and threads (via Accessibility-API capture, OCR fallback), per-project vocabulary, people, open loops. Every dictation and edit arrives *already briefed* — "reply to the thread from this morning" just works. The memory is a visible, searchable timeline the user can open, prune, exclude apps from, and delete — the anti-Recall. Local-first is the permission slip that makes this acceptable; it compounds into the moat.

**P4 — The glass pipeline (transparent intent-to-action).** Every utterance is parsed into a typed intent (`dictate | edit | command`) shown as a chip in a small HUD; edits render as streamed word-level diffs previewed before or as they apply; every action lands in an append-only, locally-stored journal (before/after, app, intent, model) with one-keystroke undo. Voice commands v1 are a whitelisted verb set (open, switch, click named element, key chord, run Shortcut) — auditable AX-tree actions, not screenshot agents. Trust as UI, not as a privacy-policy paragraph. This is the direct answer to the category's documented trust crisis and to agent opacity.

### How Mull differs from Alma

| Dimension | Alma | Mull |
|---|---|---|
| Processing | "Processing happens in Alma's cloud" (by policy); hybrid ASR in practice | Local-first ASR + memory; cloud LLM only for reasoning, zero-retention, user-visible per request |
| Trust model | Privacy-policy tiers | Trust as UI: intent chip, diff preview, undo journal, inspectable memory |
| Context | Optional momentary window text | Durable cross-app, cross-session working memory, user-ownable |
| Framing | "New interface to your computer" (input/control) | "Thinking layer" (creation/cognition) |
| Business | Free waitlist beta, undisclosed plans | Honest hybrid pricing from day one (below) |

### Pricing

- **Free:** unlimited local dictation + journal (structurally free for us — it's the user's silicon). Undercuts every metered free tier; seeds trust and distribution.
- **Pro — $10/mo or $96/yr:** Sculpt mode, working memory, cloud reasoning (Claude Haiku 4.5 class, zero-retention), commands.
- **Believer — $179 one-time:** everything, bring-your-own-API-key for cloud reasoning. Directly weaponizes documented subscription fatigue; superwhisper proved the lifetime tier works.
- Later: Teams ($12/seat) with shared vocabulary; regulated-industry edition (fully local mode) — cloud-only competitors are banned there.

### Architecture & MVP (detail in 03-technical-feasibility.md)

Native Swift/SwiftUI menu-bar app (no Electron), Developer ID + notarized + Sparkle (App Sandbox blocks the Accessibility API, so no App Store — category norm). FluidAudio/Parakeet or WhisperKit for ASR; tiered insertion engine (AX write → pasteboard swap → CGEvent typing) with a per-app strategy table; Claude Haiku 4.5 streamed with strict structured outputs for edits/intent parsing; SQLite (GRDB) for journal + memory; secure-input guard.

**8-week, 2-engineer MVP:** Weeks 1–2 shell + permissions onboarding + streaming dictation + insertion for top 15 apps. Weeks 3–4 context service + app-adaptive formatting + dictionary + latency hardening (<1s end-of-utterance to inserted text). Weeks 5–6 Sculpt mode (selection edits with diff preview + undo journal) + intent router. Weeks 7–8 commands v1 + journal timeline + notarized distribution. Post-MVP: OCR/semantic memory index, local-LLM private mode, SpeechAnalyzer backend, Windows.

### Top risks

1. **Insertion reliability in Electron/browsers** — ongoing per-app maintenance; mitigated by the tiered engine (this is the category's shared tax).
2. **Permission onboarding drop-off** (Mic + Accessibility, later Screen Recording) — invest in a guided, self-diagnosing flow.
3. **Apple commoditization from below** — mitigated by living above transcription (sculpting, memory, actions).
4. **Wispr/Alma adding memory from above** — mitigated because cloud-first vendors face user resistance to granting deep context; local-first is our structural advantage.
5. **Sculpt-mode quality bar** — the "thinking partner" promise dies if edits mangle meaning; strict diffs + trivial undo make failures cheap while quality matures.

## 5. Why This Wins

Every incumbent optimizes the *output of finished text* and hides the machinery. The evidence — Wispr's trust gap, the loudest unmet wish being real context, the vacated memory slot, subscription fatigue, and the willingness to pay for thinking tools (Lex, AudioPen, Voicenotes) — all points one direction: the durable position is **the trustworthy instrument for thinking out loud**, where continuity makes it smarter every week and transparency makes it safe to depend on. Alma has the same destination but chose cloud-by-default and hasn't shipped trust or memory as product surfaces. That's our opening.
