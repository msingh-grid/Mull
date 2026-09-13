# Insertion matrix

Twelve apps × six behaviours. This is the document that decides what
`src/main/services/insertion-table.ts` says, and it is re-run at **M2**, **M4**
and **M6** — the M6 pass on the *notarised* build is the one that counts, because
macOS treats a signed app with a stable bundle id differently from a dev-mode
Electron binary.

Nothing here can be automated. AX behaviour is per-app, undocumented, and
changes with app updates; the only way to know is to type into the thing.

---

## How to run it

```bash
npm run build:sidecar && npm run dev
tail -f "$HOME/Library/Application Support/mull/bench.jsonl"   # in a second terminal
```

Each utterance appends a row with two columns that matter here:

| Column | Meaning |
|---|---|
| `strategy` | what finally worked (`ax`, `paste`, `type`, or `null`) |
| `attempts` | the whole walk, e.g. `ax:ax-unsupported,paste:ok` |

`attempts` is the evidence. If it says `ax:ok` for an app the table has down as
Chromium, the table is wrong — fix the table, not the note.

---

## The six behaviours

1. **Insert** — caret in an empty-ish field, hold ⌥Space, say *"send the deck
   today"*, release. The cleaned sentence appears at the caret.
2. **Replace** — select a few words first. The selection is replaced, not
   appended-to, and nothing outside it moves.
3. **Undo** — press ⌥Z straight after. Exactly the inserted characters
   disappear; surrounding text is untouched. A refusal with a clear reason
   counts as a **pass** in an app that can't support it — a silent no-op does not.
4. **Clipboard** — copy a recognisable string first (`MULL-CLIPBOARD-CANARY`).
   After dictating, ⌘V elsewhere still pastes the canary.
5. **Secure input** — focus a password field in the same app where one exists,
   hold ⌥Space. HUD says *"Secure input is on — Mull paused"*; nothing is typed.
6. **Clean keys** — the insertion starts with the first word (no leading
   U+00A0 from ⌥Space), and the caret never leaves the app for the HUD.

Legend: `✓` pass · `✕` fail · `~` works with a caveat (write it in Notes) ·
`n/a` the app has nothing to test (no password field, no selection model) ·
blank = not yet run.

---

## M2 pass — dev build, unsigned

Run by: _________ Date: _________ Build: dev (`npm run dev`)

| # | App | Bundle id | Expected chain | 1 Insert | 2 Replace | 3 Undo | 4 Clipboard | 5 Secure | 6 Keys | Observed `attempts` | Notes |
|---|---|---|---|:--:|:--:|:--:|:--:|:--:|:--:|---|---|
| 1 | TextEdit | `com.apple.TextEdit` | ax → paste | | | | | n/a | | | |
| 2 | Notes | `com.apple.Notes` | ax → paste | | | | | n/a | | | |
| 3 | Mail (compose) | `com.apple.mail` | ax → paste | | | | | n/a | | | |
| 4 | Messages | `com.apple.MobileSMS` | ax → paste | | | | | n/a | | | |
| 5 | Safari (textarea) | `com.apple.Safari` | ax → paste | | | | | | | | web fields often refuse AX writes |
| 6 | Chrome (Gmail) | `com.google.Chrome` | paste | | | | | | | | |
| 7 | Slack (message box) | `com.tinyspeck.slackmacgap` | paste | | | | | n/a | | | slowest paste settle we know of |
| 8 | VS Code | `com.microsoft.VSCode` | paste | | | | | n/a | | | |
| 9 | Terminal | `com.apple.Terminal` | paste → type | | | | | | | | `sudo` prompt = the secure-input case |
| 10 | iTerm2 | `com.googlecode.iterm2` | paste → type | | | | | | | | |
| 11 | Notion | `notion.id` | paste | | | | | n/a | | | |
| 12 | Obsidian | `md.obsidian` | paste | | | | | n/a | | | |

**Undo is expected to be unavailable in most of rows 6–12.** Undo needs an AX
range write, which is exactly what Chromium and terminal targets don't offer.
The pass condition there is the honest refusal: *"This app doesn't let Mull edit
text directly, so undo isn't available here. ⌘Z should work."*

### Findings to fold back into the table

| App | What actually happened | Change to `insertion-table.ts` |
|---|---|---|
| | | |

---

## M4 pass — with the engine (Sculpt edits)

Re-run rows 1–5 plus **replace-selection under an edit intent**, where the text
being replaced came from the engine rather than the microphone.

| # | App | 1 Insert | 2 Replace | 3 Undo | Notes |
|---|---|:--:|:--:|:--:|---|
| | | | | | |

---

## M6 pass — notarised DMG

The one that ships. TCC prompts name *Mull* rather than *Electron*, permissions
attach to the real bundle id, and a few apps behave differently towards a signed
binary. Re-run all twelve rows.

| # | App | 1 Insert | 2 Replace | 3 Undo | 4 Clipboard | 5 Secure | 6 Keys | Notes |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| | | | | | | | | |

---

## Why the defaults are what they are

| Class | Chain | Settle | Reason |
|---|---|---|---|
| Native Cocoa | `ax → paste` | 90 ms | The text system implements `AXSelectedText` properly: writes land, read-back confirms, the pasteboard is never touched. |
| Chromium / Electron | `paste` | 280 ms | AX text writes are no-ops or silently dropped. Paste works, but these apps take an order of magnitude longer to service ⌘V than a Cocoa app — restoring the pasteboard too early steals the paste. |
| Terminals | `paste → type` | 120 ms | No writable AX text. ⌘V works in the emulator; typing is the fallback for full-screen TUIs that intercept it. |
| JetBrains / Swing | `paste` | 200 ms | The Java AX bridge is read-mostly. |
| Password managers | *(none)* | — | Mull refuses outright. Secure input covers the password field itself, but not the app's other fields, and a transcript does not belong in a vault. |
| Unclassified | `ax → paste` | 150 ms | Try the good one once. `InsertionService` demotes it for the session the moment the app proves it doesn't work, so a wrong guess costs one attempt. |
