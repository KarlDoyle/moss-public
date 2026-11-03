# Moss readiness review — 3 November 2026

**Decision: keep Experimental; not release-ready.** The evidence supports a narrow portfolio demonstration of routing, bounded prompts, local diff reviews, advisory accounting and approved hosted text patches. It does not establish portable distribution, live provider compatibility, model quality or safe use of every optional integration.

## Reviewed version and evidence

The final dependency merge on public `main` is `6b6c9f04e1c1e469d2c9d7c6f5495da32027b4a1`. Its [CI passed](https://github.com/KarlDoyle/moss-public/actions/runs/41629974866), separately from local validation. PRs [#4](https://github.com/KarlDoyle/moss-public/pull/4), [#5](https://github.com/KarlDoyle/moss-public/pull/5), [#6](https://github.com/KarlDoyle/moss-public/pull/6), [#7](https://github.com/KarlDoyle/moss-public/pull/7) and [#8](https://github.com/KarlDoyle/moss-public/pull/8) contain the documentation and four remediation phases; dependency PRs #1 and #2 are merged. [Issue #3](https://github.com/KarlDoyle/moss-public/issues/3) is closed with routing/accounting verification evidence.

This review reconciles the 2 November readiness findings with those changes and the Aider-deprecation patch accompanying this document. It is source inspection plus regression validation, not a fresh exhaustive security scan. Historical report line numbers refer to the old tree.

## Original findings reconciled

| Finding | Current disposition | Evidence and remaining boundary |
|---|---|---|
| R1: executable included Git configuration | Addressed in Moss-owned Git operations by PR #5 | `git.ts` inspects effective configuration before affected operations; `git-preflight.test.ts` covers direct, included, conditional, global, command and worktree configuration. Concurrent mutation remains outside the preflight contract. |
| R2: API switch/budget bypass and ask preview mismatch | Addressed by PR #6; issue #3 closed | `provider-intent.test.ts` covers disabled/exhausted/unpriced/unknown-balance refusal, fallback rechecks and preview/dispatch parity. Two routers remain, sharing constraints and API eligibility checks. |
| R3: bundled reviews could fall back to hosted | Addressed by PR #6 | Bundled reviews pin Ollama; fixtures assert no hosted probe or generation on success, outage and missing-model paths. |
| R4: edit lost session provider intent | Addressed by PR #6, with local editing now deprecated | Hosted pins reach planning/diff generation. Local edit pins now fail before route selection/provider probes and cannot broaden to hosted execution. |
| R5: unsupported patch formats bypassed scope | Addressed by PR #5 | Narrow existing-file text grammar rejects binary, rename/copy, mode-only, creation/deletion, malformed and inconsistent patches. Patch and real-Git approval tests cover supported and refused inputs. |
| R6: dangling output symlink enabled outside writes | Addressed by PR #5 | Patch text reaches Git via stdin, not a predictable output file. Symlink/collision regressions and byte/index comparisons cover approval, rejection, EOF and stage-only paths. |
| R7: sensitivity frontmatter bypass | Addressed by PR #7 in guarded supported reads | Bounded YAML parsing, schema checks and fail-closed handling; synthetic label and malformed-input tests. Explicit sensitive-read override remains intentional; this is not a whole-workspace privacy guarantee. |
| R8: unknown metered information appeared free | Addressed by PR #6 | Missing usage/cost stays unknown; known API EUR uses configured FX; independent log/ledger writes and visible failures. The local budget remains advisory and cannot prevent provider-side charges or concurrent overspend. |
| R9: aggregate context bounds incomplete | Addressed by PR #7 for routed session/ask/profile requests | UTF-8 aggregate checks before dispatch and bounded retained responses/profile reads; boundary, multibyte and oversized-input regressions. Byte limits are not model-token guarantees. |
| R10: unverified Aider handoff/child effects | Deprecated and disabled by this patch | Local `/edit` refuses before planning; the production runner rejects legacy calls and `aider` is removed from the execution allowlist. Local setup no longer probes or recommends installing it. Historical pure helpers remain; Aider is not a supported integration. |
| R11: subprocess, timeout and failure semantics | Addressed by PR #8 and its follow-up | Exit status/schema agreement, timeout/signal propagation and batch failure reporting. Real harmless Node children verify Execa cancellation; provider/edit tests use doubles. Failed or partial hosted application is reported without automatic rollback. |
| R12: parked document/memory reader confinement | Unresolved; excluded from recommended use | These commands remain parked/off by default and reachable explicitly. Per-file/provenance gaps were not remediated. Do not enable them for real or sensitive content; parked does not mean inaccessible. |
| R13: extra/month-only cost lanes crashed output | Addressed by PR #6 | Day/month rows join by lane ID, with extra/missing/unknown-lane regression cases. |
| R14: misleading help, Node minimum and ledger wording | Reconciled across prior fixes and this patch | Preview help acknowledges probes/hooks; report help names the project-root reports directory; doctor/machine checks require Node 24, matching the package; accounting docs describe both routers. CLI/session/setup no longer offer Aider editing. |

## Aider migration

Aider-backed local `/edit` is deprecated and disabled, including dry-run and stage-only requests. A local pin is never silently replaced by a hosted provider. Rejected batch edits produce a nonzero exit; interactive sessions can continue.

Local Ollama chat and bundled read-only diff reviews remain available. For experimental hosted text patches, explicitly select `/provider claude-code` or `/provider anthropic-api` and clear incompatible local model pins using `/model default`. This sends supplied context off-device. Availability, API enable/budget checks, path validation and explicit patch approval still apply. No edit workflow commits or automatically rolls back changes.

The default Aider runner is a refusal stub. Historical argument/path helpers and deprecated dependency fields are retained for internal compatibility and synthetic tests; they do not launch Aider or provide a supported way to re-enable it. Lifecycle checks may still recognise independently running Aider processes to avoid stopping another application's Ollama service.

## Validation and practical limits

Validation uses synthetic providers, temporary target repositories and an isolated HOME/XDG workspace. Live fetch and Claude/Aider/credential commands are blocked; services and model downloads are not started. The package manager uses its existing cache. The real Node cancellation tests and actual CLI smoke tests are distinct from injected provider/edit doubles.

Local validation passed: frozen-lockfile dependency installation (during dependency verification), typecheck, lint, diff whitespace checks, and the full suite: **1,006 tests passed; three live tests skipped; 97 files passed and one skipped**. Coverage was 81.54% statements, 72.63% branches, 79.66% functions and 82.51% lines. The suite includes actual CLI smoke checks. GitHub CI for this patch is reported separately on the accompanying PR; the link above is the previously merged base, not this patch. Coverage thresholds, dependencies and CI policy are unchanged by this deprecation patch. The regression suite retains real Git approval/byte/index checks and hosted partial-application/summary-failure assertions. Obsolete Aider-success assertions are replaced by refusal tests rather than presented as supported behavior.

Live Ollama generation, Claude CLI flags/authentication, hosted API interoperability and billing, sensitive external workspaces, actual model usefulness and portable installation remain unverified in this review. Optional workspace hooks can execute separately configured commands; availability previews may contact providers. No profile repository or other project is modified.

## Release decision

Keep the current experimental label. Removing an unsupported integration reduces the maintained surface; it does not establish release readiness.

A future release needs a deliberately chosen supported surface, a reproducible install/distribution artifact (the current package is private and build is a placeholder), documented platform/runtime support, and separately authorised live integration/error-path checks for the providers retained. Parked reader gaps must either be fixed before recommending those features or excluded from the released surface. The advisory budget and child-process limitations must remain visible. None of this needs to block an accurately scoped experimental portfolio entry.

Suggested profile scope: an experimental TypeScript CLI demonstrating explicit local/hosted routing, bounded prompts, usage estimates and human-approved text patches, with regression tests and documented limits. Exclude Aider, sensitive external-workspace handling, document/memory readiness, hard spending guarantees and production-readiness claims.
