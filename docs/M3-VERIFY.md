# M3 — verify by hand

M3 is **the instrument made visible**: the Studio Paper HUD, a journal window,
settings, onboarding, and a sidecar event tap that finally watches the hotkey
with one listener instead of two.

Automated first — all of this passes now:

```bash
npm run typecheck && npm test && npm run build   # 179 unit tests
npm run build:sidecar                            # protocol 3, sidecar 0.3.0
npm run smoke                                    # incl. tap start/stop + the Fn honesty check
npm run check:native
npm run pack:local                               # the DMG you actually install
```

What follows needs eyes, a keyboard and TCC.

---

## 1. What changed since M2

| | M2 | M3 |
|---|---|---|
| HUD | unstyled state read-out | the Studio Paper panel, all states |
| Window | opaque, fixed size | transparent non-activating panel, click-through when idle |
| Cards | none | diff + plan cards on a `FakeEngine`, ⏎ / esc |
| Record | SQLite only | journal window, per-row undo, deep-linkable rows |
| Settings | none | permissions, hotkey, appearance, model, about |
| Onboarding | a prototype in `design/` | five real pages, real signals |
| Hotkey | `globalShortcut` + `uiohook` | sidecar `CGEventTap`, with the old pair as fallback |

The sidecar protocol is now **3**. A stale `mull-mac` makes `init` fail loudly
at boot — if the log says `protocol version mismatch`, run
`npm run build:sidecar`.

## 2. The HUD

`npm run dev`, then:

- [ ] **It looks like the board.** Compare against `design/directions/02-studio-paper.html`:
      paper ground, serif transcript, tracked uppercase state label, hairline edges.
- [ ] **It never takes focus.** Click into TextEdit; the caret keeps blinking while
      the HUD is visible, and stays blinking through a whole dictation.
- [ ] **Clicks pass through it when idle.** Put the HUD over a Finder window and
      click where the panel is *not* — the click lands on Finder. (The panel's
      own 480px is opaque; the rest of the window is transparent and inert.)
- [ ] **Idle shows the ghost hint** *"Hold ⌥Space and speak"* in serif italic.
- [ ] **Listening animates** — orb fills and pings, waveform ticks, caret blinks.
- [ ] **The transcript never grows past two lines**; long dictation ellipsises
      rather than pushing the panel up the screen.
- [ ] **After a dictation the ghost row appears**: "Dictation · Mail · just now"
      with `⌥Z undo` — and the undo hint is **absent** when the write could not
      be verified (try it in Slack).
- [ ] **Both themes.** System Settings → Appearance → Dark. The panel goes
      lamplit; nothing becomes unreadable. Then Settings → Appearance → HUD →
      *Always paper-light* and confirm the panel alone stays on paper.
- [ ] **Reduced motion.** System Settings → Accessibility → Display → Reduce
      motion. The waveform freezes mid-trace rather than going flat, and the orb
      stays filled without pinging.

## 3. Cards, and the two chords

Menu bar → **Preview demo → Edit preview**.

- [ ] **The card rises in** with red-pencil deletions and ink insertions, and the
      count in the title matches what the body shows.
- [ ] **The panel becomes clickable** only now — Apply and Cancel respond to the
      mouse while the card is open.
- [ ] **⏎ applies.** The text lands in whatever app was frontmost, a journal
      entry appears, and ⌥Z takes it back.
- [ ] **esc cancels** and nothing is written.
- [ ] **⏎ and esc are free again immediately.** With the card closed, press ⏎ in
      TextEdit — you get a newline, not a swallowed key. **This is the one to
      check twice**; a leaked chord would break Return everywhere on the Mac.
- [ ] **Plan demo** shows `PLAN · 3 steps` with `·` state cells and says
      *"demo — nothing runs"*. Run does nothing but close it — commands are M5.

## 4. Journal window

Menu bar → **Journal…**

- [ ] **Every dictation is a row**, newest first, with app, time and summary.
- [ ] **Failures are rows too** — revoke Accessibility, dictate, grant it back.
- [ ] **Clicking a row expands it** to the marks, in the same ink as the HUD card.
- [ ] **Undo works from the row**, with the same refusals as ⌥Z: undo something
      from Mail while Notes is frontmost and it declines, naming Mail.
- [ ] **Rows that cannot be undone say why** on hover and in the expanded row —
      never a hidden button.
- [ ] **The window updates live** while you dictate into another app.
- [ ] **A row deep-links.** Expand one, note `?entry=…` is in the window URL,
      close and reopen — it comes back expanded.

## 5. Settings

Menu bar → **Settings…**

- [ ] **Permission rows reflect reality.** Revoke Accessibility in System
      Settings and watch the ✓ become `·` **without touching the window** —
      polling, not a cached answer.
- [ ] **Grant opens the right pane**, and the ✓ arrives only after macOS agrees.
- [ ] **`in use:` names the live hotkey mode.** With Input Monitoring granted it
      should read `tap`.
- [ ] **Switching to Fn takes effect without a relaunch** (if the tap is live).
      Hold the globe key and dictate. Switch back to ⌥Space afterwards.
- [ ] **Theme changes apply everywhere at once** — journal, settings and the HUD.
- [ ] **About lists the running versions**, including sidecar `0.3.0 · protocol 3`.

## 6. The event tap

This is the M3 change with the most machinery behind it.

- [ ] **No stray character.** Dictate into TextEdit: the text starts with your
      first word, with no leading non-breaking space. (That was the whole reason
      M1 needed two listeners.)
- [ ] **Release order doesn't matter.** Lift ⌥ before Space once, and Space
      before ⌥ once. Both end the utterance exactly once.
- [ ] **It survives a hitch.** Put the machine under load, keep dictating; the
      tap re-enables itself if macOS disables it.
- [ ] **Revoke Input Monitoring, restart Mull.** The hotkey still works — via the
      fallback — and Settings says why the tap is not in use.
- [ ] **Quit Mull and confirm ⌥Space types a space again** in TextEdit. Nothing
      is left claimed.

## 7. Onboarding

Delete `onboardingCompletedAt` from `~/Library/Application Support/mull/settings.json`
(or the whole file) and relaunch.

- [ ] **It opens by itself on first run**, and not on the next one.
- [ ] **Page 1 embeds the real HUD** at rest — the same component, not a picture.
- [ ] **Page 2's card is the real thing**: Apply and Cancel work, and the undo
      promise is printed in the same breath.
- [ ] **Page 3's ✓ comes from macOS**, not from pressing Grant. Grant one and
      watch the row change on its own.
- [ ] **Page 4 already shows ✓** because your model is installed; it reports the
      real file and size rather than offering a download you don't need.
- [ ] **Page 5 is a rehearsal.** Click into the practice note, hold ⌥Space, speak
      — the text lands at the caret, the HUD above runs idle → listening →
      thinking → applied, and ⌥Z takes it back.
- [ ] **Nothing blocks Continue** on any page.
- [ ] **Re-runnable** from Settings → About → Run it again, and from the tray.

## 8. Known gaps, deliberately left for later

| Gap | Why | Closes in |
|---|---|---|
| Menu-bar icon is a text glyph | §6.7 wants a monochrome template image with an ochre badge; that needs real assets, which arrive with the app icon | M6 |
| No app icon — the DMG shows Electron's | same | M6 |
| Cards are driven by a `FakeEngine` | the engine is M4; the surfaces were built first so the preview can be judged before there is anything to preview | M4 |
| No intent chip on real dictation | the router that would produce it is M4 | M4 |
| `asrMs` still misses the 400 ms budget | unchanged: the CLI provider costs a process spawn per utterance | M4 |
| Memory chips render but cite nothing | the store is M5 | M5 |
| Undo is still single-step | a stack needs the journal window first — which now exists | M4/M5 |
| Swift `XCTest` suite still can't run here | needs full Xcode; `npm run smoke` drives the built binary over real ndjson | when Xcode is present |
