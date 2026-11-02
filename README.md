# Moss

**Local-first AI orchestration with explicit routing, cost controls and human approval.**

Moss is an experimental command-line layer for using different AI providers through one consistent interface. It routes work according to task type, provider availability and cost, while keeping execution predictable and reviewable.

The aim is not to build an autonomous agent. Moss uses fixed workflows: it makes the routing decision visible, prepares bounded context, and requires a person to approve changes before they are applied.

Maintained by [Karl Doyle](https://github.com/KarlDoyle). Source: [github.com/KarlDoyle/moss-public](https://github.com/KarlDoyle/moss-public).

## What it does

- **Routes by task.** Selects a provider lane based on the kind of work and the configured routing policy.
- **Keeps local work local.** Uses Ollama for tasks configured to run on a local model.
- **Supports hosted models when needed.** Can use Claude through the Claude Code CLI or the Anthropic API.
- **Makes cost visible.** Shows the selected lane and rationale, records usage, and applies a configurable daily API spend cap (default €2).
- **Keeps the human in control.** Explains routing decisions before dispatch; proposed code changes are presented as diffs and require explicit approval before application.
- **Constrains execution.** Centralised subprocess, filesystem and network boundaries limit what the tool can access and run.

## Provider model

| Lane | Provider | Typical use | Cost model |
|---|---|---|---|
| `ollama` | Local Ollama model | Tasks configured for local execution | No per-call provider charge |
| `claude-code` | Claude via `claude -p` | Hosted reasoning and editing when the CLI is available | Cost depends on the account and plan used by the CLI |
| `anthropic-api` | Anthropic API | Metered hosted calls | Per-call usage, subject to configured cap |

The routing policy is task-based. The current configuration keeps tasks such as routing, briefing, embeddings and vision on the local lane, while reasoning and editing can use an available Claude lane, with local fallback. The actual decision can be inspected before a command runs.

## Human approval and safety

Moss is designed around explicit boundaries rather than open-ended model autonomy:

- **Explain before execution:** route previews show the selected lane, model and reason without dispatching the request.
- **Review before changes:** editing produces a proposed diff. Moss validates the diff and asks for approval before applying it.
- **Stage-only for sensitive actions:** configured irreversible or external-facing work is presented for review and is not automatically applied or sent.
- **Bounded context:** files are read through centralised path checks; access is restricted rather than assuming the model should see the whole workspace.
- **Restricted execution:** subprocesses and network access pass through centralised allowlists.
- **Secret handling:** the Anthropic API key is retrieved from macOS Keychain for the relevant request and is not stored in the project or printed by Moss.

These are implementation goals backed by code-level controls and tests; they should not be read as a claim that the system is independently security-audited.

## How it fits together

Moss provides a single front door for provider selection, context handling and safety checks. Local model execution is handled through Ollama; hosted calls use the configured Claude lane. For local editing, Aider can produce the change; on a Claude lane, Moss receives a proposed unified diff. In either case, the change is reviewed before application.

The workflow is deliberately fixed and inspectable. Model output is treated as a proposal to evaluate, not as an authoritative record or permission to take the next action.

## Quick start

Moss currently runs from a source checkout; it is not distributed as a prebuilt global package. Requires Node.js 24 or later and pnpm 10 or later. Ollama and the configured local model are needed for local execution.

```bash
git clone https://github.com/KarlDoyle/moss-public.git
cd moss-public
pnpm install
pnpm cli -- --help
pnpm cli -- doctor
pnpm cli -- --explain ask "Summarise this repository's safety model"
```

Install/start Ollama and pull the model required by the selected task in `config/routing.yaml` before running a local request. Moss does not automatically download missing models. See [First run](docs/FIRST_RUN.md).

## Core commands

| Command | Purpose |
|---|---|
| `moss` | Open the interactive session |
| `moss --explain <command>` | Preview the provider route without running the task |
| `moss status` | Inspect provider availability, fallback state and recent usage |
| `moss cost` | Review usage and spend by provider |
| `moss bench` | Measure local model throughput and cold-load time |
| `moss check` | Run read-only environment and configuration checks |
| `moss run <skill>` | Run a supported workflow through the configured route |
| `moss help --all` | Show the full command reference |

## CLI command reference

The current CLI registers these commands:

`chat` · `run` · `ask` · `status` · `local` · `credits` · `api` · `sub` · `check` · `cost` · `bench` · `doctor` · `off` · `models` · `auth` · `skills` · `plan` · `litellm` · `tools` · `inventory` · `context` · `convert` · `remember` · `recall` · `compact` · `forget`

The everyday commands are shown in the core table above. The remaining commands are retained for compatibility and specialist use; several are parked outside the default help output. Run `moss help --all` to inspect the complete command surface.

## Scope and status

**Status: Experimental; not release-ready.**

Moss is an **experimental local AI orchestration project**. Its current focus is provider routing, cost and usage visibility, controlled context, and safe execution boundaries.

It is not presented as a general-purpose autonomous agent or a finished enterprise platform. Some earlier document, memory and optional integration capabilities remain in the repository but are outside the current development focus.

## Testing

GitHub Actions runs the current typecheck, lint, coverage-enforced test suite and build. See the [latest workflow run](https://github.com/KarlDoyle/moss-public/actions) for current results.

## Further reading

- [First run](docs/FIRST_RUN.md) — setup and first-use steps.
- [Operator guide](docs/OPERATOR_GUIDE.md) — everyday commands and workflows.
- [Limitations](LIMITATIONS.md) and [Future](FUTURE.md) — known limitations and planned work.

## Engineering approach

AI assistants helped with implementation and test development. I chose the architecture, reviewed behaviour and decide which changes to keep.

## Licence

Moss is licensed under the MIT License. See [LICENSE](LICENSE).
