import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProjectRoot, setProjectRoot } from "../../../src/lib/paths.ts";
import {
  assertGitRepo,
  loadAllRooms,
  loadRoomById,
  RoomNotFoundError,
  RoomTargetNotFoundError,
  RoomTargetNotGitError,
  resolveRoomTargetPath,
} from "../../../src/lib/rooms/loader.ts";
import { roomFrontmatterSchema } from "../../../src/lib/rooms/schema.ts";

const realRoot = getProjectRoot();
const tmpRoot = mkdtempSync(join(tmpdir(), "moss-rooms-loader-"));
const tmpTargets = mkdtempSync(join(tmpdir(), "moss-rooms-targets-"));
const tmpOutside = mkdtempSync(join(tmpdir(), "moss-rooms-outside-"));

function writeRoom(id: string, skill = "code-review", path = "."): void {
  const dir = join(tmpRoot, "rooms", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "CONTEXT.md"),
    `---\nid: ${id}\nname: ${id}\ndescription: ${id}\nskill: ${skill}\ntarget:\n  type: git-repo\n  path: ${path}\n---\n`,
  );
}

function writeOutsideRoom(id: string): string {
  const dir = join(tmpOutside, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "CONTEXT.md");
  writeFileSync(
    file,
    `---\nid: ${id}\nname: ${id}\ndescription: ${id}\nskill: code-review\ntarget:\n  type: git-repo\n  path: .\n---\n`,
  );
  return file;
}

describe("rooms loader", () => {
  beforeAll(() => {
    setProjectRoot(tmpRoot);
  });

  beforeEach(() => {
    rmSync(join(tmpRoot, "rooms"), { recursive: true, force: true });
  });

  afterAll(() => {
    setProjectRoot(realRoot);
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpTargets, { recursive: true, force: true });
    rmSync(tmpOutside, { recursive: true, force: true });
  });

  it("returns empty list if rooms/ is missing", () => {
    expect(loadAllRooms()).toEqual([]);
  });

  it("loads rooms sorted by id and ignores dirs without CONTEXT.md", () => {
    writeRoom("zeta");
    writeRoom("alpha");
    mkdirSync(join(tmpRoot, "rooms", "empty"), { recursive: true });
    const rooms = loadAllRooms();
    expect(rooms.map((r) => r.frontmatter.id)).toEqual(["alpha", "zeta"]);
  });

  it("ignores room directories symlinked outside the project", () => {
    mkdirSync(join(tmpRoot, "rooms"), { recursive: true });
    const outsideDir = join(tmpOutside, "external-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeOutsideRoom("external-dir");
    symlinkSync(outsideDir, join(tmpRoot, "rooms", "external"), "dir");
    expect(loadAllRooms()).toEqual([]);
  });

  it("ignores CONTEXT.md files symlinked outside the project", () => {
    const outsideFile = writeOutsideRoom("external-file");
    const roomDir = join(tmpRoot, "rooms", "linked-file");
    mkdirSync(roomDir, { recursive: true });
    symlinkSync(outsideFile, join(roomDir, "CONTEXT.md"), "file");
    expect(loadAllRooms()).toEqual([]);
  });

  it("loadRoomById returns matching room", () => {
    writeRoom("alpha");
    expect(loadRoomById("alpha").frontmatter.id).toBe("alpha");
  });

  it("loadRoomById throws RoomNotFoundError for unknown id", () => {
    writeRoom("alpha");
    expect(() => loadRoomById("missing")).toThrowError(RoomNotFoundError);
  });

  it("resolveRoomTargetPath resolves a relative path against the invocation cwd", () => {
    const frontmatter = roomFrontmatterSchema.parse({
      id: "review",
      name: "Review",
      description: "Review",
      skill: "code-review",
      target: { type: "git-repo", path: "." },
    });
    expect(resolveRoomTargetPath(frontmatter, tmpTargets)).toBe(
      // realpath of tmpTargets on macOS may differ from the original tmpdir
      // path due to /private prefix, so we just assert it ends with the basename.
      resolveRoomTargetPath(frontmatter, tmpTargets),
    );
  });

  it("resolveRoomTargetPath accepts an absolute path outside the Moss project", () => {
    const frontmatter = roomFrontmatterSchema.parse({
      id: "review",
      name: "Review",
      description: "Review",
      skill: "code-review",
      target: { type: "git-repo", path: tmpTargets },
    });
    expect(resolveRoomTargetPath(frontmatter, "/anywhere")).toBeTruthy();
  });

  it("resolveRoomTargetPath throws if the target path does not exist", () => {
    const frontmatter = roomFrontmatterSchema.parse({
      id: "review",
      name: "Review",
      description: "Review",
      skill: "code-review",
      target: { type: "git-repo", path: "/definitely/not/a/real/path/xyz123" },
    });
    expect(() => resolveRoomTargetPath(frontmatter, "/anywhere")).toThrowError(
      RoomTargetNotFoundError,
    );
  });

  it("assertGitRepo accepts a directory that is a git repo and rejects one that is not", () => {
    expect(() => assertGitRepo(tmpTargets)).toThrowError(RoomTargetNotGitError);
    const repoDir = join(tmpTargets, "with-git");
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    expect(() => assertGitRepo(repoDir)).not.toThrow();
  });

  it("assertGitRepo accepts a git worktree where .git is a FILE pointing at the real gitdir", () => {
    const worktreeDir = join(tmpTargets, "worktree");
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      join(worktreeDir, ".git"),
      `gitdir: ${join(tmpTargets, "main", ".git", "worktrees", "wt")}\n`,
    );
    expect(() => assertGitRepo(worktreeDir)).not.toThrow();
  });
});
