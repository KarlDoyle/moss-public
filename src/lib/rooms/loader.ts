import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { joinInsideProject, resolveInsideProject } from "../paths.ts";
import { parseRoom } from "./parser.ts";
import type { Room, RoomFrontmatter } from "./schema.ts";

const ROOMS_SUBDIR = "rooms";

export class RoomNotFoundError extends Error {
  constructor(id: string) {
    super(`Room '${id}' was not found in 'rooms/'.`);
    this.name = "RoomNotFoundError";
  }
}

export class RoomTargetNotFoundError extends Error {
  constructor(path: string) {
    super(`Room target path '${path}' does not exist.`);
    this.name = "RoomTargetNotFoundError";
  }
}

export class RoomTargetNotGitError extends Error {
  constructor(path: string) {
    super(`Room target path '${path}' is not a git repository (no .git directory).`);
    this.name = "RoomTargetNotGitError";
  }
}

function roomsDir(): string {
  return joinInsideProject(ROOMS_SUBDIR);
}

function listRoomDirs(): string[] {
  const dir = roomsDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        resolveInsideProject(path);
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

function loadRoomFromDir(dir: string): Room | null {
  const file = join(dir, "CONTEXT.md");
  try {
    resolveInsideProject(file);
    statSync(file);
  } catch {
    return null;
  }
  const content = readFileSync(file, "utf8");
  return parseRoom(file, content);
}

export function loadAllRooms(): readonly Room[] {
  const dirs = listRoomDirs();
  const rooms: Room[] = [];
  for (const dir of dirs) {
    const room = loadRoomFromDir(dir);
    if (room !== null) {
      rooms.push(room);
    }
  }
  rooms.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  return rooms;
}

export function loadRoomById(id: string): Room {
  const rooms = loadAllRooms();
  const match = rooms.find((room) => room.frontmatter.id === id);
  if (match === undefined) {
    throw new RoomNotFoundError(id);
  }
  return match;
}

// Resolves the room's target path against an invocation cwd.
// Important: this path may live outside the Moss project root. Rooms are
// configured to point at a *target* repo (the thing being reviewed), not
// Moss's own files. We therefore do NOT use `resolveInsideProject` here.
export function resolveRoomTargetPath(frontmatter: RoomFrontmatter, invocationCwd: string): string {
  const raw = frontmatter.target.path;
  const absolute = isAbsolute(raw) ? raw : resolve(invocationCwd, raw);
  if (!existsSync(absolute)) {
    throw new RoomTargetNotFoundError(absolute);
  }
  return realpathSync(absolute);
}

// Accepts a directory as a git repo when it contains a `.git` entry of any
// kind. Standard repos have a `.git` directory; linked worktrees and
// submodules have a `.git` *file* pointing at the real gitdir. We accept both.
export function assertGitRepo(targetAbsPath: string): void {
  const gitEntry = join(targetAbsPath, ".git");
  if (!existsSync(gitEntry)) {
    throw new RoomTargetNotGitError(targetAbsPath);
  }
}
