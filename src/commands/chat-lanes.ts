// The session's lane wiring: every turn, /edit, /model and the route table go through
// config/routing.yaml exactly like `moss run`. Kept apart from chat.ts so each stays short.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gitApply } from "../lib/git.ts";
import { renderLaneChoice } from "../lib/lanes/explain.ts";
import { gatesIn, loadRoutingPolicy, type RoutingPolicy } from "../lib/lanes/policy.ts";
import { defaultSelectDeps, dispatchChoice } from "../lib/lanes/runtime.ts";
import { type LaneChoice, type SelectDeps, selectLane } from "../lib/lanes/select.ts";
import { pinForModel } from "../lib/lanes/skill-plan.ts";
import { assertChatModel } from "../lib/ollama.ts";
import { ollamaUse } from "../lib/ollama-lifecycle.ts";
import { joinInsideProject, resolveInsideRepo } from "../lib/paths.ts";
import { claudeModel, LANE_TASK_TYPES, type LaneTaskType } from "../lib/providers/metadata.ts";
import type { ProviderGenerateResult } from "../lib/providers/types.ts";
import type { EditRoute } from "../repl/edit.ts";
import {
  type ChatGenerateParams,
  type ChatGenerateResult,
  estimateTokens,
} from "../repl/session.ts";

export interface LaneSessionDeps {
  readonly policy: () => RoutingPolicy;
  readonly select: () => SelectDeps;
  readonly dispatch: (
    policy: RoutingPolicy,
    choice: LaneChoice,
    input: { prompt: string; system?: string; command: string },
  ) => Promise<ProviderGenerateResult>;
}

export const defaultLaneSessionDeps: LaneSessionDeps = {
  policy: () => loadRoutingPolicy(),
  select: () => defaultSelectDeps(undefined, { autoStartOllama: true }),
  dispatch: (policy, choice, input) => dispatchChoice(policy, choice, input),
};

function routeLine(choice: LaneChoice): string {
  const gate = choice.stageOnly ? ` · STAGE-ONLY (gate: ${choice.gates.join(" + ")})` : "";
  return `${choice.lane} · ${choice.model} (${choice.task})${gate}`;
}

async function choose(
  deps: LaneSessionDeps,
  task: LaneTaskType,
  text: string,
  frontDoor: string | null,
  pinned: string | undefined,
): Promise<{ policy: RoutingPolicy; choice: LaneChoice }> {
  const policy = deps.policy();
  const choice = await selectLane(
    policy,
    {
      task,
      gates: gatesIn(policy, frontDoor),
      promptTokens: estimateTokens(text),
      ...pinForModel(pinned),
    },
    deps.select(),
  );
  return { policy, choice };
}

// One session turn on the routed lane.
export async function routedGenerate(
  params: ChatGenerateParams,
  deps = defaultLaneSessionDeps,
): Promise<ChatGenerateResult> {
  const task = params.task ?? "brief";
  // A pinned local reasoning model is refused before anything is probed, started or sent —
  // otherwise Ollama would be launched only to refuse the model.
  if (params.model !== undefined && claudeModel(params.model) === undefined) {
    try {
      assertChatModel(params.model);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const { policy, choice } = await choose(
    deps,
    task,
    `${params.system ?? ""}${params.prompt}`,
    params.frontDoor ?? null,
    params.model,
  );
  if (choice.lane === null || choice.model === null) {
    return {
      ok: false,
      error: `no lane can answer right now.\n${renderLaneChoice(choice, `route (${task})`)}`,
    };
  }
  if (choice.lane === "ollama") {
    try {
      assertChatModel(choice.model);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    const result = await deps.dispatch(policy, choice, {
      prompt: params.prompt,
      ...(params.system !== undefined ? { system: params.system } : {}),
      command: "chat",
    });
    return { ok: true, response: result.response, model: result.model, route: routeLine(choice) };
  } catch (error) {
    return {
      ok: false,
      error: `${choice.lane}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function editRoute(
  ask: string,
  pinned: string | undefined,
  frontDoor: string | null,
  deps = defaultLaneSessionDeps,
): Promise<EditRoute> {
  const { choice } = await choose(deps, "edit", ask, frontDoor, pinned);
  const lane = choice.lane as EditRoute["lane"];
  if (lane === "ollama") ollamaUse.used = true; // Aider will use it
  const why = choice.verdicts
    .map((v) => `${v.picked ? "✓" : "·"} ${v.lane}: ${v.reason}`)
    .join("; ");
  return {
    lane,
    model: choice.model,
    stageOnly: choice.stageOnly,
    ...(choice.settings?.editor_model !== undefined
      ? { editorModel: choice.settings.editor_model }
      : {}),
    summary:
      lane === null ? why : `${routeLine(choice)}${choice.verdicts.length > 1 ? ` — ${why}` : ""}`,
  };
}

// The diff inside a ```diff fence, else from the first diff header on.
export function extractDiff(text: string): string {
  const fenced = /```(?:diff|patch)?\n([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text.slice(Math.max(0, text.search(/^(diff --git|--- )/m)));
  return body.endsWith("\n") ? body : `${body}\n`;
}

const MAX_FILE_BYTES = 32 * 1024;

export async function claudeDiff(
  repo: string,
  plan: string,
  files: readonly string[],
  route: EditRoute,
  deps = defaultLaneSessionDeps,
): Promise<{ ok: boolean; diff?: string; error?: string }> {
  const sources = files.map((f) => {
    const text = readFileSync(resolveInsideRepo(repo, f), "utf8");
    if (text.length > MAX_FILE_BYTES)
      throw new Error(`${f} is over ${MAX_FILE_BYTES / 1024} KiB — too big to send whole.`);
    return `FILE ${f}\n\`\`\`\n${text}\n\`\`\``;
  });
  const prompt = [
    "Write a unified diff (git format: `--- a/<path>` / `+++ b/<path>`, correct @@ hunks with",
    "3 lines of context) that carries out the PLAN on the FILES below. Touch only these files.",
    "Reply with the diff in one ```diff block and nothing else.",
    "",
    `PLAN: ${plan}`,
    "",
    ...sources,
  ].join("\n");
  // Same lane and model /edit was routed to — the plan and the diff come from one place.
  const policy = deps.policy();
  const pinned = await selectLane(
    policy,
    {
      task: "edit",
      promptTokens: estimateTokens(prompt),
      ...(route.lane !== null ? { pinLane: route.lane } : {}),
      ...(route.model !== null ? { pinModel: route.model } : {}),
    },
    deps.select(),
  );
  try {
    const result = await deps.dispatch(policy, pinned, { prompt, command: "chat" });
    return { ok: true, diff: extractDiff(result.response) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function applyPatch(repo: string, diff: string, check: boolean) {
  const file = joinInsideProject("output", "edits", `edit-${Date.now()}.diff`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, diff);
  return gitApply(repo, file, check);
}

// /model with no argument: the lane and model each task would take right now.
export async function routeTable(
  pinned: string | undefined,
  deps = defaultLaneSessionDeps,
): Promise<string> {
  const policy = deps.policy();
  const select = deps.select();
  const rows: string[] = ["routes now (config/routing.yaml):"];
  for (const task of LANE_TASK_TYPES) {
    const c = await selectLane(
      policy,
      { task, promptTokens: 1_000, ...pinForModel(pinned) },
      select,
    );
    rows.push(
      `  ${task.padEnd(7)} → ${c.lane === null ? `none — ${c.verdicts.at(-1)?.reason ?? "no lane"}` : `${c.lane} · ${c.model}`}`,
    );
  }
  return rows.join("\n");
}
