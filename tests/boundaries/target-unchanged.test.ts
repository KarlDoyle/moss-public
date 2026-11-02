import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRunCommand } from "../../src/commands/run.ts";
import { getProjectRoot, setProjectRoot } from "../../src/lib/paths.ts";
import {
  defaultSkillRunDependencies,
  type SkillRunDependencies,
} from "../../src/lib/skills/runner.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "ignore", env: { ...process.env, ...GIT_ENV } });
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const full = join(dir, name);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else out.push(full);
    }
  }
  walk(root);
  return out.sort();
}

describe("target repo unchanged guarantee (integration)", () => {
  const realRoot = getProjectRoot();
  let mossRoot: string;
  let targetRepo: string;

  beforeEach(() => {
    mossRoot = mkdtempSync(join(tmpdir(), "moss-int-root-"));
    targetRepo = mkdtempSync(join(tmpdir(), "moss-int-target-"));

    sh("git init -b main", targetRepo);
    writeFileSync(join(targetRepo, "file.txt"), "old\n");
    sh("git add -A", targetRepo);
    sh("git commit -m init", targetRepo);
    writeFileSync(join(targetRepo, "file.txt"), "new\n");

    mkdirSync(join(mossRoot, "skills", "code-review"), { recursive: true });
    writeFileSync(
      join(mossRoot, "skills", "code-review", "SKILL.md"),
      [
        "---",
        "id: code-review",
        "name: Code review",
        "description: Review a diff.",
        "---",
        "",
        "Review the diff.",
        "",
      ].join("\n"),
    );

    mkdirSync(join(mossRoot, "rooms", "review"), { recursive: true });
    writeFileSync(
      join(mossRoot, "rooms", "review", "CONTEXT.md"),
      [
        "---",
        "id: review",
        "name: Review",
        "description: Review the target.",
        "skill: code-review",
        "target:",
        "  type: git-repo",
        `  path: ${targetRepo}`,
        "---",
        "",
      ].join("\n"),
    );

    setProjectRoot(mossRoot);
  });

  afterEach(() => {
    setProjectRoot(realRoot);
    rmSync(mossRoot, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  });

  function makeStubbedDeps(): SkillRunDependencies {
    return {
      ...defaultSkillRunDependencies,
      loadRegistry: async () => ({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        generatedBy: "moss@test",
        source: "test",
        models: [{ name: "test-model", provider: "ollama", parameterSize: "3B", confidence: 0.7 }],
      }),
      generate: async (opts) => ({
        model: opts.model,
        response: "stubbed review output",
        durationMs: 1,
      }),
    };
  }

  it("a successful run leaves the target repo byte-identical and writes report inside Moss root", async () => {
    const beforeFiles = listFilesRecursive(targetRepo);
    const beforeHead = execSync("git rev-parse HEAD", { cwd: targetRepo }).toString().trim();
    const beforeStatus = execSync("git status --porcelain=v1", { cwd: targetRepo })
      .toString()
      .trim();

    const out: string[] = [];
    const ok = await runRunCommand({
      skillId: "code-review",
      cwd: "/anywhere",
      emitJson: false,
      writeReport: true,
      out: (l) => out.push(l),
      err: () => {},
      deps: makeStubbedDeps(),
    });
    expect(ok).toBe(true);

    const afterFiles = listFilesRecursive(targetRepo);
    const afterHead = execSync("git rev-parse HEAD", { cwd: targetRepo }).toString().trim();
    const afterStatus = execSync("git status --porcelain=v1", { cwd: targetRepo })
      .toString()
      .trim();

    expect(afterFiles).toEqual(beforeFiles);
    expect(afterHead).toBe(beforeHead);
    expect(afterStatus).toBe(beforeStatus);

    const reports = readdirSync(join(mossRoot, "reports"));
    expect(reports.length).toBe(1);
    expect(reports[0]).toMatch(/^code-review-\d{8}T\d{6}\d{3}Z\.md$/);

    const fileInTarget = readdirSync(targetRepo).filter((n) => n.endsWith(".md"));
    expect(fileInTarget).toEqual([]);
  });

  it("if the target mutates between snapshots, the run fails and the error is surfaced", async () => {
    let snapshotCalls = 0;
    const deps: SkillRunDependencies = {
      ...makeStubbedDeps(),
      snapshotRepo: async (path) => {
        snapshotCalls += 1;
        const base = await defaultSkillRunDependencies.snapshotRepo(path);
        if (snapshotCalls === 2) {
          writeFileSync(join(targetRepo, "sneaky.txt"), "added by attacker simulation\n");
          return await defaultSkillRunDependencies.snapshotRepo(path);
        }
        return base;
      },
    };

    const err: string[] = [];
    const ok = await runRunCommand({
      skillId: "code-review",
      cwd: "/anywhere",
      emitJson: false,
      writeReport: false,
      out: () => {},
      err: (l) => err.push(l),
      deps,
    });
    expect(ok).toBe(false);
    expect(err.join("\n")).toMatch(/Target git repository changed during the run/);

    rmSync(join(targetRepo, "sneaky.txt"), { force: true });
  });

  it("writes report files only under the Moss project's reports/ directory", async () => {
    const ok = await runRunCommand({
      skillId: "code-review",
      cwd: "/anywhere",
      emitJson: false,
      writeReport: true,
      out: () => {},
      err: () => {},
      deps: makeStubbedDeps(),
    });
    expect(ok).toBe(true);

    const reportsDir = join(mossRoot, "reports");
    const reports = readdirSync(reportsDir);
    expect(reports.length).toBe(1);

    const filesUnderTarget = listFilesRecursive(targetRepo);
    for (const file of filesUnderTarget) {
      expect(file).not.toContain("code-review-");
      expect(file).not.toMatch(/\.md$/);
    }
  });
});
