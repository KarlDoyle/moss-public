import { existsSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import type { Command } from "commander";
import { GitDiffEmptyError, GitRepoMutatedError } from "../lib/git.ts";
import { NetworkBoundaryError } from "../lib/net.ts";
import { getProjectRoot } from "../lib/paths.ts";
import { NoProviderAvailableError } from "../lib/providers/router.ts";
import { ReportPathError, writeReportSync } from "../lib/reports.ts";
import {
  RoomNotFoundError,
  RoomTargetNotFoundError,
  RoomTargetNotGitError,
} from "../lib/rooms/loader.ts";
import { SkillNotFoundError } from "../lib/skills/loader.ts";
import {
  defaultSkillRunDependencies,
  NoModelAvailableError,
  NoRoomForSkillError,
  runSkill,
  type SkillRunDependencies,
  type SkillRunResult,
} from "../lib/skills/runner.ts";
import { recordUsageBestEffort, type UsageWriteInput } from "../lib/usage/log.ts";
import { runTaisceSkill, type TaisceRunDeps } from "./run-taisce.ts";

const DEFAULT_TIMEOUT_MS = 300_000;

export class WriteReportInsideTargetError extends Error {
  constructor(target: string, reportsDir: string) {
    super(
      `Cannot --write-report when the target repo '${target}' is the same as (or contains) the Moss project ('${reportsDir}'). Reports would land inside the target, contradicting the read-only guarantee. Run \`moss run <skill>\` without --write-report, or run from outside the Moss checkout.`,
    );
    this.name = "WriteReportInsideTargetError";
  }
}

function realIfExists(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

// Returns true when the Moss project root (where reports live) is the same as
// or inside the target repo. In that situation, --write-report would deposit
// a file inside the target — contradicting the read-only target guarantee.
// We compare realpaths so a symlinked checkout still triggers the guard.
function projectIsInsideTarget(targetAbs: string, mossProjectRootAbs: string): boolean {
  const realTarget = realIfExists(targetAbs);
  const realProject = realIfExists(mossProjectRootAbs);
  if (realTarget === realProject) return true;
  const rel = relative(realTarget, realProject);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  return true;
}

export interface RunCommandOptions {
  readonly skillId: string;
  readonly cwd: string;
  readonly emitJson: boolean;
  readonly writeReport: boolean;
  readonly roomId?: string;
  readonly modelOverride?: string;
  readonly timeoutMs?: number;
  // Taisce-skill path only (src/commands/run-taisce.ts). `taisceInput` is the
  // free-text trailing CLI words (e.g. the fact for `moss run capture "..."`
  // ); `taisceContextFile` is an optional Taisce-relative path read through
  // the same guard-reads deny list `paths.ts` enforces for the skill file
  // itself. Both are no-ops for a moss room-skill run.
  readonly taisceInput?: string;
  readonly taisceContextFile?: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now?: () => Date;
  // Test seam: tests inject a stub to bypass the disk-touching helper.
  // Production code uses the default which routes through src/lib/reports.ts.
  readonly writeReport_?: (filename: string, contents: string) => string;
  readonly deps?: SkillRunDependencies;
  // Usage-logging seam, mirroring `moss ask`. When provided, called once
  // per successful skill run with the metadata for a single usage
  // record. The real CLI wires the best-effort writer; library callers
  // and unit tests stay side-effect-free by default. See D-0019.
  readonly recordUsage?: (input: UsageWriteInput) => Promise<boolean> | Promise<void>;
  // Test seam for the Taisce-skill path's routing (policy, probes, dispatch).
  readonly taisceDeps?: TaisceRunDeps;
}

// Millisecond precision on the timestamp so that O_EXCL in the safe writer
// (which refuses to overwrite an existing report file) does not collide
// when `moss run` is invoked back-to-back inside the same second. ISO-style
// `YYYYMMDDTHHMMSSXXXZ` keeps the filename ASCII-sortable.
function timestamp(now: () => Date): string {
  const d = now();
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `${pad(d.getUTCMilliseconds(), 3)}Z`
  );
}

function reportFilenameFor(result: SkillRunResult, now: () => Date): string {
  return `${result.skill.id}-${timestamp(now)}.md`;
}

function buildReport(result: SkillRunResult): string {
  const lines: string[] = [];
  lines.push(`# ${result.skill.name} report`);
  lines.push("");
  lines.push(`- skill: ${result.skill.id} (${result.skill.name})`);
  lines.push(`- room: ${result.room.id} (${result.room.name})`);
  lines.push(`- target: ${result.target}`);
  lines.push(`- model: ${result.model}`);
  lines.push(`- diff source: ${result.diffSource}`);
  lines.push(`- diff summary: ${result.diffSummary}`);
  if (result.durationMs !== undefined) {
    lines.push(`- generation duration (ms): ${result.durationMs.toFixed(0)}`);
  }
  if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
    lines.push(`- tokens (in/out): ${result.inputTokens ?? "?"} / ${result.outputTokens ?? "?"}`);
  }
  lines.push("- target repo unchanged: true");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(result.response.trimEnd());
  lines.push("");
  return lines.join("\n");
}

function summariseHuman(result: SkillRunResult, reportPath: string | null): string {
  const lines: string[] = [];
  lines.push(`Ran skill '${result.skill.id}' in room '${result.room.id}'.`);
  lines.push(`  target:       ${result.target}`);
  lines.push(`  model:        ${result.model}`);
  lines.push(`  diff source:  ${result.diffSource}`);
  lines.push(`  diff summary: ${result.diffSummary}`);
  if (result.durationMs !== undefined) {
    lines.push(`  duration:     ${result.durationMs.toFixed(0)} ms`);
  }
  if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
    lines.push(
      `  tokens:       ${result.inputTokens ?? "?"} in / ${result.outputTokens ?? "?"} out`,
    );
  }
  lines.push("  unchanged:    true");
  lines.push("");
  lines.push("----- BEGIN OUTPUT -----");
  lines.push(result.response.trimEnd());
  lines.push("----- END OUTPUT -----");
  if (reportPath !== null) {
    lines.push("");
    lines.push(`Report written to ${reportPath}`);
  }
  return lines.join("\n");
}

export async function runRunCommand(options: RunCommandOptions): Promise<boolean> {
  const deps = options.deps ?? defaultSkillRunDependencies;
  const now = options.now ?? (() => new Date());
  const writeReport = options.writeReport_ ?? writeReportSync;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let result: SkillRunResult;
  try {
    result = await runSkill(
      {
        skillId: options.skillId,
        cwd: options.cwd,
        timeoutMs,
        ...(options.roomId !== undefined ? { roomId: options.roomId } : {}),
        ...(options.modelOverride !== undefined ? { modelOverride: options.modelOverride } : {}),
      },
      deps,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Safety-boundary violation: surface the boundary message verbatim
    // rather than burying it in a generic "moss run failed:" prefix.
    // The boundary message already identifies the refused URL and
    // points the operator at src/lib/net.ts.
    if (error instanceof NetworkBoundaryError) {
      options.err(message);
      return false;
    }
    if (error instanceof SkillNotFoundError) {
      const taisceOutcome = await runTaisceSkill(
        {
          skillId: options.skillId,
          emitJson: options.emitJson,
          out: options.out,
          err: options.err,
          ...(options.taisceInput !== undefined ? { input: options.taisceInput } : {}),
          ...(options.taisceContextFile !== undefined
            ? { contextFile: options.taisceContextFile }
            : {}),
          ...(options.modelOverride !== undefined ? { model: options.modelOverride } : {}),
        },
        options.taisceDeps,
      );
      if (taisceOutcome !== undefined) return taisceOutcome;
      options.err(message);
      return false;
    }
    if (
      error instanceof NoRoomForSkillError ||
      error instanceof RoomNotFoundError ||
      error instanceof RoomTargetNotFoundError ||
      error instanceof RoomTargetNotGitError ||
      error instanceof GitDiffEmptyError ||
      error instanceof NoModelAvailableError ||
      error instanceof NoProviderAvailableError ||
      error instanceof GitRepoMutatedError
    ) {
      options.err(message);
      return false;
    }
    options.err(`moss run failed: ${message}`);
    return false;
  }

  // Record one usage line per successful skill run. providerId is the
  // lane the router actually used (carried on the result), so a fallback
  // lane is logged truthfully rather than assumed to be Ollama. The
  // result also carries the model and any token/duration data the daemon
  // reported. Best-effort: never affects the run's outcome. See D-0019.
  for (const warning of result.warnings ?? []) options.err(warning);
  if (options.recordUsage !== undefined) {
    try {
      const recorded = await options.recordUsage({
        command: "run",
        providerId: result.providerId,
        model: result.model,
        skill: result.skill.id,
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      });
      if (recorded === false)
        options.err("Accounting incomplete: usage/ledger recording or cost data is incomplete.");
    } catch {
      options.err("Accounting incomplete: usage/ledger recording or cost data is incomplete.");
    }
  }

  let reportPath: string | null = null;
  if (options.writeReport) {
    const mossProjectRoot = getProjectRoot();
    if (projectIsInsideTarget(result.target, mossProjectRoot)) {
      options.err(new WriteReportInsideTargetError(result.target, mossProjectRoot).message);
      return false;
    }
    try {
      reportPath = writeReport(reportFilenameFor(result, now), buildReport(result));
    } catch (error) {
      if (error instanceof ReportPathError) {
        options.err(error.message);
        return false;
      }
      throw error;
    }
  }

  if (options.emitJson) {
    const jsonShape = {
      ...result,
      ...(reportPath !== null ? { reportPath } : {}),
    };
    options.out(JSON.stringify(jsonShape, null, 2));
  } else {
    options.out(summariseHuman(result, reportPath));
  }
  return true;
}

export function registerRun(program: Command): void {
  program
    .command("run")
    .description('Run a Taisce skill, routed by task (e.g. run capture "…", run council "…")')
    .argument("<skill>", "Skill id (e.g. code-review) or a Taisce skill id (e.g. capture)")
    .argument(
      "[input...]",
      "Taisce-skill path only: free-text input (e.g. the fact for `moss run capture`)",
    )
    .option("--room <id>", "Use this room id explicitly")
    .option("--model <name>", "Override the registry-selected model")
    .option("--write-report", "Also write a markdown report under ~/.local/share/moss/reports/")
    .option(
      "--context <relPath>",
      "Taisce-skill path only: a Taisce-relative file read through the guard-reads deny list and included as context",
    )
    .option(
      "--timeout-ms <number>",
      `Provider timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
    )
    .option("--json", "Emit JSON instead of human-readable text")
    .action(
      async (
        skillId: string,
        input: string[],
        commandOpts: {
          room?: string;
          model?: string;
          writeReport?: boolean;
          context?: string;
          timeoutMs?: string;
          json?: boolean;
        },
      ) => {
        const globalOpts = program.opts<{ json?: boolean }>();
        const options: RunCommandOptions = {
          skillId,
          cwd: process.cwd(),
          emitJson: Boolean(commandOpts.json) || Boolean(globalOpts.json),
          writeReport: Boolean(commandOpts.writeReport),
          out: (line) => process.stdout.write(`${line}\n`),
          err: (line) => process.stderr.write(`${line}\n`),
          recordUsage: (input_) => recordUsageBestEffort(input_),
        };
        if (commandOpts.room !== undefined) Object.assign(options, { roomId: commandOpts.room });
        if (commandOpts.model !== undefined)
          Object.assign(options, { modelOverride: commandOpts.model });
        if (input.length > 0) Object.assign(options, { taisceInput: input.join(" ") });
        if (commandOpts.context !== undefined)
          Object.assign(options, { taisceContextFile: commandOpts.context });
        if (commandOpts.timeoutMs !== undefined) {
          const parsed = Number.parseInt(commandOpts.timeoutMs, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            Object.assign(options, { timeoutMs: parsed });
          }
        }
        const ok = await runRunCommand(options);
        if (!ok) process.exitCode = 1;
      },
    );
}
