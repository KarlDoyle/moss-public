import { describe, expect, it } from "vitest";
import { runPlanCommand } from "../../src/commands/plan.ts";
import { roomFrontmatterSchema } from "../../src/lib/rooms/schema.ts";
import type { SkillRunDependencies } from "../../src/lib/skills/runner.ts";
import { NoRoomForSkillError } from "../../src/lib/skills/runner.ts";
import { skillFrontmatterSchema } from "../../src/lib/skills/schema.ts";

function makeDeps(overrides: Partial<SkillRunDependencies> = {}): SkillRunDependencies {
  return {
    loadSkillById: (id) => ({
      frontmatter: skillFrontmatterSchema.parse({ id, name: id, description: id }),
      body: "Review the diff.",
      source: `skills/${id}/SKILL.md`,
    }),
    loadAllRooms: () => [
      {
        frontmatter: roomFrontmatterSchema.parse({
          id: "review",
          name: "review",
          description: "review",
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
      diff: "diff content",
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
    generate: async () => {
      throw new Error("plan must not call generate");
    },
    ...overrides,
  };
}

describe("runPlanCommand", () => {
  it("prints a human plan and never calls generate", async () => {
    const out: string[] = [];
    const ok = await runPlanCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: false,
      out: (l) => out.push(l),
      err: () => {},
      deps: makeDeps(),
    });
    expect(ok).toBe(true);
    const text = out.join("\n");
    expect(text).toContain("Plan for skill 'code-review'");
    expect(text).toContain("target:       /resolved/target");
    expect(text).toContain("model:        llama3.2:3b");
    expect(text).toContain("----- BEGIN PROMPT -----");
    expect(text).toContain("Nothing was sent to the model");
  });

  it("emits JSON shape including promptLength", async () => {
    const out: string[] = [];
    await runPlanCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: true,
      out: (l) => out.push(l),
      err: () => {},
      deps: makeDeps(),
    });
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.skill.id).toBe("code-review");
    expect(parsed.target).toBe("/resolved/target");
    expect(parsed.model).toBe("llama3.2:3b");
    expect(typeof parsed.promptLength).toBe("number");
    expect(parsed.promptLength).toBeGreaterThan(0);
  });

  it("returns false and writes a clean error if no room matches the skill", async () => {
    const err: string[] = [];
    const ok = await runPlanCommand({
      skillId: "no-match",
      cwd: "/x",
      emitJson: false,
      out: () => {},
      err: (l) => err.push(l),
      deps: makeDeps({
        loadAllRooms: () => [],
      }),
    });
    expect(ok).toBe(false);
    expect(err.join("\n")).toMatch(/No room is configured for skill/);
    // sanity: ensure the error class is reachable from the test file
    expect(new NoRoomForSkillError("x")).toBeInstanceOf(Error);
  });

  it("returns false and surfaces unexpected errors via 'moss plan failed:'", async () => {
    const err: string[] = [];
    const ok = await runPlanCommand({
      skillId: "code-review",
      cwd: "/x",
      emitJson: false,
      out: () => {},
      err: (l) => err.push(l),
      deps: makeDeps({
        loadRegistry: async () => {
          throw new Error("disk on fire");
        },
      }),
    });
    expect(ok).toBe(false);
    expect(err.join("\n")).toMatch(/moss plan failed: disk on fire/);
  });
});
