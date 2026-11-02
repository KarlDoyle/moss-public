import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadAllRooms } from "../../src/lib/rooms/loader.ts";
import { parseRoom } from "../../src/lib/rooms/parser.ts";
import { loadAllSkills } from "../../src/lib/skills/loader.ts";
import { parseSkill } from "../../src/lib/skills/parser.ts";

// Loads every shipped skill and room file and re-parses it through the
// validator. Any malformed file fails CI here, before it can break `moss run`.
describe("shipped skills and rooms validate", () => {
  it("every skills/<id>/SKILL.md parses against the skill schema", () => {
    const skills = loadAllSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      const raw = readFileSync(skill.source, "utf8");
      const reparsed = parseSkill(skill.source, raw);
      expect(reparsed.frontmatter.id).toBe(skill.frontmatter.id);
    }
  });

  it("every rooms/<id>/CONTEXT.md parses against the room schema", () => {
    const rooms = loadAllRooms();
    expect(rooms.length).toBeGreaterThan(0);
    for (const room of rooms) {
      const raw = readFileSync(room.source, "utf8");
      const reparsed = parseRoom(room.source, raw);
      expect(reparsed.frontmatter.id).toBe(room.frontmatter.id);
    }
  });

  it("every room references a skill that exists in skills/", () => {
    const skills = loadAllSkills();
    const rooms = loadAllRooms();
    const skillIds = new Set(skills.map((s) => s.frontmatter.id));
    const orphans = rooms
      .filter((r) => !skillIds.has(r.frontmatter.skill))
      .map((r) => `${r.frontmatter.id} -> ${r.frontmatter.skill}`);
    expect(orphans).toEqual([]);
  });
});
