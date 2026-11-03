// Hosted /edit: plan, validate text diff, request approval, then apply. Never commits.
// The former local Aider path is deprecated and refused before planning.
import { AIDER_DEPRECATION } from "../lib/aider.ts";
import { requestPins } from "../lib/lanes/skill-plan.ts";
import type { ProviderId } from "../lib/providers/types.ts";
import { claudeLane } from "./edit-lanes.ts";
import type { ChatGenerateParams, ChatGenerateResult } from "./session.ts";

export { diffPaths } from "./edit-lanes.ts";

export interface EditRoute {
  readonly lane: "ollama" | "claude-code" | "anthropic-api" | null;
  readonly model: string | null;
  readonly editorModel?: string;
  readonly stageOnly: boolean;
  // One line for the operator: lane, model, and why.
  readonly summary: string;
}

// Everything `/edit` needs from the outside world. Wired to src/lib/aider.ts + git.ts.
export interface SessionEditDeps {
  // The repo to edit: the cwd's git top level, else the Taisce checkout.
  readonly resolveRepo: () => Promise<string | null>;
  readonly trackedFiles: (repo: string) => Promise<string[]>;
  // Throws (with the guard message) when a picked file is sensitivity-gated.
  readonly checkFiles: (repo: string, files: readonly string[]) => void;
  /** @deprecated Compatibility only; local editing is disabled. */
  readonly coderModel: () => string;
  /** @deprecated Never invoked; local editing is disabled. */
  readonly aider: (
    repo: string,
    options: {
      message: string;
      files: readonly string[];
      dryRun: boolean;
      model?: string;
      editorModel?: string;
    },
  ) => Promise<{ exitCode: number; output: string }>;
  readonly diffStat: (repo: string) => Promise<string>;
  readonly buildPlanPrompt: (ask: string, tracked: readonly string[]) => string;
  readonly parsePlan: (text: string) => { files: string; plan: string };
  readonly pickFiles: (text: string, tracked: readonly string[]) => string[];
  // The routed edit lane for this ask (absent → the local lane, as before the router).
  readonly route?: (
    ask: string,
    pinnedModel: string | undefined,
    provider?: ProviderId,
  ) => Promise<EditRoute>;
  // Claude lane: a unified diff implementing the plan on exactly these files.
  readonly claudeDiff?: (
    repo: string,
    plan: string,
    files: readonly string[],
    route: EditRoute,
  ) => Promise<{ ok: boolean; diff?: string; error?: string; warnings?: readonly string[] }>;
  // `git apply` (check=true: `--check`, touches nothing).
  readonly applyPatch?: (
    repo: string,
    diff: string,
    check: boolean,
    files: readonly string[],
  ) => Promise<{ ok: boolean; output: string }>;
}

export interface EditContext {
  readonly edit: SessionEditDeps | undefined;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly generate: (params: ChatGenerateParams) => Promise<ChatGenerateResult>;
  readonly system: string; // the privacy header, sent with the planning turn
  readonly provider?: ProviderId;
  readonly model: string | undefined; // the session pin
  readonly nextLine: () => Promise<string | undefined>;
}

const LOCAL: EditRoute = {
  lane: "ollama",
  model: null,
  stageOnly: false,
  summary: "local lane (Aider)",
};

// Explicit outcome: warnings and deliberate no-apply decisions are successful.
// Keep unexpected dependency failures usable in an interactive session too.
export async function runEdit(ctx: EditContext, ask: string): Promise<boolean> {
  try {
    return await performEdit(ctx, ask);
  } catch (error) {
    ctx.err(`/edit: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function performEdit(ctx: EditContext, ask: string): Promise<boolean> {
  const edit = ctx.edit;
  if (edit === undefined) {
    ctx.err("/edit is not available in this session.");
    return false;
  }
  if (ask.length === 0) {
    ctx.err("usage: /edit <what to change>");
    return false;
  }
  const pins = requestPins(ctx.model, ctx.provider);
  if (pins.pinLane === "ollama") {
    ctx.err(`/edit: ${AIDER_DEPRECATION}`);
    return false;
  }
  const repo = await edit.resolveRepo();
  if (repo === null) {
    ctx.err("/edit: no git repo here and no Taisce checkout to fall back to.");
    return false;
  }
  const tracked = await edit.trackedFiles(repo);
  let route: EditRoute;
  try {
    route = edit.route !== undefined ? await edit.route(ask, ctx.model, ctx.provider) : LOCAL;
    if (route.lane !== null && pins.pinLane !== undefined && route.lane !== pins.pinLane) {
      throw new Error("edit route cannot honor the requested provider/model pin.");
    }
    if (route.lane !== null && pins.pinModel !== undefined && route.model !== pins.pinModel)
      throw new Error("edit route cannot honor the requested model pin.");
  } catch (error) {
    ctx.err(`/edit: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (route.lane === null) {
    ctx.err(`/edit: no lane can edit right now — ${route.summary}`);
    return false;
  }
  if (route.lane === "ollama") {
    ctx.err(`/edit: ${AIDER_DEPRECATION}`);
    return false;
  }
  ctx.out(`· edit in ${repo} — ${route.summary}`);

  // 1. Plan on the edit lane. The privacy rules ride along like every other turn.
  const planned = await ctx.generate({
    prompt: edit.buildPlanPrompt(ask, tracked),
    task: "edit",
    ...(ctx.system.length > 0 ? { system: ctx.system } : {}),
    ...(route.model !== null ? { model: route.model } : {}),
    provider: route.lane,
  });
  if (!planned.ok || planned.response === undefined) {
    ctx.err(planned.error ?? "/edit: planning failed.");
    return false;
  }
  for (const warning of planned.warnings ?? []) ctx.err(warning);
  const { files: namedFiles, plan } = edit.parsePlan(planned.response);
  const files = edit.pickFiles(`${namedFiles}\n${ask}`, tracked);
  ctx.out("plan:");
  ctx.out(`  files: ${files.length > 0 ? files.join(", ") : "(none matched this repo)"}`);
  ctx.out(`  ${plan}`);
  if (files.length === 0) {
    ctx.err("/edit: the plan named no file tracked in this repo. Name the file in your ask.");
    return false;
  }
  try {
    edit.checkFiles(repo, files);
  } catch (error) {
    ctx.err(error instanceof Error ? error.message : String(error));
    return false;
  }
  return claudeLane(ctx, edit, repo, plan, files, route);
}
