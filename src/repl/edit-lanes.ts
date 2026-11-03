// Hosted unified-text patch application. Local Aider editing is deprecated.

import { textPatchPaths } from "../lib/patch.ts";
import type { EditContext, EditRoute, SessionEditDeps } from "./edit.ts";

export const diffPaths = textPatchPaths;

async function askGo(ctx: EditContext): Promise<boolean> {
  ctx.out("go? [y/N]");
  const answer = ((await ctx.nextLine()) ?? "").trim().toLowerCase();
  if (["y", "yes", "go"].includes(answer)) return true;
  ctx.out("not applied. No target patch was applied.");
  return false;
}

async function finish(ctx: EditContext, edit: SessionEditDeps, repo: string): Promise<void> {
  const stat = await edit.diffStat(repo);
  ctx.out("git diff --stat:");
  ctx.out(stat.length > 0 ? stat : "  (no changes)");
  ctx.out(
    "Not committed. Applied exactly the diff shown above. Read `git diff` before committing.",
  );
}

async function finishAfterApply(
  ctx: EditContext,
  edit: SessionEditDeps,
  repo: string,
): Promise<boolean> {
  try {
    await finish(ctx, edit, repo);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.err(
      `/edit: changes were applied, but Moss could not read the diff summary (${detail}). Inspect git diff and git status before continuing.`,
    );
    return false;
  }
}

export async function claudeLane(
  ctx: EditContext,
  edit: SessionEditDeps,
  repo: string,
  plan: string,
  files: string[],
  route: EditRoute,
): Promise<boolean> {
  if (edit.claudeDiff === undefined || edit.applyPatch === undefined) {
    ctx.err(`/edit: the ${route.lane} lane is not wired for edits in this session.`);
    return false;
  }
  ctx.out(
    `· ${route.lane} preparing a unified diff with ${route.model} (patch text stays in memory)…`,
  );
  const made = await edit.claudeDiff(repo, plan, files, route);
  for (const warning of made.warnings ?? []) ctx.err(warning);
  if (!made.ok || made.diff === undefined || made.diff.trim().length === 0) {
    ctx.err(
      `/edit: no diff from ${route.lane}: ${made.error ?? "empty reply"}. Nothing was applied.`,
    );
    return false;
  }
  ctx.out(made.diff.trimEnd());
  try {
    const stray = diffPaths(made.diff).filter((p) => !files.includes(p));
    if (stray.length > 0) {
      ctx.err(
        `/edit: the diff touches files outside the plan (${stray.join(", ")}); refused, nothing applied.`,
      );
      return false;
    }
  } catch (error) {
    ctx.err(`/edit: ${error instanceof Error ? error.message : String(error)} Nothing applied.`);
    return false;
  }
  const check = await edit.applyPatch(repo, made.diff, true, files);
  if (!check.ok) {
    ctx.err(
      `/edit: the diff does not apply cleanly (git apply --check: ${check.output.trim()}); nothing applied.`,
    );
    return false;
  }
  if (route.stageOnly) {
    ctx.out(
      "STAGE-ONLY (front-door gate): the diff above is shown for review. No target patch was applied.",
    );
    return true;
  }
  if (!(await askGo(ctx))) return true;
  let applied: { ok: boolean; output: string };
  try {
    applied = await edit.applyPatch(repo, made.diff, false, files);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.err(
      `/edit: git apply raised an error (${detail}); inspect git diff and git status because Moss cannot confirm whether changes were partial.`,
    );
    return false;
  }
  if (!applied.ok) {
    ctx.err(
      `/edit: git apply failed: ${applied.output.trim()}. Inspect git diff and git status because Moss cannot confirm whether changes were partial.`,
    );
    return false;
  }
  return finishAfterApply(ctx, edit, repo);
}
