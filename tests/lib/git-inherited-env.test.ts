// Regression: moss must ignore the git variables a hook exports.
//
// Found 2026-09-19 pushing a branch from a worktree: the pre-push hook exports GIT_DIR
// (absolute, inside the worktree) and GIT_INDEX_FILE, the suite inherited them, and every
// git call aimed at a temp repository read the moss checkout instead. In production the
// same leak means `moss` invoked from a hook would inspect — and report on — the wrong
// repository. safeGit now removes them; cwd alone decides the target.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_INHERITED_ENV, gitHeadSha, gitStatusPorcelain, safeGit } from "../../src/lib/git.ts";

function git(args: readonly string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

function makeRepo(label: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), `moss-inherited-${label}-`));
  git(["init", "-b", "main"], dir);
  writeFileSync(join(dir, "file.txt"), contents);
  git(["add", "-A"], dir);
  git(
    ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-m", label],
    dir,
  );
  return dir;
}

describe("git ignores an inherited hook environment", () => {
  let target: string;
  let intruder: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    target = makeRepo("target", "target\n");
    intruder = makeRepo("intruder", "intruder\n");
    // Exactly what a pre-push hook hands its children.
    for (const key of GIT_INHERITED_ENV) saved.set(key, process.env[key]);
    process.env.GIT_DIR = join(intruder, ".git");
    process.env.GIT_WORK_TREE = intruder;
    process.env.GIT_INDEX_FILE = join(intruder, ".git", "index");
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    rmSync(target, { recursive: true, force: true });
    rmSync(intruder, { recursive: true, force: true });
  });

  it("resolves the repository from cwd, not from GIT_DIR", async () => {
    const targetHead = await gitHeadSha(target);
    const intruderHead = await gitHeadSha(intruder);
    expect(targetHead).not.toBe(intruderHead);

    const log = await safeGit(["log", "-1", "--pretty=%s"], { cwd: target });
    expect(log.stdout.trim()).toBe("target");
  });

  it("reports the cwd repository's status, not the intruder's", async () => {
    writeFileSync(join(target, "file.txt"), "dirty\n");
    expect(await gitStatusPorcelain(target)).toContain("file.txt");
    // The intruder is untouched and still clean, which is the tell: without the fix the
    // status of `target` would have been read out of the intruder's index.
    expect(await gitStatusPorcelain(intruder)).toBe("");
  });
});
