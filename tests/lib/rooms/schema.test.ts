import { describe, expect, it } from "vitest";
import { roomFrontmatterSchema } from "../../../src/lib/rooms/schema.ts";

const minimal = {
  id: "review",
  name: "Code review room",
  description: "Review the working git diff.",
  skill: "code-review",
  target: { type: "git-repo" },
};

describe("roomFrontmatterSchema", () => {
  it("accepts a minimal valid frontmatter and applies defaults", () => {
    const result = roomFrontmatterSchema.parse(minimal);
    expect(result.id).toBe("review");
    expect(result.skill).toBe("code-review");
    expect(result.target.path).toBe(".");
    expect(result.mode).toBe("read-only");
  });

  it("preserves an explicit target path", () => {
    const result = roomFrontmatterSchema.parse({
      ...minimal,
      target: { type: "git-repo", path: "/abs/path/to/repo" },
    });
    expect(result.target.path).toBe("/abs/path/to/repo");
  });

  it("rejects an unknown target type", () => {
    expect(() =>
      roomFrontmatterSchema.parse({
        ...minimal,
        target: { type: "filesystem" },
      }),
    ).toThrowError();
  });

  it("rejects an unknown mode", () => {
    expect(() => roomFrontmatterSchema.parse({ ...minimal, mode: "write" })).toThrowError();
  });

  it("rejects a non-kebab skill id", () => {
    expect(() => roomFrontmatterSchema.parse({ ...minimal, skill: "Code_Review" })).toThrowError();
  });

  it("rejects an unknown top-level field (strict mode)", () => {
    expect(() => roomFrontmatterSchema.parse({ ...minimal, extra: true })).toThrowError();
  });
});
