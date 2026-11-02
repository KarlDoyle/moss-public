// `moss check` — is the machine, the AI tooling, the scheduler + backup and the estate
// healthy and current? One report, PASS/WARN/FAIL, the fix command beside each problem.
// Report-only: nothing is installed, updated, loaded, merged or deleted. `--report` also
// writes the report to Taisce System/briefs/health--<date>.md for the session brief.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { benchCheck, claudeCli, lanesCheck, modelsCheck, ollamaVersion } from "../lib/health/ai.ts";
import { defaultHealthCtx } from "../lib/health/context.ts";
import { ESTATE_CHECKS } from "../lib/health/estate.ts";
import { MACHINE_CHECKS } from "../lib/health/machine.ts";
import { renderReport, runChecks, summary } from "../lib/health/runner.ts";
import { SCHEDULER_CHECKS } from "../lib/health/scheduler.ts";
import type { Check, CheckResult } from "../lib/health/types.ts";
import { loadRoutingPolicy } from "../lib/lanes/policy.ts";
import { pulledOllamaModels } from "../lib/lanes/runtime.ts";
import { resolveTaisceRoot } from "../lib/paths.ts";
import { readTelemetry, telemetryPath } from "../lib/taisce/telemetry.ts";
import { tierFromLanes } from "./estate.ts";
import { gatherLaneStatus } from "./lane-status.ts";

export function allChecks(): Check[] {
  return [
    ...MACHINE_CHECKS,
    claudeCli,
    ollamaVersion,
    modelsCheck(() => loadRoutingPolicy(), pulledOllamaModels),
    benchCheck(() => readTelemetry(telemetryPath("model-bench"))),
    lanesCheck(async () => (await gatherLaneStatus()).lanes, tierFromLanes),
    ...SCHEDULER_CHECKS,
    ...ESTATE_CHECKS,
  ];
}

export function healthReportPath(when: Date, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.MOSS_HEALTH_DIR?.trim() || join(resolveTaisceRoot(), "System", "briefs");
  return join(dir, `health--${when.toISOString().slice(0, 10)}.md`);
}

// The report as a Taisce brief: frontmatter, the one-line verdict first, then the table.
export function reportMarkdown(results: readonly CheckResult[], when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return [
    "---",
    `title: "Health check — ${day}"`,
    'domain: "System"',
    'type: "tracker"',
    'status: "active"',
    'sensitivity: "private"',
    'load_policy: "on_demand"',
    "source_files: []",
    `last_reviewed: "${day}"`,
    'review_frequency: "weekly"',
    "---",
    "",
    `HEALTH: ${summary(results)}`,
    "",
    "Written by `moss check --report` (report only — nothing was changed).",
    "",
    "```",
    renderReport(results, when),
    "```",
    "",
  ].join("\n");
}

export async function runCheckCommand(
  opts: { deep: boolean; report: boolean; json: boolean },
  out: (s: string) => void,
  checks: readonly Check[] = allChecks(),
): Promise<CheckResult[]> {
  const when = new Date();
  const results = await runChecks(checks, defaultHealthCtx(opts.deep));
  out(
    opts.json
      ? JSON.stringify({ when: when.toISOString(), summary: summary(results), results }, null, 2)
      : renderReport(results, when),
  );
  if (opts.report) {
    const path = healthReportPath(when);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, reportMarkdown(results, when));
    if (!opts.json) out(`report written: ${path}`);
  }
  return results;
}

export function registerCheck(program: Command): void {
  program
    .command("check")
    .description(
      "Is everything healthy and current? Machine, AI tools, scheduler + backup, estate — report only",
    )
    .option(
      "--deep",
      "Also run every repo's tests (verify-all) and ask GitHub about waiting bot PRs",
    )
    .option("--report", "Also write the report to Taisce System/briefs/health--<date>.md")
    .option("--json", "Emit the results as JSON")
    .action(async (o: { deep?: boolean; report?: boolean; json?: boolean }) => {
      const results = await runCheckCommand(
        {
          deep: o.deep === true,
          report: o.report === true,
          json: o.json === true || program.opts<{ json?: boolean }>().json === true,
        },
        (s) => process.stdout.write(`${s}\n`),
      );
      if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
    });
}
