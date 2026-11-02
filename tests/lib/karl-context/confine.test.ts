import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  expandHome,
  KarlContextPathError,
  resolveInsideRoot,
  resolveKarlContextRoot,
} from "../../../src/lib/karl-context/confine.ts";

const REAL_DIR = process.cwd(); // the moss repo root — a known existing directory

describe("src/lib/karl-context/confine.ts", () => {
  describe("expandHome", () => {
    it("expands a leading ~ and ~/", () => {
      expect(expandHome("~")).toBe(homedir());
      expect(expandHome("~/Dev/x")).toBe(`${homedir()}/Dev/x`);
    });
    it("leaves other paths untouched", () => {
      expect(expandHome("/abs/path")).toBe("/abs/path");
      expect(expandHome("relative/path")).toBe("relative/path");
    });
  });

  describe("resolveKarlContextRoot", () => {
    it("accepts an absolute existing directory and returns its realpath", () => {
      const resolved = resolveKarlContextRoot(REAL_DIR);
      expect(resolved.length).toBeGreaterThan(0);
    });
    it("rejects a relative path", () => {
      expect(() => resolveKarlContextRoot("Dev/KARL_CONTEXT")).toThrow(KarlContextPathError);
    });
    it("rejects a non-existent path", () => {
      expect(() => resolveKarlContextRoot("/definitely/not/here/xyz123")).toThrow(/does not exist/);
    });
    it("rejects personal-cloud (iCloud) paths before touching the disk", () => {
      expect(() => resolveKarlContextRoot("/Users/x/Mobile Documents/foo")).toThrow(/blocked/);
      expect(() => resolveKarlContextRoot("/Users/x/Library/CloudDocs/foo")).toThrow(/blocked/);
    });
  });

  describe("resolveInsideRoot", () => {
    it("resolves a relative target under the root", () => {
      const abs = resolveInsideRoot(REAL_DIR, "Domains/Career/x.md");
      expect(abs.startsWith(REAL_DIR)).toBe(true);
    });
    it("rejects a ../ escape out of the root", () => {
      expect(() => resolveInsideRoot(REAL_DIR, "../escape.md")).toThrow(KarlContextPathError);
      expect(() => resolveInsideRoot(REAL_DIR, "../../etc/passwd")).toThrow(/outside/);
    });
    it("rejects an absolute path outside the root", () => {
      expect(() => resolveInsideRoot(REAL_DIR, "/etc/passwd")).toThrow(/outside/);
    });
    it("rejects a blocked marker even inside the root string", () => {
      expect(() => resolveInsideRoot(REAL_DIR, "iCloud/x")).toThrow(/blocked/);
    });
  });
});
