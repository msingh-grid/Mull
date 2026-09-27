#!/usr/bin/env bash
# One command from a fresh checkout to a running Mull.
#
#   npm run setup            # install, build the sidecar, fetch the model, launch
#   npm run setup -- --no-run
#
# Every step is idempotent, so re-running after a failure picks up where it
# stopped. Nothing here downloads silently: each step says what it is fetching
# and how large it is before it starts.
set -euo pipefail

cd "$(dirname "$0")/.."

RUN=1
[[ "${1:-}" == "--no-run" ]] && RUN=0

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "Checking this machine"
[[ "$(uname -s)" == "Darwin" ]] || fail "Mull is macOS-only (it drives the Accessibility APIs). On another OS, run 'npm ci && npm run verify' to typecheck and test."
[[ "$(uname -m)" == "arm64" ]] || echo "  warning: developed on Apple silicon; Intel is untested."
command -v node >/dev/null || fail "Node is not installed (need >= 22.5)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || fail "Node $(node -v) is too old; need >= 22.5 (the tests use node:sqlite)."
command -v swift >/dev/null || fail "swift not found. Install the Xcode command line tools: xcode-select --install"
echo "  node $(node -v) · $(swift --version 2>&1 | head -1 | sed 's/.*Swift version \([0-9.]*\).*/swift \1/')"

step "Speech engine (whisper.cpp)"
if [[ -n "${MULL_WHISPER_CLI:-}" ]] || command -v whisper-cli >/dev/null || command -v whisper-cpp >/dev/null; then
  echo "  found"
elif command -v brew >/dev/null; then
  echo "  installing with Homebrew: brew install whisper-cpp"
  brew install whisper-cpp
else
  fail "whisper-cli not found and Homebrew is not installed. Install whisper.cpp, or set MULL_WHISPER_CLI."
fi

step "JavaScript dependencies (npm ci — from package-lock.json)"
npm ci

step "Swift sidecar (swift build -c release)"
npm run build:sidecar

step "Speech model (ggml-small.en.bin, ~466 MB, skipped if already present)"
npm run fetch:model

if [[ $RUN -eq 1 ]]; then
  step "Launching Mull — macOS will ask for Microphone, Accessibility and Input Monitoring"
  exec npm run dev
else
  printf '\nReady. Start Mull with: npm run dev\n'
fi
