import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertTaiscePathReadable,
  getProjectRoot,
  isInsideProject,
  joinInsideProject,
  PathOutsideProjectError,
  resolveInsideProject,
  resolveTaisceRoot,
  setProjectRoot,
  TaisceGuardedPathError,
  TaiscePathOutsideRootError,
} from "../../src/lib/paths.ts";

const realRoot = getProjectRoot();
const tmpRoot = mkdtempSync(join(tmpdir(), "moss-paths-test-"));
const tmpOutside = mkdtempSync(join(tmpdir(), "moss-paths-outside-"));

describe("paths", () => {
  beforeAll(() => {
    setProjectRoot(tmpRoot);
  });

  afterAll(() => {
    setProjectRoot(realRoot);
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpOutside, { recursive: true, force: true });
  });

  it("resolves a relative path inside the project root", () => {
    const resolved = resolveInsideProject("docs/RFC.md");
    expect(resolved).toBe(join(tmpRoot, "docs", "RFC.md"));
  });

  it("resolves an absolute path inside the project root", () => {
    const target = join(tmpRoot, "src", "cli.ts");
    expect(resolveInsideProject(target)).toBe(target);
  });

  it("rejects an absolute path outside the project root", () => {
    expect(() => resolveInsideProject("/etc/passwd")).toThrowError(PathOutsideProjectError);
  });

  it("rejects a relative path that escapes the project root via ..", () => {
    expect(() => resolveInsideProject("../../etc/passwd")).toThrowError(PathOutsideProjectError);
  });

  it("isInsideProject returns false for outside paths", () => {
    expect(isInsideProject("/var/log/system.log")).toBe(false);
    expect(isInsideProject("docs/RFC.md")).toBe(true);
  });

  it("joinInsideProject composes segments under the root", () => {
    expect(joinInsideProject("registry", "models.json")).toBe(
      join(tmpRoot, "registry", "models.json"),
    );
  });

  it("joinInsideProject rejects escape segments", () => {
    expect(() => joinInsideProject("..", "..", "secrets")).toThrowError(PathOutsideProjectError);
  });

  it("rejects a symlink under the root that points outside the root", () => {
    mkdirSync(join(tmpOutside, "secrets"), { recursive: true });
    writeFileSync(join(tmpOutside, "secrets", "key.txt"), "out-of-bounds");
    const linkPath = join(tmpRoot, "escape-link");
    symlinkSync(join(tmpOutside, "secrets"), linkPath);
    try {
      expect(() => resolveInsideProject("escape-link/key.txt")).toThrowError(
        PathOutsideProjectError,
      );
      expect(isInsideProject("escape-link/key.txt")).toBe(false);
    } finally {
      rmSync(linkPath, { force: true });
    }
  });

  it("accepts a symlink under the root that points inside the root", () => {
    const insideDir = join(tmpRoot, "inside");
    mkdirSync(insideDir, { recursive: true });
    writeFileSync(join(insideDir, "ok.txt"), "ok");
    const linkPath = join(tmpRoot, "inside-link");
    symlinkSync(insideDir, linkPath);
    try {
      expect(() => resolveInsideProject("inside-link/ok.txt")).not.toThrow();
      expect(isInsideProject("inside-link/ok.txt")).toBe(true);
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(insideDir, { recursive: true, force: true });
    }
  });

  it("allows resolving a not-yet-existing file inside the root (for writes)", () => {
    const target = join(tmpRoot, "reports", "does-not-yet-exist.md");
    expect(resolveInsideProject("reports/does-not-yet-exist.md")).toBe(target);
    expect(isInsideProject("reports/does-not-yet-exist.md")).toBe(true);
  });
});

describe("Taisce guard-reads (mirrors scripts/hooks/guard-reads.sh)", () => {
  const taisceRoot = mkdtempSync(join(tmpdir(), "moss-taisce-guard-test-"));
  const taisceOutsideRoot = mkdtempSync(join(tmpdir(), "moss-taisce-outside-test-"));

  afterAll(() => {
    rmSync(taisceRoot, { recursive: true, force: true });
    rmSync(taisceOutsideRoot, { recursive: true, force: true });
  });

  // `process.env.X = undefined` does NOT delete the var — Node coerces it to
  // the string "undefined", which resolveTaisceRoot would then treat as a
  // truthy override. Reflect.deleteProperty is the real removal, spelled so
  // it doesn't trip biome's noDelete (which doesn't know process.env's
  // stringify-everything semantics).
  afterEach(() => {
    Reflect.deleteProperty(process.env, "TAISCE_ROOT");
    Reflect.deleteProperty(process.env, "TAISCE_ALLOW_SENSITIVE");
  });

  it("resolveTaisceRoot honours TAISCE_ROOT when set", () => {
    process.env.TAISCE_ROOT = taisceRoot;
    expect(resolveTaisceRoot()).toBe(taisceRoot);
  });

  it("resolveTaisceRoot falls back to ~/context-workspace when unset", () => {
    Reflect.deleteProperty(process.env, "TAISCE_ROOT");
    expect(resolveTaisceRoot()).toMatch(/Dev\/Taisce$/);
  });

  it("allows a path outside the denied trees", () => {
    expect(assertTaiscePathReadable(taisceRoot, "Sources/Inbox/note.md")).toBe(
      join(taisceRoot, "Sources/Inbox/note.md"),
    );
  });

  it("rejects traversal outside the Taisce root", () => {
    expect(() => assertTaiscePathReadable(taisceRoot, "../../etc/passwd")).toThrowError(
      TaiscePathOutsideRootError,
    );
  });

  it("rejects absolute paths, including paths inside the Taisce root", () => {
    expect(() =>
      assertTaiscePathReadable(taisceRoot, join(taisceRoot, "Sources/Inbox/note.md")),
    ).toThrowError(TaiscePathOutsideRootError);
    expect(() =>
      assertTaiscePathReadable(taisceRoot, join(taisceOutsideRoot, "secret.txt")),
    ).toThrowError(TaiscePathOutsideRootError);
  });

  it("rejects a symlink that points outside the Taisce root", () => {
    const outsideFile = join(taisceOutsideRoot, "taisce-outside-secret.txt");
    const linkPath = join(taisceRoot, "outside-link");
    writeFileSync(outsideFile, "not for Moss");
    symlinkSync(outsideFile, linkPath);
    try {
      expect(() => assertTaiscePathReadable(taisceRoot, "outside-link")).toThrowError(
        TaiscePathOutsideRootError,
      );
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(outsideFile, { force: true });
    }
  });

  it("applies denied-tree rules to symlinks inside the root", () => {
    const sensitiveDir = join(taisceRoot, "Sources", "Family");
    const aliasPath = join(taisceRoot, "Sources", "Inbox", "family-link");
    mkdirSync(sensitiveDir, { recursive: true });
    mkdirSync(join(taisceRoot, "Sources", "Inbox"), { recursive: true });
    writeFileSync(join(sensitiveDir, "private.md"), "private");
    symlinkSync(sensitiveDir, aliasPath);
    try {
      expect(() =>
        assertTaiscePathReadable(taisceRoot, "Sources/Inbox/family-link/private.md"),
      ).toThrowError(TaisceGuardedPathError);
    } finally {
      rmSync(aliasPath, { force: true });
      rmSync(sensitiveDir, { recursive: true, force: true });
    }
  });

  it.each([
    "Sources/Family/x.md",
    "Sources/Health/x.md",
    "Sources/Relationships/x.md",
    "Sources/Finance/Benefits/x.md",
    "Projects/home-reset/x.md",
  ])("denies the always-sensitive tree %s", (relPath) => {
    expect(() => assertTaiscePathReadable(taisceRoot, relPath)).toThrowError(
      TaisceGuardedPathError,
    );
  });

  it("denies a file marked load_policy: explicit_only in its own frontmatter", () => {
    mkdirSync(join(taisceRoot, "Domains"), { recursive: true });
    writeFileSync(
      join(taisceRoot, "Domains", "gated.md"),
      '---\nload_policy: "explicit_only"\n---\n\nnope\n',
    );
    expect(() => assertTaiscePathReadable(taisceRoot, "Domains/gated.md")).toThrowError(
      TaisceGuardedPathError,
    );
  });

  it.each(["0", "false"])("does not treat TAISCE_ALLOW_SENSITIVE=%s as enabled", (value) => {
    process.env.TAISCE_ALLOW_SENSITIVE = value;
    expect(() => assertTaiscePathReadable(taisceRoot, "Sources/Family/x.md")).toThrowError(
      TaisceGuardedPathError,
    );
  });

  it("TAISCE_ALLOW_SENSITIVE bypasses sensitivity checks but not root confinement", () => {
    process.env.TAISCE_ALLOW_SENSITIVE = "1";
    expect(() => assertTaiscePathReadable(taisceRoot, "Sources/Family/x.md")).not.toThrow();
    expect(() => assertTaiscePathReadable(taisceRoot, "../../etc/passwd")).toThrowError(
      TaiscePathOutsideRootError,
    );
  });
});
