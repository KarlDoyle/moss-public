// `moss auth` — read-only provider-status command.
//
// Per the M3 design memo decision 4 (and D-0009/D-0012/D-0013):
// `moss auth` MUST be strictly read-only. It probes the currently
// registered providers via the router and prints a one-line summary
// per lane. It MAY:
//   - call each provider's `probe()` (defined for the implemented
//     providers; lanes without an implementation surface the
//     synthetic `not_installed` reason).
//   - emit configuration hints derived from the probe reason.
//
// It MUST NOT:
//   - read API keys, .env files, keychains, or SSH keys.
//   - print secrets.
//   - open or edit shell profiles (`.zshrc`, `.bashrc`, etc.).
//   - install tools globally.
//   - run interactive login flows.
//   - store credentials anywhere.
//   - assume a provider is usable without evidence from this run.
//
// In M3-T03 only the Ollama lane has a real probe; the other five
// lanes surface as `not_installed` with the router's milestone-
// neutral synthetic reason. T05/T06 will plug in real probes for the
// remaining lanes; this command does not change at that point — its
// output gets richer automatically because the router does.
//
// Output:
//   - Human: a table-shaped report keyed by `PROVIDER_ORDER`, each
//     row labelled with the provider id, status, and probe reason.
//   - JSON: the full `ProviderRouteExplanation` plus per-provider
//     probe metadata in a stable shape.

import type { Command } from "commander";
import {
  formatRouteExplanationHuman,
  formatRouteExplanationJson,
} from "../lib/providers/explain-render.ts";
import {
  explainProviderRoute,
  type ProviderRouteExplanation,
  type RouterDependencies,
} from "../lib/providers/router.ts";

// Exported so tests that need to strip the footer block can reference
// the same literal (prevents test-vs-source drift if the wording is
// ever edited).
export const READ_ONLY_FOOTER =
  "moss auth is read-only. It does not read API keys, edit shell profiles, install tools, or run interactive logins.";

export interface AuthCommandOptions {
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  // Test seam: inject a RouterDependencies to pin probe outputs.
  // Production code uses the module defaults.
  readonly routerDeps?: RouterDependencies;
}

export interface AuthCommandResult {
  readonly ok: boolean;
  readonly explanation?: ProviderRouteExplanation;
  readonly error?: string;
}

export async function runAuthCommand(options: AuthCommandOptions): Promise<AuthCommandResult> {
  let explanation: ProviderRouteExplanation;
  try {
    // Pick a representative task for the canonical status view.
    // 'ask' is the lowest-common-denominator task that every
    // implemented provider supports in M3; `moss ask --explain`
    // (T04) lets the operator request a per-task view.
    explanation = await explainProviderRoute("ask", options.routerDeps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss auth: ${message}`);
    return { ok: false, error: message };
  }

  if (options.emitJson) {
    const body = formatRouteExplanationJson(explanation);
    options.out(JSON.stringify({ ok: true, ...body }, null, 2));
  } else {
    options.out(
      formatRouteExplanationHuman(explanation, {
        heading: "Moss provider status",
        footer: READ_ONLY_FOOTER,
      }),
    );
  }
  return { ok: true, explanation };
}

export function registerAuth(program: Command): void {
  program
    .command("auth")
    .description(
      "Print read-only provider auth/availability status (no credential reads, no shell-profile edits)",
    )
    .option("--json", "Emit machine-readable JSON")
    .action(async (commandOpts: { json?: boolean }) => {
      const globalOpts = program.opts<{ json?: boolean }>();
      const options: AuthCommandOptions = {
        emitJson: Boolean(commandOpts.json) || Boolean(globalOpts.json),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      };
      const result = await runAuthCommand(options);
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
}
