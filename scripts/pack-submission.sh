#!/usr/bin/env bash
# Build the course submission ZIP from the working tree.
#
#   bash scripts/pack-submission.sh Saaketh_Koduri   # → ../Mull_submission_Saaketh_Koduri.zip
#
# Takes exactly what git would: tracked files plus untracked files that are not
# ignored — so node_modules/, out/, release/, mull-mac/.build/, *.tsbuildinfo,
# .env and .DS_Store never get in. On top of .gitignore it drops the one thing
# git tracks that must not ship: the competitor DMG in docs/alma-app/ (a
# third-party proprietary binary, kept locally for research only).
#
# Then it checks the archive rather than trusting the filter: no forbidden
# paths, no secret-looking strings, under 500 MB uncompressed, and the role
# evidence file for the named learner present.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${1:?usage: pack-submission.sh <First_Last>}"
OUT="$(cd .. && pwd)/Mull_submission_${NAME}.zip"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT

{ git ls-files; git ls-files --others --exclude-standard; } \
  | grep -v -E '^docs/alma-app/|(^|/)\.DS_Store$|(^|/)\.env(\..*)?$|\.dmg$' \
  | grep -v -E "^ROLE_EVIDENCE_" \
  | sort -u > "$LIST"

echo "ROLE_EVIDENCE_${NAME}.md" >> "$LIST"   # only this learner's role evidence

rm -f "$OUT"
zip -q -X "$OUT" -@ < "$LIST"

echo "Checking $OUT"
fail=0
listing="$(unzip -Z1 "$OUT")"

if grep -E '(^|/)(node_modules|out|release|dist|\.build|\.venv|venv)/|\.env$|\.dmg$|\.tsbuildinfo$' <<<"$listing"; then
  echo "✗ forbidden paths above"; fail=1
fi
if unzip -p "$OUT" | grep -a -E -q 'sk-ant-(api|oat|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY'; then
  echo "✗ something that looks like a real credential is inside the archive"; fail=1
fi
bytes="$(unzip -l "$OUT" | tail -1 | awk '{print $1}')"
if (( bytes >= 500 * 1024 * 1024 )); then echo "✗ ${bytes} bytes uncompressed ≥ 500 MB"; fail=1; fi
grep -q "^ROLE_EVIDENCE_${NAME}.md$" <<<"$listing" || { echo "✗ ROLE_EVIDENCE_${NAME}.md missing"; fail=1; }
for f in README.md package-lock.json submission/BUSINESS_MODEL_CANVAS.md submission/PRICING.md \
         submission/ROADMAP.md submission/DECISION_LOG.md submission/AI_DISCLOSURE.md \
         submission/research/INTERVIEWS.md submission/research/USER_TRACES.md; do
  grep -q "^${f}$" <<<"$listing" || { echo "✗ $f missing"; fail=1; }
done
grep -q -E '^submission/PITCH_DECK\.(pdf|pptx)$' <<<"$listing" \
  || echo "! submission/PITCH_DECK.pdf not found — export the deck and re-run"
pending="$(unzip -p "$OUT" 'submission/*' 'ROLE_EVIDENCE_*' 2>/dev/null | grep -c -E 'EVIDENCE PENDING|TO COMPLETE|TEAM TO FILL' || true)"
(( pending == 0 )) || echo "! ${pending} placeholder lines still open (EVIDENCE PENDING / TO COMPLETE / TEAM TO FILL)"

(( fail == 0 )) || exit 1
echo "✓ $(wc -l < "$LIST" | tr -d ' ') files, $(( bytes / 1024 / 1024 )) MB uncompressed, $(du -h "$OUT" | cut -f1) zipped"
