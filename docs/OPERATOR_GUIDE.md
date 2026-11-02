# Moss operator guide

Moss is a local-first CLI with a small command surface that stays inside the project, prefers local provider lanes, and records memory only when you ask it to.

Examples below use the installed `moss` command. Running from source, prefix with `pnpm cli --` (e.g. `pnpm cli -- doctor`).

## Command surface

```bash
moss doctor
moss status
moss local
moss credits
moss api
moss sub
moss check
moss off
moss --explain run council "should I take the offer"
moss cost
moss bench
moss auth
moss models
moss ask "Your prompt"
moss ask --explain
moss ask --context-file docs/OPERATOR_GUIDE.md "What can Moss do?"
moss inventory --check
moss inventory
moss convert --all
moss remember "Important fact" --tag moss
moss recall --tag moss --json
moss compact --tag moss --output moss-summary
moss forget <memory-id>
```

The complete command names are `chat`, `run`, `ask`, `status`, `local`,
`credits`, `api`, `sub`, `check`, `cost`, `bench`, `doctor`, `off`, `models`,
`auth`, `skills`, `plan`, `litellm`, `tools`, `inventory`, `context`, `convert`,
`remember`, `recall`, `compact`, and `forget`.

## Provider status

`moss auth` and `moss ask --explain` share the same readiness language:

- `ollama` — generation-ready when the local daemon and a model are usable. €0.
- `claude-code` — generation-ready when `claude` is on PATH and logged in (a 1-token probe, cached 15 minutes). Billed to the subscription.
- `anthropic-api` — generation-ready when an API key is in the macOS Keychain (or exported by `moss api`). Metered, capped per day in `config/routing.yaml`.
- `cursor-manual` — manual handoff: Moss prepares a packet, another tool runs it.
- `litellm` — not configured unless you point it at a localhost endpoint.

Which lane a command uses is decided per task by `config/routing.yaml`; `moss --explain <command>` shows the pick and why, and `moss cost` shows the spend.

## Explicit context

Use `--context-file` for one known project document:

```bash
moss ask --context-file docs/OPERATOR_GUIDE.md "Summarise the current Moss safety boundary."
```

This is not RAG. Moss does not search folders, rank documents, or infer what to load — you choose the file. It must be a regular markdown/text file inside the project root, ≤64 KiB.

## Documents

The document flow is safe by default: it only reads the configured approved folder.

```bash
moss inventory --check --json
moss inventory
moss convert --all
```

Don't point Moss at real iCloud folders or personal document trees. For pilots, copy synthetic or approved samples into the repo and configure that copied folder.

## Memory

Memory is explicit:

```bash
moss remember "Release v0.1.1 focused on usability." --tag moss --confidence verified
moss recall --tag moss --json
moss compact --tag moss --output release-summary
moss forget <memory-id>
```

Recall is substring/tag search only — there is no semantic memory.

## Interactive session

`moss chat` opens a persistent local-first session over the same `ask` pipeline:

```bash
moss chat
moss chat --model qwen3:4b --provider ollama
```

Type a prompt for a turn, or use a slash command: `/help`, `/model`, `/provider`, `/status`, `/clear`, `/exit`. Multi-turn context is carried but **bounded and visible** — the rolling transcript is capped and oldest turns drop off (`/status` shows the size). The session is read-only, routes deterministically like `ask`, and keeps state in memory only. Non-interactive use works too: `printf '/help\n/exit\n' | moss chat`.

## Choosing the right tool

Use Moss when the work should stay local, explicit, bounded, and repeatable. Use Codex or Cursor when you want a coding agent to edit files. Use ChatGPT for broader reasoning outside the project boundary. Moss produces manual handoff packets but never silently runs those tools.
