// Aider — the edit engine under `/edit`. moss plans, Aider edits, the operator approves.
//
// Aider writes files by default, and `--no-auto-commits` does NOT stop it: on 2026-09-18 one
// read-only-looking drill prompt cut a 520-line Taisce file to 5 (Taisce
// System/CONTINUITY.md, drill results). So the only shapes built here are:
//
//   dry run  — `--dry-run`: prints the would-be diff, touches nothing.
//   apply    — `--no-dry-run`: only after the operator typed "go" at the session prompt.
//
// The configured flags disable known automatic actions such as shell suggestions,
// URL detection, auto-lint, .gitignore edits, and commits. They do not sandbox the
// child process or prove it reads/writes only the selected files. Moss canonicalizes
// those paths immediately before handoff; Aider's complete behavior remains unverified.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { run } from "./exec.ts";
import { OLLAMA_BASE_URL } from "./ollama.ts";

export class AiderFileScopeError extends Error {
  constructor(file: string, reason: string) {
    super(`Aider file '${file}' ${reason}.`);
    this.name = "AiderFileScopeError";
  }
}

// A local 7B model through Aider: ~11s for a one-file edit measured 2026-09-18, but a big
// file at ~20 tok/s takes minutes. Ten minutes, and nothing is billed while it waits.
export const AIDER_TIMEOUT_MS = 600_000;

export interface AiderRunOptions {
  readonly message: string;
  readonly model: string; // bare Ollama name, e.g. qwen2.5-coder:7b
  // Architect/editor split (Aider --architect): `model` plans the change, `editorModel`
  // writes the edit. Absent → one model does both, as before the router.
  readonly editorModel?: string;
  readonly files: readonly string[]; // repo-relative
  readonly dryRun: boolean;
}

export function buildAiderArgs(options: AiderRunOptions): string[] {
  for (const file of options.files) {
    if (file.split(/[\\/]/).some((part) => part.startsWith("-"))) {
      throw new AiderFileScopeError(file, "looks like an option and cannot be passed safely");
    }
  }
  return [
    "--model",
    `ollama_chat/${options.model}`,
    ...(options.editorModel !== undefined
      ? ["--architect", "--editor-model", `ollama_chat/${options.editorModel}`]
      : []),
    options.dryRun ? "--dry-run" : "--no-dry-run",
    "--yes-always",
    "--no-auto-commits",
    "--no-dirty-commits",
    "--no-auto-lint",
    "--no-suggest-shell-commands",
    "--no-detect-urls",
    "--no-gitignore",
    "--no-check-update",
    "--no-analytics",
    "--no-show-model-warnings",
    "--no-pretty",
    "--no-stream",
    "--map-tokens",
    "0",
    // History files would hold whatever was routed through the edit; keep none.
    "--chat-history-file",
    "/dev/null",
    "--input-history-file",
    "/dev/null",
    "--message",
    options.message,
    ...options.files,
  ];
}

export interface AiderResult {
  readonly exitCode: number;
  readonly output: string;
}

export type AiderRunner = (args: readonly string[], cwd: string) => Promise<AiderResult>;

function isUnderRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Resolve every file immediately before invoking Aider and pass only canonical
// repo-relative regular-file paths. Aider is a child process, not a sandbox.
export function canonicalAiderFiles(repo: string, files: readonly string[]): string[] {
  const root = realpathSync(repo);
  return files.map((file) => {
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
      throw new AiderFileScopeError(file, "is not a canonical relative path");
    }
    let canonical: string;
    try {
      canonical = realpathSync(resolve(root, file));
    } catch {
      throw new AiderFileScopeError(file, "does not resolve to an existing file");
    }
    if (!isUnderRoot(canonical, root)) {
      throw new AiderFileScopeError(file, "resolves outside the target repository");
    }
    try {
      if (!statSync(canonical).isFile()) {
        throw new AiderFileScopeError(file, "does not resolve to a regular file");
      }
    } catch (error) {
      if (error instanceof AiderFileScopeError) throw error;
      throw new AiderFileScopeError(file, "cannot be inspected safely");
    }
    const canonicalRelative = relative(root, canonical).split(sep).join("/");
    if (canonicalRelative.split("/").some((part) => part.startsWith("-"))) {
      throw new AiderFileScopeError(file, "resolves to an option-like filename");
    }
    return canonicalRelative;
  });
}

export async function runAiderConfined(
  repo: string,
  options: AiderRunOptions,
  runner: AiderRunner = defaultAiderRunner,
): Promise<AiderResult> {
  const root = realpathSync(repo);
  const files = canonicalAiderFiles(root, options.files);
  const args = buildAiderArgs({ ...options, files });
  return runner(args, root);
}

export const defaultAiderRunner: AiderRunner = async (args, cwd) => {
  const privateHome = mkdtempSync(join(tmpdir(), "moss-aider-home-"));
  const configHome = join(privateHome, "config");
  const cacheHome = join(privateHome, "cache");
  const dataHome = join(privateHome, "data");
  const inherited = Object.keys(process.env);
  const retained = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "OLLAMA_API_BASE",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
  ]);
  try {
    mkdirSync(configHome);
    mkdirSync(cacheHome);
    mkdirSync(dataHome);
    const result = await run("aider", args, {
      cwd,
      timeoutMs: AIDER_TIMEOUT_MS,
      allowFailure: true,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: privateHome,
        TMPDIR: privateHome,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_DATA_HOME: dataHome,
        OLLAMA_API_BASE: OLLAMA_BASE_URL,
        ...(process.env.LANG !== undefined ? { LANG: process.env.LANG } : {}),
        ...(process.env.LC_ALL !== undefined ? { LC_ALL: process.env.LC_ALL } : {}),
        ...(process.env.LC_CTYPE !== undefined ? { LC_CTYPE: process.env.LC_CTYPE } : {}),
        ...(process.env.TERM !== undefined ? { TERM: process.env.TERM } : {}),
      },
      unsetEnv: inherited.filter((key) => !retained.has(key)),
    });
    const output = [result.stdout, result.stderr].filter((s) => s.trim().length > 0).join("\n");
    return { exitCode: result.exitCode, output };
  } finally {
    rmSync(privateHome, { recursive: true, force: true });
  }
};

// Aider's banner and token lines are noise next to the diff; the "Did not apply edit"
// line is kept because it is the proof nothing was written.
const NOISE = [
  /^Warning: Input is not a terminal/,
  /^Aider v\d/,
  /^Model: /,
  /^Git repo: /,
  /^Repo-map: /,
  /^Added .* to the chat\.?$/,
  /^Tokens: /,
  /^Cost: /,
  /^https:\/\/aider\.chat/,
];

export function tidyAiderOutput(output: string): string {
  return output
    .split("\n")
    .filter((line) => !NOISE.some((rx) => rx.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Paths the planner or the operator named that are really tracked in this repo. Matching is
// against `git ls-files`, so a model cannot invent a file into Aider's scope.
export function pickFiles(text: string, tracked: readonly string[], max = 6): string[] {
  const picked: string[] = [];
  // Longest first, so `src/lib/paths.ts` wins over a bare `paths.ts` elsewhere.
  const byLength = [...tracked].sort((a, b) => b.length - a.length);
  for (const file of byLength) {
    if (picked.length >= max) break;
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[\\s\`'"(/])${escaped}($|[\\s\`'",.:;)])`).test(text)) {
      if (!picked.some((p) => p.endsWith(`/${file}`))) picked.push(file);
    }
  }
  return picked;
}

// The prompt the chat model plans with. It must name files from the list and say what to
// change in one paragraph — that paragraph is what Aider receives verbatim.
export function buildEditPlanPrompt(ask: string, tracked: readonly string[]): string {
  return [
    "You are planning a code or text edit that another tool (Aider) will make.",
    "Reply in exactly this shape and nothing else:",
    "FILES: <comma-separated paths, copied exactly from the list below, at most 4>",
    "PLAN: <one paragraph: what to change in each file, concrete enough to do without asking>",
    "",
    "Never name a file that is not in the list. Never propose deleting a file.",
    "",
    "FILES IN THIS REPO:",
    tracked.join("\n"),
    "",
    `REQUEST: ${ask}`,
  ].join("\n");
}

export function parseEditPlan(text: string): { files: string; plan: string } {
  const files = /FILES:\s*(.*)/i.exec(text)?.[1]?.trim() ?? "";
  const planMatch = /PLAN:\s*([\s\S]*)/i.exec(text);
  const plan = (planMatch?.[1] ?? text).trim();
  return { files, plan };
}
