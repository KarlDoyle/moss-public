import { describe, expect, it } from "vitest";
import { GitRepoMutatedError } from "../../../src/lib/git.ts";
import { roomFrontmatterSchema } from "../../../src/lib/rooms/schema.ts";
import {
  NoModelAvailableError,
  NoRoomForSkillError,
  planSkill,
  runSkill,
  type SkillRunDependencies,
} from "../../../src/lib/skills/runner.ts";
import { skillFrontmatterSchema } from "../../../src/lib/skills/schema.ts";

function makeSkill(id: string, body = "Review the diff and produce a markdown report.") {
  const frontmatter = skillFrontmatterSchema.parse({
    id,
    name: id,
    description: id,
  });
  return { frontmatter, body, source: `skills/${id}/SKILL.md` };
}

function makeRoom(id: string, skill: string, path = "/target/repo") {
  const frontmatter = roomFrontmatterSchema.parse({
    id,
    name: id,
    description: id,
    skill,
    target: { type: "git-repo", path },
  });
  return { frontmatter, body: `Room body for ${id}`, source: `rooms/${id}/CONTEXT.md` };
}

function makeDeps(overrides: Partial<SkillRunDependencies> = {}): SkillRunDependencies {
  return {
    loadSkillById: (id) => makeSkill(id),
    loadAllRooms: () => [makeRoom("review", "code-review")],
    resolveRoomTargetPath: (_room, _cwd) => "/resolved/target",
    assertGitRepo: () => {},
    snapshotRepo: async () => ({ head: "a".repeat(40), statusPorcelain: "" }),
    diffForReview: async () => ({
      source: "working-tree",
      diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
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
      durationMs: 12.34,
    }),
    ...overrides,
  };
}

describe("runSkill", () => {
  it("composes skill + room + diff and returns the generation result", async () => {
    const deps = makeDeps();
    const result = await runSkill({ skillId: "code-review", cwd: "/anywhere" }, deps);
    expect(result.skill.id).toBe("code-review");
    expect(result.room.id).toBe("review");
    expect(result.target).toBe("/resolved/target");
    expect(result.model).toBe("llama3.2:3b");
    expect(result.diffSource).toBe("working-tree");
    expect(result.response).toBe("Test review output.");
    expect(result.unchanged).toBe(true);
  });

  it("forwards modelOverride to the provider", async () => {
    let seenModel = "";
    const deps = makeDeps({
      generate: async (opts) => {
        seenModel = opts.model;
        return { model: opts.model, response: "ok" };
      },
    });
    await runSkill({ skillId: "code-review", cwd: "/anywhere", modelOverride: "qwen2.5:7b" }, deps);
    expect(seenModel).toBe("qwen2.5:7b");
  });

  it("does NOT load the registry when modelOverride is provided", async () => {
    let registryCalled = false;
    const deps = makeDeps({
      loadRegistry: async () => {
        registryCalled = true;
        throw new Error("registry should not be loaded when --model is set");
      },
    });
    const result = await runSkill(
      { skillId: "code-review", cwd: "/x", modelOverride: "qwen2.5:7b" },
      deps,
    );
    expect(registryCalled).toBe(false);
    expect(result.model).toBe("qwen2.5:7b");
  });

  it("throws NoRoomForSkillError if no room references the skill", async () => {
    const deps = makeDeps({ loadAllRooms: () => [makeRoom("other", "different-skill")] });
    await expect(runSkill({ skillId: "code-review", cwd: "/x" }, deps)).rejects.toThrowError(
      NoRoomForSkillError,
    );
  });

  it("throws NoModelAvailableError if registry has no models and no override", async () => {
    const deps = makeDeps({
      loadRegistry: async () => ({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        generatedBy: "moss@test",
        source: "test",
        models: [],
      }),
    });
    await expect(runSkill({ skillId: "code-review", cwd: "/x" }, deps)).rejects.toThrowError(
      NoModelAvailableError,
    );
  });

  it("throws GitRepoMutatedError if HEAD changes during the run", async () => {
    let calls = 0;
    const deps = makeDeps({
      snapshotRepo: async () => {
        calls += 1;
        return calls === 1
          ? { head: "a".repeat(40), statusPorcelain: "" }
          : { head: "b".repeat(40), statusPorcelain: "" };
      },
    });
    await expect(runSkill({ skillId: "code-review", cwd: "/x" }, deps)).rejects.toThrowError(
      GitRepoMutatedError,
    );
  });

  it("still runs the after-snapshot integrity check if generate() throws", async () => {
    let afterSnapshots = 0;
    const deps = makeDeps({
      snapshotRepo: async () => {
        afterSnapshots += 1;
        return { head: "a".repeat(40), statusPorcelain: "" };
      },
      generate: async () => {
        throw new Error("model exploded");
      },
    });
    await expect(runSkill({ skillId: "code-review", cwd: "/x" }, deps)).rejects.toThrowError(
      /model exploded/,
    );
    // Both the before-snapshot and the after-snapshot must have run, even
    // though generate threw. The finally block guarantees this.
    expect(afterSnapshots).toBe(2);
  });

  it("if BOTH generate and the after-snapshot detect mutation, surface the mutation", async () => {
    let calls = 0;
    const deps = makeDeps({
      snapshotRepo: async () => {
        calls += 1;
        return calls === 1
          ? { head: "a".repeat(40), statusPorcelain: "" }
          : { head: "b".repeat(40), statusPorcelain: "" };
      },
      generate: async () => {
        throw new Error("ignored — repo integrity is the headline");
      },
    });
    await expect(runSkill({ skillId: "code-review", cwd: "/x" }, deps)).rejects.toThrowError(
      GitRepoMutatedError,
    );
  });

  it("throws GitRepoMutatedError if working-tree changes during the run", async () => {
    let calls = 0;
    const deps = makeDeps({
      snapshotRepo: async () => {
        calls += 1;
        return calls === 1
          ? { head: "a".repeat(40), statusPorcelain: "" }
          : { head: "a".repeat(40), statusPorcelain: " M file.ts" };
      },
    });
    await expect(runSkill({ skillId: "code-review", cwd: "/x" }, deps)).rejects.toThrowError(
      GitRepoMutatedError,
    );
  });

  it("buildPrompt embeds skill body, target metadata, diff and room body", async () => {
    let seenPrompt = "";
    const deps = makeDeps({
      generate: async (opts) => {
        seenPrompt = opts.prompt;
        return { model: opts.model, response: "ok" };
      },
    });
    await runSkill({ skillId: "code-review", cwd: "/x" }, deps);
    expect(seenPrompt).toContain("Review the diff and produce a markdown report.");
    expect(seenPrompt).toContain("Repository: /resolved/target");
    expect(seenPrompt).toContain("Diff source: working-tree");
    expect(seenPrompt).toContain("Room body for review");
    expect(seenPrompt).toContain("```diff");
    expect(seenPrompt).toContain("+new");
  });

  it("prefers the room whose id matches the skill id when multiple rooms reference the skill", async () => {
    const deps = makeDeps({
      loadAllRooms: () => [
        makeRoom("alt", "code-review"),
        makeRoom("code-review", "code-review"),
        makeRoom("zeta", "code-review"),
      ],
    });
    const result = await runSkill({ skillId: "code-review", cwd: "/x" }, deps);
    expect(result.room.id).toBe("code-review");
  });

  it("respects an explicit roomId option", async () => {
    const deps = makeDeps({
      loadAllRooms: () => [makeRoom("alt", "code-review"), makeRoom("code-review", "code-review")],
    });
    const result = await runSkill({ skillId: "code-review", cwd: "/x", roomId: "alt" }, deps);
    expect(result.room.id).toBe("alt");
  });
});

describe("planSkill", () => {
  it("returns the would-be prompt without calling generate", async () => {
    let generated = false;
    const deps = makeDeps({
      generate: async () => {
        generated = true;
        return { model: "x", response: "y" };
      },
    });
    const plan = await planSkill({ skillId: "code-review", cwd: "/x" }, deps);
    expect(generated).toBe(false);
    expect(plan.prompt).toContain("Repository: /resolved/target");
    expect(plan.model).toBe("llama3.2:3b");
  });
});
