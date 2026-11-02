# Limitations

An honest map of what Moss does **not** do yet. Grouped by capability. See [the operator guide](docs/OPERATOR_GUIDE.md) for supported workflows.

## Models and routing

- Three lanes generate: `ollama` (local), `claude-code` (`claude -p` on the subscription) and `anthropic-api` (metered, capped per day). `cursor-manual` only produces a handoff packet; `litellm` needs a localhost endpoint you run.
- The Claude lanes are text in, text out: no tools, no images. `vision` and `embed` stay local and need their models pulled (moss never pulls).
- EUR figures are list price × a dated exchange rate in `config/routing.yaml` — an estimate, not a bill. The claude-code availability probe is cached for 15 minutes, so a logout can take that long to show.
- Model confidence is a static function of parameter size unless you run `moss models --eval`. The registry (`registry/models.json`) is host-specific and gitignored — run `moss models --refresh` per machine.
- `models --explain` recognises `ask`, `code-review`, `summarise`, `general`; anything else falls back to `general`.

## Asking and chat

- Responses arrive once the daemon finishes; no token streaming yet.
- `ask` is stateless. `chat` carries multi-turn context but it is bounded and visible — the transcript is capped, oldest turns drop off, and nothing is persisted to disk.
- `--temperature` is clamped to `[0, 2]`.
- `--context-file` takes one explicit markdown/text file inside the project root, ≤64 KiB. Moss does not search folders, rank documents, or infer context. This is not RAG.

## Skills (code-review, security-review)

- Both are diff-based and read-only: they review only what is in the diff, never the whole repo, and never edit code.
- The target repo is guaranteed unchanged — `HEAD` and `git status` are snapshotted before and after the run, all git calls are hardened, and hostile repo configs are refused.
- Diffs are fenced as untrusted input in the prompt. This is structural defence, not a guarantee against a sophisticated injection — the real guard is that Moss runs no shell and writes nothing in the target.
- Reports are written only under `reports/` in the Moss project (never in the target), via a hardened writer that refuses symlinks, traversal, and overwrites.
- Default provider timeout is 300s (`--timeout-ms` to override).

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

- One metadata-only line per successful generation at `output/usage/usage.jsonl` (command, provider, model, task/skill, token counts, duration) — never the prompt or response.
- Best-effort: a logging failure never breaks or slows the command.
- Token counts depend on the daemon reporting them; absent values are recorded as unknown, not zero.
- No reader command — inspect the JSONL directly. A dedicated `moss usage --summary` reader is deferred and not on the v0.2 roadmap.
