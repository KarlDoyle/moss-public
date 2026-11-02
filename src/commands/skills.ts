import type { Command } from "commander";
import { loadAllRooms } from "../lib/rooms/loader.ts";
import type { Room } from "../lib/rooms/schema.ts";
import { loadAllSkills } from "../lib/skills/loader.ts";
import type { Skill } from "../lib/skills/schema.ts";

export interface SkillsCommandOptions {
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly skills?: () => readonly Skill[];
  readonly rooms?: () => readonly Room[];
}

function formatHuman(skills: readonly Skill[], rooms: readonly Room[]): string {
  if (skills.length === 0) {
    return [
      "No skills are registered.",
      "Add a SKILL.md under skills/<id>/ with a valid YAML frontmatter, then re-run `moss skills`.",
    ].join("\n");
  }
  const lines: string[] = [];
  lines.push(`${skills.length} skill(s) registered:`);
  for (const skill of skills) {
    const matchingRooms = rooms.filter((r) => r.frontmatter.skill === skill.frontmatter.id);
    const roomList =
      matchingRooms.length === 0
        ? "(no matching room)"
        : matchingRooms.map((r) => r.frontmatter.id).join(", ");
    lines.push("");
    lines.push(`- ${skill.frontmatter.id}  v${skill.frontmatter.version}`);
    lines.push(`    name:        ${skill.frontmatter.name}`);
    lines.push(`    description: ${skill.frontmatter.description}`);
    lines.push(`    provider:    ${skill.frontmatter.provider.preference}`);
    lines.push(`    rooms:       ${roomList}`);
  }
  return lines.join("\n");
}

function toJsonShape(skills: readonly Skill[], rooms: readonly Room[]) {
  return {
    skills: skills.map((skill) => ({
      id: skill.frontmatter.id,
      name: skill.frontmatter.name,
      version: skill.frontmatter.version,
      description: skill.frontmatter.description,
      provider: skill.frontmatter.provider,
      safety: skill.frontmatter.safety,
      rooms: rooms
        .filter((r) => r.frontmatter.skill === skill.frontmatter.id)
        .map((r) => r.frontmatter.id),
    })),
  };
}

export function runSkillsCommand(options: SkillsCommandOptions): boolean {
  const loadSkills = options.skills ?? (() => loadAllSkills());
  const loadRooms = options.rooms ?? (() => loadAllRooms());
  try {
    const skills = loadSkills();
    const rooms = loadRooms();
    if (options.emitJson) {
      options.out(JSON.stringify(toJsonShape(skills, rooms), null, 2));
    } else {
      options.out(formatHuman(skills, rooms));
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss skills failed: ${message}`);
    return false;
  }
}

export function registerSkills(program: Command): void {
  program
    .command("skills")
    .description("List skills registered under skills/ and the rooms that reference them")
    .option("--json", "Emit JSON instead of human-readable text")
    .action((commandOpts: { json?: boolean }) => {
      const globalOpts = program.opts<{ json?: boolean }>();
      const ok = runSkillsCommand({
        emitJson: Boolean(commandOpts.json) || Boolean(globalOpts.json),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      });
      if (!ok) {
        process.exitCode = 1;
      }
    });
}
