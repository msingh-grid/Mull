# Mull Design System — "Studio Paper" (D3)

*Frozen 2026-09-13 after the D2 direction pick. Source board: `design/directions/02-studio-paper.html`. Tokens live in `src/renderer/tokens.css` — components style through custom properties only, never raw hex. Brief: `docs/DESIGN-BRIEF.md` still governs behavior (states, constraints, honesty affordances).*

## 1. Identity

**Thesis:** a manuscript on a well-lit desk. Mull marks up your words the way a careful editor does — red pencil for what goes, blue-black ink for what replaces it — and every mark is legible before it lands.

The markup metaphor is the trust story made visible: for a century, editor's marks have meant *"here is exactly what changes, and nothing changes until you agree."* Warmth is not decoration; it is the difference between an instrument you monitor and one you work beside all day.

**Voice casting (strict):**
- **Serif** (`--serif`) — anything the human said or is reading back: transcript, journal summaries, window headings.
- **Sans** (`--sans`) — the instrument's own labels: state labels, chips, buttons, metadata, settings prose.
- **Mono** (`--mono`) — evidence: diff body, plan steps, key hints, hex/data readouts.

Never mix: the machine does not speak serif; the human's words are never mono.

## 2. Color

Warm neutrals do the furniture; **four hues carry four meanings and are spent nowhere else.**

| Token | Light | Dark ("lamplit") | Role |
|---|---|---|---|
| `--paper` | `#FAF7EF` | `#211C13` | HUD/panel ground |
| `--paper-bright` | `#FFFDF6` | `#2A2418` | fresh page: diff card, wells, chip ground |
| `--paper-recessed` | `#F1ECDF` | `#1A1610` | kbd keys, insets |
| `--ink` | `#2B2418` | `#ECE5D3` | primary text, intent-chip stamp |
| `--ink-2` | `#5B523F` | `#BFB397` | secondary text |
| `--ink-3` | `#766C55` | `#96896C` | meta, ghosts, labels (AA at 11px) |
| `--del` | `#B23A2E` | `#E0796B` | **red pencil** — deletions, destructive |
| `--ins` | `#274F8E` | `#8FB0E8` | **writing ink** — insertions, Apply, plan/command accents |
| `--warn` | `#9A6410` | `#D2A04F` | **ochre pencil** — warnings (secure input, rate limit) |
| `--mem` | `#4F6B33` | `#A3BF7D` | **reading green** — memory citations |

Each hue has a `-wash` (≤13% alpha background) and a `-line`/`-edge` (stroke) variant. Rules:
- Hue always means fact. Routing chips (dictation/command) stay neutral; only the four meanings get color.
- `--ins` doubles as the sole interactive accent (Apply fill, focus rings, links). `--del` is never a button fill except an explicit destructive confirm.
- Dark mode is the same desk after sundown: identical roles at raised luminance, hairlines lighten, shadows deepen. Never introduce a dark-only hue.

## 3. Type scale

| Token | Face | Size/weight | Use |
|---|---|---|---|
| `--fs-title` | serif 600 | 21px, -0.01em | journal/settings window headings |
| `--fs-transcript` | serif 400 | 13px / 1.45 | HUD transcript, journal summary |
| `--fs-body` | sans 400 | 13.5px / 1.55 | settings & onboarding prose |
| `--fs-diff` | mono 400 | 12px / 1.7 | diff body, plan steps |
| `--fs-journal` | sans 400 | 12px, tabular-nums | journal metadata |
| `--fs-chip` | sans 600 | 11px, +0.01em | chips |
| `--fs-label` | sans 700 | 11px, +0.10em, uppercase | state labels, card titles |
| `--fs-kbd` | mono 500 | 11px | key hints |

Minimum text size anywhere: 11px, and only for `--fs-label`/`--fs-chip`/`--fs-kbd` styles whose colors are AA-verified. Numerals in time/count contexts always `font-variant-numeric: tabular-nums`.

## 4. Geometry & elevation

- Radii: panel 10px (`--r-panel`) → card 7px (`--r-inner`) → chip/button 5px (`--r-chip`) → kbd 3px. Nesting always steps down.
- HUD: `--hud-w: 480px` (max-width 94vw), padding `13px 15px 12px`, anchored bottom-center, 24px above screen bottom. Grows vertically only (chips row → card); top row is fixed-height 24px so idle→listening never shifts layout.
- Elevation is honest: the HUD carries a 0.5px ring + double shadow (`--shadow-hud`) because it truly floats above everything; journal rows get `--shadow-row`; nothing else casts.
- Hairlines (`--hairline`, `--hairline-soft`) are the only borders. No 2px borders anywhere.

## 5. Motion

- `--t-fast` 140ms: hovers, chip entrances. `--t-med` 220ms: card entrances, state swaps. Single easing: `cubic-bezier(0.22, 0.7, 0.3, 1)`.
- Only `opacity` and `transform` animate. Entrance = `rise-in` (opacity 0→1, translateY 4px→0). No exit animations — disappearance is instant (the instrument stops reporting; it doesn't perform leaving).
- Ambient motion: orb ping (`--pulse-period` 1.6s, box-shadow ring 0→9px) and waveform ticks (`--wave-period` 0.95s, `scaleY` per-bar with staggered delays and amplitudes) — **listening state only**. Caret blink 1s steps(1).
- `prefers-reduced-motion`: all animation/transition to ~0ms; waveform bars freeze at `scaleY(2)` (static mid-level trace — still communicates "live"); orb stays filled without ping.

## 6. Component specs

### 6.1 HUD panel
Non-activating floating panel (`type:'panel'`, transparent window, `focusable:false`). The panel paints `--paper`, `--r-panel`, `--shadow-hud`. Never translucent over wallpaper — the paper is opaque; legibility is never borrowed. Layout: `hud-top` row (orb 13px · waveform · transcript flex-1 · state label), then optional chips row (margin-top 10px), then optional card (margin-top 11px).

**States** (class on the panel root):
- `is-idle` — orb hollow (inset 1.5px ring in `--ink-3`), waveform static low ticks in `--ink-3`, transcript shows ghost hint (*"Hold ⌥Space to dictate · Fn to ask"*, serif italic `--ink-3`), label `IDLE` in `--ink-3`. The hint names both keys because a key nobody knows about is a feature that does not exist. Optional `last-action` ghost row: hairline-top, 11px `--ink-3`, "Applied · summary · time" + `⌥Z undo` kbd right-aligned. Since §6.1a this state is reached only by asking for it or by having just finished something — the idle panel is no longer what is on screen by default.
- `is-listening` — orb fills `--ink` + ping; bars animate in `--ink-2`; transcript streams live with `--ins` caret; label `LISTENING` in `--ink`; intent chip rises in as soon as the router decides.
- `is-thinking` — same as listening but static waveform, label `THINKING`; used while the engine streams. Insertion shares the treatment and says `WRITING`.
- `is-preview` — a card is open; the label names which of the three it is (below).
- `is-applied` — label `APPLIED` in `--mem`, brief; then back to idle with the new last-action ghost.
- `is-blocked` / `is-error` — `PAUSED` in `--warn`, `ERROR` in `--del`. Ochre is something the user can fix — secure input, a missing permission, a model that is not answering. Red pencil is something that failed. They shared ochre until the states board, which flattened a distinction §2 exists to make.

**The label vocabulary.** One slot carrying four kinds of thing, so each kind takes its own word *and its own colour*, and the form says which before the word is read:

| kind | labels | colour |
|---|---|---|
| activity | `LISTENING` · `THINKING` · `WRITING` | `--ink` / `--ink-3` |
| card | `PREVIEW` · `PLAN` · `ANSWER` | `--ink` |
| fault | `PAUSED` · `ERROR` | `--warn` / `--del` |
| outcome | `APPLIED` | `--mem` |

The three card words name the three things Mull can do, because that is the one thing the card's shape says and its title does not: `PREVIEW` changes your document, `PLAN` presses things in another application, `ANSWER` changes nothing at all. A plan and a diff both saying "preview" made a proposal about behaviour indistinguishable from a proposal about text. `INSERTING` became `WRITING` (the implementation's word for the product's metaphor), and `FOUND` is gone — a finished plan *is* an answer and now looks like one.

### 6.2a Card families — what it costs to press the key
*(Board: `design/hud-states.html`.)*

The one question a user has before touching the keyboard, answered by the card's **ground** rather than by its words. Derived in `cardFamily` (`@shared/hud`) from the card itself; a lane cannot set it, and a new card kind stops compiling until it decides. Both halves read it — `services/hud.ts` for what ⏎ does, `components/Cards.tsx` for what the card is made of.

| | `will` | `wont` |
|---|---|---|
| means | something can still happen | nothing more will |
| ground | `--paper-bright` — fresh paper | `--paper-recessed` — pressed into the desk |
| buttons | the one filled `--ins` button in the app | ghost only; **never** a filled button |
| ⏎ | Apply / Run (except `send`, where it stays claimed and inert) | done |
| cards | diff, send, plan before and during its walk | answer, plan once its walk is over |

One rule, visible from across the room: **fresh paper means a key changes something; a pressed-in well means nothing will.** The Apply button that turned up under a summary of somebody's own notes could not survive it — an answer has no fresh paper to put it on. It also closes a live bug: `running` going false put **Run** straight back on a finished plan, so ⏎ started the whole walk again in somebody else's window.

**The promise sits under the button it describes**, not at the right margin of the action row. Three hundred pixels of separation is how the only sentence naming what a key costs ended up far from the key that costs it.

### 6.1a Pet — the resting form
The panel used to be on screen the whole time Mull was running, and almost all of that time it was idle: a hollow orb, a static waveform and a hint, holding 480px of somebody else's window to report that nothing was happening. At rest Mull is now a 60×65 pixel cat, bottom-centred on the same stage, and the panel grows upward from it. The pet never moves — it is the one fixed point, and it is the drag handle for the whole HUD.

**When the panel is up.** `demands || (wanted ?? linger)`, where `demands` is anything that is not plain idle — a card, a notice, or any phase but `idle`. A card waiting on ⏎ is never behind a click: a proposal nobody can see is a proposal nobody answers. `wanted` is the user's own click, which outranks the rules and is null until they make one; `linger` holds the panel for **4s after `lastAction.at`**, because `applied` itself lasts only 1 400ms and without it the last-action row and its `⌥Z undo` hint would appear and vanish inside a second and a half. A click can only fold a panel nothing else is holding open, and the accessible name says so rather than offering a "hide" that would not hide.

**Clicks.** Decided on pointer-up by distance (≤4px travel, `isTap`), not by `onClick`: the pet is a button *and* the drag handle, and dragging the HUD across the screen must not fold the panel. 4px rather than 0 because a trackpad click drifts.

**The sprite.** `assets/marmalade.webp` — an 8 × 9 sheet of 192×208 cells, 57 frames, scaled 5/16 (the largest scale under half size leaving both axes whole: 60×65 per frame, 480×585 for the sheet). Never resampled offline; the transparent pixels carry undefined colour and a resample would drag it into the edges as a halo. The shadow is a CSS ellipse in `--ink`, not part of the art, so dark mode gets it for free. Every row used has its ink at y 5–202 within the cell, so the cat's feet hold one height across every mood.

| mood | when | row · frames | motion |
|---|---|---|---|
| `rest` | idle | 0 · 0–5 | loop 2.4s |
| `asleep` | idle, untouched 90s | 6 · 1 | held |
| `listening` | `listening` | 3 · 0–3 (wave) | loop 0.72s |
| `working` | `thinking` / `inserting` / `preview` | 8 · 0–5 (paw to chin) | loop 1.5s |
| `waiting` | a card is open | 6 · 0–5 | loop 2.2s — calm; it is owed a decision, it should not fidget |
| `done` | `applied` | 4 · 0–4 (leap) | once, `jump-none`, held on the landing |
| `trouble` | `blocked` / `error` / a notice | 5 · 4–7 | loop 2.4s |

Frames 0–3 of the sad row (stand, sit, wipe, curl) are skipped: their silhouettes are too different to loop without a pop. The one curled-up frame is mid-cry, which is why `asleep` is a held content-idle frame instead — a cat that weeps because you stopped typing is the wrong note. Walk and run go unused; they are the makings of a pet that wanders the screen, which is not built. `prefers-reduced-motion` freezes each mood on the first frame of its row.

### 6.2 Chips
11px/600, padding 3px 9px, `--r-chip`, 1px border, `rise-in` entrance. Vocabulary:
| Chip | Ground | Border | Text | Note |
|---|---|---|---|---|
| intent | `--ink` | `--ink` | `--on-ink` | the stamp — only filled chip; glyph ✎ |
| cmd | `--paper-bright` | `--hairline` | `--ink` | glyph ▸ |
| mem | `--mem-wash` | `--mem-edge` | `--mem` | glyph ◈; a real `<button>` with `aria-label="Show memory citation: {name}"` (hover deepens wash); opens citation popover |
| dict | `--paper-bright` | `--hairline` | `--ink-2` | plain "Dictation" |
| warn | `--warn-wash` | `--warn-edge` | `--warn` | e.g. "secure input — paused" |

**The ask chip (M5b).** Holding Fn raises a `cmd` chip reading "asking Mull · Fn" *while the key is still down*. ⌥Space raises nothing — it is the default and needs no announcement. Fn does, because those words are about to leave the Mac and be acted on, and the moment to learn that is before letting go rather than after. It also makes a mis-press visible: Fn has a lot of neighbours.
Key hints inside chips: mono 11px at 70% opacity.

### 6.3 Diff card
`--paper-bright`, 1px `--hairline`, `--r-inner`, padding 10px 12px 11px, `rise-in` at `--t-med`. Title row: 11px label style, `--ink-3` — "EDIT PREVIEW · {app}" left, "{n} changes" right. Body: mono 12px/1.7 in `--ink-2`, `max-height: var(--diff-max-h)` scroll (thin scrollbar), **the only scrollable region in the HUD**.
- `del`: `--del` text on `--del-wash`, 1.5px line-through in `--del-line`, radius 2px, padding 0 1px.
- `ins`: `--ins` text 600 on `--ins-wash`, no text-decoration, 1px bottom border `--ins-line`.
Actions row: `Apply ⏎` (filled `--ins`, text `--on-ins`, hover `--ins-hover`) and `Cancel esc` (ghost, `--hairline` border); the undo promise — "`⌥Z` undoes this after you apply it", 11px `--ink-3` — sits on its own line **directly beneath them** (`.promise`, §6.2a). The undo path is stated in the same breath as the action, and now in the same place as it.

**The second commit (M5a).** When the card carries a `commit`, a third button sits between Apply and Cancel: `Apply & send ⌘⏎`, outlined in ochre (`--warn` text, `--warn-wash` fill, `--warn-edge` border). Ochre because hue always means fact (§2) and this fact is *you cannot take this back* — not a louder Apply. It is never the filled button and never the default: ⏎ still applies and only applies, so a press out of habit lands text and sends nothing. The undo promise is replaced, not joined, by "sending can't be undone" in `--warn` — the old line is not true of the button beside it, and two promises is one too many to read at speed. The commit appears only when the user's own words asked to send *and* the app's send chord is known (`services/send-table.ts`); an app Mull has not been told about gets no button, because a guessed keystroke in someone else's window is the one mistake here that has no undo.

### 6.3b Send card (M5a)
For "send the message" — a composer the user has already filled, and a request for one keystroke. Same card shell; title "SEND · {app}" left, "already written" right. Body is the composer's **current contents, read back out of the app**, in `--ink-2` with no diff marks: nothing here is Mull's writing and it must not look like a proposal. Actions: `Send ⌘⏎` (the ochre send button, §6.3) and `Cancel esc`, with "sending can't be undone" right-aligned in `--warn`.

**No Apply, and ⏎ does nothing.** There is nothing to apply. Return stays globally claimed while the card is open and is swallowed — releasing it would let a stray press reach Slack and send the very message the card is still asking about. The text is re-read immediately before the keystroke and the send is refused if it changed, the same rule `stillMatches` applies to an edit.

### 6.4 Plan card (commands)
Same card shell and title style as the diff card ("PLAN · {n} steps" left; verb chip context right). Steps: mono 12px/1.7 rows, each `{index}. {verb} {object}` in `--ink-2`, with a right-aligned per-step state cell (mono, min-width 18px): pending `·` in `--ink-3` → running `…` in `--ins` → done `✓` in `--mem` → failed `✕` in `--del`. Running step's text lifts to `--ink`. Actions while it is a proposal or is walking: `Run ⏎` (filled `--ins`), `Cancel esc` / `Stop esc`, promise beneath ("read-only · nothing is written or sent"). Steps never auto-run; the card is a proposal until Run.

**Then it settles.** When the walk ends the card crosses to the `wont` family (§6.2a): the ground recesses, the title becomes "Answer · {app}", the goal row drops away, Run is replaced by a ghost `Done ⏎`, and the promise becomes a flat statement of fact ("Nothing was written · back in {window}"). The steps stay — they are how the answer was come by — but the answer itself is rendered **outside** the scrolling step body, in serif, so six steps cannot push the thing the user actually asked for out of sight beneath the thing that fetched it.

A press prints where it landed rather than the label the model chose: "press Anil Turaga → Anil Turaga (DM) · Slack", or that the window is still the one it started in. `AXPress` reports that an action was accepted, not that it did anything.

### 6.5 Journal row
Flex row: `--paper` ground, `--hairline` border, `--r-inner`, padding 11px 14px, `--shadow-row`. Cells: kind tag (11px/700 uppercase on `--ins-wash`/`--ins` — Edit; Dictation uses neutral `--paper-recessed`/`--ink-2`; Command uses `--ins-wash`; failed/undone uses `--del-wash`/`--del`) · app (`--ink-2`) · time (`--ink-3`, tabular) · — · summary (serif 13px `--ink`, quoted, ellipsized) · change count (`--ink-3`) · `Undo` ghost button. Row expands on click to before/after (diff-card styling reused). The list virtualizes past ~50 rows (`content-visibility: auto` at minimum); expanded state is reflected in the window's route/query so entries deep-link.

### 6.6 Buttons & kbd
Primary = filled `--ins`; secondary = ghost with `--hairline`; destructive-confirm = filled `--del` (rare). All: `--r-chip`, 12px/650, padding 5px 13px, `:active` translateY(1px), key hint mono at 75% opacity inside the label. `kbd`: mono 11px, `--paper-recessed` ground, `--hairline` border, `--r-kbd`, padding 0.5px 4px.

### 6.7 Menu-bar presence
Template glyph (monochrome, macOS-tinted): a small ink point. States: idle = hollow ring; listening = filled (system tint); working = filled + trailing dot; attention = filled with ochre dot badge. No custom colors in the menu bar beyond the badge.

### 6.8 Journal / Settings / Onboarding windows
Normal windows on `--paper`; headings serif `--fs-title`; section rules `--hairline`; prose `--fs-body`. Onboarding steps are a numbered manuscript: one step per page, live-verified state shown as the plan card's step states (·/…/✓).

**Onboarding flow** (prototype: `design/onboarding.html`) — five pages, footer nav with ink progress ticks + "Step n of 5", Back ghost / Continue filled `--ins` with ⏎ hint:
1. *A thinking layer for your Mac* — value prop + three tenets (on-device, preview-before-change, ⌥Z undo), with the real idle HUD embedded as an object so the user meets the instrument at rest.
2. *Every change shows its marks* — a **live** diff-card demo (brief's canonical sample); Apply/Cancel actually work; undo promise printed in the same breath.
3. *Three permissions, each with a reason* — Microphone / Accessibility / Input Monitoring as plan-style step rows (·/…/✓ state cells per §6.4), each stating its reason; each Grant button deep-links System Settings and the ✓ comes from live permission polling, never from the click. Secure-input pause disclosed up front via a warn chip.
4. *Your ears, kept local* — whisper model download with mono tabular progress; copy frames privacy as architecture ("the transcript never crosses the network").
5. *Try it here* — rehearsal sandbox: a practice note + real HUD; user holds ⌥Space (the actual hotkey once Input Monitoring is granted), speaks, watches idle → listening → thinking → applied, sees text land at the caret and the journal ghost with ⌥Z.

Pages the user can't complete yet (permission denied, no model) never block Continue — rows stay `·` and the app degrades gracefully; onboarding is re-enterable from Settings. These windows follow system appearance (light/dark). **The HUD follows system appearance too** (default); a "page in the dark" toggle (HUD stays paper-light in dark mode) may ship later as a setting — the token architecture supports it via `data-theme="light"` scoped to the HUD window.

## 7. Interaction rules (from the brief, binding)

1. HUD never takes focus; all affordances have held-modifier chords printed on them.
2. Every destructive-ish action shows its undo path in the same breath.
3. Glanceable in <1s; nothing scrolls in the HUD except the diff/plan body.
4. State transitions must read instantly (≤220ms); dictation never waits on the engine.
5. Chips announce classification *before* action; the diff/plan card is a proposal until the user commits.

## 8. Accessibility

- All text ≥ 4.5:1 against its actual ground in both themes (verified §9). 11px only in the three verified label styles.
- `:focus-visible`: 2px `--ins` outline, 2px offset — journal/settings/onboarding are fully keyboard-navigable. The HUD is not focusable by design; its actions are global chords, announced on the controls.
- Waveform/orb are `aria-hidden` decoration; the state label is the accessible state (`role="status"`, `aria-live="polite"` on transcript + state).
- `prefers-reduced-motion` per §5. `prefers-contrast: more`: hairlines → 0.32 alpha (add when settings ship).
- `color-scheme` follows the active theme (set in tokens.css) so native controls/scrollbars match; each window's `<meta name="theme-color">` matches `--paper`.
- **UX copy rules:** curly quotes ("…") and `…` never `...`; active voice, second person; numerals for counts ("2 changes"); button labels name the action ("Apply", not "OK"); errors state the fix, not just the problem; non-breaking space between key glyphs and their labels (`⌥Z`).

## 9. Verified contrast (WCAG AA, 2026-09-13)

Light: ink 14.34, ink-2 7.20, ink-3 4.85, del 5.83, ins 7.95, warn 4.67, mem 5.63, on-ink 15.08, on-ins 7.95.
Dark: ink 13.48, ink-2 8.15, ink-3 4.91, del 5.22, ins 7.00, warn 7.16, mem 8.31, on-ins 7.70.
(Each vs. its component ground. Re-run `scratch: contrast.mjs` pattern if tokens change; any token change re-verifies before merge.)
