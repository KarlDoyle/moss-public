import { existsSync } from "node:fs";
import type { Command } from "commander";
import { ExecCommandNotAllowedError, ExecFailedError, type ExecResult, run } from "../lib/exec.ts";
import {
  gitVersion as defaultGitVersion,
  revListLeftRightCount as defaultRevListLeftRightCount,
  type RevListDivergence,
} from "../lib/git.ts";
import { type FetchResult, NetworkBoundaryError, safeFetch } from "../lib/net.ts";
import { resolveTaisceRoot as defaultResolveTaisceRoot, getProjectRoot } from "../lib/paths.ts";

const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";
const MIN_NODE_MAJOR = 24;

export interface DoctorDependencies {
  readonly execRun: (
    command: string,
    args: readonly string[],
    options?: { readonly allowFailure?: boolean; readonly timeoutMs?: number },
  ) => Promise<ExecResult>;
  // Doctor's git version probe is the one place outside src/lib/git.ts that
  // would otherwise need to run a git command. We expose it as a dedicated
  // dependency so the M2 git-call import boundary stays honest: nothing
  // outside src/lib/git.ts invokes git directly.
  readonly gitVersion: (cwd: string) => Promise<string | null>;
  readonly netFetch: (url: string) => Promise<FetchResult>;
  readonly cwd: () => string;
  readonly nodeVersion: () => string;
  readonly projectRoot: () => string;
  // Estate fallback-ladder tier status (System/fallback-ladder.md). Optional
  // so existing test fakes that construct a `DoctorDependencies` literal
  // without these fields keep compiling; `gatherDiagnostics` falls back to
  // the real implementations when a field is omitted. `estate-mode status`
  // (mac-setup dotfiles/zsh) calls `moss doctor --json` and reads this
  // section as the single source of truth for the machine-observable part
  // of the tier — it cannot see Claude Code's own subscription/credit
  // state, only what's locally checkable: an API key and a local model.
  readonly hasApiKey?: () => boolean;
  readonly taisceRoot?: () => string;
  readonly taisceDivergence?: (cwd: string) => Promise<RevListDivergence | null>;
}

export interface NodeCheck {
  readonly version: string;
  readonly satisfiesMin: boolean;
}

export interface BinaryCheck {
  readonly available: boolean;
  readonly version?: string;
}

export interface GithubCheck {
  readonly authed: boolean;
  readonly account?: string;
  readonly scopes?: readonly string[];
}

export interface OllamaModelInfo {
  readonly name: string;
  readonly size?: number;
}

export interface OllamaCheck {
  readonly reachable: boolean;
  readonly models: readonly OllamaModelInfo[];
  readonly error?: string;
}

export interface ProjectRootCheck {
  readonly expected: string;
  readonly actual: string;
  readonly matches: boolean;
}

// The fallback-ladder tier this machine can currently reach, as far as moss
// can observe from this process alone. "active" is a best-effort label, not
// a live read of Claude Code's billing state (moss has no access to that):
// an exported ANTHROPIC_API_KEY means Tier 2 is in play for this shell;
// otherwise Tier 0/1 (subscription or usage credits) is assumed, since
// neither is locally distinguishable. Tier 3 readiness is reported
// separately via `ollama` above, and `estate-mode status` combines both.
export interface TierCheck {
  readonly active: "api-key" | "subscription-or-credits";
  readonly apiKeyPresent: boolean;
  readonly localReady: boolean; // Tier 3 could be entered now (ollama reachable + a model pulled)
}

export interface TaisceCheck {
  readonly root: string;
  readonly present: boolean;
  // null when the checkout is absent, has no `origin/main`, or isn't a git
  // repo at all — a missing divergence reading is reported, not guessed.
  readonly divergence: RevListDivergence | null;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly node: NodeCheck;
  readonly pnpm: BinaryCheck;
  readonly git: BinaryCheck;
  readonly github: GithubCheck;
  readonly ollama: OllamaCheck;
  readonly projectRoot: ProjectRootCheck;
  readonly tier: TierCheck;
  readonly taisce: TaisceCheck;
  readonly warnings: readonly string[];
}

export const defaultDoctorDependencies: DoctorDependencies = {
  execRun: (cmd, args, opts) => run(cmd, args, opts),
  gitVersion: (cwd) => defaultGitVersion(cwd),
  netFetch: (url) => safeFetch(url, { timeoutMs: 3000 }),
  cwd: () => process.cwd(),
  nodeVersion: () => process.version,
  projectRoot: () => getProjectRoot(),
  hasApiKey: () =>
    Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0),
  taisceRoot: () => defaultResolveTaisceRoot(),
  taisceDivergence: (cwd) => defaultRevListLeftRightCount(cwd, "origin/main...HEAD"),
};

function parseNodeVersion(raw: string): NodeCheck {
  const trimmed = raw.startsWith("v") ? raw.slice(1) : raw;
  const major = Number.parseInt(trimmed.split(".")[0] ?? "0", 10);
  return {
    version: trimmed,
    satisfiesMin: Number.isFinite(major) && major >= MIN_NODE_MAJOR,
  };
}

async function checkBinary(
  deps: DoctorDependencies,
  command: string,
  args: readonly string[],
): Promise<BinaryCheck> {
  try {
    const result = await deps.execRun(command, args, { allowFailure: true, timeoutMs: 4000 });
    if (result.exitCode === 0) {
      const version = result.stdout.trim().split("\n")[0]?.trim();
      return version ? { available: true, version } : { available: true };
    }
    return { available: false };
  } catch (error) {
    if (error instanceof ExecCommandNotAllowedError) {
      return { available: false };
    }
    return { available: false };
  }
}

// Git is the only binary check that does NOT route through checkBinary; it
// goes through src/lib/git.ts:gitVersion() so the M2 git-call import
// boundary holds (only src/lib/git.ts may invoke git as a subprocess).
async function checkGit(deps: DoctorDependencies): Promise<BinaryCheck> {
  try {
    const version = await deps.gitVersion(deps.cwd());
    if (version === null) return { available: false };
    return { available: true, version: version.split("\n")[0]?.trim() ?? version };
  } catch {
    return { available: false };
  }
}

const GH_ACCOUNT_RE = /Logged in to github\.com account (\S+)/;
const GH_SCOPES_RE = /Token scopes: (.+)/;

function parseGhAuthStatus(stderr: string, stdout: string): GithubCheck {
  const combined = `${stdout}\n${stderr}`;
  const accountMatch = combined.match(GH_ACCOUNT_RE);
  const scopesMatch = combined.match(GH_SCOPES_RE);
  if (!accountMatch) {
    return { authed: false };
  }
  const account = accountMatch[1];
  const scopesRaw = scopesMatch?.[1];
  const scopes = scopesRaw
    ? scopesRaw
        .split(",")
        .map((s) => s.trim().replace(/^'(.*)'$/, "$1"))
        .filter(Boolean)
    : undefined;
  const result: GithubCheck = scopes
    ? { authed: true, account: account ?? "unknown", scopes }
    : { authed: true, account: account ?? "unknown" };
  return result;
}

async function checkGithub(deps: DoctorDependencies): Promise<GithubCheck> {
  try {
    const result = await deps.execRun("gh", ["auth", "status"], {
      allowFailure: true,
      timeoutMs: 5000,
    });
    if (result.exitCode !== 0) {
      return { authed: false };
    }
    return parseGhAuthStatus(result.stderr, result.stdout);
  } catch (error) {
    if (error instanceof ExecCommandNotAllowedError) {
      return { authed: false };
    }
    if (error instanceof ExecFailedError) {
      return { authed: false };
    }
    return { authed: false };
  }
}

function parseOllamaTagsBody(body: string): OllamaModelInfo[] {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return [];
    const models = (parsed as { models?: unknown }).models;
    if (!Array.isArray(models)) return [];
    return models
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
      .map((m) => {
        const name = typeof m.name === "string" ? m.name : "";
        const sizeRaw = typeof m.size === "number" ? m.size : undefined;
        const info: OllamaModelInfo = sizeRaw !== undefined ? { name, size: sizeRaw } : { name };
        return info;
      })
      .filter((m) => m.name.length > 0);
  } catch {
    return [];
  }
}

async function checkOllama(deps: DoctorDependencies): Promise<OllamaCheck> {
  try {
    const result = await deps.netFetch(OLLAMA_TAGS_URL);
    if (!result.ok) {
      return { reachable: false, models: [], error: `HTTP ${result.status}` };
    }
    return { reachable: true, models: parseOllamaTagsBody(result.body) };
  } catch (error) {
    if (error instanceof NetworkBoundaryError) {
      return { reachable: false, models: [], error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { reachable: false, models: [], error: message };
  }
}

function checkTier(deps: DoctorDependencies, ollama: OllamaCheck): TierCheck {
  const apiKeyPresent = (deps.hasApiKey ?? defaultDoctorDependencies.hasApiKey)?.() ?? false;
  const localReady = ollama.reachable && ollama.models.length > 0;
  return {
    active: apiKeyPresent ? "api-key" : "subscription-or-credits",
    apiKeyPresent,
    localReady,
  };
}

async function checkTaisce(deps: DoctorDependencies): Promise<TaisceCheck> {
  const root = (deps.taisceRoot ?? defaultDoctorDependencies.taisceRoot)?.() ?? "";
  const present = existsSync(root);
  if (!present) {
    return { root, present: false, divergence: null };
  }
  const divergence = await (deps.taisceDivergence ?? defaultDoctorDependencies.taisceDivergence)?.(
    root,
  );
  return { root, present: true, divergence: divergence ?? null };
}

function checkProjectRoot(deps: DoctorDependencies): ProjectRootCheck {
  const expected = deps.projectRoot();
  const actual = deps.cwd();
  return {
    expected,
    actual,
    matches: actual === expected,
  };
}

function buildWarnings(report: Omit<DoctorReport, "ok" | "warnings">): string[] {
  const warnings: string[] = [];
  if (!report.node.satisfiesMin) {
    warnings.push(
      `Node ${report.node.version} is below the required ${MIN_NODE_MAJOR}; upgrade Node.`,
    );
  }
  if (!report.pnpm.available) {
    warnings.push("pnpm is not available; install pnpm to run the tooling scripts.");
  }
  if (!report.git.available) {
    warnings.push("git is not available; install git to manage the repo.");
  }
  if (!report.github.authed) {
    warnings.push("GitHub CLI is not authenticated; run `gh auth login -h github.com`.");
  }
  if (!report.ollama.reachable) {
    warnings.push(
      `Local Ollama daemon is not reachable at 127.0.0.1:11434${report.ollama.error ? ` (${report.ollama.error})` : ""}; start the daemon to use \`moss ask\`.`,
    );
  } else if (report.ollama.models.length === 0) {
    warnings.push(
      "Ollama daemon is reachable but no models are installed; pull at least one (for example `ollama pull llama3.2:3b`).",
    );
  }
  // A working directory outside the moss home is NOT a problem: the project
  // root is resolved from the module's own location, so the registry, output
  // and usage log always resolve to the moss checkout regardless of cwd. When
  // running a skill, the cwd is meant to be the target repo. So a mismatch is
  // reported informationally (see formatReportHuman) — never as a warning.
  return warnings;
}

export async function gatherDiagnostics(deps: DoctorDependencies): Promise<DoctorReport> {
  const node = parseNodeVersion(deps.nodeVersion());
  const [pnpm, git, github, ollama] = await Promise.all([
    checkBinary(deps, "pnpm", ["--version"]),
    checkGit(deps),
    checkGithub(deps),
    checkOllama(deps),
  ]);
  const projectRoot = checkProjectRoot(deps);
  const tier = checkTier(deps, ollama);
  const taisce = await checkTaisce(deps);
  const partial = { node, pnpm, git, github, ollama, projectRoot, tier, taisce } as const;
  const warnings = buildWarnings(partial);
  const ok =
    node.satisfiesMin &&
    pnpm.available &&
    git.available &&
    github.authed &&
    ollama.reachable &&
    ollama.models.length > 0;
  return { ...partial, ok, warnings };
}

function formatReportHuman(report: DoctorReport): string {
  const lines: string[] = [];
  const tick = (ok: boolean) => (ok ? "ok" : "not ok");
  lines.push(`moss doctor — ${report.ok ? "READY" : "ISSUES FOUND"}`);
  lines.push("");
  lines.push(`- node: ${tick(report.node.satisfiesMin)} (${report.node.version})`);
  lines.push(
    `- pnpm: ${tick(report.pnpm.available)}${report.pnpm.version ? ` (${report.pnpm.version})` : ""}`,
  );
  lines.push(
    `- git: ${tick(report.git.available)}${report.git.version ? ` (${report.git.version})` : ""}`,
  );
  lines.push(
    `- github: ${tick(report.github.authed)}${report.github.account ? ` (${report.github.account})` : ""}`,
  );
  lines.push(
    `- ollama daemon: ${tick(report.ollama.reachable)}${report.ollama.error ? ` (${report.ollama.error})` : ""}`,
  );
  lines.push(
    `- ollama models: ${report.ollama.models.length === 0 ? "none" : report.ollama.models.map((m) => m.name).join(", ")}`,
  );
  lines.push(
    `- moss home: ${report.projectRoot.expected}${
      report.projectRoot.matches ? "" : ` (running from ${report.projectRoot.actual})`
    }`,
  );
  lines.push("");
  lines.push(
    `- fallback tier: ${report.tier.active} (api key ${report.tier.apiKeyPresent ? "present" : "absent"}; local Tier 3 ${report.tier.localReady ? "ready" : "not ready"})`,
  );
  if (report.taisce.present) {
    const div = report.taisce.divergence;
    const divText =
      div === null
        ? "divergence unknown (no origin/main, or not a git repo)"
        : `behind ${div.left}, ahead ${div.right} (origin/main...HEAD)`;
    lines.push(`- taisce: ${report.taisce.root} — ${divText}`);
  } else {
    lines.push(`- taisce: not found at ${report.taisce.root}`);
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join("\n");
}

export interface DoctorCommandOptions {
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
}

export async function runDoctorCommand(
  options: DoctorCommandOptions,
  deps: DoctorDependencies = defaultDoctorDependencies,
): Promise<DoctorReport> {
  const report = await gatherDiagnostics(deps);
  options.out(options.emitJson ? JSON.stringify(report, null, 2) : formatReportHuman(report));
  return report;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose Node, pnpm, git, gh, Ollama and models (--json for scripts)")
    .option("--json", "Emit JSON instead of human-readable text")
    .action(async (commandOpts: { json?: boolean }) => {
      const globalOpts = program.opts<{ json?: boolean }>();
      const emitJson = Boolean(commandOpts.json) || Boolean(globalOpts.json);
      await runDoctorCommand({
        emitJson,
        out: (line) => process.stdout.write(`${line}\n`),
      });
    });
}
