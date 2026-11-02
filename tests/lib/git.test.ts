import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertRepoUnchanged,
  diffForReview,
  GitDiffEmptyError,
  GitHostileConfigError,
  GitRepoMutatedError,
  gitHeadSha,
  gitStatusPorcelain,
  snapshotRepo,
} from "../../src/lib/git.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "ignore", env: { ...process.env, ...GIT_ENV } });
}

describe("lib/git", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "moss-git-test-"));
    sh("git init -b main", repo);
    writeFileSync(join(repo, "hello.txt"), "v1\n");
    sh("git add -A", repo);
    sh("git -c user.email=test@example.invalid -c user.name=test commit -m init", repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("gitHeadSha returns the current HEAD sha", async () => {
    const sha = await gitHeadSha(repo);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("gitStatusPorcelain returns empty for a clean repo", async () => {
    const status = await gitStatusPorcelain(repo);
    expect(status).toBe("");
  });

  it("snapshotRepo captures head and status together", async () => {
    const snap = await snapshotRepo(repo);
    expect(snap.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.statusPorcelain).toBe("");
  });

  it("assertRepoUnchanged is a no-op when snapshots match", async () => {
    const a = await snapshotRepo(repo);
    const b = await snapshotRepo(repo);
    expect(() => assertRepoUnchanged(a, b)).not.toThrow();
  });

  it("assertRepoUnchanged throws when status changed", async () => {
    const before = await snapshotRepo(repo);
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    const after = await snapshotRepo(repo);
    expect(() => assertRepoUnchanged(before, after)).toThrowError(GitRepoMutatedError);
  });

  it("assertRepoUnchanged throws when HEAD changed", async () => {
    const before = await snapshotRepo(repo);
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    sh("git add -A", repo);
    sh("git -c user.email=test@example.invalid -c user.name=test commit -m v2", repo);
    const after = await snapshotRepo(repo);
    expect(() => assertRepoUnchanged(before, after)).toThrowError(GitRepoMutatedError);
  });

  it("diffForReview prefers working-tree changes if present", async () => {
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    const result = await diffForReview(repo);
    expect(result.source).toBe("working-tree");
    expect(result.diff).toContain("-v1");
    expect(result.diff).toContain("+v2");
    expect(result.summary).toMatch(/working-tree-vs-HEAD: 1 file/);
  });

  it("diffForReview's working-tree includes BOTH staged and unstaged changes", async () => {
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    sh("git add -A", repo);
    writeFileSync(join(repo, "hello.txt"), "v3\n");
    const result = await diffForReview(repo);
    expect(result.source).toBe("working-tree");
    expect(result.diff).toContain("-v1");
    expect(result.diff).toContain("+v3");
  });

  it("diffForReview surfaces staged-only changes via the working-tree branch", async () => {
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    sh("git add -A", repo);
    const result = await diffForReview(repo);
    expect(result.source).toBe("working-tree");
    expect(result.diff).toContain("-v1");
    expect(result.diff).toContain("+v2");
  });

  it("diffForReview falls back to HEAD~1..HEAD if working-tree and index are clean", async () => {
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    sh("git add -A", repo);
    sh("git -c user.email=test@example.invalid -c user.name=test commit -m v2", repo);
    const result = await diffForReview(repo);
    expect(result.source).toBe("head-vs-prev");
    expect(result.diff).toContain("-v1");
    expect(result.diff).toContain("+v2");
  });

  it("hardening neutralises a hostile core.fsmonitor in the target's .git/config", async () => {
    const canaryDir = mkdtempSync(join(tmpdir(), "moss-git-canary-"));
    const canary = join(canaryDir, "evidence-of-hook-execution.txt");
    const monitorScript = join(canaryDir, "monitor.sh");
    writeFileSync(monitorScript, `#!/usr/bin/env bash\necho "FIRED" > ${canary}\nexit 1\n`);
    execSync(`chmod +x ${monitorScript}`);
    execSync(`git config core.fsmonitor ${monitorScript}`, {
      cwd: repo,
      env: { ...process.env, ...GIT_ENV },
    });

    try {
      await gitStatusPorcelain(repo);
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  it("diffForReview neutralises a hostile diff.external via --no-ext-diff", async () => {
    // A hostile target sets diff.external to a script that touches a canary
    // file. If --no-ext-diff is correctly applied to our diff invocations,
    // the script is never run and the canary stays absent.
    const canaryDir = mkdtempSync(join(tmpdir(), "moss-extdiff-canary-"));
    const canary = join(canaryDir, "fired");
    const script = join(canaryDir, "ext.sh");
    writeFileSync(script, `#!/usr/bin/env bash\ntouch ${canary}\nexit 0\n`);
    execSync(`chmod +x ${script}`);
    execSync(`git config diff.external ${script}`, {
      cwd: repo,
      env: { ...process.env, ...GIT_ENV },
    });
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    try {
      // diffForReview must succeed (the external diff is neutralised) AND
      // produce a real diff via git's built-in diff implementation.
      const result = await diffForReview(repo);
      expect(result.diff).toContain("-v1");
      expect(result.diff).toContain("+v2");
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  it("diffForReview refuses when the target's local config defines a filter.*.process", async () => {
    execSync('git config filter.malicious.process "/bin/sh -c \\"echo pwned\\""', {
      cwd: repo,
      env: { ...process.env, ...GIT_ENV },
    });
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    await expect(diffForReview(repo)).rejects.toThrowError(GitHostileConfigError);
  });

  it("diffForReview refuses when the target's local config defines core.sshCommand", async () => {
    execSync("git config core.sshCommand /usr/bin/curl", {
      cwd: repo,
      env: { ...process.env, ...GIT_ENV },
    });
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    await expect(diffForReview(repo)).rejects.toThrowError(GitHostileConfigError);
  });

  it("diffForReview throws GitDiffEmptyError when nothing to review", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "moss-git-fresh-"));
    try {
      sh("git init -b main", fresh);
      writeFileSync(join(fresh, "only.txt"), "lone\n");
      sh("git add -A", fresh);
      sh("git -c user.email=test@example.invalid -c user.name=test commit -m only", fresh);
      await expect(diffForReview(fresh)).rejects.toThrowError(GitDiffEmptyError);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
