import type { Command } from "commander";
import { GitDiffEmptyError, GitRepoMutatedError } from "../lib/git.ts";
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
  planSkill,
  type SkillPlan,
  type SkillRunDependencies,
} from "../lib/skills/runner.ts";

const PROMPT_PREVIEW_CHARS = 1200;

export interface PlanCommandOptions {
  readonly skillId: string;
  readonly cwd: string;
  readonly emitJson: boolean;
  readonly roomId?: string;
  readonly modelOverride?: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly deps?: SkillRunDependencies;
}

function summariseHuman(plan: SkillPlan, promptPreviewChars: number): string {
  const preview = plan.prompt.slice(0, promptPreviewChars);
  const elided = plan.prompt.length > promptPreviewChars ? "\n... (prompt truncated)" : "";
  return [
    `Plan for skill '${plan.skill.id}' (${plan.skill.name}):`,
    `  room:         ${plan.room.id} (${plan.room.name})`,
    `  target:       ${plan.target}`,
    `  model:        ${plan.model}`,
    `  diff source:  ${plan.diffSource}`,
    `  diff summary: ${plan.diffSummary}`,
    "",
    "Prompt preview:",
    "----- BEGIN PROMPT -----",
    `${preview}${elided}`,
    "----- END PROMPT -----",
    "",
    `Nothing was sent to the model. Run \`moss run ${plan.skill.id}\` to execute.`,
  ].join("\n");
}

function toJsonShape(plan: SkillPlan) {
  return {
    skill: plan.skill,
    room: plan.room,
    target: plan.target,
    model: plan.model,
    diff: { source: plan.diffSource, summary: plan.diffSummary },
    promptLength: plan.prompt.length,
    prompt: plan.prompt,
  };
}

export async function runPlanCommand(options: PlanCommandOptions): Promise<boolean> {
  const deps = options.deps ?? defaultSkillRunDependencies;
  try {
    const plan = await planSkill(
      {
        skillId: options.skillId,
        cwd: options.cwd,
        ...(options.roomId !== undefined ? { roomId: options.roomId } : {}),
        ...(options.modelOverride !== undefined ? { modelOverride: options.modelOverride } : {}),
      },
      deps,
    );
    options.out(
      options.emitJson
        ? JSON.stringify(toJsonShape(plan), null, 2)
        : summariseHuman(plan, PROMPT_PREVIEW_CHARS),
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof SkillNotFoundError ||
      error instanceof NoRoomForSkillError ||
      error instanceof RoomNotFoundError ||
      error instanceof RoomTargetNotFoundError ||
      error instanceof RoomTargetNotGitError ||
      error instanceof GitDiffEmptyError ||
      error instanceof NoModelAvailableError ||
      error instanceof GitRepoMutatedError
    ) {
      options.err(message);
      return false;
    }
    options.err(`moss plan failed: ${message}`);
    return false;
  }
}

export function registerPlan(program: Command): void {
  program
    .command("plan")
    .description(
      "Show what `moss run <skill>` would do (model, room, target, prompt) without calling the model",
    )
    .argument("<skill>", "Skill id (e.g. code-review)")
    .option("--room <id>", "Use this room id explicitly")
    .option("--model <name>", "Override the registry-selected model")
    .option("--json", "Emit JSON instead of human-readable text")
    .action(
      async (skillId: string, commandOpts: { room?: string; model?: string; json?: boolean }) => {
        const globalOpts = program.opts<{ json?: boolean }>();
        const options: PlanCommandOptions = {
          skillId,
          cwd: process.cwd(),
          emitJson: Boolean(commandOpts.json) || Boolean(globalOpts.json),
          out: (line) => process.stdout.write(`${line}\n`),
          err: (line) => process.stderr.write(`${line}\n`),
        };
        if (commandOpts.room !== undefined) {
          Object.assign(options, { roomId: commandOpts.room });
        }
        if (commandOpts.model !== undefined) {
          Object.assign(options, { modelOverride: commandOpts.model });
        }
        const ok = await runPlanCommand(options);
        if (!ok) process.exitCode = 1;
      },
    );
}
