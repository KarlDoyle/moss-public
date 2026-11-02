// Safe writer for everything under <project-root>/reports/.
//
// Threat model (the directly addressed concern from issue #6):
//   - An attacker with write access inside or adjacent to the reports
//     directory could place a symlink at the expected report path,
//     causing a naive `writeFileSync` to follow the link and write the
//     report content into an arbitrary file on disk.
//   - Even with `paths.ts` already enforcing lexical containment plus a
//     realpath of the deepest existing ancestor, there is a window
//     between the realpath check and the write where the final
//     component (or an ancestor) can be swapped.
//
// What this module guarantees:
//   1. Every report write goes through `writeReportSync` (a central
//      helper; an import-boundary test forbids any other writeFile-shaped
//      call from landing under `reports/`).
//   2. The reports directory is realpathed once per write; the resolved
//      directory must equal `<projectRoot>/reports` realpathed (so a
//      symlinked reports/ pointing outside the project is refused).
//   3. The filename is whitelist-validated. It must match a strict
//      regex (alphanumeric stem, dotted suffix). Path traversal
//      sequences (`..`, `/`, `\\`, NUL) cannot appear.
//   4. The final path is opened with
//      `O_CREAT | O_WRONLY | O_EXCL | O_NOFOLLOW`:
//        - `O_EXCL` refuses to overwrite an existing regular file.
//        - `O_NOFOLLOW` refuses to follow a symlink at the final
//          component (raises `ELOOP` on POSIX).
//   5. After the open succeeds we run two independent post-open checks:
//      a. `fstat(fd)` vs `lstat(path)` on `(dev, ino)` and `isFile()`.
//         This catches a *swap-and-revert* between realpath and open:
//         the attacker replaces an ancestor with a symlink so the open
//         lands at inode X under their control, then reverts the
//         symlink before the lstat post-check; the lstat then sees
//         either ENOENT or a different inode A and the mismatch trips
//         `ReportInodeMismatchError`.
//      b. `realpathSync(dirname(fullPath))` compared against the
//         realpathed reports directory captured at the start of the
//         write. This catches the *swap-and-persist* variant where
//         the attacker plants an ancestor symlink and leaves it in
//         place for the entire write — the equality check in (a) does
//         NOT catch this case because both lstat and fstat traverse
//         the same persistent symlink and report the same inode X.
//         Comparing the dirname's realpath against the cached value
//         catches it because the dirname now resolves into the
//         attacker's directory while the cached value resolves to the
//         original reports directory.
//   6. The file is created with mode `0o600`.
//
// What this module does NOT guarantee:
//   - True `openat`-style protection against an ancestor swap that
//     happens AFTER the post-open checks complete and BEFORE the writer
//     closes the fd. The fd is bound to the original inode so bytes
//     still land in the original file, but downstream callers consulting
//     `reportPath` later may not find the file at that path. Closing
//     this window cleanly needs `openat`/file-descriptor-relative APIs
//     that Node's `fs` does not expose. Documented as residual risk in
//     docs/DECISIONS.md (D-0010).
//   - Protection against an attacker who already has write access to
//     `<projectRoot>/reports/` (or its real path). At that point the
//     attacker can do worse things than confuse the report writer.

import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { getProjectRoot } from "./paths.ts";

const REPORTS_SUBDIR = "reports";

// Filename whitelist:
//   - First character must be alphanumeric.
//   - Remaining stem characters: alphanumeric, dot, hyphen, underscore.
//   - Must end in `.md`.
// Examples accepted: `code-review-20260522T120000000Z.md`,
//                    `preflight-cursor.md`, `verifier-M2.md`.
// Examples refused : `../escape.md`, `/abs.md`, `subdir/x.md`,
//                    `.hidden.md`, `name.txt`, `name`.
const VALID_REPORT_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

// Linux and macOS both cap a single filename component at 255 bytes
// (NAME_MAX). We cap well below that so that a pathological filename
// doesn't surface as a raw `ENAMETOOLONG` from the kernel — callers
// expect typed `Report*Error`s, not raw errno strings.
const MAX_REPORT_FILENAME_LEN = 200;

export class ReportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportPathError";
  }
}

export class ReportFilenameInvalidError extends ReportPathError {
  constructor(filename: string) {
    super(
      `Report filename '${filename}' is invalid. Filenames must match ${VALID_REPORT_FILENAME} and contain no path separators or traversal sequences.`,
    );
    this.name = "ReportFilenameInvalidError";
  }
}

export class ReportPathOutsideReportsError extends ReportPathError {
  constructor(resolvedPath: string, reportsDir: string) {
    super(
      `Refusing to write report at '${resolvedPath}': resolved path is not inside the reports directory '${reportsDir}'.`,
    );
    this.name = "ReportPathOutsideReportsError";
  }
}

export class ReportSymlinkRefusedError extends ReportPathError {
  constructor(path: string) {
    super(
      `Refusing to write report at '${path}': the path is a symlink (or an ancestor is hostile). O_NOFOLLOW refused the open.`,
    );
    this.name = "ReportSymlinkRefusedError";
  }
}

export class ReportAlreadyExistsError extends ReportPathError {
  constructor(path: string) {
    super(
      `Refusing to write report at '${path}': a file already exists. The safe writer never overwrites; the caller must pick a fresh filename.`,
    );
    this.name = "ReportAlreadyExistsError";
  }
}

export class ReportInodeMismatchError extends ReportPathError {
  constructor(path: string) {
    super(
      `Refusing to write report at '${path}': the open file descriptor does not refer to the same inode as the path on disk. An ancestor or the file itself was swapped during the open.`,
    );
    this.name = "ReportInodeMismatchError";
  }
}

// `O_NOFOLLOW` is POSIX-only. On Windows it is not present in
// `fs.constants`; we degrade to no extra constant (the rest of the
// safety mechanisms still apply). Moss is a darwin/linux project per
// docs/RFC.md so this is documented as expected on macOS/Linux runners.
const NOFOLLOW: number = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;

const OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW;
const FILE_MODE = 0o600;

// Returns the realpathed reports/ directory inside the active project
// root. Creates the directory if it does not already exist.
//
// Order of operations (matters for the F2 auditor finding):
//   1. lstat the lexical `<projectRoot>/reports`. If it exists AND is a
//      symlink AND its realpath is not exactly `<realpath(projectRoot)>/
//      reports`, refuse with `ReportPathOutsideReportsError` BEFORE any
//      side-effecting fs call (no mkdir on the attacker's target).
//   2. mkdirSync(..., { recursive: true }) — idempotent on a directory
//      that already exists, and only reached once (1) has passed.
//   3. realpathSync the lexical path and assert it equals
//      `<realpath(projectRoot)>/reports`. This is the line-of-defence
//      that survives any race in step (1).
export function reportsDirectory(): string {
  const projectRoot = getProjectRoot();
  const lexical = resolve(projectRoot, REPORTS_SUBDIR);
  const realProject = realpathSync(projectRoot);
  const expectedReal = resolve(realProject, REPORTS_SUBDIR);

  if (existsSync(lexical)) {
    let lex: Stats;
    try {
      lex = lstatSync(lexical);
    } catch {
      throw new ReportPathOutsideReportsError(lexical, expectedReal);
    }
    if (lex.isSymbolicLink()) {
      const targetReal = realpathSync(lexical);
      if (targetReal !== expectedReal) {
        throw new ReportPathOutsideReportsError(targetReal, expectedReal);
      }
    }
  }

  mkdirSync(lexical, { recursive: true });
  const real = realpathSync(lexical);
  if (real !== expectedReal) {
    throw new ReportPathOutsideReportsError(real, expectedReal);
  }
  return real;
}

export function validateReportFilename(filename: string): void {
  if (filename.length > MAX_REPORT_FILENAME_LEN) {
    throw new ReportFilenameInvalidError(filename);
  }
  if (!VALID_REPORT_FILENAME.test(filename)) {
    throw new ReportFilenameInvalidError(filename);
  }
  // Belt-and-braces: ensure no NUL byte and no path separators in any
  // representation. The regex above already enforces this but the
  // explicit check makes the intent loud.
  if (
    filename.includes("\0") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    throw new ReportFilenameInvalidError(filename);
  }
}

// Returns the absolute path a report WOULD be written to without
// actually performing the open. Useful for `moss run --json` output
// where we want to surface the intended path even if the write itself
// is going to fail downstream.
export function plannedReportPath(filename: string): string {
  validateReportFilename(filename);
  const dir = reportsDirectory();
  const candidate = resolve(dir, filename);
  // Final-component containment: candidate must be exactly one
  // path component beyond dir.
  const expectedPrefix = dir + sep;
  if (
    !candidate.startsWith(expectedPrefix) ||
    candidate.slice(expectedPrefix.length).includes(sep)
  ) {
    throw new ReportPathOutsideReportsError(candidate, dir);
  }
  return candidate;
}

// Writes a report to <projectRoot>/reports/<filename> using all of the
// hardening described at the top of this file. Returns the absolute
// path written. Throws a typed ReportPathError on any safety violation.
export function writeReportSync(filename: string, contents: string): string {
  // Capture the realpathed reports directory BEFORE the open so we can
  // diff it against `realpathSync(dirname(fullPath))` afterwards. If
  // an attacker plants a persistent ancestor symlink between this call
  // and the open, the two values will differ. See header comment 5(b).
  const cachedReportsDir = reportsDirectory();
  const fullPath = plannedReportPath(filename);

  // Pre-flight: if anything is already at the target path, classify
  // *why* we are about to refuse before we hand off to the kernel.
  //
  // Why both this check and O_NOFOLLOW + O_EXCL?
  //   - On Linux, `open(O_CREAT | O_EXCL | O_NOFOLLOW)` against a
  //     symlink raises ELOOP, which we'd map to ReportSymlinkRefusedError.
  //   - On macOS/BSD, the same call raises EEXIST instead because
  //     `O_EXCL` wins precedence in the kernel's check order. That
  //     would surface as `ReportAlreadyExistsError`, hiding the more
  //     security-relevant cause (a hostile symlink, not a clock collision).
  //   - This `lstatSync` lets us return the security-relevant error name
  //     consistently across platforms. The actual safety still rests on
  //     the kernel-level open flags below; this is purely UX.
  //
  // TOCTOU concern: a symlink could be planted between this check and
  // the open. That's fine — the open's `O_NOFOLLOW` + `O_EXCL` still
  // fail closed (ELOOP on Linux, EEXIST on macOS), so we never write to
  // the symlink target. The post-open inode equality check provides a
  // further independent guard.
  let preExisting: Stats | null = null;
  try {
    preExisting = lstatSync(fullPath);
  } catch {
    preExisting = null;
  }
  if (preExisting?.isSymbolicLink()) {
    throw new ReportSymlinkRefusedError(fullPath);
  }

  let fd: number;
  try {
    fd = openSync(fullPath, OPEN_FLAGS, FILE_MODE);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ELOOP" || errno.code === "EMLINK") {
      throw new ReportSymlinkRefusedError(fullPath);
    }
    if (errno.code === "EEXIST") {
      // A symlink may have been planted in the race window between the
      // pre-flight lstat above and this open. lstat again to be sure
      // before we report a clock-collision-style error.
      try {
        const post = lstatSync(fullPath);
        if (post.isSymbolicLink()) {
          throw new ReportSymlinkRefusedError(fullPath);
        }
      } catch (innerError) {
        if (innerError instanceof ReportSymlinkRefusedError) throw innerError;
      }
      throw new ReportAlreadyExistsError(fullPath);
    }
    throw error;
  }

  try {
    // Post-open check (a): inode equality.
    // Catches the swap-and-revert race; see header comment 5(a).
    let lstatResult: Stats;
    try {
      lstatResult = lstatSync(fullPath);
    } catch {
      throw new ReportInodeMismatchError(fullPath);
    }
    const fstatResult = fstatSync(fd);
    if (
      lstatResult.ino !== fstatResult.ino ||
      lstatResult.dev !== fstatResult.dev ||
      !lstatResult.isFile()
    ) {
      throw new ReportInodeMismatchError(fullPath);
    }

    // Post-open check (b): dirname realpath equality.
    // Catches the swap-and-persist variant; see header comment 5(b).
    // If an attacker planted a persistent ancestor symlink between
    // `reportsDirectory()` above and this `openSync`, the open landed
    // in the attacker's tree, both lstat and fstat saw the same
    // (attacker-controlled) inode, and check (a) passed. Here we
    // re-realpath the dirname; if it does not equal the cached
    // realpathed reports directory captured before the open, we know
    // the ancestor has changed and we refuse.
    const dirAfterOpen = realpathSync(dirname(fullPath));
    if (dirAfterOpen !== cachedReportsDir) {
      throw new ReportInodeMismatchError(fullPath);
    }

    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }

  return fullPath;
}
