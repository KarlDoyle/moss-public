import { relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveKarlContextRoot } from "../../../src/lib/karl-context/confine.ts";
import { formatPacketProvenance } from "../../../src/lib/karl-context/provenance.ts";
import {
  assembleContextPacket,
  globToRegExp,
  KarlContextProfileError,
  type KarlContextReaderDeps,
} from "../../../src/lib/karl-context/reader.ts";
import type { KarlContextConfig } from "../../../src/lib/karl-context/types.ts";

const ROOT = resolveKarlContextRoot(process.cwd());

const TREE: Record<string, readonly { name: string; isDir: boolean }[]> = {
  "": [
    { name: "Domains", isDir: true },
    { name: "System", isDir: true },
    { name: "Sources", isDir: true },
    { name: ".git", isDir: true },
  ],
  Domains: [
    { name: "Career", isDir: true },
    { name: "Ventures", isDir: true },
  ],
  "Domains/Career": [
    { name: "profile.md", isDir: false },
    { name: "sub", isDir: true },
  ],
  "Domains/Career/sub": [{ name: "deep.md", isDir: false }],
  "Domains/Ventures": [{ name: "venture.md", isDir: false }],
  System: [{ name: "00-context-map.md", isDir: false }],
  Sources: [{ name: "secret-health.md", isDir: false }],
  ".git": [{ name: "config", isDir: false }],
};

function relKey(absDir: string): string {
  return relative(ROOT, absDir).split(sep).join("/");
}

function fakeDeps(bytesPerFile = 10): KarlContextReaderDeps {
  return {
    listDir: async (dir) => TREE[relKey(dir)] ?? [],
    readFile: async (abs) => `${"x".repeat(bytesPerFile)} <${relKey(abs)}>`,
  };
}

function config(profiles: Record<string, readonly string[]>, maxBytes = 32_768): KarlContextConfig {
  return {
    enabled: true,
    path: process.cwd(),
    profiles,
    alwaysExclude: ["Sources/**", ".git/**"],
    maxBytes,
  };
}

describe("src/lib/karl-context/reader.ts", () => {
  describe("globToRegExp", () => {
    it("matches ** at any depth and * within a segment", () => {
      expect(globToRegExp("Domains/Career/**").test("Domains/Career/x.md")).toBe(true);
      expect(globToRegExp("Domains/Career/**").test("Domains/Career/sub/deep.md")).toBe(true);
      expect(globToRegExp("Domains/Career/**").test("Domains/Ventures/x.md")).toBe(false);
      expect(globToRegExp("*.md").test("x.md")).toBe(true);
      expect(globToRegExp("*.md").test("sub/x.md")).toBe(false);
      expect(globToRegExp("System/00-context-map.md").test("System/00-context-map.md")).toBe(true);
    });
  });

  it("reads only files matched by the active profile (allowlist)", async () => {
    const packet = await assembleContextPacket(
      config({ career: ["Domains/Career/**"] }),
      "career",
      fakeDeps(),
    );
    expect(packet.files.map((f) => f.path)).toEqual([
      "Domains/Career/profile.md",
      "Domains/Career/sub/deep.md",
    ]);
  });

  it("NEVER reads Sources/ or .git/, even when the profile glob is ** (default-deny guard)", async () => {
    const packet = await assembleContextPacket(config({ all: ["**"] }), "all", fakeDeps());
    const paths = packet.files.map((f) => f.path);
    expect(paths).toEqual([
      "Domains/Career/profile.md",
      "Domains/Career/sub/deep.md",
      "Domains/Ventures/venture.md",
      "System/00-context-map.md",
    ]);
    expect(paths.some((p) => p.startsWith("Sources/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
  });

  it("default-deny: an empty profile reads nothing", async () => {
    const packet = await assembleContextPacket(config({ none: [] }), "none", fakeDeps());
    expect(packet.files).toEqual([]);
    expect(packet.renderedContext).toBe("");
  });

  it("caps at maxBytes (soft cap) and marks truncated", async () => {
    const full = await assembleContextPacket(config({ all: ["**"] }), "all", fakeDeps(10));
    expect(full.files.length).toBe(4);
    expect(full.truncated).toBe(false);
    // A small cap includes fewer files and flags truncation.
    const capped = await assembleContextPacket(config({ all: ["**"] }, 50), "all", fakeDeps(10));
    expect(capped.truncated).toBe(true);
    expect(capped.files.length).toBeLessThan(4);
    expect(capped.files.length).toBeGreaterThanOrEqual(1);
  });

  it("throws on an unknown profile", async () => {
    await expect(
      assembleContextPacket(config({ career: ["**"] }), "ghost", fakeDeps()),
    ).rejects.toBeInstanceOf(KarlContextProfileError);
  });

  it("provenance lists each included file with size and hash, no contents", async () => {
    const packet = await assembleContextPacket(
      config({ career: ["Domains/Career/**"] }),
      "career",
      fakeDeps(),
    );
    const rendered = formatPacketProvenance(packet);
    expect(rendered).toContain("profile 'career'");
    expect(rendered).toContain("Domains/Career/profile.md");
    expect(rendered).toContain("sha256:");
    expect(rendered).not.toContain("xxxxxxxxxx"); // never leaks file contents
  });
});
