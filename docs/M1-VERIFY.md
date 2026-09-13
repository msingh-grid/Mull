# M1 — verify by hand

M1 is the end-to-end dictation loop: **hold ⌥Space → speak → cleaned text appears at your caret.**

Everything that can be checked without a microphone, a keyboard or a TCC prompt already is:

```bash
npm run typecheck && npm test && npm run build   # 49 unit tests, both bundles
npm run smoke                                    # sidecar over real ndjson + pipeline on fakes
npm run check:native                             # better-sqlite3 + FTS5 under Electron's ABI
```

What follows is the part only you can do.

---

## 1. One-time setup

```bash
npm run build:sidecar     # Swift sidecar → mull-mac/.build/release/mull-mac
brew install whisper-cpp  # the local speech engine (~2 min)
npm run fetch:model       # ggml-base.en.bin, ~148 MB, into Application Support
npm run smoke             # should now print SMOKE_OK with no "todo" lines
```

`npm run smoke` prints where each file is expected; if a path looks wrong, `MULL_WHISPER_CLI`
and `MULL_SIDECAR_PATH` override them.

## 2. Permissions

Launch once (`npm run dev`) and let it ask, or pre-grant in **System Settings → Privacy & Security**:

| Permission | Why Mull needs it | Symptom when missing |
|---|---|---|
| **Microphone** | to hear you | HUD shows "No audio captured" |
| **Accessibility** | to place text at the caret | HUD shows the Accessibility notice; nothing is inserted |
| **Input Monitoring** | to see ⌥Space while in the background | HUD says ⌥Space is unavailable; hotkey falls back to toggle mode |

In dev the permissions are attributed to **Electron**, not "Mull" — that is expected until M6 signs
a real app bundle. **Grants require a restart of `npm run dev`** to take effect.

## 3. The checklist

Start the app with `npm run dev`, then:

- [ ] **The HUD appears** bottom-centre and says `IDLE · Hold ⌥Space and speak`.
- [ ] **It never steals focus.** Click into TextEdit — the caret keeps blinking, the HUD stays visible.
- [ ] **Hold ⌥Space** → HUD flips to `LISTENING` within a blink, and names the frontmost app.
- [ ] **Speak a sentence, release.** → `THINKING` → `INSERTING` → `APPLIED`, and the cleaned text
      lands at the caret in TextEdit.
- [ ] **No stray character.** The text starts with your first word — no leading non-breaking space.
      (If there is one, `globalShortcut` failed to claim ⌥Space; check the log for `hotkey mode`.)
- [ ] **Fillers are gone.** Say "um, send the deck uh today" → `Send the deck today`.
- [ ] **A tap does nothing.** Press and release ⌥Space quickly → no text, no error.
- [ ] **Silence does nothing.** Hold for two seconds without speaking → no text.
- [ ] **Release order doesn't matter.** Lift ⌥ before Space once, and Space before ⌥ once —
      both end the utterance exactly once.
- [ ] **Secure input is respected.** Focus a password field (Safari login, `sudo` in Terminal),
      hold ⌥Space → HUD says *"Secure input is on — Mull paused"* and **nothing is inserted**.
- [ ] **It works in a second app.** Repeat in Notes or Mail.
- [ ] **Latency is in budget.** See below.

## 4. Latency

Every utterance appends a row to `~/Library/Application Support/mull/bench.jsonl`:

```bash
tail -3 "$HOME/Library/Application Support/mull/bench.jsonl" | python3 -m json.tool
```

Budgets from `docs/PLAN.md`: `asrMs` < 400 (key-up → transcript), `insertMs` < 300
(transcript → on screen). Expect `asrMs` around 500–900 ms on `base.en` for a normal sentence —
**over budget, and known**: see the gap list below.

## 5. Known gaps, deliberately left for later

| Gap | Why | Closes in |
|---|---|---|
| `asrMs` misses the 400 ms budget | `smart-whisper` (the in-process binding the plan named) does not compile against this Node/toolchain — node-gyp fails in `binding.cc`. The CLI provider costs a process spawn per utterance and can't stream partials. The `AsrProvider` seam exists precisely so this swaps out. | M3/M4 |
| No live partial transcript | same cause — the CLI only returns a final result | with the above |
| ⌥Space handled by two listeners | `globalShortcut` consumes key-down (so no stray U+00A0), `uiohook-napi` reports key-up. A single `CGEventTap` in the sidecar does both. | M3 |
| HUD is an unstyled read-out | tokens and specs are frozen (`docs/DESIGN.md`), the panel itself is M3's job | M3 |
| Insertion is paste-only | the AX write path needs the focused-element reader | M2 |
| Nothing is journalled or undoable | `JournalEntry` exists as a type; the store is M2 | M2 |
| Swift `XCTest` suite does not run here | requires full Xcode; only Command Line Tools are installed. `npm run smoke` drives the built binary over real ndjson instead, which covers the same framing. | when Xcode is present |

## 6. If something is wrong

```bash
tail -f "$HOME/Library/Logs/mull/main.log"
```

The boot line `permissions {...}` reports what macOS actually granted and which `hotkeyMode`
was reached (`ptt` is the good one; `ptt-passive`, `toggle` and `unavailable` are the degraded rungs).
`MULL_ASR=fake npm run dev` runs the whole loop with a canned transcript, which separates
"the pipeline is broken" from "the microphone or the model is broken".
