import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTaisceSessionDeps } from "../../src/commands/chat.ts";
import * as exec from "../../src/lib/exec.ts";
import { diffForReview, gitApply, gitTrackedFiles, snapshotRepo } from "../../src/lib/git.ts";

describe("effective Git preflight", () => {
  let root: string;
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "moss-preflight-"));
    repo = join(root, "repo");
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-b", "main", repo], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    writeFileSync(join(repo, "f.txt"), "old\n");
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=canary.with.dots\n");
    git("add", ".");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    writeFileSync(join(repo, "f.txt"), "dirty\n");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["direct", "include", "conditional", "global", "command", "worktree"])(
    "refuses %s filter configuration before any affected command",
    async (kind) => {
      // This command string is inert data: run is intercepted before Git can
      // consume it. The callback proves no status/diff/apply/ls-files runs.
      const config = '[filter "canary.with.dots"]\n clean = fixture-callback-never-run\n';
      const included = join(root, "included.config");
      writeFileSync(included, config);
      if (kind === "direct")
        git("config", "filter.canary.with.dots.clean", "fixture-callback-never-run");
      if (kind === "include") git("config", "include.path", included);
      if (kind === "conditional")
        git("config", `includeIf.gitdir:${realpathSync(repo)}/.git.path`, included);
      if (kind === "global") vi.stubEnv("GIT_CONFIG_GLOBAL", included);
      if (kind === "command") {
        vi.stubEnv("GIT_CONFIG_COUNT", "1");
        vi.stubEnv("GIT_CONFIG_KEY_0", "filter.canary.with.dots.process");
        vi.stubEnv("GIT_CONFIG_VALUE_0", "fixture-callback-never-run");
      }
      if (kind === "worktree") {
        git("config", "extensions.worktreeConfig", "true");
        writeFileSync(join(repo, ".git/config.worktree"), config);
      }
      const original = exec.run;
      const dangerous = vi.fn();
      vi.spyOn(exec, "run").mockImplementation(async (command, args, options) => {
        if (command !== "git" || !args.includes("config")) {
          dangerous();
          throw new Error("affected command must never run");
        }
        return original(command, args, options);
      });
      const bytes = readFileSync(join(repo, "f.txt"));
      const index = readFileSync(join(repo, ".git/index"));
      for (const operation of [
        () => snapshotRepo(repo),
        () => diffForReview(repo),
        () => gitTrackedFiles(repo),
        () =>
          gitApply(repo, "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-dirty\n+new\n", true, ["f.txt"]),
      ]) {
        await expect(operation()).rejects.toThrow("effective config defines");
      }
      await expect(
        buildTaisceSessionDeps(join(root, "absent-workspace")).edit?.aider(repo, {
          message: "fixture",
          files: ["f.txt"],
          dryRun: true,
        }),
      ).rejects.toThrow("deprecated and disabled");
      expect(dangerous).not.toHaveBeenCalled();
      expect(readFileSync(join(repo, "f.txt"))).toEqual(bytes);
      expect(readFileSync(join(repo, ".git/index"))).toEqual(index);
    },
  );

  it.each(["", "with.dots"])("refuses Git-valid unusual filter subsection %j", async (driver) => {
    git("config", `filter.${driver}.clean`, "fixture-callback-never-run");
    const original = exec.run;
    const affected = vi.fn();
    vi.spyOn(exec, "run").mockImplementation(async (command, args, options) => {
      if (!args.includes("config")) {
        affected();
        throw new Error("must never run");
      }
      return original(command, args, options);
    });
    await expect(snapshotRepo(repo)).rejects.toThrow("effective config defines");
    expect(affected).not.toHaveBeenCalled();
  });

  it("permits ordinary included configuration and preserves spaced tracked names", async () => {
    const included = join(root, "harmless.config");
    writeFileSync(included, "[diff]\n algorithm = histogram\n");
    git("config", "include.path", included);
    writeFileSync(join(repo, "two words.txt"), "text\n");
    git("add", "two words.txt");
    expect(await gitTrackedFiles(repo)).toContain("two words.txt");
    expect((await diffForReview(repo)).diff).toContain("+dirty");
  });

  it.each(["failure", "framing", "throw"])("fails closed on inspection %s", async (kind) => {
    const affected = vi.fn();
    vi.spyOn(exec, "run").mockImplementation(async (_command, args) => {
      if (!args.includes("config")) affected();
      if (kind === "throw") throw new Error("inspection unavailable");
      return {
        command: "git",
        args,
        stdout: kind === "framing" ? "filter.x.clean" : "",
        stderr: "",
        exitCode: kind === "failure" ? 1 : 0,
      };
    });
    await expect(gitTrackedFiles(repo)).rejects.toThrow();
    expect(affected).not.toHaveBeenCalled();
  });
});
