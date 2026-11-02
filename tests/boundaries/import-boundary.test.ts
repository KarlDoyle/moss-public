import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SRC_ROOT = join(REPO_ROOT, "src");

const SUBPROCESS_IMPORT_RE =
  /from\s+["'](node:child_process|child_process|execa)["']|require\(["'](node:child_process|child_process|execa)["']\)/;
const FETCH_PRIMITIVE_RE = /\b(fetch\(|new\s+URL\(|new\s+Request\()/;

async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const name of entries) {
      const full = join(dir, name);
      const stats = await stat(full);
      if (stats.isDirectory()) {
        await walk(full);
      } else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

describe("import boundary — subprocess", () => {
  it("only src/lib/exec.ts imports subprocess primitives", async () => {
    const files = await listSourceFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      if (!SUBPROCESS_IMPORT_RE.test(contents)) continue;
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (rel === "src/lib/exec.ts") continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("import boundary — network primitives (M1 + M5)", () => {
  it("only net.ts, ollama.ts, litellm.ts, and litellm/config.ts touch fetch/URL/Request", async () => {
    const files = await listSourceFiles(SRC_ROOT);
    const ALLOWED = new Set([
      "src/lib/net.ts",
      "src/lib/providers/ollama.ts",
      // M5: the LiteLLM lane uses safeFetch via the provider, and the
      // config loader uses `new URL()` to validate localhost-only
      // endpoints at parse time. Both stay inside the safety boundary
      // — net.ts is the only module that performs the actual fetch.
      "src/lib/providers/litellm.ts",
      "src/lib/litellm/config.ts",
      "src/lib/mcp/client.ts",
      "src/lib/mcp/config.ts",
    ]);
    const offenders: string[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (ALLOWED.has(rel)) continue;
      if (FETCH_PRIMITIVE_RE.test(contents)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("import boundary — git subprocess (M2)", () => {
  // Every git invocation in Moss must go through the safeGit wrapper in
  // src/lib/git.ts. This boundary makes sure nobody else reaches around
  // safeGit to call git directly through exec.ts or a deps-style wrapper.
  //
  // Match anything of the form `<name>("git", ...)` where <name> ends in
  // "run" or "Run" (covers `run`, `execRun`, `someRun`, future `safeRun`,
  // etc.) or is one of the node:child_process primitives. The match must
  // be on a literal `"git"` as the first argument. Every alternative is
  // anchored on the left with `\b` so it cannot be partially matched as
  // the tail of an unrelated identifier (e.g. matching `mySpawn` would
  // be a false positive; matching `spawn` is genuine).
  const GIT_INVOCATION_RE =
    /(\b\w*[rR]un|\bspawn|\bspawnSync|\bexec|\bexecFile|\bexecFileSync|\bexecSync)\s*\(\s*["']git["']/;

  it("only src/lib/git.ts invokes git as a subprocess", async () => {
    const files = await listSourceFiles(SRC_ROOT);
    const offenders: { file: string; matches: string[] }[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (rel === "src/lib/git.ts") continue;
      const matches: string[] = [];
      for (const line of contents.split("\n")) {
        if (GIT_INVOCATION_RE.test(line)) matches.push(line.trim());
      }
      if (matches.length > 0) offenders.push({ file: rel, matches });
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it("the boundary regex is not vacuous — it catches synthetic offenders", () => {
    // Sanity check: if someone rewrites the regex into a no-op we want
    // this assertion to fail loudly.
    const offenders = [
      'await run("git", ["status"])',
      'deps.execRun("git", ["--version"])',
      'spawn("git", args)',
      'execFileSync("git", ["--version"])',
      'await someRun("git", [])',
    ];
    for (const line of offenders) {
      expect(GIT_INVOCATION_RE.test(line), `should match: ${line}`).toBe(true);
    }
    const allowed = [
      'console.log("git is great")',
      'const cmd = "git";',
      '"git status".split(" ")',
    ];
    for (const line of allowed) {
      expect(GIT_INVOCATION_RE.test(line), `should NOT match: ${line}`).toBe(false);
    }
  });
});

describe("import boundary — report writes (M3)", () => {
  // Every disk write whose target lives inside <projectRoot>/reports/ must
  // go through src/lib/reports.ts's `writeReportSync`. This boundary catches
  // anybody reaching for `fs.writeFileSync(...reports...)` or `fs.openSync`
  // with a path string containing `reports/`. Without this rule, a future
  // contributor could accidentally re-introduce a TOCTOU/symlink-follow
  // write that we hardened against in M3-T00 (issue #6).
  //
  // The boundary is intentionally narrow: it only fires when a write-shaped
  // call is on the SAME line as a string literal that mentions `reports/`.
  // Known bypass shapes (NOT caught by this regex) that contributors must
  // still avoid by following the helper:
  //   1. Multi-line call where the literal and the call name are split
  //      across lines, e.g.
  //          writeFileSync(
  //            "reports/x.md",
  //            data,
  //          );
  //   2. Path constructed by variable composition with no `reports/`
  //      literal on the call line, e.g.
  //          const p = join(root, "reports", filename);
  //          writeFileSync(p, data);
  //   3. Indirect write through a variable that aliases an fs API.
  // For those, the runtime guard is the inode/realpath checks in
  // src/lib/reports.ts itself; this boundary is a defence-in-depth
  // grep, not the only defence.
  const FILE_WRITE_RE =
    /(\bwriteFile\b|\bwriteFileSync\b|\bopenSync\b|\bopen\b|\bcreateWriteStream\b|\bappendFile\b|\bappendFileSync\b|\bcopyFile\b|\bcopyFileSync\b|\bcp\b|\bcpSync\b|\brename\b|\brenameSync\b|\blink\b|\blinkSync\b|\bsymlink\b|\bsymlinkSync\b)\s*\(/;
  const REPORTS_PATH_LITERAL_RE = /["'`][^"'`]*\breports\/[^"'`]*["'`]/;

  it("only src/lib/reports.ts touches reports/ via direct fs write calls", async () => {
    const files = await listSourceFiles(SRC_ROOT);
    const offenders: { file: string; matches: string[] }[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (rel === "src/lib/reports.ts") continue;
      const matches: string[] = [];
      for (const line of contents.split("\n")) {
        if (FILE_WRITE_RE.test(line) && REPORTS_PATH_LITERAL_RE.test(line)) {
          matches.push(line.trim());
        }
      }
      if (matches.length > 0) offenders.push({ file: rel, matches });
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it("the reports-write boundary regex is not vacuous", () => {
    const offenders = [
      'writeFileSync("/abs/reports/x.md", "data")',
      'await writeFile(join(root, "reports/x.md"), data)',
      'openSync("reports/escape.md", flags)',
      'copyFileSync(src, "reports/x.md")',
      'renameSync(tmp, "reports/x.md")',
      'symlinkSync(target, "reports/x.md")',
      'linkSync(target, "reports/x.md")',
      'cpSync(src, "reports/x.md")',
    ];
    for (const line of offenders) {
      expect(
        FILE_WRITE_RE.test(line) && REPORTS_PATH_LITERAL_RE.test(line),
        `should match: ${line}`,
      ).toBe(true);
    }
    const allowed = [
      "// see reports/safety-auditor-M2.md",
      'console.log("reports/x.md")',
      'const REPORTS_SUBDIR = "reports";',
    ];
    for (const line of allowed) {
      expect(
        FILE_WRITE_RE.test(line) && REPORTS_PATH_LITERAL_RE.test(line),
        `should NOT match: ${line}`,
      ).toBe(false);
    }
  });
});
