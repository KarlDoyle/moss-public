import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";

// External-root confinement for M12 (D-0024).
//
// src/lib/paths.ts confines every Moss read/write to the PROJECT root. The
// karl-context workspace lives OUTSIDE the project (~/context-workspace), so it
// cannot go through paths.ts. This module is the only sanctioned way to reach
// outside the project root, and it applies the same defences paths.ts does —
// realpath/symlink-escape checks and `..`-traversal rejection — but rooted at
// a CONFIGURED external base, plus the iCloud/CloudDocs blocklist from
// docs/config.ts. Reads only; nothing here writes.

// Personal-cloud markers that must never appear in a resolved karl-context
// path (mirrors src/lib/docs/config.ts). Blocks iCloud/Mobile-Documents roots.
export const BLOCKED_PATH_MARKERS: readonly string[] = ["Mobile Documents", "iCloud", "CloudDocs"];

export class KarlContextPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KarlContextPathError";
  }
}

// Expand a single leading `~` to the user's home directory.
export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

function assertNotBlocked(absolutePath: string): void {
  for (const marker of BLOCKED_PATH_MARKERS) {
    if (absolutePath.includes(marker)) {
      throw new KarlContextPathError(
        `karl-context path '${absolutePath}' is blocked (contains '${marker}'). Moss does not read personal-cloud folders.`,
      );
    }
  }
}

function realpathDeepestAncestor(target: string): string {
  let head = target;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return target;
    tail.unshift(basename(head));
    head = parent;
  }
  const realHead = realpathSync(head);
  return tail.length === 0 ? realHead : resolve(realHead, ...tail);
}

function isUnderRoot(absolute: string, root: string): boolean {
  const rel = relative(root, absolute);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

// Resolve and validate the configured karl-context root itself. Must be an
// absolute (after ~ expansion) path that exists, is a directory, is not a
// blocked personal-cloud path, and resolves (via realpath) to itself — i.e.
// not a symlink pointing somewhere surprising. Returns the realpath'd root.
export function resolveKarlContextRoot(configuredPath: string): string {
  const expanded = expandHome(configuredPath);
  if (!isAbsolute(expanded)) {
    throw new KarlContextPathError(
      `karl-context path '${configuredPath}' must be absolute (or start with ~). Relative paths are not allowed for an external source.`,
    );
  }
  const absolute = normalize(expanded);
  assertNotBlocked(absolute);
  if (!existsSync(absolute)) {
    throw new KarlContextPathError(`karl-context path '${absolute}' does not exist.`);
  }
  const real = realpathSync(absolute);
  assertNotBlocked(real);
  if (!statSync(real).isDirectory()) {
    throw new KarlContextPathError(`karl-context path '${real}' is not a directory.`);
  }
  return real;
}

// Resolve a target that must stay INSIDE the given (already-validated) root.
// Rejects `..` escapes and symlinks that resolve outside the root. Returns the
// absolute path. Used for every per-file read under the karl-context root.
export function resolveInsideRoot(root: string, target: string): string {
  const absolute = isAbsolute(target) ? normalize(target) : resolve(root, target);
  if (!isUnderRoot(absolute, root)) {
    throw new KarlContextPathError(
      `Path '${absolute}' resolves outside the karl-context root '${root}'.`,
    );
  }
  assertNotBlocked(absolute);
  const realTarget = realpathDeepestAncestor(absolute);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  if (!isUnderRoot(realTarget, realRoot)) {
    throw new KarlContextPathError(
      `Path '${realTarget}' resolves (via symlink) outside the karl-context root '${realRoot}'.`,
    );
  }
  return absolute;
}
