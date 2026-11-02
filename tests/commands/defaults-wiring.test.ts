// The real default dependencies, exercised without side effects: local files, `pnpm
// --version`, and the Ollama lifecycle guard the suite sets (MOSS_NO_OLLAMA_LIFECYCLE=1).
// These run on GitHub's runner too, where only moss's own code is on hand.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { defaultBenchTargets } from "../../src/commands/bench.ts";
import { allChecks } from "../../src/commands/check.ts";
import { defaultExplainDeps } from "../../src/commands/explain.ts";
import { registerOff } from "../../src/commands/off.ts";
import { defaultTaisceRunDeps } from "../../src/commands/run-taisce.ts";
import { defaultHealthCtx } from "../../src/lib/health/context.ts";

describe("moss check's real context", () => {
  it("reads files, times and folders, runs an allowlisted command, and reads local git config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-ctx-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    const ctx = defaultHealthCtx(false);
    expect(ctx.readText(join(dir, "a.txt"))).toBe("hello");
    expect(ctx.readText(join(dir, "missing"))).toBeNull();
    expect(ctx.mtime(join(dir, "a.txt"))).toBeInstanceOf(Date);
    expect(ctx.mtime(join(dir, "missing"))).toBeNull();
    expect(ctx.listDir(dir)).toEqual(["a.txt"]);
    expect(ctx.listDir(join(dir, "missing"))).toEqual([]);
    expect(ctx.exists(dir)).toBe(true);
    expect((await ctx.run("pnpm", ["--version"])).exitCode).toBe(0);
    expect((await ctx.run("not-allowlisted", [])).exitCode).toBe(127);
    expect(await ctx.gitConfig(dir, "core.hooksPath")).toBeNull();
    expect(ctx.deep).toBe(false);
    expect(ctx.now()).toBeInstanceOf(Date);
  });

  it("assembles checks whose policy and bench readers work on this checkout", async () => {
    const checks = allChecks();
    const models = checks.find((c) => c.name === "models routing.yaml needs");
    const bench = checks.find((c) => c.name === "last moss bench");
    const ctx = defaultHealthCtx(false);
    expect(Array.isArray(await models?.run(ctx))).toBe(true);
    expect(await bench?.run(ctx)).toMatchObject({ group: "AI tools" });
  });
});

describe("default deps of run, --explain and bench", () => {
  it("load the real routing policy and build select deps without probing anything", async () => {
    expect(defaultTaisceRunDeps.policy().caps["anthropic-api"].enabled).toBe(false);
    expect(typeof defaultTaisceRunDeps.select().probe).toBe("function");
    expect(await defaultTaisceRunDeps.afterRun?.()).toBeNull(); // this process started nothing
    expect(defaultExplainDeps.policy().tasks.reason?.lanes[0]).toBe("claude-code");
    expect(typeof defaultExplainDeps.select().localModels).toBe("function");
    expect(defaultBenchTargets({ MOSS_CHAT_MODEL: "x:1" }).map((t) => t.model)).toContain("x:1");
  });
});

describe("moss off", () => {
  it("never touches the real Ollama from a test, and says so", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const program = new Command().exitOverride();
      registerOff(program);
      await program.parseAsync(["node", "moss", "off"]);
      expect(write.mock.calls.map((c) => String(c[0])).join("")).toContain("lifecycle disabled");
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      process.exitCode = 0;
    }
  });
});
