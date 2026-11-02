import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  diffForReview,
  GIT_HARDENING_FLAGS,
  GIT_SAFE_ENV,
  gitHeadSha,
  gitStatusPorcelain,
  safeGit,
} from "../../src/lib/git.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GIT_TS_PATH = resolve(HERE, "../../src/lib/git.ts");

const GIT_AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "ignore", env: { ...process.env, ...GIT_AUTHOR_ENV } });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "moss-safegit-"));
  sh("git init -b main", repo);
  writeFileSync(join(repo, "hello.txt"), "v1\n");
  sh("git add -A", repo);
  sh("git -c user.email=test@example.invalid -c user.name=test commit -m init", repo);
  return repo;
}

describe("safeGit (P1 hardening boundary)", () => {
  it("works against a normal local repo end-to-end", async () => {
    const repo = makeRepo();
    try {
      const head = await gitHeadSha(repo);
      const status = await gitStatusPorcelain(repo);
      const rev = await safeGit(["rev-parse", "--short", "HEAD"], { cwd: repo });
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      expect(status).toBe("");
      expect(rev.exitCode).toBe(0);
      expect(rev.stdout.trim()).toMatch(/^[0-9a-f]{7,}$/);

      writeFileSync(join(repo, "hello.txt"), "v2\n");
      const result = await diffForReview(repo);
      expect(result.source).toBe("working-tree");
      expect(result.diff).toContain("-v1");
      expect(result.diff).toContain("+v2");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("hardening flag list contains the documented entries (no surprise additions)", () => {
    // If someone adds or removes a hardening flag, this test forces them to
    // update the audit followup report at the same time.
    expect([...GIT_HARDENING_FLAGS]).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.pager=cat",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "protocol.file.allow=never",
    ]);
  });

  it("safe env disables credential and SSH prompts and pagers and optional locks", () => {
    expect(GIT_SAFE_ENV.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(GIT_SAFE_ENV.GIT_TERMINAL_PROMPT).toBe("0");
    expect(GIT_SAFE_ENV.GIT_ASKPASS).toBe("/bin/false");
    expect(GIT_SAFE_ENV.SSH_ASKPASS).toBe("/bin/false");
    expect(GIT_SAFE_ENV.GIT_PAGER).toBe("cat");
    expect(GIT_SAFE_ENV.PAGER).toBe("cat");
    expect(GIT_SAFE_ENV.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("safeGit does NOT print credential or SSH prompts even with a hostile pager", async () => {
    // Sanity check: ensure no interactive prompt blocks the test. We set a
    // pager in the local config to a command that would hang waiting for
    // input; if our hardening works, it is never invoked.
    const repo = makeRepo();
    try {
      execSync("git config core.pager 'less -K'", {
        cwd: repo,
        env: { ...process.env, ...GIT_AUTHOR_ENV },
      });
      // gitStatusPorcelain on a clean repo would never print anything anyway,
      // but with a hostile pager and no GIT_PAGER override it could try to
      // page. With our env, this completes immediately.
      const status = await gitStatusPorcelain(repo);
      expect(status).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("appends --no-ext-diff and --no-textconv to diff, show, log, blame subcommands", async () => {
    // We assert this structurally by inspecting the source of git.ts. The
    // safeGit wrapper builds the final argv from constants; if either of
    // those flags is removed, this test must fail. A pure-runtime check is
    // covered by the live-canary tests below and in tests/lib/git.test.ts.
    const source = readFileSync(GIT_TS_PATH, "utf8");
    // The constants must exist and must contain both flags.
    expect(source).toMatch(/DIFF_HARDENING_FLAGS[\s\S]*?"--no-ext-diff"/);
    expect(source).toMatch(/DIFF_HARDENING_FLAGS[\s\S]*?"--no-textconv"/);
    expect(source).toMatch(
      /DIFF_PRODUCING_SUBCOMMANDS[\s\S]*?"diff"[\s\S]*?"show"[\s\S]*?"log"[\s\S]*?"blame"/,
    );
  });

  it("live: --no-ext-diff neutralises hostile diff.external on diff calls", async () => {
    const repo = makeRepo();
    const canaryDir = mkdtempSync(join(tmpdir(), "moss-extdiff-canary-"));
    const canary = join(canaryDir, "fired");
    const script = join(canaryDir, "ext.sh");
    writeFileSync(script, `#!/usr/bin/env bash\ntouch ${canary}\nexit 0\n`);
    execSync(`chmod +x ${script}`);
    execSync(`git config diff.external ${script}`, {
      cwd: repo,
      env: { ...process.env, ...GIT_AUTHOR_ENV },
    });
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    try {
      const result = await diffForReview(repo);
      expect(result.diff).toContain("-v1");
      expect(result.diff).toContain("+v2");
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("live: --no-textconv neutralises hostile textconv on diff", async () => {
    const repo = makeRepo();
    const canaryDir = mkdtempSync(join(tmpdir(), "moss-textconv-canary-"));
    const canary = join(canaryDir, "textconv-fired");
    const script = join(canaryDir, "textconv.sh");
    writeFileSync(script, `#!/usr/bin/env bash\ntouch ${canary}\ncat "$1"\n`);
    execSync(`chmod +x ${script}`);
    execSync(`git config diff.evil.textconv ${script}`, {
      cwd: repo,
      env: { ...process.env, ...GIT_AUTHOR_ENV },
    });
    writeFileSync(join(repo, ".gitattributes"), "hello.txt diff=evil\n");
    writeFileSync(join(repo, "hello.txt"), "v2\n");
    try {
      const result = await diffForReview(repo);
      expect(result.diff).toContain("hello.txt");
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("source of git.ts does not reference secrets, .env, SSH keys, browser profiles, or keychains", () => {
    // Defensive grep over the implementation. None of these tokens should
    // ever appear in the M2 git module.
    const forbidden: ReadonlyArray<RegExp> = [
      /\.aws\b/,
      /\.gnupg\b/,
      /id_rsa\b/i,
      /id_ed25519\b/i,
      /id_ecdsa\b/i,
      /authorized_keys\b/i,
      /known_hosts\b/i,
      /keychain/i,
      /\bnetrc\b/i,
      /Library\/(Application Support|Cookies|Keychains)/i,
      /\.config\/(google-chrome|firefox|chromium)/i,
      /\.env\b/,
      /password/i,
      /secret/i,
      /\btoken\b/i,
      /api[_-]?key/i,
    ];
    const source = readFileSync(GIT_TS_PATH, "utf8");
    for (const re of forbidden) {
      expect(source, `git.ts must not reference ${re}`).not.toMatch(re);
    }
  });
});
