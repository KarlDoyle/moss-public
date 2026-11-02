import { describe, expect, it } from "vitest";
import { parseRoom } from "../../../src/lib/rooms/parser.ts";
import { RoomValidationError } from "../../../src/lib/rooms/schema.ts";

const valid = `---
id: review
name: Code review room
description: Review the working git diff.
skill: code-review
target:
  type: git-repo
  path: .
mode: read-only
---

Body describing the room.
`;

describe("parseRoom", () => {
  it("parses a valid room file", () => {
    const room = parseRoom("rooms/review/CONTEXT.md", valid);
    expect(room.frontmatter.id).toBe("review");
    expect(room.frontmatter.target.path).toBe(".");
    expect(room.body.trim()).toBe("Body describing the room.");
  });

  it("accepts an empty body (rooms do not need a body for the model)", () => {
    const content =
      "---\nid: r\nname: R\ndescription: R\nskill: s\ntarget:\n  type: git-repo\n---\n";
    const room = parseRoom("rooms/r/CONTEXT.md", content);
    expect(room.body).toBe("");
  });

  it("rejects a file without an opening frontmatter delimiter", () => {
    expect(() => parseRoom("rooms/x/CONTEXT.md", "no frontmatter\n")).toThrowError(
      RoomValidationError,
    );
  });

  it("rejects an unterminated frontmatter block", () => {
    expect(() => parseRoom("rooms/x/CONTEXT.md", "---\nid: x\nname: X\n")).toThrowError(
      RoomValidationError,
    );
  });

  it("rejects malformed YAML", () => {
    expect(() => parseRoom("rooms/x/CONTEXT.md", "---\nid: : :\n---\n")).toThrowError(
      RoomValidationError,
    );
  });

  it("reports specific schema issues on validation failure", () => {
    const content =
      "---\nid: NotKebab\nname: X\ndescription: X\nskill: s\ntarget:\n  type: git-repo\n---\nbody\n";
    try {
      parseRoom("rooms/x/CONTEXT.md", content);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RoomValidationError);
      expect((error as RoomValidationError).issues.join("\n")).toContain("id:");
    }
  });
});
