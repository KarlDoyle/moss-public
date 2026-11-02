// Provider status under the router's eligibility rules. Documented readiness
// probes can read credentials, contact providers and write probe metadata;
// this command does not dispatch the requested task or print credential values.
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
  "moss auth skips requested generation. Availability probes may read configured credentials, contact providers and write probe metadata; no shell profiles are edited and no tools are installed.";

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
