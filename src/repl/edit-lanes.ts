// The two ways `/edit` applies a plan: Aider on the local lane, or one Claude-written
// unified diff on a Claude lane. Split from edit.ts; the flow and its contract live there.

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

async function finish(
  ctx: EditContext,
  edit: SessionEditDeps,
  repo: string,
  second: boolean,
): Promise<void> {
  const stat = await edit.diffStat(repo);
  ctx.out("git diff --stat:");
  ctx.out(stat.length > 0 ? stat : "  (no changes)");
  ctx.out(
    second
      ? "Not committed. Read `git diff` — the apply is a second generation and can differ from the dry run."
      : "Not committed. Applied exactly the diff shown above. Read `git diff` before committing.",
  );
}

async function finishAfterApply(
  ctx: EditContext,
  edit: SessionEditDeps,
  repo: string,
  second: boolean,
): Promise<void> {
  try {
    await finish(ctx, edit, repo, second);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.err(
      `/edit: changes were applied, but Moss could not read the diff summary (${detail}). Inspect git diff and git status before continuing.`,
    );
  }
}

export async function claudeLane(
  ctx: EditContext,
  edit: SessionEditDeps,
  repo: string,
  plan: string,
  files: string[],
  route: EditRoute,
) {
  if (edit.claudeDiff === undefined || edit.applyPatch === undefined) {
    ctx.err(`/edit: the ${route.lane} lane is not wired for edits in this session.`);
    return;
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
    return;
  }
  ctx.out(made.diff.trimEnd());
  try {
    const stray = diffPaths(made.diff).filter((p) => !files.includes(p));
    if (stray.length > 0) {
      ctx.err(
        `/edit: the diff touches files outside the plan (${stray.join(", ")}); refused, nothing applied.`,
      );
      return;
    }
  } catch (error) {
    ctx.err(`/edit: ${error instanceof Error ? error.message : String(error)} Nothing applied.`);
    return;
  }
  const check = await edit.applyPatch(repo, made.diff, true, files);
  if (!check.ok) {
    ctx.err(
      `/edit: the diff does not apply cleanly (git apply --check: ${check.output.trim()}); nothing applied.`,
    );
    return;
  }
  if (route.stageOnly) {
    ctx.out(
      "STAGE-ONLY (front-door gate): the diff above is shown for review. No target patch was applied.",
    );
    return;
  }
  if (!(await askGo(ctx))) return;
  let applied: { ok: boolean; output: string };
  try {
    applied = await edit.applyPatch(repo, made.diff, false, files);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.err(
      `/edit: git apply raised an error (${detail}); inspect git diff and git status because Moss cannot confirm whether changes were partial.`,
    );
    return;
  }
  if (!applied.ok) {
    ctx.err(
      `/edit: git apply failed: ${applied.output.trim()}. Inspect git diff and git status because Moss cannot confirm whether changes were partial.`,
    );
    return;
  }
  await finishAfterApply(ctx, edit, repo, false);
}

export async function localLane(
  ctx: EditContext,
  edit: SessionEditDeps,
  repo: string,
  plan: string,
  files: string[],
  route: EditRoute,
) {
  const editor = route.editorModel ?? edit.coderModel();
  const architect = route.model ?? undefined;
  const opts = {
    message: plan,
    files,
    ...(architect !== undefined ? { model: architect, editorModel: editor } : {}),
  };
  const who = architect !== undefined ? `architect ${architect} → editor ${editor}` : editor;
  ctx.out(`· aider --dry-run with ${who} (Moss has not applied a patch)…`);
  const dry = await edit.aider(repo, { ...opts, dryRun: true });
  ctx.out(dry.output.length > 0 ? dry.output : "(aider printed nothing)");
  if (dry.exitCode !== 0) {
    ctx.err(`/edit: aider exited ${dry.exitCode} on the dry run; nothing was applied.`);
    return;
  }
  if (route.stageOnly) {
    ctx.out(
      "STAGE-ONLY (front-door gate): the dry run above is staged for you to read. Nothing was applied.",
    );
    return;
  }
  if (!(await askGo(ctx))) return;
  ctx.out(`· aider applying with ${who} (no commit)…`);
  let applied: { exitCode: number; output: string };
  try {
    applied = await edit.aider(repo, { ...opts, dryRun: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.err(
      `/edit: aider apply failed (${detail}). Moss cannot determine whether it changed some files; inspect git diff and git status before continuing. No completion is reported.`,
    );
    return;
  }
  ctx.out(applied.output.length > 0 ? applied.output : "(aider printed nothing)");
  if (applied.exitCode !== 0) {
    ctx.err(
      `/edit: aider exited ${applied.exitCode} during apply. Moss cannot determine whether it changed some files; inspect git diff and git status before continuing. No completion is reported.`,
    );
    return;
  }
  await finishAfterApply(ctx, edit, repo, true);
}
