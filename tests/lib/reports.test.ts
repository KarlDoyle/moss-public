import {
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectRoot, setProjectRoot } from "../../src/lib/paths.ts";
import {
  plannedReportPath,
  ReportAlreadyExistsError,
  ReportFilenameInvalidError,
  ReportPathError,
  ReportPathOutsideReportsError,
  ReportSymlinkRefusedError,
  reportsDirectory,
  validateReportFilename,
  writeReportSync,
} from "../../src/lib/reports.ts";

// Each test runs against a fresh tmpdir so the real Moss reports/ is never
// touched. We restore the previous project root in afterEach.

describe("src/lib/reports.ts — safe report writer", () => {
  const realRoot = getProjectRoot();
  let sandbox: string;

  beforeEach(() => {
    // realpathSync so that on macOS `/var/...` -> `/private/var/...`
    // matches what the writer produces (it realpaths internally).
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), "moss-reports-")));
    setProjectRoot(sandbox);
  });

  afterEach(() => {
    setProjectRoot(realRoot);
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe("happy path", () => {
    it("creates the reports/ directory on first use", () => {
      const dir = reportsDirectory();
      expect(dir).toBe(resolve(sandbox, "reports"));
      const stats = lstatSync(dir);
      expect(stats.isDirectory()).toBe(true);
    });

    it("writes a report and returns the absolute path", () => {
      const path = writeReportSync("code-review-20260522T120000000Z.md", "hello world\n");
      expect(path).toBe(resolve(sandbox, "reports", "code-review-20260522T120000000Z.md"));
      expect(readFileSync(path, "utf8")).toBe("hello world\n");
    });

    it("creates the file with mode 0o600 (owner-only)", () => {
      const path = writeReportSync("perms.md", "x");
      const mode = lstatSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("is reentrant when filenames differ", () => {
      writeReportSync("a.md", "first");
      writeReportSync("b.md", "second");
      expect(readFileSync(resolve(sandbox, "reports", "a.md"), "utf8")).toBe("first");
      expect(readFileSync(resolve(sandbox, "reports", "b.md"), "utf8")).toBe("second");
    });
  });

  describe("filename validation", () => {
    const cases: Array<[string, string]> = [
      ["empty", ""],
      ["bare dot", "."],
      ["double dot", ".."],
      ["hidden file", ".hidden.md"],
      ["forward slash", "sub/file.md"],
      ["backward slash", "sub\\file.md"],
      ["NUL byte", "x\0.md"],
      ["wrong extension", "file.txt"],
      ["no extension", "file"],
      ["traversal", "../escape.md"],
      ["absolute path", "/etc/passwd.md"],
      ["leading dot-slash", "./file.md"],
      ["space", "with space.md"],
      // F5 — filename length cap. 202 chars; cap is `length > 200`.
      ["too long", `${"a".repeat(200 - 3)}xy.md`],
    ];
    for (const [label, bad] of cases) {
      it(`refuses invalid filename: ${label}`, () => {
        expect(() => validateReportFilename(bad)).toThrow(ReportFilenameInvalidError);
        expect(() => writeReportSync(bad, "x")).toThrow(ReportFilenameInvalidError);
      });
    }

    const good = [
      "a.md",
      "code-review-20260522T120000000Z.md",
      "verifier-M2.md",
      "preflight-cursor.md",
      "x_y.md",
      // F5 — filename length cap. 200 chars is the inclusive limit.
      `${"a".repeat(200 - 3)}.md`,
    ];
    for (const name of good) {
      it(`accepts valid filename: ${name}`, () => {
        expect(() => validateReportFilename(name)).not.toThrow();
      });
    }
  });

  describe("symlink refusal", () => {
    it("fails closed when the report path is a pre-existing symlink", () => {
      const dir = reportsDirectory();
      const decoy = join(sandbox, "decoy.txt");
      writeFileSync(decoy, "this file should NEVER be touched\n");
      const reportFile = join(dir, "code-review.md");
      symlinkSync(decoy, reportFile);

      expect(() => writeReportSync("code-review.md", "payload")).toThrow(ReportSymlinkRefusedError);

      // Verify the decoy was not overwritten.
      expect(readFileSync(decoy, "utf8")).toBe("this file should NEVER be touched\n");
    });

    it("fails closed when the report path is a dangling symlink", () => {
      const dir = reportsDirectory();
      const reportFile = join(dir, "report.md");
      symlinkSync(join(sandbox, "does-not-exist.txt"), reportFile);

      expect(() => writeReportSync("report.md", "payload")).toThrow(ReportSymlinkRefusedError);
    });

    it("refuses when reports/ itself is a symlink to outside the project", () => {
      // Remove the reports dir that beforeEach implicitly didn't create
      // (it's created lazily by reportsDirectory()), then replace it with
      // a symlink pointing to an external attacker-controlled directory.
      const external = mkdtempSync(join(tmpdir(), "moss-attacker-"));
      try {
        const lexical = resolve(sandbox, "reports");
        rmSync(lexical, { recursive: true, force: true });
        symlinkSync(external, lexical);
        expect(() => reportsDirectory()).toThrow(ReportPathOutsideReportsError);
      } finally {
        rmSync(external, { recursive: true, force: true });
      }
    });
  });

  describe("path-traversal refusal", () => {
    // The filename whitelist alone refuses traversal in writeReportSync,
    // but plannedReportPath also asserts containment after path.resolve.
    it("plannedReportPath rejects traversal", () => {
      expect(() => plannedReportPath("../escape.md")).toThrow(ReportFilenameInvalidError);
    });

    it("the resolved path stays inside reports/", () => {
      const path = plannedReportPath("verifier-M3.md");
      const dir = reportsDirectory();
      expect(path.startsWith(`${dir}/`)).toBe(true);
      // Single component beyond reports/
      expect(path.slice(dir.length + 1)).toBe("verifier-M3.md");
    });
  });

  describe("never overwrites existing files", () => {
    it("refuses to overwrite a pre-existing regular file at the target path", () => {
      const dir = reportsDirectory();
      const reportFile = join(dir, "existing.md");
      writeFileSync(reportFile, "original\n");

      expect(() => writeReportSync("existing.md", "new")).toThrow(ReportAlreadyExistsError);
      expect(readFileSync(reportFile, "utf8")).toBe("original\n");
    });
  });

  describe("module surface", () => {
    it("all custom errors inherit from ReportPathError", () => {
      expect(new ReportFilenameInvalidError("x")).toBeInstanceOf(ReportPathError);
      expect(new ReportPathOutsideReportsError("a", "b")).toBeInstanceOf(ReportPathError);
      expect(new ReportSymlinkRefusedError("a")).toBeInstanceOf(ReportPathError);
      expect(new ReportAlreadyExistsError("a")).toBeInstanceOf(ReportPathError);
    });

    it("uses O_NOFOLLOW on POSIX platforms when the constant is exposed", () => {
      // This is a sanity check that the runtime knows about O_NOFOLLOW on
      // the platforms we ship on (darwin/linux). If it's ever missing on
      // CI we want to fail loudly rather than silently degrade.
      if (process.platform === "darwin" || process.platform === "linux") {
        expect((fsConstants as Record<string, number | undefined>).O_NOFOLLOW).toBeTypeOf("number");
      }
    });
  });
});
