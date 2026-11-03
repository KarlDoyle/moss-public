import { renderLaneChoice } from "../lib/lanes/explain.ts";
import { gatesIn, isTaskType, loadRoutingPolicy, type RoutingPolicy } from "../lib/lanes/policy.ts";
import { defaultSelectDeps } from "../lib/lanes/runtime.ts";
import { type SelectDeps, selectLane } from "../lib/lanes/select.ts";
import { requestPins } from "../lib/lanes/skill-plan.ts";
import type { LaneTaskType } from "../lib/providers/metadata.ts";
import type { ProviderId, TaskId } from "../lib/providers/types.ts";
import { runFrontDoorHook } from "../lib/taisce/hooks.ts";
// `moss --explain <command …>` — for ANY command: which lane and model it would use, why
// (every lane considered, with its reason), what it would cost, and whether a gate makes it
// stage-only. Nothing is run. Commands that never call a model say so.
import { estimateTokens } from "../repl/session.ts";
import { type AskCommandOptions, type AskCommandResult, runAskCommand } from "./ask.ts";
import { defaultTaisceRunDeps, runTaisceSkill, type TaisceRunDeps } from "./run-taisce.ts";

export interface ExplainDeps {
  readonly policy: () => RoutingPolicy;
  readonly select: () => SelectDeps;
  readonly frontDoor: (text: string) => Promise<string | null>;
  readonly taisce: TaisceRunDeps;
  readonly ask?: (options: AskCommandOptions) => Promise<AskCommandResult>;
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
      const separator = a.indexOf("=");
      const name = a.slice(2, separator < 0 ? undefined : separator);
      const inline = separator < 0 ? undefined : a.slice(separator + 1);
      if (inline !== undefined) flags[name] = inline;
      else if (
        ["model", "context", "context-file", "task", "provider", "system"].includes(name) &&
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

  try {
    requestPins(flags.model, flags.provider as ProviderId | undefined);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (command === "ask") {
    if (flags.task !== undefined && flags.task !== "ask" && flags.task !== "code-review") {
      err(`unknown task: ${flags.task}`);
      return 1;
    }
    const result = await (deps.ask ?? runAskCommand)({
      prompt: words.join(" "),
      explain: true,
      emitJson: flags.json === "true",
      out,
      err,
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(flags.provider !== undefined ? { provider: flags.provider as ProviderId } : {}),
      ...(flags.task !== undefined ? { task: flags.task as TaskId } : {}),
      ...(flags.system !== undefined ? { system: flags.system } : {}),
      ...(flags.context !== undefined ? { karlContextProfile: flags.context } : {}),
      ...(flags["context-file"] !== undefined ? { contextFilePath: flags["context-file"] } : {}),
    });
    return result.ok ? 0 : 1;
  }

  if (command === "run") {
    if (flags.provider !== undefined) {
      err("--provider is unsupported for run; bundled reviews are Ollama-only.");
      return 1;
    }
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
      if (skillId !== "code-review" && skillId !== "security-review") {
        err(`unknown skill: ${skillId}`);
        return 1;
      }
      try {
        requestPins(flags.model, "ollama", true);
      } catch (error) {
        err(String(error));
        return 1;
      }
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
    {
      task,
      gates,
      promptTokens: estimateTokens(prompt) + 2_000,
      ...requestPins(flags.model, flags.provider as ProviderId | undefined),
    },
    deps.select(),
  );
  const context =
    command === "chat"
      ? "the session — each typed prompt routes as 'brief'; /<skill> routes by the skill's task; /edit routes as 'edit'"
      : `moss ask${prompt.length > 0 ? ` "${prompt.slice(0, 60)}"` : ""}`;
  out(
    `${renderLaneChoice(choice, `moss ${command} — route`, context)}\n  no requested generation (--explain); availability probes and configured hooks may run.`,
  );
  return choice.lane !== null ? 0 : 1;
}
