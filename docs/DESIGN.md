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
- `is-idle` — orb hollow (inset 1.5px ring in `--ink-3`), waveform static low ticks in `--ink-3`, transcript shows ghost hint (*"Hold ⌥Space and speak"*, serif italic `--ink-3`), label `IDLE` in `--ink-3`. Optional `last-action` ghost row: hairline-top, 11px `--ink-3`, "Applied · summary · time" + `⌥Z undo` kbd right-aligned.
- `is-listening` — orb fills `--ink` + ping; bars animate in `--ink-2`; transcript streams live with `--ins` caret; label `LISTENING` in `--ink`; intent chip rises in as soon as the router decides.
- `is-thinking` — same as listening but static waveform, label `THINKING`; used while the engine streams.
- `is-preview` — diff or plan card open; label `THINKING` until card completes, then `PREVIEW`.
- `is-applied` — label `APPLIED`, brief; then back to idle with the new last-action ghost.

### 6.2 Chips
11px/600, padding 3px 9px, `--r-chip`, 1px border, `rise-in` entrance. Vocabulary:
| Chip | Ground | Border | Text | Note |
|---|---|---|---|---|
| intent | `--ink` | `--ink` | `--on-ink` | the stamp — only filled chip; glyph ✎ |
| cmd | `--paper-bright` | `--hairline` | `--ink` | glyph ▸ |
| mem | `--mem-wash` | `--mem-edge` | `--mem` | glyph ◈; a real `<button>` with `aria-label="Show memory citation: {name}"` (hover deepens wash); opens citation popover |
| dict | `--paper-bright` | `--hairline` | `--ink-2` | plain "Dictation" |
| warn | `--warn-wash` | `--warn-edge` | `--warn` | e.g. "secure input — paused" |
Key hints inside chips: mono 11px at 70% opacity.

### 6.3 Diff card
`--paper-bright`, 1px `--hairline`, `--r-inner`, padding 10px 12px 11px, `rise-in` at `--t-med`. Title row: 11px label style, `--ink-3` — "EDIT PREVIEW · {app}" left, "{n} changes" right. Body: mono 12px/1.7 in `--ink-2`, `max-height: var(--diff-max-h)` scroll (thin scrollbar), **the only scrollable region in the HUD**.
- `del`: `--del` text on `--del-wash`, 1.5px line-through in `--del-line`, radius 2px, padding 0 1px.
- `ins`: `--ins` text 600 on `--ins-wash`, no text-decoration, 1px bottom border `--ins-line`.
Actions row: `Apply ⏎` (filled `--ins`, text `--on-ins`, hover `--ins-hover`), `Cancel esc` (ghost, `--hairline` border), and right-aligned undo promise: "`⌥Z` undoes after apply" (11px `--ink-3`). The undo path is stated in the same breath as the action — always.

**The second commit (M5a).** When the card carries a `commit`, a third button sits between Apply and Cancel: `Apply & send ⌘⏎`, outlined in ochre (`--warn` text, `--warn-wash` fill, `--warn-edge` border). Ochre because hue always means fact (§2) and this fact is *you cannot take this back* — not a louder Apply. It is never the filled button and never the default: ⏎ still applies and only applies, so a press out of habit lands text and sends nothing. The undo promise is replaced, not joined, by "sending can't be undone" in `--warn` — the old line is not true of the button beside it, and two promises is one too many to read at speed. The commit appears only when the user's own words asked to send *and* the app's send chord is known (`services/send-table.ts`); an app Mull has not been told about gets no button, because a guessed keystroke in someone else's window is the one mistake here that has no undo.

### 6.4 Plan card (commands)
Same card shell and title style as the diff card ("PLAN · {n} steps" left; verb chip context right). Steps: mono 12px/1.7 rows, each `{index}. {verb} {object}` in `--ink-2`, with a right-aligned per-step state cell (mono, min-width 18px): pending `·` in `--ink-3` → running `…` in `--ins` → done `✓` in `--mem` → failed `✕` in `--del`. Running step's text lifts to `--ink`. Actions: `Run ⏎` (filled `--ins`), `Cancel esc`, undo promise right ("each step journaled"). Steps never auto-run; the card is a proposal until Run.

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
