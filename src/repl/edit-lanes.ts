// The two ways `/edit` applies a plan: Aider on the local lane, or one Claude-written
// unified diff on a Claude lane. Split from edit.ts; the flow and its contract live there.
import type { EditContext, EditRoute, SessionEditDeps } from "./edit.ts";

// Paths a unified diff touches (`--- a/x` / `+++ b/x`), minus /dev/null.
export function diffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const m of diff.matchAll(/^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/gm)) {
    if (m[1] !== undefined && m[1] !== "/dev/null") paths.add(m[1]);
  }
  return [...paths];
}

async function askGo(ctx: EditContext): Promise<boolean> {
  ctx.out("go? [y/N]");
  const answer = ((await ctx.nextLine()) ?? "").trim().toLowerCase();
  if (["y", "yes", "go"].includes(answer)) return true;
  ctx.out("not applied. Nothing was written.");
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
  ctx.out(`· ${route.lane} writing a unified diff with ${route.model} (nothing is written)…`);
  const made = await edit.claudeDiff(repo, plan, files, route);
  if (!made.ok || made.diff === undefined || made.diff.trim().length === 0) {
    ctx.err(
      `/edit: no diff from ${route.lane}: ${made.error ?? "empty reply"}. Nothing was applied.`,
    );
    return;
  }
  ctx.out(made.diff.trimEnd());
  const stray = diffPaths(made.diff).filter((p) => !files.includes(p));
  if (stray.length > 0) {
    ctx.err(
      `/edit: the diff touches files outside the plan (${stray.join(", ")}); refused, nothing applied.`,
    );
    return;
  }
  const check = await edit.applyPatch(repo, made.diff, true);
  if (!check.ok) {
    ctx.err(
      `/edit: the diff does not apply cleanly (git apply --check: ${check.output.trim()}); nothing applied.`,
    );
    return;
  }
  if (route.stageOnly) {
    ctx.out(
      "STAGE-ONLY (front-door gate): the diff above is staged for you to read. Nothing was applied.",
    );
    return;
  }
  if (!(await askGo(ctx))) return;
  const applied = await edit.applyPatch(repo, made.diff, false);
  if (!applied.ok) {
    ctx.err(`/edit: git apply failed: ${applied.output.trim()}`);
    return;
  }
  await finish(ctx, edit, repo, false);
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
  ctx.out(`· aider --dry-run with ${who} (nothing is written)…`);
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
  const applied = await edit.aider(repo, { ...opts, dryRun: false });
  ctx.out(applied.output.length > 0 ? applied.output : "(aider printed nothing)");
  await finish(ctx, edit, repo, true);
}
