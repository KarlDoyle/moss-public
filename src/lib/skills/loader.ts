import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { joinInsideProject, resolveInsideProject } from "../paths.ts";
import { parseSkill } from "./parser.ts";
import type { Skill } from "./schema.ts";

const SKILLS_SUBDIR = "skills";

export class SkillNotFoundError extends Error {
  constructor(id: string) {
    super(`Skill '${id}' was not found in 'skills/'.`);
    this.name = "SkillNotFoundError";
  }
}

function skillsDir(): string {
  return joinInsideProject(SKILLS_SUBDIR);
}

function listSkillDirs(): string[] {
  const dir = skillsDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        resolveInsideProject(path);
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

function loadSkillFromDir(dir: string): Skill | null {
  const skillFile = join(dir, "SKILL.md");
  try {
    resolveInsideProject(skillFile);
    statSync(skillFile);
  } catch {
    return null;
  }
  const content = readFileSync(skillFile, "utf8");
  return parseSkill(skillFile, content);
}

export function loadAllSkills(): readonly Skill[] {
  const dirs = listSkillDirs();
  const skills: Skill[] = [];
  for (const dir of dirs) {
    const skill = loadSkillFromDir(dir);
    if (skill !== null) {
      skills.push(skill);
    }
  }
  skills.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  return skills;
}

export function loadSkillById(id: string): Skill {
  const skills = loadAllSkills();
  const match = skills.find((skill) => skill.frontmatter.id === id);
  if (match === undefined) {
    throw new SkillNotFoundError(id);
  }
  return match;
}
