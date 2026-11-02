# First run

Moss is an experimental, local-first AI orchestration CLI. It routes tasks through configured provider lanes and makes the selected route inspectable before dispatch.

## Requirements

- Node.js 24 or later
- pnpm 10 or later; use `packageManager` in `package.json` (currently pnpm 11.5.2) for reproducible installation
- Git for diff reviews and hosted patch edits. Aider may be installed separately, but its optional local `/edit` adapter is unsupported and not recommended.
- Ollama for local model execution
- Optional: Claude Code CLI, installed and authenticated, for the `claude-code` lane
- Optional: an Anthropic API key for metered API use; disabled by default on both routing paths (see [cap limits](../LIMITATIONS.md#spend-cap-and-accounting))
- Examples assume a POSIX shell. Keychain retrieval, `open -a Ollama` lifecycle and machine/scheduler checks target macOS; on other systems start Ollama yourself. The core Node CLI does not establish cross-platform support for every operator integration.

## Install from source

From a checkout of the repository:

```bash
pnpm install --frozen-lockfile
pnpm exec tsx ./src/cli.ts --version
pnpm exec tsx ./src/cli.ts --help
```

The package currently exposes a source CLI; it is not a published, prebuilt global package. In the examples below, use `pnpm exec tsx ./src/cli.ts` from the checkout, or `moss` if you have configured your own local command. Do not insert an extra `--` between the source entry point and its flags. The `build` script is a placeholder and produces no compiled/distributable artefact.

## Check your environment

```bash
pnpm exec tsx ./src/cli.ts doctor
```

`doctor` checks binaries, local Ollama and optional workspace readiness; it does not generate a model answer. It may report GitHub account information: review output before sharing. Node requirements in `package.json` take precedence over doctor's older minimum check. Missing optional integrations need not prevent a pinned local request.

`status`, `auth`, `ask --explain` and reasoning/edit route previews can invoke a real Claude Code readiness call (cached for 15 minutes). `check` is a specialist machine/workspace check and can contact package registries; it is not a portable, offline setup prerequisite.

## Try a local route inspection

With Ollama already running and `llama3.1:latest` pulled:

```bash
TAISCE_ROOT=/tmp/moss-public-no-workspace MOSS_NO_OLLAMA_LIFECYCLE=1 \
  pnpm exec tsx ./src/cli.ts --explain ask --provider ollama --model llama3.1:latest "Explain what a CLI is."
```

Choose an absent temporary directory for `TAISCE_ROOT` to disable optional workspace hooks. This preview pins the local provider/model, runs only its availability probe and returns without generation. It does not start Ollama or pull a model. The explicit model avoids needing a registry.

The committed [capture](assets/route-preview.png) is a historical task-policy preview from before remediation. Current global and standalone ask previews use the same request parser and resolver; their output differs from that image. The equivalent standalone form is:

```bash
pnpm exec tsx ./src/cli.ts ask --provider ollama --model llama3.1:latest --explain
```

Both forms resolve the model and eligible fallback list. Unpinned previews may use hosted availability probes; see [routing limitations](../LIMITATIONS.md#models-and-routing).

## Run a local request

Install and start Ollama, then pull the model required by the task in `config/routing.yaml`. Moss does not automatically download missing models.

For example:

```bash
ollama pull llama3.1
pnpm exec tsx ./src/cli.ts ask --provider ollama --model llama3.1:latest "Explain what a CLI is."
```

Unlike inspection, this sends a prompt to Ollama and performs local model inference. The explicit provider pin prevents hosted fallback; the explicit model avoids requiring a generated registry. Default session requests use the models in `config/routing.yaml`; for older registry-based commands run `models --refresh` after pulling models. Model RAM/disk needs vary; availability is checked, not guaranteed by installing Moss.

## Hosted and manual lanes

- **Claude Code:** install and authenticate the `claude` CLI. Moss probes readiness and dispatches through the isolated CLI invocation.
- **Anthropic API:** supply `ANTHROPIC_API_KEY` through your environment or configure the macOS Keychain item `anthropic-api-key` for the current user. Do not place credentials in the checkout. Enable the lane in `config/routing.yaml` for routed calls. Both routing engines enforce the switch and advisory local estimate; it is not a provider-side budget or a limit on other tools.
- **Cursor manual:** Moss creates a handoff packet for you to paste into another tool. It does not run Cursor or claim that the task was executed.

`api` and `sub` describe companion shell functions; the CLI cannot change its parent shell environment. External Taisce skills/hooks require a separate workspace selected with `TAISCE_ROOT`; they are not bundled setup requirements. Before hosted use, review [spend and execution boundaries](../LIMITATIONS.md).

## Explicit context

Use `--context-file` when a prompt needs one known document:

```bash
pnpm exec tsx ./src/cli.ts ask --provider ollama --model llama3.1:latest --context-file LIMITATIONS.md "Summarise Moss's current safety boundaries."
```

The file is selected explicitly and checked against the project boundary. This is not repository-wide search or RAG.

## More detail

- [Operator guide](OPERATOR_GUIDE.md) — commands and workflows.
- [README](../README.md) — overview.
- [Limitations](../LIMITATIONS.md) — current constraints.
