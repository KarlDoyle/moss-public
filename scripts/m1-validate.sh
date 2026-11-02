#!/usr/bin/env bash
# scripts/m1-validate.sh — Manual validation for the M1 milestone gate.
#
# Read-only against the host (no installs, no global changes). Live Ollama call
# is attempted only when `moss doctor` reports the daemon up; otherwise the
# step is skipped with a clear note.
#
# Run from the project root: `bash scripts/m1-validate.sh`.

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

step "moss models --refresh"
"${CLI[@]}" models --refresh
REFRESH_RC=$?

step "moss models"
"${CLI[@]}" models
MODELS_RC=$?

step "moss models --explain ask"
"${CLI[@]}" models --explain ask
EXPLAIN_RC=$?

if [ "$DAEMON_UP" = "yes" ]; then
  step "moss ask (live)"
  "${CLI[@]}" ask "Reply with exactly the three words: moss is live."
  ASK_RC=$?
else
  step "moss ask (skipped — daemon or model unavailable per doctor)"
  ASK_RC=0
fi

step "Summary"
printf "typecheck:        %s\n" "$([ $TYPECHECK_RC -eq 0 ] && echo ok || echo "FAIL ($TYPECHECK_RC)")"
printf "lint:             %s\n" "$([ $LINT_RC -eq 0 ] && echo ok || echo "FAIL ($LINT_RC)")"
printf "test:             %s\n" "$([ $TEST_RC -eq 0 ] && echo ok || echo "FAIL ($TEST_RC)")"
printf "models --refresh: %s\n" "$([ $REFRESH_RC -eq 0 ] && echo ok || echo "FAIL ($REFRESH_RC)")"
printf "models:           %s\n" "$([ $MODELS_RC -eq 0 ] && echo ok || echo "FAIL ($MODELS_RC)")"
printf "models --explain: %s\n" "$([ $EXPLAIN_RC -eq 0 ] && echo ok || echo "FAIL ($EXPLAIN_RC)")"
printf "ask:              %s\n" "$([ $ASK_RC -eq 0 ] && echo ok || echo "FAIL ($ASK_RC)")"

FAIL=$((TYPECHECK_RC + LINT_RC + TEST_RC + REFRESH_RC + MODELS_RC + EXPLAIN_RC + ASK_RC))
if [ $FAIL -ne 0 ]; then
  exit 1
fi
