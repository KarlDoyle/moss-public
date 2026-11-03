// Deprecated Aider compatibility helpers. Production execution is disabled.
// Pure planning/parsing helpers are also used by hosted patch editing.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class AiderFileScopeError extends Error {
  constructor(file: string, reason: string) {
    super(`Aider file '${file}' ${reason}.`);
    this.name = "AiderFileScopeError";
  }
}

/** @deprecated Historical adapter constant; production Aider execution is disabled. */
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

/** @deprecated Aider execution is disabled; retained only to reject legacy callers clearly. */
export const AIDER_DEPRECATION =
  "Aider support is deprecated and disabled. Local /edit is unavailable. Local chat and read-only reviews remain available. To use experimental hosted patch edits, explicitly select /provider claude-code or /provider anthropic-api; hosted calls send context off-device and API eligibility checks still apply.";

export const defaultAiderRunner: AiderRunner = async () => {
  throw new Error(AIDER_DEPRECATION);
};

// Aider's banner and token lines are noise next to the diff; the "Did not apply edit"
// line is retained as historical output, not proof of filesystem integrity.
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
// change in one paragraph for the subsequent hosted text-patch proposal.
export function buildEditPlanPrompt(ask: string, tracked: readonly string[]): string {
  return [
    "You are planning a code or text edit that will be proposed as a reviewed text patch.",
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
