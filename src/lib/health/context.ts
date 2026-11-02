// The real HealthCtx: guarded subprocesses (exec.ts allowlist), git through git.ts, and
// read-only file metadata. Nothing here writes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { run } from "../exec.ts";
import { safeGit } from "../git.ts";
import { resolveTaisceRoot } from "../paths.ts";
import type { HealthCtx } from "./types.ts";

// The folder holding every repo (~/Dev): Taisce's parent — or, when Taisce is a worktree
// (<repo>/.claude/worktrees/<name>), the parent of the repo that owns it.
export function estateRoot(taisceRoot: string): string {
  const at = taisceRoot.indexOf("/.claude/worktrees/");
  return dirname(at === -1 ? taisceRoot : taisceRoot.slice(0, at));
}

export function defaultHealthCtx(deep: boolean): HealthCtx {
  const taisceRoot = resolveTaisceRoot();
  return {
    run: async (command, args, timeoutMs = 120_000) => {
      try {
        const r = await run(command, args, { allowFailure: true, timeoutMs });
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      } catch (error) {
        return {
          exitCode: 127,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
    gitConfig: async (repo, key) => {
      // --local: safeGit's hardening passes `-c core.hooksPath=/dev/null` (and friends) on
      // every call, which a plain --get would report instead of the repo's own setting.
      const r = await safeGit(["config", "--local", "--get", key], {
        cwd: repo,
        allowFailure: true,
      });
      return r.exitCode === 0 ? r.stdout.trim() : null;
    },
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    mtime: (path) => {
      try {
        return statSync(path).mtime;
      } catch {
        return null;
      }
    },
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    exists: (path) => existsSync(path),
    now: () => new Date(),
    home: homedir(),
    devRoot: estateRoot(taisceRoot),
    taisceRoot,
    deep,
  };
}
