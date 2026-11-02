// `moss litellm` command — config-only surface for M5.
//
// Subcommands:
//   --print-config   Emit a starter LiteLLM config to stdout. The
//                    operator is expected to redirect it to
//                    config/litellm.json themselves and edit. Moss
//                    never writes the config file automatically (no
//                    surprise writes; same posture as `moss doctor`).
//   --check          Validate config/litellm.json against the schema
//                    and probe the configured endpoint via the
//                    LiteLLM provider lane. Reports endpoint
//                    reachability + the `enabled` flag.
//   (no flag)        Same as --check.

import type { Command } from "commander";
import { liteLlmProbe } from "../lib/providers/litellm.ts";

const STARTER_CONFIG = `{
  "enabled": false,
  "endpointUrl": "http://127.0.0.1:4000",
  "models": [
    { "name": "gpt-4o-mini", "viaLiteLLM": true }
  ],
  "notes": "M5: localhost-only endpoints (D-0015). Run your LiteLLM proxy yourself; Moss never spawns it."
}
`;

export interface LiteLlmCommandOptions {
  readonly mode: "print-config" | "check";
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export async function runLiteLlmCommand(options: LiteLlmCommandOptions): Promise<number> {
  if (options.mode === "print-config") {
    options.out(STARTER_CONFIG);
    return 0;
  }

  const probe = await liteLlmProbe();
  if (options.emitJson) {
    options.out(JSON.stringify(probe, null, 2));
  } else {
    options.out(`LiteLLM lane status: ${probe.status}`);
    options.out(`Reason: ${probe.reason}`);
    options.out(`Last probed: ${probe.lastProbedAt}`);
  }
  return probe.status === "available" ? 0 : 1;
}

export function registerLiteLlm(program: Command): void {
  program
    .command("litellm")
    .description(
      "Inspect and validate the optional LiteLLM lane. Default action prints status; --print-config emits a starter config to stdout.",
    )
    .option(
      "--print-config",
      "Print a starter LiteLLM config to stdout. Redirect to config/litellm.json and edit.",
    )
    .option(
      "--check",
      "Validate config/litellm.json and probe the configured endpoint (default action).",
    )
    .option("--json", "Emit JSON instead of human-readable text (for --check).")
    .action(async (commandOpts: { printConfig?: boolean; check?: boolean; json?: boolean }) => {
      const globalOpts = program.opts<{ json?: boolean }>();
      const mode = commandOpts.printConfig === true ? "print-config" : "check";
      const exitCode = await runLiteLlmCommand({
        mode,
        emitJson: Boolean(commandOpts.json) || Boolean(globalOpts.json),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      });
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    });
}
