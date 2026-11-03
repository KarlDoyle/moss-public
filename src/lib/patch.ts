import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

export class UnsupportedPatchError extends Error {
  constructor(detail: string) {
    super(
      `Unsupported patch: ${detail}. Only text modifications of existing planned regular files are supported.`,
    );
    this.name = "UnsupportedPatchError";
  }
}

function refuse(detail: string): never {
  throw new UnsupportedPatchError(detail);
}

function pathName(raw: string, prefix: "a/" | "b/"): string {
  let path = raw;
  if (raw.startsWith('"')) {
    // Deliberately accept only literal quoted names, not Git C/octal escapes.
    if (!raw.endsWith('"') || raw.slice(1, -1).includes('"')) refuse("invalid quoted path");
    path = raw.slice(1, -1);
  }
  if (!path.startsWith(prefix)) refuse("missing a/ or b/ path prefix");
  path = path.slice(2);
  if (
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    /[\\":]/.test(path) ||
    path
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    refuse("non-canonical path");
  return path;
}

// Narrow unified-text grammar: optional matching diff/index headers, paired same-file
// headers, then complete counted hunks. No creation/deletion, extended operations,
// timestamps, escaped names, CRLF patch syntax, or prose outside the patch.
export function textPatchPaths(diff: string): string[] {
  if (!diff.endsWith("\n") || diff.includes("\0") || diff.includes("\r"))
    refuse("invalid text framing");
  const lines = diff.slice(0, -1).split("\n");
  const paths: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let gitHeader: string | undefined;
    if (lines[i]?.startsWith("diff --git ")) {
      gitHeader = lines[i++];
      if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: 100(?:644|755))?$/.test(lines[i] ?? "")) i++;
    }
    const before = lines[i++];
    const after = lines[i++];
    if (!before?.startsWith("--- ") || !after?.startsWith("+++ "))
      refuse("missing paired file headers");
    const oldRaw = before.slice(4);
    const newRaw = after.slice(4);
    const path = pathName(oldRaw, "a/");
    if (pathName(newRaw, "b/") !== path) refuse("different old/new paths");
    if (gitHeader !== undefined && gitHeader !== `diff --git ${oldRaw} ${newRaw}`)
      refuse("inconsistent diff header");
    if (paths.includes(path)) refuse("duplicate file section");
    paths.push(path);
    let hunks = 0;
    let changes = 0;
    while (lines[i]?.startsWith("@@ ")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[i++] ?? "");
      if (!hunk) refuse("malformed hunk");
      const numbers = hunk.slice(1).map((n) => (n === undefined ? 1 : Number(n)));
      if (numbers.some((n) => !Number.isSafeInteger(n))) refuse("invalid hunk range");
      let old = numbers[1] ?? 1;
      let next = numbers[3] ?? 1;
      while (old > 0 || next > 0) {
        const line = lines[i++];
        const marker = line?.[0];
        if (marker === " ") {
          old--;
          next--;
        } else if (marker === "-") {
          old--;
          changes++;
        } else if (marker === "+") {
          next--;
          changes++;
        } else refuse("invalid or truncated hunk body");
        if (old < 0 || next < 0) refuse("inconsistent hunk counts");
        if (lines[i] === "\\ No newline at end of file") i++;
      }
      hunks++;
    }
    if (hunks === 0 || changes === 0) refuse("empty file change");
  }
  if (paths.length === 0) refuse("empty patch");
  return paths;
}

export function validateTextPatch(
  repo: string,
  diff: string,
  approved: readonly string[],
): string[] {
  const paths = textPatchPaths(diff);
  const root = realpathSync(repo);
  for (const path of paths) {
    if (!approved.includes(path)) refuse(`path outside the plan (${path})`);
    let current = root;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (
        stat.isSymbolicLink() ||
        (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
      ) {
        refuse(`non-regular or symlink path (${path})`);
      }
    }
  }
  return paths;
}
