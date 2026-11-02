import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { binaryOnPath } from "../../../src/lib/providers/detection.ts";

describe("binaryOnPath", () => {
  it("returns false for an undefined or empty PATH", () => {
    expect(binaryOnPath("anything", { path: undefined })).toBe(false);
    expect(binaryOnPath("anything", { path: "" })).toBe(false);
  });

  it("returns true when the binary exists in any directory on PATH", () => {
    // Build two temp directories: one empty, one containing the file
    // we're looking for. Composing them as `empty:withBinary` proves
    // the function walks the list, not just the first entry.
    const empty = mkdtempSync(join(tmpdir(), "moss-detect-empty-"));
    const withBinary = mkdtempSync(join(tmpdir(), "moss-detect-bin-"));
    try {
      writeFileSync(join(withBinary, "fake-tool"), "#!/bin/sh\n");
      const path = `${empty}${delimiter}${withBinary}`;
      expect(binaryOnPath("fake-tool", { path })).toBe(true);
      expect(binaryOnPath("missing-tool", { path })).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(withBinary, { recursive: true, force: true });
    }
  });

  it("skips empty PATH entries without error", () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-detect-empty-entry-"));
    try {
      writeFileSync(join(dir, "tool"), "");
      const path = `${delimiter}${delimiter}${dir}${delimiter}`;
      expect(binaryOnPath("tool", { path })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
