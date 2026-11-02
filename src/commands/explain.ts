import { renderLaneChoice } from "../lib/lanes/explain.ts";
import { gatesIn, isTaskType, loadRoutingPolicy, type RoutingPolicy } from "../lib/lanes/policy.ts";
import { defaultSelectDeps } from "../lib/lanes/runtime.ts";
import { type SelectDeps, selectLane } from "../lib/lanes/select.ts";
import { pinForModel } from "../lib/lanes/skill-plan.ts";
import type { LaneTaskType } from "../lib/providers/metadata.ts";
import { runFrontDoorHook } from "../lib/taisce/hooks.ts";
// `moss --explain <command …>` — for ANY command: which lane and model it would use, why
// (every lane considered, with its reason), what it would cost, and whether a gate makes it
// stage-only. Nothing is run. Commands that never call a model say so.
import { estimateTokens } from "../repl/session.ts";
import { defaultTaisceRunDeps, runTaisceSkill, type TaisceRunDeps } from "./run-taisce.ts";

export interface ExplainDeps {
  readonly policy: () => RoutingPolicy;
  readonly select: () => SelectDeps;
  readonly frontDoor: (text: string) => Promise<string | null>;
  readonly taisce: TaisceRunDeps;
}

export const defaultExplainDeps: ExplainDeps = {
  policy: () => loadRoutingPolicy(),
  select: () => defaultSelectDeps(),
  frontDoor: (text) => runFrontDoorHook(text),
  taisce: defaultTaisceRunDeps,
};

// Splits `words --flag value …` into positional words and the value flags we care about.
export function splitArgs(args: readonly string[]): {
  words: string[];
  flags: Record<string, string>;
} {
  const words: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (inline !== undefined) flags[name] = inline;
      else if (
        ["model", "context", "task", "provider", "system"].includes(name) &&
        i + 1 < args.length
      ) {
        flags[name] = args[i + 1] as string;
        i += 1;
      } else flags[name] = "true";
    } else words.push(a);
  }
  return { words, flags };
}

const MODEL_COMMANDS = new Set(["run", "ask", "chat"]);

export async function explainInvocation(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  deps: ExplainDeps = defaultExplainDeps,
): Promise<number> {
  const [command = "chat", ...rest] = args;
  if (!MODEL_COMMANDS.has(command)) {
    out(
      `moss ${command} — no model call: it runs locally and never routes to a lane. Nothing was run (--explain).`,
    );
    return 0;
  }
  const { words, flags } = splitArgs(rest);

  if (command === "run") {
    const [skillId, ...input] = words;
    if (skillId === undefined) {
      err('moss --explain run: name a skill, e.g. `moss --explain run capture "a fact"`.');
      return 1;
    }
    const outcome = await runTaisceSkill(
      {
        skillId,
        emitJson: false,
        explainOnly: true,
        out,
        err,
        ...(input.length > 0 ? { input: input.join(" ") } : {}),
        ...(flags.context !== undefined ? { contextFile: flags.context } : {}),
        ...(flags.model !== undefined ? { model: flags.model } : {}),
      },
      deps.taisce,
    );
    if (outcome === undefined) {
      out(
        `moss run ${skillId} — not a Taisce skill; moss's own review skills (code-review, security-review) run on the local Ollama lane only. Nothing was run (--explain).`,
      );
      return 0;
    }
    return outcome ? 0 : 1;
  }

  // ask and chat: a plain prompt is a brief task; `ask --task code-review` is reasoning.
  const policy = deps.policy();
  const asked = flags.task ?? "";
  const task: LaneTaskType =
    asked === "code-review" ? "reason" : isTaskType(asked) ? asked : "brief";
  const prompt = words.join(" ");
  const gates = prompt.length > 0 ? gatesIn(policy, await deps.frontDoor(prompt)) : [];
  const choice = await selectLane(
    policy,
    { task, gates, promptTokens: estimateTokens(prompt) + 2_000, ...pinForModel(flags.model) },
    deps.select(),
  );
  const context =
    command === "chat"
      ? "the session — each typed prompt routes as 'brief'; /<skill> routes by the skill's task; /edit routes as 'edit'"
      : `moss ask${prompt.length > 0 ? ` "${prompt.slice(0, 60)}"` : ""}`;
  out(
    `${renderLaneChoice(choice, `moss ${command} — route`, context)}\n  nothing was run (--explain).`,
  );
  return choice.lane !== null ? 0 : 1;
}
