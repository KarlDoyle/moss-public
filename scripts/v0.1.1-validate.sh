#!/usr/bin/env bash
# scripts/v0.1.1-validate.sh — release validation for Moss v0.1.1.
set -euo pipefail
cd "$(dirname "$0")/.."

CLI=(pnpm exec tsx ./src/cli.ts)

step() { printf "\n=== %s ===\n" "$1"; }

step "pnpm typecheck"
pnpm typecheck

step "pnpm lint"
pnpm lint

step "pnpm test"
pnpm test

step "moss --version"
VERSION="$("${CLI[@]}" --version)"
printf "%s\n" "$VERSION"
test "$VERSION" = "0.1.1"

step "moss doctor"
"${CLI[@]}" doctor

step "moss auth"
"${CLI[@]}" auth

step "moss ask --explain"
"${CLI[@]}" ask --explain

step "moss ask --context-file"
"${CLI[@]}" ask --context-file docs/AI_REVIEW_CONTEXT.md "What can Moss do?"

step "moss remember --type milestone"
TAG="v0.1.1-validate-$(date +%s)"
"${CLI[@]}" remember "v0.1.1 validation milestone" --type milestone --tag "$TAG" --json
"${CLI[@]}" recall --tag "$TAG" --json | head -40

step "moss inventory/convert fixture"
"${CLI[@]}" inventory --check --json
"${CLI[@]}" inventory
"${CLI[@]}" convert --all

echo
echo "v0.1.1 validation complete."
