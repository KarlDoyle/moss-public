import { parse as parseYaml } from "yaml";
import {
  type Skill,
  type SkillFrontmatter,
  SkillValidationError,
  skillFrontmatterSchema,
} from "./schema.ts";

const FRONTMATTER_DELIMITER = "---";

interface SplitResult {
  yaml: string;
  body: string;
}

function splitFrontmatter(content: string, source: string): SplitResult {
  const normalised = content.replace(/^\uFEFF/, "");
  const lines = normalised.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new SkillValidationError(source, [
      "skill file must start with a YAML frontmatter block delimited by '---'",
    ]);
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIMITER) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new SkillValidationError(source, [
      "frontmatter block is not closed (missing trailing '---')",
    ]);
  }
  const yaml = lines.slice(1, end).join("\n");
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return { yaml, body };
}

function parseFrontmatterYaml(yaml: string, source: string): unknown {
  try {
    const value = parseYaml(yaml);
    if (value === null || value === undefined) {
      throw new Error("frontmatter is empty");
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("frontmatter must be a YAML mapping");
    }
    return value;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SkillValidationError(source, [`could not parse frontmatter YAML: ${reason}`]);
  }
}

function validateFrontmatter(data: unknown, source: string): SkillFrontmatter {
  const result = skillFrontmatterSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    });
    throw new SkillValidationError(source, issues);
  }
  return result.data;
}

export function parseSkill(source: string, content: string): Skill {
  const { yaml, body } = splitFrontmatter(content, source);
  const raw = parseFrontmatterYaml(yaml, source);
  const frontmatter = validateFrontmatter(raw, source);
  if (body.trim() === "") {
    throw new SkillValidationError(source, ["skill body is empty (model prompt is required)"]);
  }
  return { frontmatter, body, source };
}
