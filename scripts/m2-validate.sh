#!/usr/bin/env bash
# scripts/m2-validate.sh — Manual validation for the M2 milestone gate.
#
# Builds on m1-validate.sh and additionally exercises the new M2 surface:
# `moss skills`, `moss plan`, and `moss run code-review` (live when Ollama is up).
#
# Read-only against the host (no installs, no global changes). Live model
# invocation is attempted only when `moss doctor` reports the daemon up.
#
# Run from the project root: `bash scripts/m2-validate.sh`.

set -u
set -o pipefail

cd "$(dirname "$0")/.."

CLI=(pnpm exec tsx ./src/cli.ts)

step() {
  printf "\n=== %s ===\n" "$1"
}

step "pnpm typecheck"
pnpm typecheck
TYPECHECK_RC=$?

step "pnpm lint"
pnpm lint
LINT_RC=$?

step "pnpm test"
pnpm test
TEST_RC=$?

step "moss --help"
"${CLI[@]}" --help

step "moss doctor --json"
DOCTOR_OUT=$("${CLI[@]}" doctor --json)
echo "$DOCTOR_OUT"
DAEMON_UP=$(printf '%s' "$DOCTOR_OUT" | node -e "
  let buf=''; process.stdin.on('data',c=>buf+=c); process.stdin.on('end',()=>{
    try { const j=JSON.parse(buf); console.log(j.ollama && j.ollama.reachable && (j.ollama.models||[]).length>0 ? 'yes':'no'); }
    catch { console.log('no'); }
  });
" <<< "$DOCTOR_OUT")

step "moss skills"
"${CLI[@]}" skills
SKILLS_RC=$?

step "moss plan code-review"
"${CLI[@]}" plan code-review
PLAN_RC=$?

if [ "$DAEMON_UP" = "yes" ]; then
  step "moss run code-review (live)"
  # No --write-report: when the target IS the Moss project, the M2 hardening
  # refuses to write a report inside the target. The "target repo unchanged"
  # guarantee is the invariant we actually want to prove here, so we snapshot
  # before/after and assert byte-identical state regardless.
  BEFORE_HEAD=$(git rev-parse HEAD)
  BEFORE_STATUS=$(git status --porcelain=v1)
  "${CLI[@]}" run code-review
  RUN_RC=$?
  AFTER_HEAD=$(git rev-parse HEAD)
  AFTER_STATUS=$(git status --porcelain=v1)
  if [ "$BEFORE_HEAD" != "$AFTER_HEAD" ] || [ "$BEFORE_STATUS" != "$AFTER_STATUS" ]; then
    echo "ERROR: target repo (this repo) changed during \`moss run\`. M2 invariant violated."
    UNCHANGED_RC=1
  else
    UNCHANGED_RC=0
  fi
else
  step "moss run code-review (skipped — daemon or model unavailable per doctor)"
  RUN_RC=0
  UNCHANGED_RC=0
fi

step "Summary"
printf "typecheck:                %s\n" "$([ $TYPECHECK_RC -eq 0 ] && echo ok || echo "FAIL ($TYPECHECK_RC)")"
printf "lint:                     %s\n" "$([ $LINT_RC -eq 0 ] && echo ok || echo "FAIL ($LINT_RC)")"
printf "test:                     %s\n" "$([ $TEST_RC -eq 0 ] && echo ok || echo "FAIL ($TEST_RC)")"
printf "skills:                   %s\n" "$([ $SKILLS_RC -eq 0 ] && echo ok || echo "FAIL ($SKILLS_RC)")"
printf "plan code-review:         %s\n" "$([ $PLAN_RC -eq 0 ] && echo ok || echo "FAIL ($PLAN_RC)")"
printf "run code-review:          %s\n" "$([ $RUN_RC -eq 0 ] && echo ok || echo "FAIL ($RUN_RC)")"
printf "target repo unchanged:    %s\n" "$([ $UNCHANGED_RC -eq 0 ] && echo ok || echo "FAIL ($UNCHANGED_RC)")"

FAIL=$((TYPECHECK_RC + LINT_RC + TEST_RC + SKILLS_RC + PLAN_RC + RUN_RC + UNCHANGED_RC))
if [ $FAIL -ne 0 ]; then
  exit 1
fi
