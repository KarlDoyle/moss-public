#!/usr/bin/env bash
# scripts/v0.1.0-validate.sh — Final release validation for Moss v0.1.0.
set -u
set -o pipefail
cd "$(dirname "$0")/.."
CLI=(pnpm exec tsx ./src/cli.ts)

step() { printf "\n=== %s ===\n" "$1"; }

step "pnpm typecheck"; pnpm typecheck
step "pnpm lint"; pnpm lint
step "pnpm test"; pnpm test

step "moss --version"; "${CLI[@]}" --version

step "moss --help (full surface)"
"${CLI[@]}" --help

step "moss doctor --json"; "${CLI[@]}" doctor --json | head -20

step "moss auth --json"; "${CLI[@]}" auth --json | head -30

step "moss skills --json"; "${CLI[@]}" skills --json

step "moss inventory --check --json"; "${CLI[@]}" inventory --check --json || true

step "memory smoke"
TAG="release-$(date +%s)"
"${CLI[@]}" remember "v0.1.0 release validation" --tag "$TAG" --json
"${CLI[@]}" recall --tag "$TAG" --json | head -20

echo
echo "v0.1.0 manual validation complete."
