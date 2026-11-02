#!/usr/bin/env bash
# scripts/m8-validate.sh — Manual validation for the M8 milestone gate.
set -u
set -o pipefail
cd "$(dirname "$0")/.."
CLI=(pnpm exec tsx ./src/cli.ts)
TAG="m8-smoke-$(date +%s)"

step() { printf "\n=== %s ===\n" "$1"; }

step "pnpm typecheck"; pnpm typecheck
step "pnpm lint"; pnpm lint
step "pnpm test"; pnpm test

step "moss remember (create)"
"${CLI[@]}" remember "M8 validation note" --tag "$TAG" --type note --json

step "moss recall --tag"
"${CLI[@]}" recall --tag "$TAG" --json

step "moss compact"
"${CLI[@]}" compact --tag "$TAG" --output "validate-${TAG}" --json

step "moss forget (tombstone latest entry)"
ID=$("${CLI[@]}" recall --tag "$TAG" --json | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);console.log(j.entries[0]?.id??"")})')
if [[ -n "$ID" ]]; then
  "${CLI[@]}" forget "$ID" --json
fi

step "moss --help includes memory commands"
"${CLI[@]}" --help | grep -E '\bremember\b|\brecall\b|\bcompact\b|\bforget\b'

echo
echo "M8 manual validation complete."
