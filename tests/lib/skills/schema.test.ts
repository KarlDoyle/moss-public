import { describe, expect, it } from "vitest";
import { skillFrontmatterSchema } from "../../../src/lib/skills/schema.ts";

const minimal = {
  id: "code-review",
  name: "Code review",
  description: "Review a diff",
};

describe("skillFrontmatterSchema", () => {
  it("accepts a minimal valid frontmatter and applies defaults", () => {
    const result = skillFrontmatterSchema.parse(minimal);
    expect(result.id).toBe("code-review");
    expect(result.version).toBe(1);
    expect(result.inputs).toEqual([]);
    expect(result.outputs).toEqual([]);
    expect(result.provider).toEqual({ preference: "local", fallback: "none" });
    expect(result.safety).toEqual({ reads: [], writes: [], network: [] });
  });

  it("rejects an id that is not kebab-case", () => {
    expect(() => skillFrontmatterSchema.parse({ ...minimal, id: "Code_Review" })).toThrowError();
  });

  it("rejects an unknown top-level field (strict mode)", () => {
    expect(() => skillFrontmatterSchema.parse({ ...minimal, extra: 1 })).toThrowError();
  });

  it("rejects an unknown input kind", () => {
    expect(() =>
      skillFrontmatterSchema.parse({
        ...minimal,
        inputs: [{ name: "diff", kind: "magic" }],
      }),
    ).toThrowError();
  });

  it("rejects an unknown provider preference", () => {
    expect(() =>
      skillFrontmatterSchema.parse({
        ...minimal,
        provider: { preference: "cloud" },
      }),
    ).toThrowError();
  });

  it("rejects a version that is not a positive integer", () => {
    expect(() => skillFrontmatterSchema.parse({ ...minimal, version: 0 })).toThrowError();
    expect(() => skillFrontmatterSchema.parse({ ...minimal, version: 1.5 })).toThrowError();
  });

  it("preserves explicit safety arrays", () => {
    const result = skillFrontmatterSchema.parse({
      ...minimal,
      safety: { reads: ["target-repo"], writes: [], network: [] },
    });
    expect(result.safety.reads).toEqual(["target-repo"]);
  });
});
