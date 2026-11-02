import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRunCommand } from "../../src/commands/run.ts";
import { getProjectRoot, setProjectRoot } from "../../src/lib/paths.ts";
import { roomFrontmatterSchema } from "../../src/lib/rooms/schema.ts";
import type { SkillRunDependencies } from "../../src/lib/skills/runner.ts";
import { skillFrontmatterSchema } from "../../src/lib/skills/schema.ts";

function makeDeps(overrides: Partial<SkillRunDependencies> = {}): SkillRunDependencies {
  return {
    loadSkillById: (id) => ({
      frontmatter: skillFrontmatterSchema.parse({ id, name: `${id} skill`, description: "x" }),
      body: "Be careful.",
      source: `skills/${id}/SKILL.md`,
    }),
    loadAllRooms: () => [
      {
        frontmatter: roomFrontmatterSchema.parse({
          id: "review",
          name: "review",
          description: "x",
          skill: "code-review",
          target: { type: "git-repo", path: "." },
        }),
        body: "",
        source: "rooms/review/CONTEXT.md",
      },
    ],
    resolveRoomTargetPath: () => "/resolved/target",
    assertGitRepo: () => {},
    snapshotRepo: async () => ({ head: "a".repeat(40), statusPorcelain: "" }),
    diffForReview: async () => ({
      source: "working-tree",
      diff: "diff",
      summary: "working-tree: 1 file(s), +1 -1",
    }),
    loadRegistry: async () => ({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: "moss@test",
      source: "test",
      models: [
        { name: "llama3.2:3b", provider: "ollama", parameterSize: "3.2B", confidence: 0.75 },
      ],
    }),
    generate: async (opts) => ({
      model: opts.model,
      response: "Test review output.",
      durationMs: 42,
    }),
    ...overrides,
  };
}

// Test-only stub that mirrors writeReportSync's contract: it returns the
// absolute path that would have been written to. The fake builds the path
// under a synthetic /tmp/reports/ root so we don't touch the real disk.
function makeFakeReportWriter(): {
  writeReport_: (filename: string, contents: string) => string;
  writes: Array<{ filename: string; path: string; contents: string }>;
} {
  const writes: Array<{ filename: string; path: string; contents: string }> = [];
  return {
    writes,
    writeReport_: (filename, contents) => {
      const path = `/fake/reports/${filename}`;
      writes.push({ filename, path, contents });
      return path;
    },
  };
}

describe("runRunCommand", () => {
  it("runs end-to-end and prints a human summary without writing a report by default", async () => {
    const out: string[] = [];
    const writer = makeFakeReportWriter();
    const ok = await runRunCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: false,
      writeReport: false,
      out: (l) => out.push(l),
      err: () => {},
      deps: makeDeps(),
      writeReport_: writer.writeReport_,
    });
    expect(ok).toBe(true);
    expect(writer.writes).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain("Ran skill 'code-review'");
    expect(text).toContain("Test review output.");
    expect(text).not.toContain("Report written to");
  });

  it("records one usage line per successful run via the recordUsage seam", async () => {
    const calls: unknown[] = [];
    const ok = await runRunCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: false,
      writeReport: false,
      out: () => {},
      err: () => {},
      deps: makeDeps({
        // Simulate the router selecting a non-Ollama fallback lane: the
        // usage record must reflect the real provider, not a hardcoded
        // "ollama".
        generate: async (opts) => ({
          model: opts.model,
          response: "ok",
          providerId: "cursor-manual",
          durationMs: 42,
          inputTokens: 100,
          outputTokens: 20,
        }),
      }),
      recordUsage: async (input) => {
        calls.push(input);
      },
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "run",
      providerId: "cursor-manual",
      model: "llama3.2:3b",
      skill: "code-review",
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it("writes a markdown report under reports/ when --write-report is set", async () => {
    const out: string[] = [];
    const writer = makeFakeReportWriter();
    const fixedNow = () => new Date(Date.UTC(2026, 4, 22, 12, 0, 0, 0));
    const ok = await runRunCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: false,
      writeReport: true,
      out: (l) => out.push(l),
      err: () => {},
      deps: makeDeps(),
      now: fixedNow,
      writeReport_: writer.writeReport_,
    });
    expect(ok).toBe(true);
    expect(writer.writes).toHaveLength(1);
    const write = writer.writes[0];
    expect(write).toBeDefined();
    if (write === undefined) return;
    expect(write.filename).toBe("code-review-20260522T120000000Z.md");
    expect(write.path).toMatch(/\/reports\/code-review-20260522T120000000Z\.md$/);
    expect(write.contents).toContain("# code-review skill report");
    expect(write.contents).toContain("Test review output.");
    expect(write.contents).toContain("target repo unchanged: true");
    expect(out.join("\n")).toContain("Report written to ");
  });

  it("emits JSON including reportPath when --write-report is set", async () => {
    const out: string[] = [];
    const writer = makeFakeReportWriter();
    await runRunCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: true,
      writeReport: true,
      out: (l) => out.push(l),
      err: () => {},
      deps: makeDeps(),
      now: () => new Date(Date.UTC(2026, 4, 22, 12, 0, 0, 0)),
      writeReport_: writer.writeReport_,
    });
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.skill.id).toBe("code-review");
    expect(parsed.unchanged).toBe(true);
    expect(parsed.reportPath).toMatch(/\/reports\/code-review-20260522T120000000Z\.md$/);
  });

  it("does not write a report if the run errors before completion", async () => {
    const writer = makeFakeReportWriter();
    const err: string[] = [];
    const ok = await runRunCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: false,
      writeReport: true,
      out: () => {},
      err: (l) => err.push(l),
      deps: makeDeps({
        generate: async () => {
          throw new Error("ollama exploded");
        },
      }),
      writeReport_: writer.writeReport_,
    });
    expect(ok).toBe(false);
    expect(writer.writes).toEqual([]);
    expect(err.join("\n")).toMatch(/moss run failed: ollama exploded/);
  });

  it("surfaces NoRoomForSkillError verbatim without 'moss run failed:' prefix", async () => {
    const err: string[] = [];
    const ok = await runRunCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: false,
      writeReport: false,
      out: () => {},
      err: (l) => err.push(l),
      deps: makeDeps({ loadAllRooms: () => [] }),
    });
    expect(ok).toBe(false);
    expect(err.join("\n")).toMatch(/^No room is configured for skill/);
  });

  it("refuses --write-report when the target IS the Moss project root", async () => {
    const realRoot = getProjectRoot();
    const mossRoot = mkdtempSync(join(tmpdir(), "moss-run-self-"));
    setProjectRoot(mossRoot);
    const err: string[] = [];
    const writer = makeFakeReportWriter();
    try {
      const ok = await runRunCommand({
        skillId: "code-review",
        cwd: "/x",
        emitJson: false,
        writeReport: true,
        out: () => {},
        err: (l) => err.push(l),
        deps: makeDeps({
          resolveRoomTargetPath: () => mossRoot,
        }),
        writeReport_: writer.writeReport_,
      });
      expect(ok).toBe(false);
      expect(writer.writes).toEqual([]);
      expect(err.join("\n")).toMatch(/Cannot --write-report when the target repo/);
    } finally {
      setProjectRoot(realRoot);
      rmSync(mossRoot, { recursive: true, force: true });
    }
  });

  it("writes the report path under the Moss project root, not the target", async () => {
    const writer = makeFakeReportWriter();
    await runRunCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: false,
      writeReport: true,
      out: () => {},
      err: () => {},
      deps: makeDeps(),
      now: () => new Date(Date.UTC(2026, 4, 22, 0, 0, 0, 0)),
      writeReport_: writer.writeReport_,
    });
    const written = writer.writes[0];
    expect(written).toBeDefined();
    if (written === undefined) return;
    expect(written.path).not.toMatch(/^\/resolved\/target/);
    expect(written.path).toMatch(/\/reports\//);
  });
});
