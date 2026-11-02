# Changelog

Newest first. What changed and why it matters; the detail is in `docs/milestones/`.

## 2026-09-18 — one front door, three lanes

moss now routes every terminal model call by task and cost, instead of only ever asking Ollama.

- **Three lanes behind one `Provider` interface:** `ollama` (local, €0), `claude-code`
  (`claude -p` on the subscription, fully isolated: no tools, hooks, settings, MCP or saved
  session) and `anthropic-api` (metered, key from the macOS Keychain, capped at €2/day by
  default). The four detection-only lanes that could never generate are gone.
- **`config/routing.yaml`:** route/brief/embed/vision stay local; reason/edit take the best
  Claude lane up, else local; a front-door `irreversible`/`external-facing` gate forces the
  best lane and makes the result stage-only. Kept equal to Taisce's
  `09-model-routing-rules.md` table by a lint in `check-guardrails.sh`.
- **`moss --explain <command>`** before any command: lane, model, why each other lane was
  skipped, estimated cost — nothing runs.
- **The session is lane-aware:** each answer names its lane; `/model` shows the per-task table
  and pins Claude or local; `/edit` runs Aider architect → editor locally, or applies exactly
  the unified diff a Claude lane wrote, after "go?".
- **Budget:** one ledger line per call in Taisce `System/telemetry/lane-usage.jsonl`;
  `moss cost` (today/month by lane); `moss status` shows lanes, resident model, today's
  spend and the last bench.
- **`moss bench`** — named in the local-model brief, never built until now.
- **Fixed on the way:** a regression suite for the session as it was; `vitest` bumped to
  4.1.11, clearing all six Dependabot alerts (dev-only); coverage ratchet raised to
  79/69/76/80.
