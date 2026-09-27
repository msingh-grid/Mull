# Third-party notices

Mull itself is private and unlicensed (`"license": "UNLICENSED"` in
`package.json`). It is built on, and ships with, the work of others. Licences
below were read from each package's own `package.json` / `LICENSE` in
`node_modules` on 26 Sep 2026.

## Shipped inside the app

| Component | Version | Licence | Notes |
|---|---|---|---|
| Electron (incl. Chromium, Node.js) | 44.x | MIT | Chromium's own third-party licences ship as `LICENSES.chromium.html` in the app bundle |
| React, React DOM | 19.3.0 | MIT | © Meta Platforms, Inc. |
| framer-motion | 13.4.0 | MIT | |
| zod | 4.6.4 | MIT | |
| electron-log | 5.4.4 | MIT | |
| diff (jsdiff) | 9.0.0 | BSD-3-Clause | © 2009–2015 Kevin Decker |
| better-sqlite3 | 13.0.3 | MIT | Bundles the SQLite amalgamation (public domain) |
| uiohook-napi | 1.5.5 | MIT | © 2020 Alexander Drozdov. **Bundles libuiohook, LGPL-3.0** (© 2006–2023 Alexander Barker), compiled into the native addon. LGPL-3.0 requires this notice and that users can relink against a modified libuiohook; the addon is a separate `.node` file, which permits that. Source: https://github.com/SnosMe/uiohook-napi (vendors https://github.com/kwhat/libuiohook) |
| @anthropic-ai/sdk | 0.125.0 | MIT | |
| @anthropic-ai/claude-agent-sdk (+ darwin-arm64 binary) | 0.3.270 | Proprietary — © Anthropic PBC | Use governed by Anthropic's Commercial Terms of Service: https://code.claude.com/docs/en/legal-and-compliance |

The Swift sidecar (`mull-mac/`) has no package dependencies.

## Installed or downloaded by the user, not bundled

| Component | Licence | How it arrives |
|---|---|---|
| whisper.cpp (`whisper-cli`) | MIT | `brew install whisper-cpp` |
| Whisper model weights (`ggml-*.en.bin`) — OpenAI Whisper, converted by ggerganov | MIT | Downloaded on an explicit click from `huggingface.co/ggerganov/whisper.cpp` |
| Silero VAD (`ggml-silero-v5.1.2.bin`) | MIT | Optional, from `huggingface.co/ggml-org/whisper-vad` |
| OpenAI Codex CLI | See upstream (github.com/openai/codex) | Optional; the user's own install, used by the experimental Codex lane |

## Art

| Asset | Source | Licence / attribution |
|---|---|---|
| App icon (`icons/main_app.svg` → `build/icon.png`) | The Noun Project | "Created by **Aaz** from the Noun Project" — Noun Project free-use licence, which requires this attribution (Creative Commons Attribution). The credit was stripped from the SVG in commit 6e0623d; this notice restores the attribution. |
| Menu-bar icon (`icons/top_bar.svg`) | The Noun Project | "Created by **Dan Vo** from the Noun Project" — as above. |
| Resting-state cat, "Marmalade" (`pet/cat/spritesheet.webp`, `src/renderer/assets/marmalade.webp`) | [codexpets.net/gallery/marmalade](https://codexpets.net/gallery/marmalade), created by **danielvictorino** on CodexPets.net (a community gallery of pet packages for the Codex app); downloaded by Mohit Singh, commit dfff485 | The resource page states no licence of its own, so the site's terms apply: "provided for personal, non-commercial use unless a specific resource page states otherwise", and "You may not redistribute, resell, or claim ownership of resources downloaded from this site." ⚠ Fine for this coursework prototype; **must be replaced (or licensed in writing) before any public or commercial release**, since shipping it in a DMG is redistribution. |

Fonts: none are bundled. The interface uses macOS system fonts (New York, SF
Pro, SF Mono) through `ui-serif` / `-apple-system` / `ui-monospace` stacks
(`src/renderer/tokens.css`).

## Development-time only (not shipped)

`.agents/skills/` and `.claude/skills/` hold prompt files used by AI coding
assistants while building Mull (sources in `skills-lock.json`):
`anthropics/skills` — `frontend-design` (Apache-2.0, `LICENSE.txt` included);
`Leonxlnx/taste-skill`, `pbakaus/impeccable`, `vercel-labs/agent-skills` (no
licence file in the repo; see each upstream repository).

## Trademarks

Claude and Anthropic are trademarks of Anthropic PBC; ChatGPT, Codex and
Whisper of OpenAI; Slack, Chrome, Safari, VS Code, Notion and other application
names mentioned in code and docs belong to their owners and are named only to
describe compatibility. Competitor names in `docs/` (Alma, Wispr Flow,
superwhisper and others) appear in research for comparison only. Mull is not
affiliated with or endorsed by any of them.
