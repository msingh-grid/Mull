# M4 — verify by hand

M4 is **the edit lane**: say what you want done to the text in front of you, and
Mull shows every mark before anything changes. It is the milestone that answers
*"if I say something it gets typed, but if I have to summarize or make it
crisp, that's not working."*

M4.1 is the correction it needed. The first sentence the rules table met in the
wild — *"Can you make my last message less apologetic?"*, said into a Slack
composer holding the very text it referred to — got typed as a question. So the
model decides now, edits can act on a whole field rather than only a selection,
and the panel can be dragged out of the way.

Automated first — all of this passes now:

```bash
npm run typecheck && npm test && npm run build   # 375 unit tests
npm run bench:engine                             # the 1.2s first-token budget
npm run smoke && npm run check:native
npm run pack:local                               # the DMG you actually install
```

The sidecar is **unchanged** — still protocol 3, still `0.3.0`. M4 is assembled
from parts M2 and M3 already built, so there is no `build:sidecar` step and no
stale-binary trap this time.

---

## 1. What changed since M3

| | M3 | M4 |
|---|---|---|
| Cards | a `FakeEngine` demo from the tray | a real model, from your own speech |
| Routing | every utterance was dictation | a model decides; rules gate and answer offline |
| Edit target | — | a selection, or the whole focused field |
| Chips | none on real dictation | live focus chip, Edit stamp, local-only warning |
| HUD | nailed to the bottom centre | draggable, and it remembers |
| Engine | none | Claude subscription, or an API key |
| Credentials | none | `safeStorage`, never logged, never sent to a renderer |
| Undo | caret-relative only | also where the write reported landing |

## 2. The rule, in one sentence

**Say what you want done to the text in front of you.** Something selected, or
just text in the box you're typing in — either works. An empty box has nothing
to edit, so the words are simply typed.

A model makes that call, not a list of phrasings; the list only decides whether
the question is worth asking, and answers it offline. Which means the thing to
check by hand is no longer a fixture table — it is whether the decisions feel
right on your own sentences.

## 3. The loop

`npm run dev`, then in **TextEdit**:

- [ ] **Type a hedgy paragraph**, select it, hold ⌥Space and say *"make this
      crisp"*.
- [ ] **The chip appears while you are still speaking** — "TextEdit — 31 words".
      That is the selection Mull has, shown in time for you to change your mind.
- [ ] **The card fills in as the model writes**, red pencil and ink, and the
      label goes `THINKING` → `PREVIEW` only when it is finished arriving.
- [ ] **⏎ applies it.** The selection is replaced, a journal row appears, and
      **⌥Z restores the original exactly**. Check the restored text character
      for character — this is the one that matters.
- [ ] **esc changes nothing**, and still leaves a `cancelled` journal row.
- [ ] **⏎ and esc are free again** the moment the card closes. Press ⏎ in
      TextEdit: a newline, not a swallowed key.

Then the same edit in **Slack** (or any Electron app):

- [ ] **The text still lands**, via paste.
- [ ] **⌥Z declines and says why** — nothing read the write back, so undo is not
      offered. The card never promised one either.

## 4. Routing — the half that must not fire

Each of these is said **with text on screen** (selected, or just in the box).
All of them should be *typed*, not edited. This is the failure that costs you
something, so it is worth doing by hand once.

- [ ] *"make sure Priya signs off"* → typed.
- [ ] *"fix the meeting to 3pm and tell Dan"* → typed.
- [ ] *"turn it off before you leave"* → typed.
- [ ] *"cut the budget by ten percent this quarter"* → typed.
- [ ] *"that said, make it clear we need sign-off"* → typed.
- [ ] A long sentence that opens with "make this…" and runs past fourteen words
      → typed.

And the ones that should edit:

- [ ] *"tighten this up"*, *"fix the grammar"*, *"turn this into bullet points"*,
      *"make it sound less apologetic"*, *"clean up the wording"*.
- [ ] *"could you tighten this up"* and *"just make this shorter"* — the
      politeness is stripped before the rules run.

With **an empty box**:

- [ ] *"make this crisp"* is typed immediately, with no perceptible pause —
      nothing was asked, because there was nothing to edit.

Timing, which is the thing this milestone traded away:

- [ ] **Ordinary speech into a half-written email lands at once.** "and I'll
      send the deck tonight" has no instruction verb, so it never waits.
- [ ] **An instruction-shaped sentence pauses first.** Two to four seconds on
      the subscription lane while the model decides — that is the Claude Code
      harness, not the model (`npm run bench:engine` shows first tokens at
      ~880 ms). An API key is much faster; Settings → Engine can switch to
      **Rules only**, which never waits and never sends anything.
- [ ] *"make sure Priya signs off"* pauses, then types. Correct, and the pause
      is the cost of it being correct.

## 5. Nothing is applied to text that moved

- [ ] Select, speak, wait for the card — then **click somewhere else** and press
      ⏎. Refused: *"The selection is gone…"*. Nothing changed.
- [ ] Select, speak, then **type over the selection** while reading the card.
      Refused: *"That text has changed since Mull read it…"*.
- [ ] Select in TextEdit, speak, **switch to Notes**, press ⏎. Refused, naming
      the app.
- [ ] **Start a new utterance while a card is open.** The card closes as a
      cancel, and the journal has the row to prove it — a proposal never just
      disappears.

## 6. The engine

Menu bar → **Settings… → Engine**.

- [ ] **If this Mac is signed in to Claude Code**, the pane says so and there is
      nothing to paste. `In use:` reads `Claude subscription · claude-sonnet-5`.
- [ ] **Otherwise** it shows `claude setup-token` with a Copy button. Run it,
      paste the token, Save. The field clears itself.
- [ ] **Test** does one real round trip and reports the time. A saved credential
      is not a working one; this is the only honest ✓.
- [ ] **Careful → Fast** takes effect on the next edit, with no relaunch. Haiku
      is visibly quicker; the marks are usually the same.
- [ ] **Sign out** → the next edit refuses with *"No engine is connected…
      Dictation still works."* — and dictation still works. Try it.
- [ ] **Turn off Wi-Fi mid-edit** → a `local-only` chip naming the reason, and a
      journal row. Turn it back on; the next edit just works, with nothing to
      click.

The secrets:

- [ ] `~/Library/Application Support/mull/credentials.json` is ciphertext. Open
      it — your token must not be in there in any readable form.
- [ ] It is `-rw-------`.
- [ ] `grep -ri "sk-ant" ~/Library/Logs/mull/` finds nothing.

And on the packaged build specifically:

- [ ] **The DMG's copy can edit too.** The Agent SDK ships its own `claude`
      executable; `npm run pack:local` proves it is present and that the bundle
      still verifies, but only launching the installed app proves it *runs*
      under the hardened runtime. Do one edit from `/Applications/Mull.app`.

## 7. The ledger

```bash
tail -3 "$HOME/Library/Application Support/mull/bench.jsonl" | python3 -m json.tool
```

- [ ] Edits are `"kind":"edit"` rows with `firstTokenMs`, `engineMs`, `changes`.
- [ ] **The writing itself is not in there.** Lengths only. A latency log is no
      place for what someone was drafting.
- [ ] `npm run bench:engine` reports p50 first token under 1200 ms. If it does
      not, docs/PLAN.md says the default lane flips to the API key — and this is
      the measurement that decides it, not a preference.

## 8. Known gaps, deliberately left for later

| Gap | Why | Closes in |
|---|---|---|
| No command lane — `plan()` refuses on both real engines | whitelisted verbs are M5's; an empty plan card would propose nothing, which is worse than an honest error nobody can currently trigger | M5 |
| Memory chips still cite nothing | the store is M5 | M5 |
| Undo is still single-step | the journal window makes a stack legible; the stack itself is later | M5 |
| ~~The router is rules only~~ | closed in M4.1 — the model decides, the rules gate whether to ask and answer offline | done |
| An instruction-shaped utterance waits 2–4 s on the subscription lane | measured: a warm Agent SDK turn is p50 4.2 s to *completion*, which is harness overhead rather than the model. Nothing in the SDK's options fixes it; the API-key lane does, and so does asking less often | when a faster classification path exists |
| Whole-field edits are AX-only | `replaceRange` with `expect` is the only write exact enough for a whole field; a paste fallback would need ⌘A, and "select everything in whatever has focus, then overwrite it" is not a thing to do on a guess. Selections still degrade to paste and work everywhere | M5 |
| Menu-bar and app icons are still glyphs | needs real monochrome assets | M6 |
| The subscription lane can't be notarised as-is | the SDK ships its own `claude` executable, signed by Anthropic. `npm run pack:local` confirms it lands in `app.asar.unpacked` and that `codesign --verify --deep` accepts the whole bundle — so the local DMG is fine. A *notarised* build cannot nest code signed by another team, which is one more reason the API-key lane exists | M6 |

## 9. Moving the HUD

The panel used to be nailed to the bottom centre, which is fine until it is
sitting on Slack's composer toolbar.

- [ ] **Hover it and the cursor becomes a grab hand.** Drag from anywhere on the
      paper — the transcript, the chips, the empty space.
- [ ] **Clicks still pass through everywhere else.** With the pointer off the
      panel, click where the window *is* but the paper is not; the click lands
      on the app underneath.
- [ ] **It cannot be lost.** Drag hard left, right and down: it stops at the
      screen edge. Drag up: it goes almost to the top, panel still visible.
- [ ] **It stays where you put it** across a quit and relaunch.
- [ ] **Menu bar → Reset HUD position** brings it home, and so does
      Settings → Appearance → HUD position.
- [ ] **Buttons still work.** With a card open, Apply and Cancel respond to the
      mouse, and dragging from a button does not move the window.
