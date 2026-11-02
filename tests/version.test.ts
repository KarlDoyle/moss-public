import { describe, expect, it } from "vitest";
import { MOSS_VERSION } from "../src/version.ts";

describe("MOSS_VERSION", () => {
  it("is a semver-shaped string", () => {
    expect(MOSS_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
