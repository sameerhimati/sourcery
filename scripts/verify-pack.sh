#!/usr/bin/env bash
# Publish gate: the npm tarball must install into a clean directory and behave —
# help lists every command, and a keyless run fails fast with the friendly error,
# not a stack trace. This is what "works on a machine that never saw the repo" means.
set -euo pipefail

cd "$(dirname "$0")/.."
npm test
npm run lint
npm run build:cli

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
npm pack --pack-destination "$scratch" >/dev/null
cd "$scratch"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund ./sourcery-eval-*.tgz >/dev/null

help_out="$(npx sourcery --help)"
for cmd in init run batch credibility report providers; do
  echo "$help_out" | grep -q "$cmd" || { echo "FAIL: --help missing '$cmd'"; exit 1; }
done

set +e
out="$(env -u OPENAI_API_KEY -u FIREWORKS_API_KEY npx sourcery run "test query" 2>&1)"
code=$?
set -e
[ "$code" -eq 1 ] || { echo "FAIL: keyless run exited $code (want 1)"; exit 1; }
echo "$out" | grep -q "Missing required env" || { echo "FAIL: keyless run error not friendly:"; echo "$out"; exit 1; }

echo "verify-pack: PASS"
