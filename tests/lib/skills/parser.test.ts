import { describe, expect, it } from "vitest";
import { parseSkill } from "../../../src/lib/skills/parser.ts";
import { SkillValidationError } from "../../../src/lib/skills/schema.ts";

const validFrontmatter = `---
id: code-review
name: Code review
description: Review a diff
inputs:
  - name: diff
    kind: git-diff
outputs:
  - name: report
    kind: markdown
safety:
  reads:
    - target-repo
---

You are a careful code reviewer.
`;

describe("parseSkill", () => {
  it("parses a valid skill file with body", () => {
    const skill = parseSkill("skills/code-review/SKILL.md", validFrontmatter);
    expect(skill.frontmatter.id).toBe("code-review");
    expect(skill.frontmatter.inputs).toHaveLength(1);
    expect(skill.frontmatter.inputs[0]?.kind).toBe("git-diff");
    expect(skill.body.trim()).toBe("You are a careful code reviewer.");
  });

  it("rejects a file without an opening frontmatter delimiter", () => {
    const content = "No frontmatter here.\nBody.\n";
    expect(() => parseSkill("skills/x/SKILL.md", content)).toThrowError(SkillValidationError);
  });

  it("rejects a file with an unterminated frontmatter block", () => {
    const content = "---\nid: x\nname: X\ndescription: X\n";
    expect(() => parseSkill("skills/x/SKILL.md", content)).toThrowError(SkillValidationError);
  });

  it("rejects a file with empty body", () => {
    const content = "---\nid: x\nname: X\ndescription: X\n---\n\n";
    expect(() => parseSkill("skills/x/SKILL.md", content)).toThrowError(SkillValidationError);
  });

  it("rejects malformed YAML inside the frontmatter block", () => {
    const content = "---\nid: : :\nname: X\ndescription: X\n---\nbody\n";
    expect(() => parseSkill("skills/x/SKILL.md", content)).toThrowError(SkillValidationError);
  });

  it("rejects a frontmatter that fails schema validation and reports issues", () => {
    const content = "---\nid: NotKebab\nname: X\ndescription: X\n---\nbody\n";
    try {
      parseSkill("skills/x/SKILL.md", content);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillValidationError);
      const issues = (error as SkillValidationError).issues.join("\n");
      expect(issues).toContain("id:");
    }
  });

  it("strips a leading BOM if present", () => {
    const skill = parseSkill("skills/x/SKILL.md", `\uFEFF${validFrontmatter}`);
    expect(skill.frontmatter.id).toBe("code-review");
  });
});
