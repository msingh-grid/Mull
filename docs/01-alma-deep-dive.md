# Alma (alma.inc) — Product Research Report

*Research date: 2026-09-13. Sources: alma.inc pages, public appcast + downloadable DMG (binary inspection), corporate registries, press.*

## What Alma Is

- **Alma** is "an AI-native interface for your computer" — a macOS app built around the thesis that "the interface should begin with intent and context, not with apps and menus" ([alma.inc](https://alma.inc/), homepage copy pulled from raw HTML).
- Per its own Terms: "Alma is a new interface to your computer. Today it supports real time voice dictation with generative edits, voice prompting, and the surrounding features that make those work well… Alma is under active development. What it does at the date above is not a fixed list" ([alma.inc/terms/](https://alma.inc/terms/), last updated 7 September 2026).
- Made by **Memfold AI Inc.**, a Delaware corporation d/b/a Alma, 2261 Market Street STE 85610, San Francisco, CA 94114; contact support@memfold.ai ([terms](https://alma.inc/terms/), [privacy](https://alma.inc/privacy/)). memfold.ai 301-redirects to alma.inc (verified via curl).
- Public marketing demos (X accounts [@alma_inc](https://x.com/alma_inc), [@thinkwithalma](https://x.com/thinkwithalma)) show voice-driven painting ("you talk, Alma paints") and computer-use demos such as building a rocket in Blender by voice (surfaced via web search snippets; posts not directly readable).
- **Alma Paint** ([alma.inc/paint/](https://alma.inc/paint/), served from games.alma.inc) is a public web demo: a faithful Windows-XP-era MS Paint clone driven entirely by voice — og:description: "Paint by talking. No mouse, no menus." It has Google sign-in, a time/credits meter, a hidden "Buy more credits" button wired to `/api/checkout` (Stripe strings present), share-to-X, a gallery (`/api/artworks`), PNG export, and streams mic audio over a WebSocket to `wss://games.alma.inc/stt`, with LLM calls to `/api/llm` (all extracted from the deployed JS bundle `main-5Rn6dihv.js`).

## Confirmed Features

From the Terms/Privacy ([terms](https://alma.inc/terms/), [privacy](https://alma.inc/privacy/)):
- Real-time **voice dictation with generative edits** and **voice prompting**; "Alma acts where your caret is."
- Push-to-talk: the shipped app's mic usage string is *"Alma listens while you hold the dictation key and types what you say."*; binary strings show the hotkey is **holding the Fn key** ("hold fn and say anything") (extracted from Alma-1.0.34.dmg, `alma-helper` binary).
- **Optional screen context**: "Alma reads text from the window you are working in so that dictation and formatting come out better, for example by recognising names and specialised terms" — toggleable in Settings ([privacy §4](https://alma.inc/privacy/)).
- **Personalization ("what Alma learns for you")**: history, learned spellings, per-app preferences, formatting habits, style notes, snippets — individually deletable, stored locally unless Full-data sync is chosen ([privacy §4](https://alma.inc/privacy/)).
- **Password-field safety**: "Alma stops entirely while a secure input field is focused"; keystroke logging is counts-only ("it records that a key went down, never which key"); no voiceprints/biometrics ([privacy §5](https://alma.inc/privacy/)).
- Accounts via emailed code or **Sign in with Google**; device registration/management in Settings ([terms §3](https://alma.inc/terms/)).
- **Auto-updates** (Sparkle; can disable checks), verified before install ([terms §5](https://alma.inc/terms/)); beta/experimental feature labels and a private program with confidentiality ([terms §11](https://alma.inc/terms/)).
- Requirements: **Apple silicon Mac, macOS 14+**; "Processing happens in Alma's cloud" ([terms §1](https://alma.inc/terms/)). The appcast confirms `minimumSystemVersion 14.0`, `hardwareRequirements arm64`.

## Inferred Architecture & Permissions

*From direct inspection of the publicly downloadable app (Alma-1.0.34.dmg from the public appcast at https://alma.inc/download/appcast.xml) and the paint demo's JS — factual observations of shipped code; interpretations are inference.*

**App composition (confirmed observations):**
- Menu-bar/background app (`LSUIElement=true`), bundle id `ai.almaapp.helper`, v1.0.34 (Sep 12, 2026), ~12 MB DMG, three arm64 binaries: `alma-helper` (Swift UI/OS layer), `alma-core` (Rust — OpenTelemetry GenAI spans `ai.client.inference`, `ai.provider.name`, `ai.request.model`; local SQLite stores `alma.sqlite` + `outbox.sqlite`, i.e., an offline outbox/sync pattern), `alma-asr` (on-device speech).
- **Code-signed "Developer ID Application: Vinod Ganesan (JXN4226TT8)"** — the founder personally, not a company cert yet. Copyright string reads "© 2026 The Alma project. MIT License."
- **On-device ASR is real, not just cloud**: `alma-asr` embeds the open-source **FluidAudio** Swift framework with CoreML models downloaded from **HuggingFace**: NVIDIA **Parakeet** (streaming + EOU endpointing) and **Nemotron** multilingual streaming ASR, Paraformer, **Sortformer streaming diarization**, **Kokoro** TTS (ANE), and a `cohere-transcribe-03-2026-coreml/q8` model. Inference: Alma runs hybrid local+cloud STT — `alma-core` telemetry keys `alma.stt.comparison.agree/word/outcome` suggest it compares local vs. cloud transcripts.
- **Per-app context handling**: an embedded bundle-ID list — Terminal, Ghostty, VS Code, Chrome, **Claude for Desktop**, Slack, WhatsApp, and `com.almanac.combinedSpace` (their own earlier Almanac app) — presumably apps with tailored caret/context behavior (inference from string list in `alma-core`).
- **Cloud stack (confirmed strings)**: identity = **Clerk**; analytics = **PostHog** (US+EU hosts; also on the website with Cookiebot consent gating + Google Tag Manager); distribution = **Sparkle** updates from **Azure Blob Storage** (`stalmaotaprodeus2.blob.core.windows.net` — "alma OTA prod East-US-2"; alma.inc/download/ proxies to Azure per `x-ms-request-id` headers). The privacy policy names only *categories* of subprocessors, no vendors ([privacy §10](https://alma.inc/privacy/)). No OpenAI/Anthropic/Deepgram endpoints appear in the binaries; the cloud LLM/STT provider is not identifiable from the client.
- **macOS permissions** (inference from APIs present, plus the one declared usage string):
  - **Microphone** — declared (`NSMicrophoneUsageDescription`, audio-input entitlement). Confirmed.
  - **Accessibility** — `AXIsProcessTrusted(WithOptions)`, full AXUIElement API surface (reading window text, caret-position text insertion). Effectively required; confirmed API presence.
  - **Input Monitoring** — `CGEventTapCreate/Enable` + `IOHIDCheckAccess` (Fn-hold hotkey, key-down counting). Confirmed API presence.
  - **Screen Recording** — `SCShareableContent` (ScreenCaptureKit) + `CGWindowListCopyWindowInfo` are linked, so some screen/window capture capability exists; whether the permission is demanded or optional is inference.
  - Secure-input detection via `IsSecureEventInputEnabled` and a `SecureInputMonitor` class — matches the "stops during password fields" promise. Confirmed.

## Company / Team / Funding

- **US entity**: Memfold AI Inc. (Delaware), SF address above (confirmed, [terms](https://alma.inc/terms/)).
- **India entity**: Memfold AI Private Limited, incorporated **Aug 13, 2025**, Bangalore (J P Nagar), CIN U62099KA2025FTC206587, subsidiary of a foreign company; directors **Malur Narasimha Nischith Shadagopan** and **Vinod Ganesan** ([Tofler](https://www.tofler.in/memfold-ai-private-limited/company/U62099KA2025FTC206587), [Falconebiz](https://www.falconebiz.com/company/MEMFOLD-AI-PRIVATE-LIMITED-U62099KA2025FTC206587)).
- **Founders**: **Vinod Ganesan** ([LinkedIn](https://www.linkedin.com/in/vinod-ganesan-9744b285/), [X @vinodgansan](https://x.com/vinodgansan), [Google Scholar](https://scholar.google.com/citations?user=_qOfuA0AAAAJ&hl=en)) and **Nischith Shadagopan M N** ([LinkedIn](https://www.linkedin.com/in/nischiths/), [Scholar](https://scholar.google.com/citations?hl=en&user=QHyP32wAAAAJ)). Both described as ex-**Microsoft Research** researchers and **founding engineers/members of Sarvam AI** ([Indian Startup Times](https://www.indianstartuptimes.com/investment/peak-xv-backs-five-ai-startups-at-india-ai-impact-summit-2026/), [Newspatrolling](https://newspatrolling.com/peak-xv-invests-in-five-companies-shaping-consumer-and-enterprise-use-of-ai-in-india/)). The Developer ID signature in Vinod Ganesan's name independently corroborates his role.
- **Funding**: **Peak XV Partners** led an undisclosed **seed round** (Tracxn dates it Feb 18, 2026), announced when Peak XV backed five AI startups at the **Impact AI PitchFest / India AI Impact Summit, Feb 17, 2026** ([Entrackr](https://entrackr.com/snippets/peak-xv-invests-in-five-early-stage-ai-companies-at-impact-ai-pitchfest-11122187), [Entrepreneur India](https://india.entrepreneur.com/news-and-trends/five-ai-startups-secure-peak-xv-support-to-build/502888), [Tracxn](https://tracxn.com/d/companies/memfold/__VZQ-UDCxnB-TnDdgwUBVIlUHteHkUJsOy_4mWbva9z4)). Amount not disclosed.
- **Product history / pivot (inference, well-supported)**: Memfold's product at funding time was described as "AI-native workspaces… flagship product **Almanac** unifying research and document creation" — Alma's own LinkedIn link on the homepage is `tryalmanac`, and the bundle ID `com.almanac.combinedSpace` appears inside the shipped binary. Alma appears to be the evolution/rebrand of Almanac toward a voice-first computer interface. One press snippet also describes Memfold as "designing an interface for agents to use computers on behalf of users."
- Socials: X [@alma_inc](https://x.com/alma_inc) and [@thinkwithalma](https://x.com/thinkwithalma), Instagram @thinkwithalma, LinkedIn "tryalmanac".

## Data & Privacy Practices

(All confirmed from [alma.inc/privacy/](https://alma.inc/privacy/), last updated 7 Sep 2026.)
- **Three user-selectable data settings**: (1) **Full data** — voice, transcripts, history, learned data sync to cloud, usable to improve Alma, 12-month retention; (2) **Usage data** — numbers only (counts/timings/outcomes/error types), content stays on the Mac; (3) **Zero data retention** — requests processed then discarded, nothing stored server-side.
- "Whichever setting you choose, our providers are contractually barred from training on your content and from retaining it beyond answering your request."
- Never collected: keystroke identity, password-field content, voiceprints. No ads, no sale of personal info, no cross-context behavioral ad sharing; honors GPC/DNT.
- Retention: synced content/diagnostics up to 12 months; support messages up to 3 years; account records for account life.
- GDPR/UK GDPR with SCCs + UK Addendum; CCPA rights; **18+ minimum age worldwide**.
- Subprocessor **categories only** (identity/auth, cloud hosting+storage, speech & language processing, analytics, software distribution, email/support) — no vendor names in the policy (binary inspection identifies Clerk, PostHog, Azure, HuggingFace).
- Website telemetry: PostHog **with session recording** (inputs masked), gated behind Cookiebot statistics consent; GTM.

## Pricing / Availability

- **Free, waitlist-gated beta.** "There is no charge for Alma… We do not sell subscriptions… we collect no payment or billing details"; free hosted use is metered against a non-transferable allowance with quotas/rate limits; paid plans would require prior consent and a third-party payment processor ([terms §4](https://alma.inc/terms/)). Free accounts can be terminated after 12 months of inactivity; liability cap $100.
- Homepage is a single email-capture waitlist ([alma.inc](https://alma.inc/)).
- The app is live and iterating fast: public appcast shows releases 1.0.32 → 1.0.34 within Sep 11–12, 2026, plus a `canary` channel (confirmed, appcast.xml).
- The Paint demo has time-metered credits with a currently dormant Stripe checkout ("Payments not set up yet" string in the JS) — inference: monetization scaffolding, not active.

## Gaps (could not be confirmed)

- **Cloud STT/LLM vendor(s)**: no provider endpoints or model names in binaries; policy lists categories only.
- **Funding amount and valuation** (undisclosed; Tracxn masks it).
- **Team size / hiring**: no careers, jobs, blog, docs, or about pages on alma.inc (all 404); no job posts found.
- **No press coverage of Alma itself** (TechCrunch's "Alma" articles are the unrelated immigration-law startup tryalma.ai). No HN threads, no Product Hunt launch, no independent user reviews or demo videos found.
- **Exact permission prompts at runtime** (which of Accessibility/Input Monitoring/Screen Recording are mandatory vs. optional).
- Contents of @alma_inc / @thinkwithalma posts (X not directly fetchable; only search-snippet evidence for the paint and Blender demos).
