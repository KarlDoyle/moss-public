import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const HOME = homedir();
const FALLBACK_ROOT = resolve(HOME, "Dev", "moss");

// Resolves the Moss project root by walking up from this file's location
// (src/lib/paths.ts) to the nearest directory that contains a package.json
// whose name is "moss". Falls back to ~/.local/share/moss if not found.
function detectProjectRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
      const pkg = resolve(dir, "package.json");
      if (existsSync(pkg)) {
        try {
          const contents = JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown };
          if (contents && contents.name === "moss") {
            return dir;
          }
        } catch {
          // ignore malformed package.json and keep walking
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta unavailable or fileURL conversion failed; use fallback
  }
  return FALLBACK_ROOT;
}

let projectRoot: string = detectProjectRoot();

export function setProjectRoot(next: string): void {
  projectRoot = resolve(next);
}

export function getProjectRoot(): string {
  return projectRoot;
}

export class PathOutsideProjectError extends Error {
  constructor(target: string, root: string) {
    super(
      `Path '${target}' resolves outside the project root '${root}'. All writes must stay inside the Moss project directory.`,
    );
    this.name = "PathOutsideProjectError";
  }
}

function ensureAbsolute(input: string): string {
  return isAbsolute(input) ? normalize(input) : resolve(projectRoot, input);
}

// Realpath of the deepest existing ancestor of `target`, with the remaining
// non-existent tail re-attached. This lets us validate writes to files that do
// not yet exist (e.g. a new report file) while still catching the case where
// a real symlink under the project root points outside it.
function realpathDeepestAncestor(target: string): string {
  let head = target;
  const tail: string[] = [];
  while (true) {
    try {
      lstatSync(head);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(head);
    if (parent === head) {
      return target;
    }
    tail.unshift(basename(head));
    head = parent;
  }
  const realHead = realpathSync(head);
  return tail.length === 0 ? realHead : resolve(realHead, ...tail);
}

function realpathRoot(): string {
  return existsSync(projectRoot) ? realpathSync(projectRoot) : projectRoot;
}

function isUnderRoot(absolute: string, root: string): boolean {
  const rel = relative(root, absolute);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

export function resolveInsideProject(target: string): string {
  const absolute = ensureAbsolute(target);

  if (!isUnderRoot(absolute, projectRoot)) {
    throw new PathOutsideProjectError(absolute, projectRoot);
  }

  const realTarget = realpathDeepestAncestor(absolute);
  const realRoot = realpathRoot();
  if (!isUnderRoot(realTarget, realRoot)) {
    throw new PathOutsideProjectError(realTarget, realRoot);
  }

  if (absolute === projectRoot) {
    return projectRoot;
  }
  return absolute;
}

export function isInsideProject(target: string): boolean {
  try {
    resolveInsideProject(target);
    return true;
  } catch {
    return false;
  }
}

export function joinInsideProject(...segments: readonly string[]): string {
  const joined = segments.join(sep);
  return resolveInsideProject(joined);
}

// -----------------------------------------------------------------------------
// Taisce guard-reads — mirrors scripts/hooks/guard-reads.sh in the Taisce repo.
//
// `moss run <taisce-skill>` reads a Taisce skill's SKILL.md (and an optional
// operator-named context file) as a prompt. Those reads must respect the same
// sensitivity rule Claude Code enforces via its PreToolUse hook
// (`System/04-privacy-and-sensitivity-rules.md`): never load the always-
// sensitive trees, and never load a file whose own frontmatter marks it
// `sensitivity: highly_private` or `load_policy: explicit_only`.
//
// This is deliberately a second, independent implementation (not a shared
// script) — moss has no shell-out to the Taisce repo's hooks, and the M2
// import-boundary rule keeps subprocess calls inside src/lib/exec.ts. Keep
// the deny list here in sync with guard-reads.sh if either changes.
// -----------------------------------------------------------------------------

const TAISCE_FALLBACK_ROOT = resolve(HOME, "Dev", "Taisce");

// Trees that are always denied, regardless of frontmatter. `Sources/` as a
// whole is NOT denied — `Sources/Inbox/` must stay readable for `capture`.
const TAISCE_DENIED_TREES: readonly string[] = [
  "Sources/Family",
  "Sources/Health",
  "Sources/Relationships",
  "Sources/Finance/Benefits",
  "Projects/home-reset",
];

export class TaisceGuardedPathError extends Error {
  constructor(relPath: string, reason: string) {
    super(
      `Blocked by guard-reads: '${relPath}' ${reason} (System/04-privacy-and-sensitivity-rules.md). Set the TAISCE_ALLOW_SENSITIVE=1 env var only if Karl has asked for this file by name.`,
    );
    this.name = "TaisceGuardedPathError";
  }
}

export class TaiscePathOutsideRootError extends Error {
  constructor(relPath: string, root: string) {
    super(
      `Blocked by guard-reads: '${relPath}' resolves outside the configured Taisce root '${root}'. TAISCE_ALLOW_SENSITIVE cannot bypass root confinement.`,
    );
    this.name = "TaiscePathOutsideRootError";
  }
}

// Resolves the Taisce checkout to read from. `TAISCE_ROOT` lets tests and an
// alternate checkout (e.g. a worktree) override the default `~/context-workspace`.
export function resolveTaisceRoot(): string {
  const envRoot = process.env.TAISCE_ROOT;
  return envRoot && envRoot.trim().length > 0 ? resolve(envRoot) : TAISCE_FALLBACK_ROOT;
}

function toPosixRelative(relPath: string): string {
  return relPath.split(sep).join("/");
}

function isUnderDeniedTaisceTree(relPath: string): boolean {
  const posix = toPosixRelative(relPath);
  return TAISCE_DENIED_TREES.some((tree) => posix === tree || posix.startsWith(`${tree}/`));
}

const TAISCE_FRONTMATTER_MAX_BYTES = 64 * 1024;
const TaisceSensitivityFrontmatterSchema = z
  .object({
    sensitivity: z.enum(["public", "private", "highly_private"]).optional(),
    load_policy: z.enum(["default", "explicit_only"]).optional(),
  })
  .passthrough();

// Read and parse the complete, bounded YAML frontmatter. Unknown or malformed
// policy labels fail closed; ordinary files without frontmatter have no label.
// File contents never leave this guard.
function taisceFrontmatterDenies(absolutePath: string, relPath: string): boolean {
  if (!existsSync(absolutePath)) return false;
  let fd: number;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new TaisceGuardedPathError(relPath, "has unreadable or ambiguous frontmatter");
  }
  let raw: string;
  let frontmatterBomBytes = 0;
  try {
    const bytes = Buffer.alloc(TAISCE_FRONTMATTER_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const count = readSync(fd, bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    raw = bytes.subarray(0, bytesRead).toString("utf8");
    if (raw.startsWith("\uFEFF")) {
      raw = raw.slice(1);
      frontmatterBomBytes = 3;
    }
  } catch {
    throw new TaisceGuardedPathError(relPath, "has unreadable or ambiguous frontmatter");
  } finally {
    closeSync(fd);
  }

  const rawLines = raw.split("\n");
  const lines = rawLines.map((line) => line.replace(/\r$/, ""));
  if ((lines[0] ?? "").trim() !== "---") return false;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (
    end === -1 ||
    Buffer.byteLength(rawLines.slice(0, end + 1).join("\n"), "utf8") + frontmatterBomBytes >
      TAISCE_FRONTMATTER_MAX_BYTES
  ) {
    throw new TaisceGuardedPathError(relPath, "has missing or oversized frontmatter");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join("\n"));
  } catch {
    throw new TaisceGuardedPathError(relPath, "has malformed sensitivity frontmatter");
  }
  const labels = TaisceSensitivityFrontmatterSchema.safeParse(parsed);
  if (!labels.success) {
    throw new TaisceGuardedPathError(
      relPath,
      "has unknown or ambiguous sensitivity/load-policy labels",
    );
  }
  return (
    labels.data.sensitivity === "private" ||
    labels.data.sensitivity === "highly_private" ||
    labels.data.load_policy === "explicit_only"
  );
}

// Asserts a path inside the Taisce checkout is safe to read and returns its
// absolute path. `relPath` is relative to `root` (e.g. `Library/skills/capture/SKILL.md`).
// Throws TaisceGuardedPathError on either the path deny-list or a denying
// frontmatter. The `TAISCE_ALLOW_SENSITIVE` env var mirrors guard-reads.sh's
// `ALLOW_SENSITIVE` escape hatch for an interactive session where Karl has
// asked for the file by name.
export function assertTaiscePathReadable(root: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new TaiscePathOutsideRootError(relPath, root);
  }

  const absoluteRoot = resolve(root);
  const realRoot = existsSync(absoluteRoot) ? realpathSync(absoluteRoot) : absoluteRoot;
  const absolute = resolve(absoluteRoot, relPath);

  // Reject lexical traversal before resolving symlinks.
  if (!isUnderRoot(absolute, absoluteRoot)) {
    throw new TaiscePathOutsideRootError(relPath, root);
  }

  // Resolve existing path components so symlinks cannot escape the checkout.
  const realTarget = realpathDeepestAncestor(absolute);
  if (!isUnderRoot(realTarget, realRoot)) {
    throw new TaiscePathOutsideRootError(relPath, root);
  }

  // Apply sensitivity rules to the canonical path, not a symlink alias.
  const rel = toPosixRelative(relative(realRoot, realTarget));
  if (process.env.TAISCE_ALLOW_SENSITIVE === "1") return absolute;
  if (isUnderDeniedTaisceTree(rel)) {
    throw new TaisceGuardedPathError(rel, "is a sensitivity-gated tree");
  }
  if (taisceFrontmatterDenies(realTarget, rel)) {
    throw new TaisceGuardedPathError(
      rel,
      "is marked private/highly_private/explicit_only in frontmatter",
    );
  }
  return absolute;
}

// A repo-relative path an edit may read, resolved and confined to that repo (no `..`, no
// absolute path, no symlink out). Used by `/edit` on a Claude lane to send the planned files'
// current text; Taisce's guard-reads is applied separately by the caller.
export function resolveInsideRepo(repo: string, relPath: string): string {
  const root = realpathSync(repo);
  const absolute = resolve(root, relPath);
  if (!isUnderRoot(absolute, root) || !isUnderRoot(realpathDeepestAncestor(absolute), root)) {
    throw new PathOutsideProjectError(absolute, root);
  }
  return absolute;
}
