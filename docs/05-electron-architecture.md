# Mull — Real App Architecture (Electron + Claude Agent SDK)

*Decision context: 2026-09-13. Constraint from product owner: Electron for speed of development; Claude Code SDK (Agent SDK) / Codex as the language engine so end users need no API keys.*

## 0. Key decisions

| Question | Decision | Why |
|---|---|---|
| Shell | **Electron** (main = Node, renderer = HUD/journal UI) | Fastest to build; Wispr Flow itself ships on Electron, so the category has proven it's viable. Cost: RAM (~200–400MB) and no direct access to macOS Accessibility APIs from JS — solved with a Swift sidecar. |
| Speech-to-text | **Local, in-process — NOT the Claude SDK** | The Claude API has no audio input; no LLM SDK does ASR. Local ASR is also key-free, offline, and lower latency. Engine: `sherpa-onnx` (streaming, node bindings, Parakeet/Zipformer ONNX models) or `whisper.cpp` via `smart-whisper` (utterance-level — fine for push-to-talk). |
| Language engine | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) with the user's Claude subscription login | No API key: SDK resolves `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or an `ant auth login` OAuth profile. Abstract behind an `Engine` interface so Codex (`codex login` with ChatGPT account) is a drop-in alternative. |
| macOS integration (AX read/write, caret insertion, secure-input, frontmost app) | **Swift sidecar binary** spawned by Electron, JSON-RPC over stdio | Electron/Node cannot call AXUIElement; nut-js/robotjs only synthesize keys and can't read selection or window text. A ~500-line Swift CLI covers everything and is the pattern to keep. |
| Global push-to-talk hotkey | `uiohook-napi` (key **down/up** events; Electron's `globalShortcut` can't do hold-to-talk) or the Swift sidecar's CGEventTap | Needs Accessibility/Input Monitoring permission either way. |
| Storage | SQLite via `better-sqlite3` (journal, memory, dictionary) | Local-first pillar. |

## 1. Process architecture

```
┌────────────────────────────── Electron app ──────────────────────────────┐
│                                                                           │
│  Renderer: HUD window (frameless, transparent, always-on-top,            │
│  non-activating panel via `type: 'panel'` + focusable:false)             │
│  ├─ live transcript, intent chip, diff preview, plan preview             │
│  └─ Journal & Settings windows (normal BrowserWindows)                   │
│                    ▲ IPC (contextBridge)                                  │
│  Main process (Node)                                                      │
│  ├─ HotkeyService        uiohook-napi: Fn/⌥Space down → record, up → stop │
│  ├─ AudioService         mic capture (renderer getUserMedia → PCM to main,│
│  │                       or node-record-lpcm16) + VAD (silero via onnx)   │
│  ├─ ASRService           sherpa-onnx streaming (partials) OR whisper.cpp  │
│  │                       per-utterance; worker_thread, never main loop    │
│  ├─ ContextService       polls sidecar: frontmost app, window title,      │
│  │                       focused field text ±2KB, selection               │
│  ├─ IntentRouter         fast rules first ("new line", "scratch that"),   │
│  │                       else Engine call → {dictate|edit|command} JSON   │
│  ├─ Engine (interface)   ClaudeAgentEngine | CodexEngine | ApiKeyEngine   │
│  ├─ ActionExecutor       whitelisted verbs → sidecar (AX click, keychord, │
│  │                       open app) — never free-form computer use         │
│  ├─ InsertionService     sidecar: AX write → paste-swap → keystroke type  │
│  ├─ JournalStore         better-sqlite3: intents, before/after, undo      │
│  └─ MemoryStore          sqlite FTS5 (+ later embeddings) of recent       │
│                          contexts, vocabulary, threads                    │
│                    ▲ JSON-RPC over stdio                                   │
│  Swift sidecar (`mull-mac`)  — the only non-JS code                       │
│  ├─ AX: focused element, selection, surrounding text, window title        │
│  ├─ Insert: AXSelectedText write / NSPasteboard swap+⌘V / CGEvent type    │
│  ├─ SecureInput: IsSecureEventInputEnabled → hard-disable                 │
│  └─ Verbs: activate app, click AX element by label, key chord             │
└───────────────────────────────────────────────────────────────────────────┘
```

**Permissions:** Microphone (standard prompt) + Accessibility (manual, drives everything in the sidecar) + Input Monitoring (uiohook). Screen Recording only later for OCR fallback. App Sandbox blocks AX → **no Mac App Store**; ship Developer ID-signed + notarized, update with `electron-updater`. Both the Electron binary *and* the sidecar need to be signed; the Accessibility grant attaches to the parent app bundle.

## 2. Speech pipeline (local, key-free)

1. **Hold-to-talk**: key-down starts a 16kHz mono capture; key-up ends the utterance.
2. **Streaming partials** (nice-to-have v1, required v2): `sherpa-onnx` node bindings run streaming Zipformer/Parakeet ONNX models → partial hypotheses to the HUD as you speak. Simpler v1: `whisper.cpp` (Metal) transcribes the whole utterance on key-up — for push-to-talk utterances of 3–15s this returns in a few hundred ms on Apple silicon.
3. **Post-ASR local cleanup** (no LLM, keeps dictation <1s): filler stripping, casing, punctuation heuristics, personal dictionary substitution. LLM-grade "app-aware tone" cleanup is optional and async.
4. Models (~600MB–1GB) downloaded on first run from Hugging Face into `app.getPath('userData')` — same pattern Alma uses.

**Why not Claude for speech:** the Messages API accepts text/images/PDFs only. Even as a "transcribe this" multimodal call it doesn't exist — and if it did, round-tripping audio through an agent harness would be seconds of latency for something the Neural Engine does locally in milliseconds.

## 3. The Engine layer (no API keys)

```ts
interface Engine {
  // short-lived, latency-critical; tools disabled
  transform(req: {kind: 'edit'|'intent'|'draft', system: string, input: string}): AsyncIterable<string>;
  // long-lived working-memory summarization, sculpt sessions
  session(): EngineSession;
}
```

### ClaudeAgentEngine (default)

- **Package:** `@anthropic-ai/claude-agent-sdk` — Claude Code as a library: `query(prompt, options)` with the full harness, sessions, and streaming. (Docs: code.claude.com/docs/en/agent-sdk. Note this is a different product from the API SDK's tool runner.)
- **Auth without API keys:** onboarding runs `claude setup-token` (or detects an existing Claude Code login / `ant auth login` profile) and stores the OAuth token in the macOS Keychain; the SDK picks up `CLAUDE_CODE_OAUTH_TOKEN` / the profile automatically. Users on Claude Pro/Max pay nothing extra and paste nothing.
- **Latency discipline — the make-or-break detail:** never spawn a fresh `query()` per utterance. Keep **one warm streaming-input session** per task lane (edits lane, sculpt lane), created at app start:
  - system prompt = Mull's edit/intent instructions (stable → prompt-cached),
  - **all tools disallowed** for the edit/intent lane (`disallowedTools: ['*']` / empty tool set) so the harness does a single model turn, no file access, no bash,
  - responses streamed token-by-token into the diff preview.
  With a warm session and cached prompt, an edit turn is ~1–2s to full diff (first tokens ~500–900ms). Cold harness spawn is 2–4s — acceptable only at startup.
- **Structured intent:** the Agent SDK has no `output_config.format`, so either (a) prompt for strict JSON and validate/retry locally, or (b) register a single in-process MCP tool `emit_intent(intent)` and read the tool call — (b) is more reliable.
- **What the agent never does:** touch files, run bash, or act on the computer. Mull's ActionExecutor performs whitelisted verbs itself; the model only produces text and intent JSON. This keeps the trust story ("glass pipeline") intact and the harness fast.

### CodexEngine (alternative)

Same interface over OpenAI Codex: `codex login` (ChatGPT account, no API key), then drive `codex exec --json`/proto mode as a subprocess. Worth keeping as a build target so the app isn't married to one vendor, but Claude is the default lane.

### ApiKeyEngine (escape hatch)

Direct `@anthropic-ai/sdk` Messages calls (`claude-haiku-4-5` for edits — fastest; streaming + prompt caching + strict structured outputs). Lowest latency and the right path for a paid product tier later ("Believer" BYOK). Users who *have* a key get the best experience; everyone else uses the subscription engine.

### Honest caveats on the no-key approach

1. **Terms of service:** subscription OAuth tokens are intended for Claude Code / Agent SDK use by the account holder. A personal tool and a beta where each user logs into *their own* Claude account is the sanctioned shape. Reselling access or proxying one account for many users is not. For commercial launch, plan the BYOK tier and/or a hosted backend with your own API billing.
2. **Rate/usage limits:** the user's Claude plan limits apply (5-hour windows). Heavy dictation days can hit them; degrade gracefully to local-only mode (dictation + rules cleanup keep working — a genuinely nice property of this architecture).
3. **Headless dependency:** the engine requires the Claude Code runtime; bundle the SDK (it vendors the CLI) and health-check at startup.

## 4. Latency budget (targets)

| Stage | Target | How |
|---|---|---|
| key-up → transcript final | < 400ms | local whisper.cpp/sherpa-onnx on ANE/Metal |
| transcript → inserted dictation | < 300ms | local rules cleanup + AX write (no LLM in the hot path) |
| transcript → intent chip | < 700ms | rules fast-path; else warm-session Haiku-class turn |
| edit command → first diff tokens | < 1.2s | warm Agent SDK session, tools off, streamed |
| command → plan preview | < 1.5s | same lane, `emit_intent` tool call |

## 5. Build order (Electron MVP)

1. **Week 1–2 — skeleton + speech:** Electron shell, HUD panel window, uiohook PTT, mic capture, whisper.cpp worker, transcript in HUD. Swift sidecar v1: frontmost app + AX insert + paste fallback + secure-input guard. Permissions onboarding with live verification.
2. **Week 3–4 — dictation done right:** rules cleanup, personal dictionary, per-app strategy table (Slack, Chrome, Mail, Notes, VS Code, Terminal, Notion…), journal with undo.
3. **Week 5–6 — engine + edits:** ClaudeAgentEngine (setup-token onboarding, warm sessions), intent router, selection capture → streamed diff preview → apply/undo.
4. **Week 7–8 — commands + memory v0:** whitelisted verbs through the sidecar with plan preview; context store (recent window texts, FTS5) briefing the edit prompts; sign, notarize, auto-update.

Defer: streaming partials (if v1 used whisper.cpp), OCR context, embeddings memory, CodexEngine, Windows (Electron makes it plausible later — the sidecar becomes a UIA/Win32 equivalent).

## 6. Risks specific to this stack

- **Electron + AX friction:** the sidecar is load-bearing; test the insert path per-app early (the category's shared tax).
- **Agent SDK latency variance:** if warm-session turns exceed budget in practice, the fallback is ApiKeyEngine for edits while keeping AgentEngine for sculpt/long tasks — measure in week 5, don't assume.
- **Hold-to-talk reliability:** uiohook needs Input Monitoring; Fn key events are quirky — offer ⌥Space as default, Fn as opt-in.
- **Memory pressure:** whisper model + Electron + Node ≈ 1.5GB working set; pick model size by machine RAM (base/small on 8GB).
