# Mull — Design Brief (D1)

*Input to Phase D2 (four direction boards). Every board renders the same content in a different visual world. This brief is the shared contract; it says what must be shown and how it must behave — not how it should look.*

## 1. What Mull is

A macOS voice-first "thinking layer": hold a key, speak, and text lands in whatever app you're using. Beyond dictation it can edit selected text (streamed diff preview), run a small set of whitelisted commands (plan preview, per-step execution), and keep a local working memory that briefs its edits. Local-first: ASR runs on-device; the language engine is the user's own Claude subscription.

**The product's differentiator is legibility of AI behavior.** Alma and Wispr hide the machinery; Mull shows it: what was heard, what the AI intends to do, exactly what will change, and a journal that can undo it. The UI is the trust story.

## 2. Personality: *trustworthy instrument*

Like a good oscilloscope or a flight instrument: calm, precise, quietly confident. Never cute, never chatty, never "AI-magical." It reports state; it does not perform. Decoration only where it carries information (waveform = you are being heard; diff colors = what changes). If a direction feels like a consumer voice assistant, it is wrong. If it feels like a tool a professional trusts with their words, it is right.

Tone words: **precise, calm, legible, honest, quick.**
Anti-words: playful, bubbly, gradient-magic, sci-fi glow, skeuomorphic.

## 3. Surfaces

1. **HUD** — the hero surface. A frameless, non-activating floating panel near the bottom of the screen (`type:'panel'`, transparent window, always-on-top). Never takes focus; keyboard hints refer to held-modifier chords, not focused buttons. Compact: roughly 380–560px wide, grows vertically only when a card appears.
2. **Journal window** — a normal window: chronological list of everything Mull did (dictations, edits, commands), each entry with before/after and an Undo affordance.
3. **Onboarding wizard** — mic permission → Accessibility (live-verified) → model download → engine sign-in or "skip: local-only."
4. **Settings** — hotkey, per-app insertion behavior, dictionary editor, memory timeline/prune, privacy toggles.
5. **Menu-bar presence** — a template glyph with states: idle / listening / working / attention.

Boards must render: **HUD in 3 states + one journal entry + palette/type specimen.** Onboarding/settings/menu-bar can be described in a sentence or skipped.

## 4. HUD anatomy & the 3 states to render

Shared anatomy (from the validated mock `docs/mock/mull-playground.html`):
- **Orb** — small status dot/element; pulses while listening.
- **Waveform** — live input level; the "you are being heard" signal.
- **State label** — tiny uppercase word: `idle`, `listening`, `thinking`, `applied`.
- **Transcript line** — the words as heard, appearing live.
- **Chips row** — small pills that announce classification and context:
  - `intent` chip (e.g. "✎ Edit — tighten selection") — the router's decision, visible before anything happens.
  - `cmd` chip (e.g. "▸ Command — 3 steps") — a whitelisted command was recognized.
  - `mem` chip (e.g. "◈ using: Q3 thread") — working memory being cited; clickable to inspect.
  - `dict` chip — plain dictation route.
  - `warn` chip (e.g. "secure input — paused", "rate limit — local-only").
  - Chips may carry a keyboard hint (e.g. `⌥Z undo`).
- **Diff card** — appears for edits: title row, scrollable diff body (`del` = removed, `ins` = added), Apply / Cancel buttons with key hints.
- **Plan card** — appears for commands: numbered steps, each with a live per-step state (`…` → `✓`), Run / Cancel.

**State A — Idle**: orb static, label `idle`, quiet waveform, maybe last-action ghost. The HUD at its most invisible.
**State B — Listening**: orb pulsing, waveform live, partial transcript appearing, an intent chip just landed.
**State C — Diff preview**: transcript settled, `intent` + `mem` chips, diff card open with a realistic before/after (use a real sentence-tightening example), Apply/Cancel visible.

Sample content boards should reuse (verbatim, so boards are comparable):
- Transcript: *"tighten this up and make it sound less apologetic"*
- Diff: `del` "I'm so sorry to bother you again, but I was just wondering if maybe" → `ins` "Following up:" … `del` "whenever you get a chance, no rush at all" → `ins` "by Friday".
- Journal entry: *Edit · Mail · 2:41 PM — "tighten + de-apologize" · 2 changes · Undo*
- Memory chip: *◈ using: Q3 planning thread*

## 5. Hard constraints (every direction must satisfy)

1. **Legible over any wallpaper.** The HUD floats over user content — photos, terminals, white docs. It needs its own ground (solid or heavily frosted surface + real contrast), never naked text over blur.
2. **macOS light + dark.** Directions may lead with one appearance but must state how the other resolves. The HUD itself may be appearance-invariant (e.g. always-dark glass) if the journal/settings adapt.
3. **Sub-second state transitions.** Motion is 120–250ms, ease-out, mostly opacity/transform. State changes must read instantly; nothing bounces, nothing blocks.
4. **`prefers-reduced-motion`**: pulse/wave animations degrade to static level indicators; transitions become fades.
5. **Small-type discipline.** Much of the HUD is 11–13px; the type choice must survive that size on non-retina. Diff body is monospace or mono-adjacent.
6. **Color carries meaning**: added / removed / warning / memory-citation each need a stable hue; everything else stays neutral. Don't spend accent color on decoration.
7. **Density**: HUD is glanceable in <1s; journal is scannable; nothing scrolls inside the HUD except the diff body.
8. **Honesty affordances**: every destructive-ish action shows its undo path in the same breath (Apply · ⌥Z to undo).

## 6. The four directions (D2)

| # | Name | World | Lead appearance |
|---|------|-------|-----------------|
| 1 | **Instrument** | dark optical glass, precision hairlines, mono data voice — an oscilloscope you talk to | dark |
| 2 | **Studio paper** | warm light editorial, ink-on-paper diffs, book typography — a manuscript being marked up | light |
| 3 | **Signal brutalist** | industrial terminal grid, stencil/uppercase labels, raw meters — declassified equipment | dark |
| 4 | **Quiet minimal** | type-only hierarchy, muted monochrome, almost no chrome — the UI is barely there | light |

Each board: one self-contained HTML page presenting the direction like an agency board — direction name + one-line thesis, the 3 HUD states rendered at real size over a realistic desktop backdrop, one journal entry, palette swatches with hex + role, type specimen (family, sizes, tracking), and a short "why this fits *trustworthy instrument*" note. Boards commit to their own look (they are not theme-adaptive; they document how the other appearance would resolve).

## 7. What D3 will extract from the winner

Tokens (color, type scale, radii, spacing, elevation, motion durations/easings), component specs for HUD/chips/cards/journal row, and `src/renderer/tokens.css`. Boards should therefore be built with CSS custom properties, not hardcoded one-offs, so the winner converts cleanly.
