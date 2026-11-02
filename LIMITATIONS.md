# Limitations

An honest map of what Moss does **not** do yet. Grouped by capability. See [the operator guide](docs/OPERATOR_GUIDE.md) for supported workflows.

## Models and routing

- Three main lanes generate: `ollama` (local), `claude-code` (hosted via `claude -p`, using its account/plan) and `anthropic-api` (metered; budget checks only on task-policy routes). `cursor-manual` only produces a handoff packet; `litellm` needs a localhost endpoint you run.
- The Claude lanes are text in, text out: no tools, no images. `vision` and `embed` stay local and need their models pulled (moss never pulls).
- EUR figures are list price × a dated exchange rate in `config/routing.yaml` — an estimate, not a bill. The claude-code availability probe is cached for 15 minutes, so a logout can take that long to show.
- Registry “confidence” defaults to a static parameter-size heuristic, not measured model quality. `moss models --eval` runs a limited local evaluation, not a general quality benchmark. The registry (`registry/models.json`) is host-specific and gitignored — run `moss models --refresh` per machine.
- `models --explain` recognises `ask`, `code-review`, `summarise`, `general`; anything else falls back to `general`.
- Two routers remain: default chat and Taisce skill runs use `config/routing.yaml`; standalone `ask` and legacy chat with `/provider` or `/context` use `providers/router.ts`. Global `--explain ask` shows the former; `ask --explain` shows the latter (provider choice, not a resolved model). Do not treat a global ask preview as a prediction of standalone ask dispatch.
- Policy routes skip unavailable/disabled lanes and unpulled local models, but do not retry another lane after generation failure. The older router retries eligible fallbacks on classified operational errors, retains the same model option across lanes and stops on boundary/unknown errors. Pinning `ask --provider ollama --model <name>` removes hosted fallback.
- Previews suppress requested generation, not all I/O: a Claude Code readiness probe is a real hosted call, cached for 15 minutes. `status` and `auth` can also probe it. A harmless global brief preview with no external hook stays on the local lane.

## Spend cap and accounting

- `caps.anthropic-api.enabled: false` is the shipped task-policy default. When enabled, `selectLane` checks the local day's recorded API EUR estimate plus estimated prompt tokens and the configured maximum output against `daily_eur` (default €2).
- This covers calls selected through that function: default chat, hosted `/edit` planning/diff generation and Taisce skill runs. The older standalone `ask` and legacy chat routes do **not** consult this switch/cap, even if pinned to `anthropic-api`. Avoid those paths for budget-controlled hosted work.
- The check is before dispatch, with no atomic reservation between processes. Successful routed calls append metadata best-effort to a local ledger. Missing/malformed entries and failed or unrecorded calls can undercount; concurrent calls can pass against the same balance. This is an advisory local budget control, not a hard billing ceiling.
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
- Best-effort: logging errors are swallowed so the generation can still succeed; logs can be incomplete.
- Token counts depend on the daemon reporting them; absent values are recorded as unknown, not zero.
- Task-policy chat/skills and Claude Code probes instead use the lane ledger, by default `System/telemetry/lane-usage.jsonl` in the configured Taisce workspace. `MOSS_LANE_USAGE_FILE` overrides its path; `moss cost` reads this ledger, not the older usage log. There is no combined accounting view. A dedicated `moss usage --summary` reader is deferred.
- Metadata-only usage does not mean all output is content-free: review reports, explicit memory entries and terminal responses may contain supplied source material.
