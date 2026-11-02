#!/usr/bin/env bash
# scripts/m7-validate.sh — Manual validation for the M7 milestone gate.
set -u
set -o pipefail
cd "$(dirname "$0")/.."
CLI=(pnpm exec tsx ./src/cli.ts)

step() { printf "\n=== %s ===\n" "$1"; }

step "pnpm typecheck"; pnpm typecheck
step "pnpm lint"; pnpm lint
step "pnpm test"; pnpm test

step "moss inventory --print-config"
"${CLI[@]}" inventory --print-config | head -20

step "moss inventory --check (enabled fixture config)"
"${CLI[@]}" inventory --check --json

step "moss inventory (fixture corpus scan)"
"${CLI[@]}" inventory --json | head -40

step "moss inventory --review-queue"
"${CLI[@]}" inventory --review-queue | head -20

step "moss convert --all"
"${CLI[@]}" convert --all

step "moss --help includes inventory + convert"
"${CLI[@]}" --help | grep -E '\binventory\b|\bconvert\b'

echo
echo "M7 manual validation complete."
