# First run

Moss is an experimental, local-first AI orchestration CLI. It routes tasks through configured provider lanes and makes the selected route inspectable before dispatch.

## Requirements

- Node.js 24 or later
- pnpm 10 or later
- Ollama for local model execution
- Optional: Claude Code CLI, installed and authenticated, for the `claude-code` lane
- Optional: an Anthropic API key for metered API use; the lane is disabled by default

## Install from source

From a checkout of the repository:

```bash
pnpm install
pnpm cli -- --version
pnpm cli -- --help
```

The package currently exposes a source CLI; it is not a published, prebuilt global package. In the examples below, use `pnpm cli --` from the checkout, or `moss` if you have configured your own local command.

## Check your environment

```bash
pnpm cli -- doctor
pnpm cli -- status
pnpm cli -- check
```

These commands report local readiness, provider status and environment/configuration checks. A provider being registered does not mean it is installed, authenticated, enabled or ready.

## Try a route preview

```bash
pnpm cli -- --explain ask "Summarise this repository's safety model"
```

A route preview explains the intended lane without dispatching the prompt.

## Run a local request

Install and start Ollama, then pull the model required by the task in `config/routing.yaml`. Moss does not automatically download missing models.

For example:

```bash
ollama pull llama3.1
pnpm cli -- ask "Summarise this repository's safety model"
```

The selected model depends on the task routing policy; check the route and configured model before running a request.

## Hosted and manual lanes

- **Claude Code:** install and authenticate the `claude` CLI. Moss probes readiness and dispatches through the isolated CLI invocation.
- **Anthropic API:** configure the key using the documented keychain/environment mechanism. The lane is disabled by default; enabling it also makes calls metered and subject to the daily cap in `config/routing.yaml`.
- **Cursor manual:** Moss creates a handoff packet for you to paste into another tool. It does not run Cursor or claim that the task was executed.

Use `pnpm cli -- auth` and `pnpm cli -- --explain <command>` to inspect provider readiness and routing.

## Explicit context

Use `--context-file` when a prompt needs one known document:

```bash
pnpm cli -- ask --context-file LIMITATIONS.md "Summarise Moss's current safety boundaries."
```

The file is selected explicitly and checked against the project boundary. This is not repository-wide search or RAG.

## More detail

- [Operator guide](OPERATOR_GUIDE.md) — commands and workflows.
- [README](../README.md) — overview.
- [Limitations](../LIMITATIONS.md) — current constraints.
