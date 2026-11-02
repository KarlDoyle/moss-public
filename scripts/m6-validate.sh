#!/usr/bin/env bash
# scripts/m6-validate.sh — Manual validation for the M6 milestone gate.
set -u
set -o pipefail
cd "$(dirname "$0")/.."
CLI=(pnpm exec tsx ./src/cli.ts)

step() { printf "\n=== %s ===\n" "$1"; }

step "pnpm typecheck"; pnpm typecheck
step "pnpm lint"; pnpm lint
step "pnpm test"; pnpm test

step "moss tools --print-config"
"${CLI[@]}" tools --print-config | head -20

step "moss tools --check (expect non-zero when disabled/absent)"
"${CLI[@]}" tools --check || true

step "moss --help includes tools"
"${CLI[@]}" --help | grep -E '\btools\b'

echo
echo "M6 manual validation complete."
