import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

const SCAN_ROOTS = ["src", "tests", "scripts", "docs", "registry", ".github"];

const TOKEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "github personal access token", re: /\bgho_[A-Za-z0-9]{30,}\b/ },
  { name: "github fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: "github OAuth app token", re: /\bgho?[su]_[A-Za-z0-9]{30,}\b/ },
  { name: "openai api key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "anthropic api key", re: /\bsk-ant-[A-Za-z0-9-]{20,}\b/ },
  { name: "aws access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "generic private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const EXCLUDED_FILES = new Set(["tests/boundaries/secret-scan.test.ts", "pnpm-lock.yaml"]);

function isExcluded(rel: string): boolean {
  return EXCLUDED_FILES.has(rel) || rel.endsWith(".lockb") || rel.endsWith(".lock");
}

async function listScannableFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const stats = await stat(full);
      if (stats.isDirectory()) {
        await walk(full);
      } else {
        const rel = relative(REPO_ROOT, full).replace(/\\/g, "/");
        if (isExcluded(rel)) continue;
        out.push(full);
      }
    }
  }
  for (const root of SCAN_ROOTS) {
    await walk(join(REPO_ROOT, root));
  }

  // Also scan every regular file at the repository root, not just dotenv
  // files. This catches accidental secrets in root-level config and scripts.
  // The scan is working-tree only; Git history requires a separate history scan.
  try {
    for (const name of await readdir(REPO_ROOT)) {
      const full = join(REPO_ROOT, name);
      const stats = await stat(full);
      if (!stats.isFile()) continue;
      const rel = relative(REPO_ROOT, full).replace(/\\/g, "/");
      if (!isExcluded(rel)) out.push(full);
    }
  } catch {
    // no root listing — ignore
  }
  return out;
}

describe("secret scan", () => {
  it("no real-looking tokens or private keys are present in scanned trees and root files", async () => {
    const files = await listScannableFiles();
    const findings: { file: string; pattern: string; match: string }[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8").catch(() => "");
      for (const { name, re } of TOKEN_PATTERNS) {
        const m = re.exec(contents);
        if (m) {
          findings.push({
            file: relative(REPO_ROOT, file),
            pattern: name,
            match: `${m[0].slice(0, 12)}…`,
          });
        }
      }
    }
    expect(findings).toEqual([]);
  });
});
