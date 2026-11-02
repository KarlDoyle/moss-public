// `moss run <taisce-skill> [input]` — a Taisce skill's SKILL.md as a prompt, routed by
// config/routing.yaml: the skill's task type picks the lane list, the front door can force
// the best lane (stage-only), and the call is logged to the lane-usage ledger. Never writes
// a file. Privacy rules are prepended and every Taisce read passes guard-reads, as before.
import { renderLaneChoice } from "../lib/lanes/explain.ts";
import { loadRoutingPolicy, type RoutingPolicy } from "../lib/lanes/policy.ts";
import { defaultSelectDeps, dispatchChoice } from "../lib/lanes/runtime.ts";
import { type LaneChoice, type SelectDeps, selectLane } from "../lib/lanes/select.ts";
import {
  defaultSkillPlanDeps,
  pinForModel,
  planTaisceSkill,
  type SkillPlanDeps,
} from "../lib/lanes/skill-plan.ts";
import { NetworkBoundaryError } from "../lib/net.ts";
import { ollamaUse, turnOffOllama } from "../lib/ollama-lifecycle.ts";
import { TaisceGuardedPathError } from "../lib/paths.ts";
import type { ProviderGenerateResult } from "../lib/providers/types.ts";

export interface TaisceRunOptions {
  readonly skillId: string;
  readonly input?: string;
  readonly contextFile?: string;
  readonly model?: string;
  readonly emitJson: boolean;
  readonly explainOnly?: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface TaisceRunDeps {
  readonly policy: () => RoutingPolicy;
  readonly select: () => SelectDeps;
  readonly plan: SkillPlanDeps;
  readonly dispatch: (
    policy: RoutingPolicy,
    choice: LaneChoice,
    prompt: string,
  ) => Promise<ProviderGenerateResult>;
  // After the run: turn Ollama off again if this command started it (null = nothing to say).
  readonly afterRun?: () => Promise<string | null>;
}

export const defaultTaisceRunDeps: TaisceRunDeps = {
  policy: () => loadRoutingPolicy(),
  select: () => defaultSelectDeps(undefined, { autoStartOllama: true }),
  plan: defaultSkillPlanDeps,
  dispatch: (policy, choice, prompt) => dispatchChoice(policy, choice, { prompt, command: "run" }),
  afterRun: async () => (ollamaUse.started ? (await turnOffOllama()).message : null),
};

// undefined = not a Taisce skill (the caller reports "skill not found"); otherwise success.
// Whatever happens, Ollama is turned off again at the end if this command started it.
export async function runTaisceSkill(
  options: TaisceRunOptions,
  deps: TaisceRunDeps = defaultTaisceRunDeps,
): Promise<boolean | undefined> {
  try {
    return await runRouted(options, deps);
  } finally {
    const off = await deps.afterRun?.();
    if (off) options.err(`· ${off}`);
  }
}

async function runRouted(
  options: TaisceRunOptions,
  deps: TaisceRunDeps = defaultTaisceRunDeps,
): Promise<boolean | undefined> {
  const policy = deps.policy();
  let plan: Awaited<ReturnType<typeof planTaisceSkill>>;
  try {
    plan = await planTaisceSkill(
      policy,
      options.skillId,
      options.input,
      options.contextFile,
      deps.plan,
    );
  } catch (error) {
    if (error instanceof TaisceGuardedPathError) {
      options.err(error.message);
      return false;
    }
    throw error;
  }
  if (plan === null) return undefined;

  const choice = await selectLane(
    policy,
    {
      task: plan.task,
      gates: plan.gates,
      promptTokens: plan.promptTokens,
      ...pinForModel(options.model),
    },
    deps.select(),
  );
  const explained = renderLaneChoice(
    choice,
    `moss run ${options.skillId} — route`,
    `Taisce skill '${plan.skill.id}'`,
  );
  if (options.explainOnly === true) {
    options.out(`${explained}\n  nothing was run (--explain).`);
    return choice.lane !== null;
  }
  if (choice.lane === null) {
    options.err(`moss run: no lane can run '${plan.skill.id}' right now.\n${explained}`);
    return false;
  }

  let result: ProviderGenerateResult;
  try {
    result = await deps.dispatch(policy, choice, plan.prompt);
  } catch (error) {
    options.err(
      error instanceof NetworkBoundaryError
        ? error.message
        : `moss run: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  const stage = choice.stageOnly
    ? `STAGE-ONLY (gate: ${choice.gates.join(" + ")}) — nothing was sent or applied`
    : undefined;
  if (options.emitJson) {
    options.out(
      JSON.stringify(
        {
          source: "taisce",
          skill: plan.skill.id,
          skillPath: plan.skill.path,
          task: choice.task,
          lane: choice.lane,
          providerId: result.providerId,
          model: result.model,
          stageOnly: choice.stageOnly,
          response: result.response,
        },
        null,
        2,
      ),
    );
    return true;
  }
  options.out(
    [
      `Ran Taisce skill '${plan.skill.id}' (${plan.skill.path})`,
      `  task:         ${choice.task}`,
      `  lane:         ${choice.lane}`,
      `  model:        ${result.model}`,
      ...(stage !== undefined ? [`  ${stage}`] : []),
      "",
      "----- BEGIN OUTPUT -----",
      result.response.trimEnd(),
      "----- END OUTPUT -----",
    ].join("\n"),
  );
  return true;
}
