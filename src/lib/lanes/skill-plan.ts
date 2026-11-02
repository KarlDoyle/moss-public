// A Taisce skill turned into a routable request: the prompt moss will send, the task type
// it routes as, and any front-door gate its input trips. Shared by `moss run` and
// `moss --explain run`, so the explanation is always of the call that would really be made.
import { estimateTokens } from "../../repl/session.ts";
import { claudeModel, type LaneTaskType } from "../providers/metadata.ts";
import { PROVIDER_IDS, type ProviderId } from "../providers/types.ts";
import { runFrontDoorHook } from "../taisce/hooks.ts";
import {
  buildTaisceSkillPrompt,
  defaultContextFor,
  findTaisceSkill,
  loadTaisceGuardrails,
  readGuardedTaisceFile,
  type TaisceSkillRef,
} from "../taisce/skills.ts";
import { gatesIn, type RoutingPolicy, taskForSkill } from "./policy.ts";

export interface SkillPlan {
  readonly skill: TaisceSkillRef;
  readonly prompt: string;
  readonly task: LaneTaskType;
  readonly gates: readonly string[];
  readonly promptTokens: number;
}

export interface SkillPlanDeps {
  readonly frontDoor: (text: string) => Promise<string | null>;
}

export const defaultSkillPlanDeps: SkillPlanDeps = { frontDoor: (text) => runFrontDoorHook(text) };

// null = no Taisce skill by that id. Throws TaisceGuardedPathError for a gated file.
export async function planTaisceSkill(
  policy: RoutingPolicy,
  skillId: string,
  input: string | undefined,
  contextFile: string | undefined,
  deps: SkillPlanDeps = defaultSkillPlanDeps,
): Promise<SkillPlan | null> {
  const skill = findTaisceSkill(skillId);
  if (skill === null) return null;
  const guardrails = loadTaisceGuardrails();
  const ctxFile = contextFile ?? defaultContextFor(skill.id);
  const contextText = ctxFile !== undefined ? readGuardedTaisceFile(ctxFile) : "";
  const joined = [input, contextText]
    .filter((p): p is string => p !== undefined && p.trim().length > 0)
    .join("\n\n");
  const prompt = buildTaisceSkillPrompt(skill, guardrails, joined);
  // The gate is judged on what the operator asked for, not on the skill's own text (every
  // publishing skill mentions publishing).
  const frontDoor =
    input !== undefined && input.trim().length > 0 ? await deps.frontDoor(input) : null;
  return {
    skill,
    prompt,
    task: taskForSkill(policy, skill.id, skill.content),
    gates: gatesIn(policy, frontDoor),
    promptTokens: estimateTokens(prompt),
  };
}

// `--model <name>` pins a lane: a Claude alias or id pins claude-code, anything else Ollama.
export function pinForModel(model: string | undefined): {
  pinLane?: ProviderId;
  pinModel?: string;
} {
  if (model === undefined) return {};
  return { pinLane: claudeModel(model) !== undefined ? "claude-code" : "ollama", pinModel: model };
}

// Shared intent contract for previews, both routers, and edit planning. A provider
// pin never admits fallback; a model without a provider pins its native lane.
export function requestPins(
  model?: string,
  provider?: ProviderId,
  localOnly = false,
): {
  pinLane?: ProviderId;
  pinModel?: string;
} {
  if (provider !== undefined && !(PROVIDER_IDS as readonly string[]).includes(provider))
    throw new Error(`Unknown provider: ${provider}`);
  const inferred = pinForModel(model);
  const lane = provider ?? inferred.pinLane ?? (localOnly ? "ollama" : undefined);
  if (localOnly && lane !== "ollama")
    throw new Error("local-only request conflicts with hosted/provider pin.");
  if (
    model !== undefined &&
    provider !== undefined &&
    provider !== "cursor-manual" &&
    provider !== "litellm"
  ) {
    const hosted = claudeModel(model) !== undefined;
    if ((provider === "ollama" && hosted) || (provider !== "ollama" && !hosted)) {
      throw new Error(`model '${model}' is incompatible with provider '${provider}'.`);
    }
  }
  return {
    ...(lane !== undefined ? { pinLane: lane } : {}),
    ...(model !== undefined ? { pinModel: model } : {}),
  };
}
