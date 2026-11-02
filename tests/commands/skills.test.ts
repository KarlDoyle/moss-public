import { describe, expect, it } from "vitest";
import { runSkillsCommand } from "../../src/commands/skills.ts";
import type { Room } from "../../src/lib/rooms/schema.ts";
import { roomFrontmatterSchema } from "../../src/lib/rooms/schema.ts";
import type { Skill } from "../../src/lib/skills/schema.ts";
import { skillFrontmatterSchema } from "../../src/lib/skills/schema.ts";

function fakeSkill(id: string): Skill {
  return {
    frontmatter: skillFrontmatterSchema.parse({
      id,
      name: `${id} skill`,
      description: `Run ${id}.`,
    }),
    body: `Body for ${id}`,
    source: `skills/${id}/SKILL.md`,
  };
}

function fakeRoom(id: string, skill: string): Room {
  return {
    frontmatter: roomFrontmatterSchema.parse({
      id,
      name: `${id} room`,
      description: `Room for ${skill}`,
      skill,
      target: { type: "git-repo", path: "." },
    }),
    body: "",
    source: `rooms/${id}/CONTEXT.md`,
  };
}

describe("runSkillsCommand", () => {
  it("prints a human listing including rooms per skill", () => {
    const out: string[] = [];
    const ok = runSkillsCommand({
      emitJson: false,
      out: (l) => out.push(l),
      err: () => {},
      skills: () => [fakeSkill("code-review")],
      rooms: () => [fakeRoom("review", "code-review")],
    });
    expect(ok).toBe(true);
    const text = out.join("\n");
    expect(text).toContain("1 skill(s) registered");
    expect(text).toContain("code-review");
    expect(text).toContain("rooms:       review");
  });

  it("notes (no matching room) when a skill has no room", () => {
    const out: string[] = [];
    runSkillsCommand({
      emitJson: false,
      out: (l) => out.push(l),
      err: () => {},
      skills: () => [fakeSkill("only-skill")],
      rooms: () => [],
    });
    expect(out.join("\n")).toContain("(no matching room)");
  });

  it("emits JSON when emitJson is true", () => {
    const out: string[] = [];
    runSkillsCommand({
      emitJson: true,
      out: (l) => out.push(l),
      err: () => {},
      skills: () => [fakeSkill("code-review")],
      rooms: () => [fakeRoom("review", "code-review")],
    });
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].id).toBe("code-review");
    expect(parsed.skills[0].rooms).toEqual(["review"]);
  });

  it("renders an empty-state message when no skills are registered", () => {
    const out: string[] = [];
    runSkillsCommand({
      emitJson: false,
      out: (l) => out.push(l),
      err: () => {},
      skills: () => [],
      rooms: () => [],
    });
    expect(out.join("\n")).toContain("No skills are registered");
  });

  it("reports a failure via err and returns false if the loader throws", () => {
    const out: string[] = [];
    const err: string[] = [];
    const ok = runSkillsCommand({
      emitJson: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      skills: () => {
        throw new Error("boom");
      },
      rooms: () => [],
    });
    expect(ok).toBe(false);
    expect(err.join("\n")).toContain("moss skills failed");
  });
});
