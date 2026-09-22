# Feasibility Study: System-Wide Voice + AI Layer for macOS

*Real-time dictation, voice-driven generative edits, voice commands in any app, persistent context, transparent intent→action. Reference incumbent: Alma (alma.inc) — cloud-processed, Apple Silicon, macOS 14+.*

**Bottom line: feasible with today's components.** The hard part is not ASR or the LLM — both are commoditized in 2025/26. The hard parts are (a) reliable text insertion/reading across hostile apps (Electron, browsers, terminals), (b) permission UX and distribution constraints, and (c) making the intent→action layer trustworthy.

---

## 1. Speech-to-Text Options

### On-device

| Option | What it is | Latency / speed | Accuracy | Streaming | Cost |
|---|---|---|---|---|---|
| **WhisperKit** (Argmax, Swift/CoreML, MIT) | Whisper family compiled for the Apple Neural Engine | Real-time streaming; ~0.46 s mean per-word hypothesis latency; sub-100 ms decode steps | ~2.2% WER with optimized large-v3-turbo (ICML 2025 paper) | Yes — true streaming with partials | Free (user's Mac) |
| **NVIDIA Parakeet TDT 0.6B v2/v3** via **parakeet-mlx** or **FluidAudio** (Swift/CoreML, MIT) | Best open non-Whisper ASR; v3 = 25 languages, ~2.3 GB (v2 English ~600 MB) | ~32–110× real-time on M-series via CoreML/ANE; apps quote ~80 ms perceived latency | Tops open ASR leaderboards for English; beats Whisper-large on dictation audio | Chunked/streaming implementations exist | Free |
| **whisper.cpp** (MIT) | Battle-tested C++ Whisper runtime | Fast, but streaming is DIY (sliding-window re-decode; partials flicker) | Whisper-class | Pseudo-streaming | Free |
| **Apple SpeechAnalyzer / SpeechTranscriber** (macOS 26+) | New first-party Speech API, replaces SFSpeechRecognizer; runs on ANE | Extremely fast batch (34-min file in 45 s); live transcription with volatile + finalized results | Comparable to Whisper-class in press tests | Yes — native AsyncSequence of volatile/final results | Free, zero bundle weight |

Notes: SpeechAnalyzer is macOS 26-only — targeting macOS 14+ requires a bundled engine (WhisperKit or FluidAudio/Parakeet), preferring SpeechAnalyzer when available. Old SFSpeechRecognizer has ~1-minute session limits and mediocre on-device quality. Diarization barely matters for near-field dictation (FluidAudio ships a pipeline if needed).

### Cloud streaming

| Provider | Streaming price | Latency | Notes | Partials | Diarization |
|---|---|---|---|---|---|
| **Deepgram Nova-3** | ~$0.0077/min (~$0.46/hr) | Sub-300 ms | Claimed 5.26% WER (real-world 7–10%); keyterm prompting | Yes | Yes |
| **AssemblyAI Universal-Streaming** | $0.15/hr — billed on **session duration** (idle counts!) | ~300 ms word emission | Best diarization; immutable partials (nice for UI) | Yes | Yes |
| **OpenAI gpt-4o-transcribe / Realtime** | $0.006/min file; realtime ~$0.017/min (~$1/hr) | Good; heavier session | Strong on accents; no diarization | Realtime yes | No |
| **Groq Whisper large-v3-turbo** | $0.04/hr (batch) | Not streaming — chunk-and-post; 228× real-time makes ~1–2 s chunked viable | Whisper-class | Simulated | No |

Session-duration billing (AssemblyAI) is a trap for an always-listening layer. Per-audio-minute billing (Deepgram) fits push-to-talk better.

**Recommendation:** **On-device-first**: FluidAudio/Parakeet v3 (MIT, Swift-native, ANE) or WhisperKit as default engine, SpeechAnalyzer opportunistically on macOS 26+, Deepgram Nova-3 as optional cloud tier. ~Zero marginal cost, offline, <300 ms latency, and a privacy story cloud vendors can't match. This inverts Alma's cloud-processing choice.

## 2. Text Insertion & Editing on macOS

No single reliable mechanism — shipping apps use a **tiered strategy with a per-app compatibility table**:

- **Tier 1 — Accessibility API (AXUIElement).** `AXUIElementCreateSystemWide()` → `kAXFocusedUIElementAttribute` → write via `kAXSelectedTextAttribute` (inserts at caret/replaces selection). Reading: `kAXValueAttribute`, `kAXSelectedTextAttribute`, `kAXSelectedTextRangeAttribute` → grab surrounding context via `kAXStringForRangeParameterizedAttribute`. Clean, no clipboard disturbance; works in native apps.
- **Tier 2 — Pasteboard swap.** Save `NSPasteboard` + `changeCount`, write text (mark `org.nspasteboard.TransientType`), synthesize ⌘V via CGEvent, restore after ~100–300 ms. Works almost everywhere incl. terminals and Electron. Downsides: clipboard-manager races, apps intercepting ⌘V, paste-completion heuristics.
- **Tier 3 — CGEvent keyboard synthesis.** `CGEventKeyboardSetUnicodeString` "types" text (~20 chars/event). Slowest; survives remapped-paste apps. Also the path for navigation/edit keystrokes in voice commands.
- **Tier 4 — Input Method Kit (IMK).** Architecturally "correct" (how CJK input and Apple Dictation insert, with marked-text support) but user must switch input sources, poorly documented, doesn't help reading context. Skip for MVP; reconsider later for flicker-free streaming insertion.

**Hostile apps & workarounds:**
- **Electron/Chromium:** AX tree disabled until you set `AXManualAccessibility` = true; `AXSelectedText` writes buggy ([electron#36337](https://github.com/electron/electron/issues/36337)). Read via AX, insert via paste.
- **Chrome specifically — the line above no longer holds** (measured Chrome 152, Sept 2026). `AXManualAccessibility` is not in Chrome's attribute list at all: the set fails `-25205 kAXErrorAttributeUnsupported`, as does `AXEnhancedUserInterface` (`-25208`), on both the application and the window element. There is **no in-process lever** to wake Chrome's renderer accessibility. A cold Chrome window answers with its own furniture — 119 nodes, 18 targets, no `AXWebArea` — and that is indistinguishable from a small page unless you check for a web document. The user-side remedy is "Native accessibility API support" at `chrome://accessibility`. Electron apps (Slack, Discord, VS Code) still honour `AXManualAccessibility` and are unaffected.
- **Detecting it:** count `AXWebArea`, **not** `AXDOMIdentifier`. Chrome's own toolbar and tab strip are WebUI, so 112 of those 119 nodes carry DOM identifiers — a DOM-identifier test can never tell a cold browser from a live page.
- **Browsers:** contenteditable lies about value/selection; Google Docs handled by paste + keystrokes only.
- **Terminals:** no AX text semantics; paste-only insertion; context from screen text (Terminal.app exposes contents via AX; others need OCR).
- **Secure input:** `EnableSecureEventInput` blocks taps/synthesis — detect via `IsSecureEventInputEnabled()` and visibly disable (Wispr does this).
- **Java/Qt:** spotty AX; paste fallback.

**Generative edits of selected text:** read `AXSelectedText` (fallback: synthesize ⌘C into swapped pasteboard), send to LLM, replace via AX write (fallback: paste over selection).

## 3. Context Capture

**Cheap signals (Accessibility permission only):** frontmost app (`NSWorkspace`, no permission), window title (AX `kAXTitleAttribute`), focused element role/value/selection/caret ± surrounding text. This is the primary "what is the user working on" signal.

**Fallback — pixels:** ScreenCaptureKit capture of the focused window + Vision `VNRecognizeTextRequest` OCR (fast, on-device). Needed for Google Docs, terminals, canvases. Screenpipe's architecture is the blueprint: event-driven capture (app switch, click, typing pause), AX-first with OCR fallback, indexed locally into SQLite+FTS.

**Privacy-safe local indexing:** local-only store (SQLite + embeddings), per-app exclusion list, pause control, secure-input auto-pause, send only *retrieved snippets* to the cloud LLM — never the raw archive.

**Permissions matrix:**

| Capability | Permission (TCC) | Prompt behavior |
|---|---|---|
| Audio capture | Microphone | Standard prompt |
| Read AX tree, insert text, hotkeys via AX | **Accessibility** | Manual enable in System Settings; restart-sensitive |
| CGEventTap listen-only | **Input Monitoring** | Manual enable |
| ScreenCaptureKit / OCR | **Screen Recording** | Manual enable; macOS 15+ monthly re-consent for legacy APIs — use SCK + `SCContentSharingPicker` |

**Distribution:** the App Sandbox **blocks the Accessibility API** → **no Mac App Store**. Developer ID signing + notarization + Sparkle updates (how Wispr, VoiceInk, Talon, Raycast, Rewind all ship). Biggest UX risk in the category: the **onboarding permission gauntlet** — budget real design time for a guided flow with live verification.

## 4. LLM Layer: Generative Edits & Intent Parsing

Latency budget ~500 ms–1 s for "rewrite this selection":
- **Cloud small models (recommended default):** **Claude Haiku 4.5** ($1/$5 per MTok, 200K context) — sub-second short edits when streamed; **Claude Sonnet 5** ($3/$15) for the harder agentic-command tier; **GPT-5-mini** ($0.25/$2.00) as cheapest capable option. Techniques matter more than model choice: stream the edited text, prompt-cache stable system/app-profile blocks (~0.1× input price on cache reads), keep prompts tiny (selection + 1–2 KB context), use strict structured outputs so intent parses are guaranteed-valid JSON.
- **Local models (MLX/Ollama):** Qwen3-class 4–9B run 25–35+ tok/s on 16 GB M-series; MLX beats Ollama/llama.cpp 1.5–3×. Viable for a "fully private mode" toggle and cheap utterance classification, not the default edit engine yet (quality + RAM residency).

**Transparent intent→action layer (the differentiator):**
1. **Intent parse as a typed contract:** every utterance → `{mode: dictate|edit|command, target, action, params, confidence}` via strict tool-use. Low confidence → treat as dictation (safe default).
2. **Show parsed intent** in a HUD (non-activating NSPanel) before/while acting.
3. **Preview diff** for destructive edits (word-level old→new); apply on confirm, or auto-apply with a 2–3 s undo window for low-risk edits. Stream the diff.
4. **Undo journal:** append-only local log — timestamp, app, before/after text, insertion method, intent JSON, model + prompt hash. Undo = AX-restore or ⌘Z synthesis. The journal *is* the visible intent-to-action trail; expose it as a searchable timeline.
5. **Voice commands:** whitelisted verb set (open app, switch window, click named AX element, key chord, run Shortcut) — not free-form computer-use. Screenshot-driven agents are too slow/erratic for a flow tool; AX-tree action grounding is faster and auditable.

## 5. Reference Open-Source Projects

| Project | License | Take |
|---|---|---|
| [VoiceInk](https://github.com/Beingpax/VoiceInk) | **GPL v3** | Closest full reference (Swift dictation, per-app Power Mode). Reference architecture only — do not copy code into a proprietary app |
| [WhisperKit](https://github.com/argmaxinc/WhisperKit) | MIT | Production ANE streaming ASR — likely direct dependency |
| [FluidAudio](https://github.com/FluidInference/FluidAudio) | MIT | Parakeet v2/v3 CoreML + VAD + diarization — likely direct dependency (note: Alma itself embeds this) |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | Fallback engine |
| [parakeet-mlx](https://github.com/senstella/parakeet-mlx) | MIT | Prototyping |
| [Screenpipe](https://github.com/screenpipe/screenpipe) | Source-available | Blueprint for context continuity (event-driven capture, local SQLite index) |
| [Talon](https://talonvoice.com/) + [community grammars](https://github.com/talonhub/community) | Closed core | Gold standard for voice commands & per-app action grammars |
| [Hammerspoon](https://github.com/Hammerspoon/hammerspoon) | MIT | Fastest way to prototype AX insertion/reading strategies per app |
| [macOS-use](https://github.com/browser-use/macOS-use) | MIT | AX-tree agent actions reference |
| [node-insert-text](https://github.com/xitanggg/node-insert-text) | MIT | Compact AX+paste hybrid insertion reference |

## 6. Recommended Architecture & MVP Plan

```
┌────────────────────────── menu-bar app (Swift/SwiftUI, non-sandboxed, Developer ID + notarized) ─┐
│  Hotkey/PTT (CGEventTap) ─▶ Audio (AVAudioEngine, 16k mono) ─▶ VAD                                │
│                                        │                                                          │
│                          ASR Engine Protocol (streaming partials)                                 │
│              ├─ FluidAudio/Parakeet v3 (default, ANE)                                             │
│              ├─ SpeechAnalyzer (macOS 26+, opportunistic)                                         │
│              └─ Deepgram Nova-3 WS (opt-in cloud tier)                                            │
│                                        │                                                          │
│  Context Service ──────────────▶ Intent Router                                                    │
│  (AX: app, window, focused        ├─ dictate  → Formatter (local rules + optional LLM cleanup)    │
│   field, selection, ±2KB text;    ├─ edit     → LLM (Claude Haiku 4.5, streamed, strict schema)   │
│   OCR fallback via SCK+Vision;    └─ command  → Action Executor (whitelisted AX/keystroke verbs)  │
│   local SQLite context store)                   │                                                 │
│                                        Insertion Engine (tiered: AX write → paste-swap →          │
│                                        CGEvent typing; per-app strategy table; secure-input guard)│
│                                                 │                                                 │
│  HUD (floating NSPanel): live transcript, parsed-intent chip, diff preview, undo                  │
│  Action Journal (SQLite): intent JSON, before/after, method, undo hooks                           │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Stack: Swift + SwiftUI menu-bar app; FluidAudio or WhisperKit via SwiftPM; Anthropic API (streaming, prompt caching, strict tool use); SQLite (GRDB) for journal + context; Sparkle for updates. No Electron.

### 4–8 week MVP (2 engineers)
- **Weeks 1–2:** Menu-bar shell, permissions onboarding (Mic + Accessibility, live verification), push-to-talk, streaming ASR with live partials in HUD, Tier-1/2 insertion, per-app strategy table for top ~15 apps (Slack, Chrome, Safari, Notes, Mail, VS Code, Cursor, iTerm/Terminal, Notion, Obsidian, Xcode, Messages, Word, Google Docs).
- **Weeks 3–4:** Context service (frontmost app, window title, focused-field text, selection); app-adaptive formatting; personal dictionary; secure-input guard; latency hardening (<1 s utterance-end → text-inserted).
- **Weeks 5–6:** Generative edits: selection capture → Claude Haiku 4.5 streamed edit → diff preview → replace; undo journal with restore; intent router via strict structured output.
- **Weeks 7–8:** Voice commands v1 (whitelisted verbs), intent-chip transparency UI, journal timeline view, opt-in telemetry, notarized distribution + Sparkle.

**Defer post-MVP:** SpeechAnalyzer backend, OCR/screen context + local semantic index, local-LLM private mode, IMK input method, free-form computer-use tier, Windows.

### Key risks
1. Insertion reliability in Electron/browsers — tiered engine + per-app table; ongoing maintenance.
2. Permission onboarding drop-off — guided flow + self-diagnosis.
3. No Mac App Store — direct distribution only (industry norm).
4. LLM latency variance — streaming, caching, tiny prompts, rules-only fast path for common commands ("scratch that," "new line").
5. License hygiene — VoiceInk is GPL v3: study, don't copy.

### Key sources
[Argmax/WhisperKit](https://www.argmaxinc.com/blog/apple-and-argmax) · [WhisperKit paper](https://arxiv.org/html/2507.10860v1) · [FluidAudio Parakeet v3](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml) · [WWDC25 SpeechAnalyzer](https://developer.apple.com/videos/play/wwdc2025/277/) · [MacStories SpeechAnalyzer test](https://www.macstories.net/stories/hands-on-how-apples-new-speech-apis-outpace-whisper-for-lightning-fast-transcription/) · [Deepgram Nova-3](https://deepgram.com/learn/introducing-nova-3-speech-to-text-api) · [AssemblyAI Universal-Streaming](https://www.assemblyai.com/blog/introducing-universal-streaming) · [Swift insert-text two ways](https://levelup.gitconnected.com/swift-macos-insert-text-to-other-active-applications-two-ways-9e2d712ae293) · [AX write-path pitfalls](https://t8r.tech/t/macos-accessibility-ui-tree) · [Wispr Flow field guide](https://github.com/vkorost/wispr-flow-field-guide/blob/main/book/chapters/04-macos.md) · [Screenpipe](https://github.com/screenpipe/screenpipe) · [AX + sandbox (Apple forums)](https://developer.apple.com/forums/thread/780626)
