# M2 — verify by hand

M2 is **insertion done right**: the sidecar can read the focused element and
write through the Accessibility API, the host picks a strategy per app and
proves the text landed, every action is written to a journal, and ⌥Z takes back
the last one.

Automated first — all of this passes now:

```bash
npm run typecheck && npm test && npm run build   # 99 unit tests
npm run build:sidecar                            # protocol 2, sidecar 0.2.0
npm run smoke                                    # incl. a real journal + undo round trip
npm run notarize:dryrun                          # entitlements, hardened runtime, signing
```

What follows needs a keyboard, a microphone and TCC.

---

## 1. What changed since M1

| | M1 | M2 |
|---|---|---|
| Insertion | always paste | per-app chain `ax → paste → type`, with read-back |
| Proof it worked | none | `verified` on every write; unverifiable AX writes fall through |
| Record | `bench.jsonl` only | SQLite journal at `~/Library/Application Support/mull/journal.db` |
| Undo | none | ⌥Z, refusing unless it can confirm the exact characters |
| Packaging | untested | hardened-runtime entitlements + signing proven ad-hoc |

The sidecar protocol is now **2**. A stale `mull-mac` binary makes `init` fail
loudly at boot rather than returning shapes the host can't parse — if the log
says `protocol version mismatch`, run `npm run build:sidecar`.

## 2. The checklist

`npm run dev`, then in **TextEdit** (the app most likely to exercise the AX path):

- [ ] **Dictation still works.** Everything in `docs/M1-VERIFY.md` §3 still passes.
- [ ] **It used AX, not paste.** `tail -1 bench.jsonl` shows `"strategy":"ax"`
      and `"attempts":"ax:ok"`.
- [ ] **The clipboard is untouched.** Copy `MULL-CLIPBOARD-CANARY` first; after
      dictating, ⌘V elsewhere still pastes the canary. (With the AX strategy the
      pasteboard is never touched at all — this is the user-visible payoff.)
- [ ] **⌥Z removes exactly what was inserted.** Surrounding text unchanged, and
      no stray Ω from the chord itself.
- [ ] **⌥Z twice does nothing the second time** — *"Nothing to undo."*
- [ ] **Type a character, then ⌥Z** → *"The text has changed since Mull inserted
      it — nothing was undone."* and the text stays. This is the check that
      protects other people's writing; it must refuse.
- [ ] **Dictate in TextEdit, switch to Notes, press ⌥Z** → *"That text went into
      TextEdit — switch back and press ⌥Z there."*
- [ ] **Click away from any text field, press ⌥Z** → *"Click back into the text
      field first."*

Then in **Slack** (or any Electron app):

- [ ] **Text still lands**, via paste: `"attempts":"paste:ok"`.
- [ ] **The clipboard survives** the paste-swap.
- [ ] **⌥Z refuses honestly** — *"This app doesn't let Mull edit text directly…"* —
      rather than deleting something approximate.

Then in **Terminal**:

- [ ] **Text lands** at the shell prompt.
- [ ] **`sudo` prompt is respected**: start `sudo -v`, hold ⌥Space → *"Secure
      input is on — Mull paused"*, nothing typed.

Refusals to confirm anywhere:

- [ ] **1Password is refused outright.** Focus its search field, dictate → the
      HUD says Mull doesn't type into password managers, and `bench.jsonl` shows
      `refused-credential-app` with **no** sidecar write attempt.

## 3. The journal

```bash
sqlite3 "$HOME/Library/Application Support/mull/journal.db" \
  "SELECT datetime(at/1000,'unixepoch','localtime'), status, app_name, strategy, verified, undoable, summary
     FROM entries ORDER BY at DESC LIMIT 10;"
```

- [ ] Every applied dictation is a row, with the app and the strategy used.
- [ ] **Failures are rows too** — force one by revoking Accessibility, dictating,
      then granting it again. A journal of only successes is one nobody trusts.
- [ ] An undone entry has `status = undone` and `undone_at` set.
- [ ] `undoable = 0` wherever `verified` is not `1`. No exceptions: that
      invariant is what stops undo from deleting text Mull only *believes* it
      inserted.

## 4. The insertion matrix

`docs/INSERTION-MATRIX.md` is the twelve-app grid. Running the M2 pass is part of
this milestone; its findings feed straight back into
`src/main/services/insertion-table.ts`. The `attempts` column in `bench.jsonl` is
the evidence for each row.

At quit, the log line `insertion: unsupported strategies observed` lists what the
session learned — apps that refused a strategy and were demoted for the rest of
the run. Anything there that the table doesn't already know is a table change.

## 5. Packaging

`npm run notarize:dryrun` proves the parts that don't need an Apple account:
entitlements are well-formed and complete, the builder config asks for the
hardened runtime and signs the nested sidecar, and the sidecar signs and
verifies.

For an app that only ever runs on this Mac, that is already enough:

```bash
npm run pack:local      # → release/Mull-0.0.1-arm64.dmg, ad-hoc signed
```

See `docs/LOCAL-BUILD.md` — in particular the `tccutil reset` step, which is
needed after every rebuild because TCC keys grants to the code signature.

Distribution to anyone else needs three things that only an Apple Developer
account provides:

- [ ] Set a real `appId` in `electron-builder.yml` (it is a placeholder).
- [ ] Developer ID Application certificate in the login keychain.
- [ ] `xcrun notarytool store-credentials mull --apple-id … --team-id … --password …`

## 6. Known gaps, deliberately left for later

| Gap | Why | Closes in |
|---|---|---|
| `asrMs` still misses the 400 ms budget | unchanged from M1: the CLI provider costs a process spawn per utterance | M3/M4 |
| ~~The HUD is still an unstyled read-out~~ | closed in M3 | done |
| ~~No journal *window* — the store has no UI~~ | closed in M3, with per-row undo | done |
| Undo is single-step | the journal window now makes a stack legible; the stack itself is later | M4/M5 |
| `activateApp` / `keyChord` are implemented but unused | they exist for the M5 whitelisted verbs; nothing calls them yet | M5 |
| Swift `XCTest` suite still can't run here | needs full Xcode; `npm run smoke` drives the built binary over real ndjson instead | when Xcode is present |
| Per-app demotions are in memory only | a fresh run re-tests its assumptions, which is what makes the matrix re-runnable; persisting them needs a settings surface | M6 |
