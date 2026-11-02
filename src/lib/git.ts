import { run } from "./exec.ts";
import { validateTextPatch } from "./patch.ts";

export class GitDiffEmptyError extends Error {
  constructor(path: string) {
    super(
      `Target repo at '${path}' has nothing to review: no working-tree changes, no staged changes, and no previous commit to compare against HEAD.`,
    );
    this.name = "GitDiffEmptyError";
  }
}

export class GitRepoMutatedError extends Error {
  constructor(reason: string) {
    super(`Target git repository changed during the run: ${reason}`);
    this.name = "GitRepoMutatedError";
  }
}

export class GitHostileConfigError extends Error {
  constructor(target: string, detail: string) {
    super(
      `Refusing to read git from '${target}': the target's effective Git configuration defines a directive that can execute arbitrary code (${detail}). Re-run after removing the directive, or use a different target.`,
    );
    this.name = "GitHostileConfigError";
  }
}

export interface RepoSnapshot {
  readonly head: string;
  readonly statusPorcelain: string;
}

export interface DiffResult {
  readonly source: "working-tree" | "head-vs-prev";
  readonly diff: string;
  readonly summary: string;
}

const GIT_TIMEOUT_MS = 15_000;

// -----------------------------------------------------------------------------
// safeGit: the ONLY way Moss runs git.
//
// Every git invocation in src/lib/git.ts goes through `safeGit`. It:
//   1. Goes through src/lib/exec.ts (which uses execa with an explicit
//      arg array — never a shell string), so target paths and refs are
//      passed as data, never interpolated into a shell command.
//   2. Runs against the explicit `cwd` (target repo path). exec.ts does
//      not honour ambient pwd; the cwd is always the parameter we pass.
//   3. Sets a fixed safe environment that disables credential prompts,
//      pager fallbacks, and optional locks. See GIT_SAFE_ENV.
//   4. Prefixes every command with defensive `-c` flags that neutralise
//      the dangerous repo-local config knobs we can override. See
//      GIT_HARDENING_FLAGS. These take effect AFTER repo-local config,
//      so a hostile `.git/config` cannot win.
//   5. For diff-producing subcommands, appends `--no-ext-diff` and
//      `--no-textconv` so external diff drivers and textconv filters
//      cannot fire even if the user has them configured globally.
// -----------------------------------------------------------------------------

// Defensive overrides apply to inspection and operations alike. Per-driver filters
// cannot be disabled by a wildcard override; assertSafeGitConfig refuses them.
export const GIT_HARDENING_FLAGS: readonly string[] = [
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
];

// Environment variables passed into every git invocation. These layer on
// top of execa's inherited env; execa receives an explicit `env` map so
// these settings cannot be undone by ambient process state.
export const GIT_SAFE_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
};

// Variables git sets for its own child processes — hooks, filters, `git rebase -x`.
// Inheriting them is a correctness *and* a safety bug: a pre-push hook runs with
// GIT_DIR pointing at the repository being pushed, so any git command moss then runs
// with a `cwd` elsewhere would silently operate on the pushing repository instead of
// the one it was aimed at. safeGit always removes them; the cwd is the only thing that
// decides which repository is touched.
export const GIT_INHERITED_ENV: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

// Git subcommands that can invoke an external diff driver and/or textconv
// filter. For these, safeGit appends `--no-ext-diff --no-textconv` right
// after the subcommand name.
const DIFF_PRODUCING_SUBCOMMANDS: ReadonlySet<string> = new Set(["diff", "show", "log", "blame"]);

const DIFF_HARDENING_FLAGS: readonly string[] = ["--no-ext-diff", "--no-textconv"];

export interface SafeGitOptions {
  readonly cwd: string;
  readonly allowFailure?: boolean;
  readonly input?: string;
}

export interface SafeGitResult {
  readonly stdout: string;
  readonly exitCode: number;
  readonly stderr?: string;
}

// All git invocations in Moss go through this wrapper. Direct uses of
// `run("git", ...)` elsewhere in the codebase are forbidden.
export async function safeGit(
  args: readonly string[],
  options: SafeGitOptions,
): Promise<SafeGitResult> {
  if (args.length === 0) {
    throw new Error("safeGit requires at least one argument (the git subcommand).");
  }
  if (args[0] !== "config" && args[0] !== "--version") {
    await assertSafeGitConfig(options.cwd);
  }
  const subcommand = args[0] as string;
  const subcommandArgs = args.slice(1);
  const diffFlags = DIFF_PRODUCING_SUBCOMMANDS.has(subcommand) ? DIFF_HARDENING_FLAGS : [];

  const finalArgs: readonly string[] = [
    ...GIT_HARDENING_FLAGS,
    subcommand,
    ...diffFlags,
    ...subcommandArgs,
  ];

  const result = await run("git", finalArgs, {
    cwd: options.cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    env: GIT_SAFE_ENV,
    unsetEnv: GIT_INHERITED_ENV,
    allowFailure: options.allowFailure ?? false,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return { stdout: result.stdout, exitCode: result.exitCode, stderr: result.stderr };
}

// -----------------------------------------------------------------------------
// Effective configuration refusal model
//
// Enumerate keys with includes and conditional includes under the same cwd and
// hardened environment as the operation. This includes global, local, worktree
// and command configuration (system configuration is disabled for both).
// Config enumeration does not run filters/hooks. Fail closed on errors/framing.
// -----------------------------------------------------------------------------

const REFUSE_EFFECTIVE_CONFIG_KEYS: readonly RegExp[] = [
  /^core\.sshcommand$/i,
  /^filter\.[\s\S]*\.(process|clean|smudge)$/i,
  /^url\..+\.insteadof$/i,
];

async function listEffectiveConfigKeys(repoPath: string): Promise<string[]> {
  const result = await safeGit(["config", "--includes", "--null", "--name-only", "--list"], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    throw new GitHostileConfigError(repoPath, "effective configuration inspection failed");
  }
  if (result.stdout !== "" && !result.stdout.endsWith("\0")) {
    throw new GitHostileConfigError(repoPath, "ambiguous configuration inspection output");
  }
  return result.stdout.split("\0").filter((line) => line !== "");
}

export async function assertSafeGitConfig(repoPath: string): Promise<void> {
  const keys = await listEffectiveConfigKeys(repoPath);
  for (const key of keys) {
    for (const pattern of REFUSE_EFFECTIVE_CONFIG_KEYS) {
      if (pattern.test(key)) {
        throw new GitHostileConfigError(repoPath, `effective config defines '${key}'`);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Public read-only git surface
// -----------------------------------------------------------------------------

// `git --version` is the one git invocation that does not need a target
// repo (it produces the same output anywhere). We expose it as a typed
// helper so callers like `moss doctor` do not have to reach around safeGit
// to invoke git directly. We pass an arbitrary cwd (the operator's pwd is
// fine — `git --version` consults no config and writes nothing) and lower
// the timeout because the command is trivial.
export async function gitVersion(cwd: string): Promise<string | null> {
  const result = await safeGit(["--version"], { cwd, allowFailure: true });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim();
}

export interface RevListDivergence {
  // Commits reachable from the left ref but not the right (e.g. how far
  // behind `origin/main` HEAD is, for `origin/main...HEAD`).
  readonly left: number;
  // Commits reachable from the right ref but not the left (e.g. how far
  // ahead HEAD is of `origin/main`).
  readonly right: number;
}

// `git rev-list --left-right --count <left>...<right>` — used by `moss
// doctor` to report the Taisce checkout's divergence from its remote, the
// same check CONTINUITY.md calls out as a point-in-time fact that must be
// re-run, not assumed. Returns null (not a thrown error) when the range
// cannot be resolved (e.g. no such remote-tracking ref, or not a git repo)
// so a missing/misconfigured checkout degrades doctor's report rather than
// crashing it.
export async function revListLeftRightCount(
  repoPath: string,
  range: string,
): Promise<RevListDivergence | null> {
  const result = await safeGit(["rev-list", "--left-right", "--count", range], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  const parts = result.stdout.trim().split(/\s+/);
  const left = Number.parseInt(parts[0] ?? "", 10);
  const right = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return { left, right };
}

// The repo `/edit` works in: the git top level containing `cwd`, or null when `cwd` is not
// inside a work tree (the session then falls back to the Taisce checkout).
export async function gitTopLevel(cwd: string): Promise<string | null> {
  const result = await safeGit(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (result.exitCode !== 0) return null;
  const top = result.stdout.trim();
  return top.length > 0 ? top : null;
}

// Tracked files, for the `/edit` planner to pick from. Capped so a huge repo cannot flood a
// local model's context window.
export async function gitTrackedFiles(repoPath: string, max = 400): Promise<string[]> {
  const result = await safeGit(["ls-files", "-z"], { cwd: repoPath, allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\0")
    .filter((line) => line.length > 0)
    .slice(0, max);
}

// `git diff --stat` of the working tree — what `/edit` prints after a real Aider run.
export async function gitDiffStat(repoPath: string): Promise<string> {
  const result = await safeGit(["diff", "--stat"], { cwd: repoPath, allowFailure: true });
  return result.stdout.trimEnd();
}

// `git apply` of patch text via stdin — `/edit` on a Claude lane applies exactly the diff the operator
// approved. check=true runs `--check` first, which touches nothing.
export async function gitApply(
  repoPath: string,
  patch: string,
  check: boolean,
  files: readonly string[],
): Promise<{ ok: boolean; output: string }> {
  validateTextPatch(repoPath, patch, files);
  const result = await safeGit(
    ["apply", ...(check ? ["--check"] : []), "--whitespace=nowarn", "-"],
    {
      cwd: repoPath,
      allowFailure: true,
      input: patch,
    },
  );
  return { ok: result.exitCode === 0, output: `${result.stderr ?? ""}${result.stdout}` };
}

export async function gitHeadSha(repoPath: string): Promise<string> {
  const result = await safeGit(["rev-parse", "HEAD"], { cwd: repoPath, allowFailure: true });
  if (result.exitCode !== 0) {
    return "";
  }
  return result.stdout.trim();
}

export async function gitStatusPorcelain(repoPath: string): Promise<string> {
  const result = await safeGit(["status", "--porcelain=v1"], { cwd: repoPath });
  return result.stdout.trimEnd();
}

export async function snapshotRepo(repoPath: string): Promise<RepoSnapshot> {
  await assertSafeGitConfig(repoPath);
  const [head, statusPorcelain] = await Promise.all([
    gitHeadSha(repoPath),
    gitStatusPorcelain(repoPath),
  ]);
  return { head, statusPorcelain };
}

export function assertRepoUnchanged(before: RepoSnapshot, after: RepoSnapshot): void {
  if (before.head !== after.head) {
    throw new GitRepoMutatedError(
      `HEAD changed from '${before.head || "(unborn)"}' to '${after.head || "(unborn)"}'.`,
    );
  }
  if (before.statusPorcelain !== after.statusPorcelain) {
    throw new GitRepoMutatedError("working-tree or index status differs from pre-run snapshot.");
  }
}

// "Working-tree" deliberately means "everything different from HEAD" — i.e.
// the union of staged and unstaged changes. Using plain `git diff` would skip
// staged content and produce reviews that miss a chunk of the user's intent.
async function gitDiffWorkingVsHead(repoPath: string): Promise<string> {
  const result = await safeGit(["diff", "--no-color", "HEAD"], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return "";
  }
  return result.stdout;
}

async function gitDiffHeadVsPrev(repoPath: string): Promise<string> {
  const result = await safeGit(["diff", "--no-color", "HEAD~1..HEAD"], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return "";
  }
  return result.stdout;
}

async function gitNumstat(repoPath: string, args: readonly string[]): Promise<string> {
  const result = await safeGit(["diff", "--numstat", "--no-color", ...args], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return "";
  }
  return result.stdout.trimEnd();
}

function summariseNumstat(numstat: string, label: string): string {
  if (numstat === "") {
    return `${label}: no changes`;
  }
  const lines = numstat.split("\n").filter((line) => line.trim() !== "");
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const a = Number.parseInt(parts[0] ?? "0", 10);
    const r = Number.parseInt(parts[1] ?? "0", 10);
    if (!Number.isNaN(a)) added += a;
    if (!Number.isNaN(r)) removed += r;
    files += 1;
  }
  return `${label}: ${files} file(s), +${added} -${removed}`;
}

// Selects the most informative diff available for review:
// 1. Working-tree-vs-HEAD if any (union of staged + unstaged changes).
// 2. HEAD~1..HEAD if there's at least one previous commit.
// Throws GitDiffEmptyError if none of these yield content.
//
// Note: "staged-only" is intentionally not a separate branch — `git diff HEAD`
// already includes the staged content, so a dedicated staged branch would be
// dead code (if `git diff HEAD` is empty, `git diff --cached` is also empty).
export async function diffForReview(repoPath: string): Promise<DiffResult> {
  await assertSafeGitConfig(repoPath);
  const working = await gitDiffWorkingVsHead(repoPath);
  if (working.trim() !== "") {
    const summary = summariseNumstat(await gitNumstat(repoPath, ["HEAD"]), "working-tree-vs-HEAD");
    return { source: "working-tree", diff: working, summary };
  }
  const headVsPrev = await gitDiffHeadVsPrev(repoPath);
  if (headVsPrev.trim() !== "") {
    const summary = summariseNumstat(await gitNumstat(repoPath, ["HEAD~1..HEAD"]), "HEAD~1..HEAD");
    return { source: "head-vs-prev", diff: headVsPrev, summary };
  }
  throw new GitDiffEmptyError(repoPath);
}
