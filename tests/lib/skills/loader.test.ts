import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProjectRoot, setProjectRoot } from "../../../src/lib/paths.ts";
import {
  loadAllSkills,
  loadSkillById,
  SkillNotFoundError,
} from "../../../src/lib/skills/loader.ts";

const realRoot = getProjectRoot();
const tmpRoot = mkdtempSync(join(tmpdir(), "moss-skills-loader-"));
const tmpOutside = mkdtempSync(join(tmpdir(), "moss-skills-outside-"));

function writeSkill(id: string, body = `Body for ${id}.`): void {
  const dir = join(tmpRoot, "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nid: ${id}\nname: ${id}\ndescription: ${id}\n---\n\n${body}\n`,
  );
}

function writeOutsideSkill(id: string): string {
  const dir = join(tmpOutside, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nid: ${id}\nname: ${id}\ndescription: ${id}\n---\n\nOutside content.\n`);
  return file;
}

describe("skills loader", () => {
  beforeAll(() => {
    setProjectRoot(tmpRoot);
  });

  beforeEach(() => {
    rmSync(join(tmpRoot, "skills"), { recursive: true, force: true });
  });

  afterAll(() => {
    setProjectRoot(realRoot);
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpOutside, { recursive: true, force: true });
  });

  it("returns an empty list if skills/ is missing", () => {
    expect(loadAllSkills()).toEqual([]);
  });

  it("loads all skills sorted by id", () => {
    writeSkill("zeta");
    writeSkill("alpha");
    writeSkill("mid");
    const skills = loadAllSkills();
    expect(skills.map((s) => s.frontmatter.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("ignores directories without a SKILL.md", () => {
    mkdirSync(join(tmpRoot, "skills", "no-skill"), { recursive: true });
    writeSkill("alpha");
    expect(loadAllSkills().map((s) => s.frontmatter.id)).toEqual(["alpha"]);
  });

  it("ignores skill directories symlinked outside the project", () => {
    mkdirSync(join(tmpRoot, "skills"), { recursive: true });
    const outsideDir = join(tmpOutside, "external-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeOutsideSkill("external-dir");
    symlinkSync(outsideDir, join(tmpRoot, "skills", "external"), "dir");
    expect(loadAllSkills()).toEqual([]);
  });

  it("ignores SKILL.md files symlinked outside the project", () => {
    const outsideFile = writeOutsideSkill("external-file");
    const skillDir = join(tmpRoot, "skills", "linked-file");
    mkdirSync(skillDir, { recursive: true });
    symlinkSync(outsideFile, join(skillDir, "SKILL.md"), "file");
    expect(loadAllSkills()).toEqual([]);
  });

  it("loadSkillById returns the matching skill", () => {
    writeSkill("alpha", "Alpha body.");
    const skill = loadSkillById("alpha");
    expect(skill.frontmatter.id).toBe("alpha");
    expect(skill.body.trim()).toBe("Alpha body.");
  });

  it("loadSkillById throws SkillNotFoundError for unknown id", () => {
    writeSkill("alpha");
    expect(() => loadSkillById("missing")).toThrowError(SkillNotFoundError);
  });
});
