// Aider — the edit engine under `/edit`. moss plans, Aider edits, the operator approves.
//
// Aider writes files by default, and `--no-auto-commits` does NOT stop it: on 2026-09-18 one
// read-only-looking drill prompt cut a 520-line Taisce file to 5 (Taisce
// System/CONTINUITY.md, drill results). So the only shapes built here are:
//
//   dry run  — `--dry-run`: prints the would-be diff, touches nothing.
//   apply    — `--no-dry-run`: only after the operator typed "go" at the session prompt.
//
// Both runs are non-interactive (`--yes-always`), so every Aider feature that would act on a
// "yes" is switched off explicitly: shell-command suggestions (it would run them), URL
// detection (it would fetch them), auto-lint (a second, unreviewed edit round), .gitignore
// edits, and commits of any kind. The repo map is off too (`--map-tokens 0`): Aider sees
// only the files the plan names, which is also what makes the guard-reads check below
// meaningful — Aider cannot wander into a gated file on its own.
import { run } from "./exec.ts";
import { OLLAMA_BASE_URL } from "./ollama.ts";

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

export const defaultAiderRunner: AiderRunner = async (args, cwd) => {
  const result = await run("aider", args, {
    cwd,
    timeoutMs: AIDER_TIMEOUT_MS,
    allowFailure: true,
    env: { OLLAMA_API_BASE: OLLAMA_BASE_URL },
  });
  const output = [result.stdout, result.stderr].filter((s) => s.trim().length > 0).join("\n");
  return { exitCode: result.exitCode, output };
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
