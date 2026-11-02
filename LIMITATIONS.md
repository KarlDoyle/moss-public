# Limitations

An honest map of what Moss does **not** do yet. Grouped by capability. See [the operator guide](docs/OPERATOR_GUIDE.md) for supported workflows.

## Models and routing

- Three main lanes generate: `ollama` (local), `claude-code` (hosted via `claude -p`, using its account/plan) and `anthropic-api` (metered; both routing paths enforce its enable switch and advisory budget). `cursor-manual` produces a handoff packet; `litellm` requires a configured localhost endpoint and its upstream cost is unknown.
- The Claude lanes are text in, text out: no tools, no images. `vision` and `embed` stay local and need their models pulled (moss never pulls).
- EUR figures are list price × a dated exchange rate in `config/routing.yaml` — an estimate, not a bill. The claude-code availability probe is cached for 15 minutes, so a logout can take that long to show.
- Registry “confidence” defaults to a static parameter-size heuristic, not measured model quality. `moss models --eval` runs a limited local evaluation, not a general quality benchmark. The registry (`registry/models.json`) is host-specific and gitignored — run `moss models --refresh` per machine.
- `models --explain` recognises `ask`, `code-review`, `summarise`, `general`; anything else falls back to `general`.
- Two routing engines remain: default chat and external-workspace skills use task-policy lane order; standalone `ask` and context-profile/optional-provider chat use provider order. They share provider/model pin rules and the API eligibility check. Both global `--explain ask` and `ask --explain` use the same ask parser and request resolution, including registry/explicit context reads and resolved per-lane models. No registry is needed with an explicit model or a model-optional pinned provider.
- Policy routes select once and do not retry generation failures. Provider-order routes retry eligible dispatching fallbacks only for classified operational errors, stopping on boundary/unknown errors. A registry default is not a local-only constraint: its hosted fallback uses that lane’s configured model. Explicit provider pins are single-lane; a model-only pin selects its native lane (Claude alias/ID → Claude Code, other names → Ollama). Incompatible pins fail before probing. Bundled reviews are always Ollama-only. Session provider pins also constrain edit planning and diff generation.
- Previews suppress requested generation, not all I/O. The two ask preview forms use the same existing availability probes; a Claude Code readiness probe is a real hosted call, cached for 15 minutes, and can write probe metadata. `status` and `auth` can also probe it. Pin Ollama and a model to avoid hosted probes. Previews do not start Ollama or pull models. Availability and recorded balances can change between preview and dispatch; fallback lists are conditional on classified failures.

## Spend cap and accounting

- `caps.anthropic-api.enabled: false` is the shipped default. Both routers consult it, price the estimated input and maximum output using the configured static price table and dated FX, and compare with the local day’s recorded API EUR estimate. Unknown pricing or an unknown balance refuses API selection. Dispatch rechecks the switch and budget immediately before each API attempt.
- This covers routed standalone asks, session turns (including context-profile paths), hosted edit planning/diff generation and external-workspace skill calls. Bundled reviews cannot dispatch the metered lane. Direct low-level provider adapters are not a budget-enforcing public workflow; callers must use a router.
- The budget is advisory: there is no atomic reservation between processes. Concurrent requests can pass against the same balance, and failed/timed-out requests or a crash before append can leave unrecorded upstream usage. Missing ledger files mean no recorded calls, not proof of no spend. Malformed, negative, implausible or incomplete records are flagged rather than counted as free; a recorded API row with unknown EUR blocks further budgeted API selection. A failed append is reported but cannot guarantee durable evidence when storage is unavailable.
- It excludes Claude Code generation and readiness probes, LiteLLM upstream billing, other applications and provider-account-wide spend. EUR is list-price usage × the configured dated USD/EUR rate; subscription USD figures are notional. Electricity/hardware, tax, discounts and actual invoices are not measured.

## Asking and chat

- Responses arrive once the daemon finishes; no token streaming yet.
- `ask` is stateless. `chat` carries multi-turn context but it is bounded and visible — the transcript is capped, oldest turns drop off, and chat history is not saved. Usage metadata and approved edits can still be written.
- `--temperature` is clamped to `[0, 2]`.
- `--context-file` takes one explicit markdown/text file inside the project root, ≤64 KiB. Moss does not search folders, rank documents, or infer context. This is not RAG.

## Skills (code-review, security-review)

- Both are diff-based and read-only: they review only what is in the diff, never the whole repo, and never edit code.
- The review workflow does not intentionally edit the target. It compares `HEAD` and `git status` snapshots before/after, uses hardened git calls and refuses selected hostile configurations. Those snapshots detect some mutations; they are not a byte-for-byte integrity proof or protection against concurrent changes.
- Diffs are fenced as untrusted input in the prompt. This is structural defence, not a guarantee against a sophisticated injection — the review path does not execute model-suggested shell commands or write into the target. Hardened git subprocesses still run.
- Reports are written only under `reports/` in the Moss project (never in the target), via a hardened writer that refuses symlinks, traversal, and overwrites.
- Default provider timeout is 300s (`--timeout-ms` to override).

## Approval and execution boundaries

- `/edit` requires explicit approval before application and never commits. Hosted diffs are checked for planned paths and clean application. The local Aider apply is a second generation, so it may differ from the dry-run output; review the resulting diff.
- Hosted patches support only unified text modifications of existing planned regular files. Paired `--- a/…` / `+++ b/…` paths must match; optional `diff --git` and index headers must agree, and hunks must have complete counts. Literal spaced or quoted paths are supported; escaped paths, creation/deletion, rename/copy, mode changes, binary patches, symlink paths and non-canonical paths are refused. Git checks applicability as a second validation layer. Patch text goes to Git through stdin and is not saved as a Moss patch artifact, including on rejection, EOF or stage-only. Provider accounting and other workflow output are separate from target changes.
- Moss's Git wrapper inspects effective configuration, including active includes/conditional includes, before repository operations and refuses inspection failures. It conservatively refuses filter commands (even unused drivers), SSH command directives and URL rewrites; ordinary non-executable includes are allowed. System configuration is disabled for these Git calls. This is a preflight, not protection against another process changing configuration or files concurrently. Aider's own Git invocations do not inherit the wrapper's overrides; its configuration, environment and child behavior remain unverified and it is not recommended for valuable or untrusted targets.
- Stage-only gates rely on recognised output from an optional Taisce front-door hook. A missing/failing hook supplies no gate. Stage-only suppresses application or sending the proposed external action; it does not prevent the prompt/context being sent to a hosted model.
- `paths.ts`, `exec.ts` and `net.ts` centralise application checks, not an OS sandbox or independent security audit. The direct HTTP allowlist permits local Ollama, configured localhost endpoints and the Anthropic API under the active policy. It does not govern networking performed by Claude Code, Aider, shell hooks or a localhost proxy's upstream.
- Built-in reviews read a separately selected target; edits act in the selected repository. Optional Taisce skills/context and telemetry operate outside this checkout. Do not assume project-root checks confine every integration to Moss.
- Anthropic credentials resolve from the environment first, then macOS Keychain. Key presence is not proof of authentication or remaining credit. Reports, errors, hook output and terminal transcripts still need review before publication.

## Documents

- Off by default. Scans only one configured approved folder inside the project; iCloud-like paths are rejected at config-parse time.
- Converts text-like formats only (markdown, text, json, yaml, html). PDF/image return an OCR-not-supported error; unknown types are skipped.
- Writes derivatives with provenance front-matter under `output/docs/`. Sources stay read-only — no moves, no cloud upload, no semantic dedupe.

## Memory

- Off by default and never automatic — no session watcher, no chat capture.
- `recall` is substring/tag search only; no embeddings or semantic memory.
- `compact` writes a deterministic summary (no LLM). `forget` tombstones an entry but retains the file for audit.
- No automatic import from document inventory.

## Usage logging

- Standalone `ask`, legacy chat and built-in review skills write metadata at `output/usage/usage.jsonl` (command, provider, model, task/skill, token counts, duration) — never the prompt or response.
- Usage logging and lane-ledger recording are attempted independently. Failures and missing usage/cost produce accounting warnings without discarding a generated response. Logs can remain incomplete.
- Token counts depend on the daemon reporting them; absent values are recorded as unknown, not zero.
- Both routing paths feed the lane ledger, by default `System/telemetry/lane-usage.jsonl` in the configured external workspace (`MOSS_LANE_USAGE_FILE` overrides it). `moss cost` reads that ledger; the secondary usage log is not a separate billing source. Known API USD estimates are converted with routing.yaml’s dated FX. Missing usage/prices stay unknown (JSON totals use null), and day/month totals join by lane ID. Token counts above one billion or monetary amounts above one million per record are flagged as implausible. A dedicated secondary-log summary reader is deferred.
- Metadata-only usage does not mean all output is content-free: review reports, explicit memory entries and terminal responses may contain supplied source material.
