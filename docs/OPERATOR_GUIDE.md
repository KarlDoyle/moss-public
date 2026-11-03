# Moss operator guide

Moss is an experimental local-first CLI for explicit routing and bounded workflows. Hosted routes send supplied context off-machine; optional workspace integrations and telemetry can operate outside this checkout. Memory is opt-in.

Examples below use the installed `moss` command. Running from source, replace `moss` with `pnpm exec tsx ./src/cli.ts` (e.g. `pnpm exec tsx ./src/cli.ts doctor`).

## Command surface

Start with chat, provider-pinned `ask`, route inspection and the bundled `code-review`/`security-review` diff workflows. `run council` and other Taisce skills need a separate workspace; they are not bundled here. The list below also includes specialist machine/tier helpers and parked document/memory commands, not a promise that every command is ready on a fresh checkout.

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
moss ask --provider ollama --model llama3.1:latest "Your prompt"
moss ask --provider ollama --model llama3.1:latest --explain
moss ask --provider ollama --model llama3.1:latest --context-file docs/OPERATOR_GUIDE.md "What can Moss do?"
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

`moss auth` and provider-level `ask --explain` use the following readiness language. Probing Claude Code can make a real hosted call; “preview” means no requested generation, not necessarily offline:

- `ollama` — generation-ready when the local daemon and a model are usable. €0.
- `claude-code` — generation-ready when `claude` is on PATH and logged in (a short hosted probe, cached 15 minutes). Uses the CLI account/plan; not covered by the API cap.
- `anthropic-api` — key-present when `ANTHROPIC_API_KEY` or macOS Keychain supplies a key; validity and credit are only established on dispatch. Metered; both routing engines consult the enable switch and advisory daily estimated budget in `config/routing.yaml`.
- `cursor-manual` — manual handoff: Moss prepares a packet, another tool runs it.
- `litellm` — not configured unless you point it at a localhost endpoint.

Default chat and external-workspace skills select by task-policy lane order; standalone asks and context-profile/optional-provider chat retain provider-order fallback. Both enforce explicit provider/model constraints and API eligibility. Global and standalone ask previews parse and resolve the same request, including its model and eligible fallback list. Registry defaults can admit hosted fallback; explicit local pins cannot. Bundled reviews are Ollama-only. `moss cost` shows recorded usage across both routing paths, flags incomplete accounting and keeps unknown totals explicit. See [routing and accounting limits](../LIMITATIONS.md).

`models`, `auth`, `skills`, `plan`, `litellm`, `tools`, `inventory`, `context`, `convert`, `remember`, `recall`, `compact` and `forget` are parked outside default help. Tier helpers (`api`, `sub`, `credits`) rely on account settings or companion shell functions. `local`/`off` manage macOS Ollama lifecycle. `check` targets machine/workspace integrations and can query registries; `--deep` can inspect other checkouts and `--report` writes a workspace report. Do not treat it as a project-only quality gate.

## Explicit context

Use `--context-file` for one known project document:

```bash
moss ask --provider ollama --model llama3.1:latest --context-file docs/OPERATOR_GUIDE.md "Summarise the current Moss safety boundary."
```

This is not RAG. Moss does not search folders, rank documents, or infer what to load — you choose the file. It must be a regular markdown/text file inside the project root, ≤64 KiB.

## Documents

The parked document flow is off by default and reads one configured approved folder when enabled. Known per-file confinement/provenance gaps remain in the parked readers. They are excluded from recommended use; do not enable them for real or sensitive content.

```bash
moss inventory --check --json
moss inventory
moss convert --all
```

Don't point Moss at real iCloud folders or personal document trees. For pilots, copy synthetic or approved samples into the repo and configure that copied folder.

## Memory

Memory remains parked and excluded from recommended use because per-file reader confinement is not remediated. The following is a reference to existing commands, not a recommended workflow:

```bash
moss remember "Release v0.1.1 focused on usability." --tag moss --confidence verified
moss recall --tag moss --json
moss compact --tag moss --output release-summary
moss forget <memory-id>
```

Recall is substring/tag search only — there is no semantic memory.

## Interactive session

`moss chat` opens an in-memory session over task-policy routing by default:

```bash
moss chat
moss chat --model qwen3:4b --provider ollama
```

Type a prompt for a turn, or use a slash command: `/help`, `/model`, `/provider`, `/status`, `/clear`, `/exit`. Multi-turn context is carried but **bounded and visible** — the rolling transcript is capped and oldest turns drop off (`/status` shows the size). Ordinary turns produce text and keep session history in memory. `/edit` can modify files after approval; usage metadata can be written to disk. `/model` shows task-policy routes; `/provider` constrains all session/edit requests; `/context` retains the ask-based profile path under the same pin and API checks. Optional manual/proxy providers also retain that path. It is not a read-only session as a whole. Non-interactive use works too: `printf '/help\n/exit\n' | moss chat`.

## Reviewed edits

`/edit <request>` proposes a plan for tracked files in the selected repository. On a Claude lane it displays a unified diff, refuses parsed paths outside the plan, checks clean application, and asks `go? [y/N]` before applying. Aider support is deprecated and disabled. Local `/edit` requests are refused before planning; there is no Aider dry-run or application and no automatic switch from a local pin to a hosted provider. Local chat and bundled read-only reviews remain available. For experimental hosted patch editing, explicitly choose `/provider claude-code` or `/provider anthropic-api` (and clear an incompatible local model pin with `/model default`). Hosted calls send supplied context off-device and API eligibility checks still apply. No edit workflow commits.

Recognised irreversible/external-facing gates make output stage-only. They depend on an optional workspace hook and suppress application, not model dispatch. Approval is for applying changes, not a confirmation before every hosted request. See [boundary limits](../LIMITATIONS.md#approval-and-execution-boundaries).

## Choosing the right tool

Use Moss to inspect explicit routes, run a bounded prompt or diff review, or review a fixed edit workflow. Choose and pin Ollama when work must stay local. It is not an autonomous agent, retrieval system, finished platform or universal provider abstraction. Manual handoff packets still require you to act in the receiving tool. For broader coding-agent workflows, use a dedicated coding agent.
