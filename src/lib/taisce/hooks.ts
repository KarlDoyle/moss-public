// Runs Taisce's own Claude Code hooks for the moss session, by path. The scripts are the
// source of truth; moss never copies their logic (the privacy-rules prepend and guard-reads
// are the two exceptions, and they already live in skills.ts and paths.ts):
//
//   scripts/hooks/session-start.sh  → the opening brief (Pulse due-list + Scoreboard)
//   scripts/hooks/front-door.sh     → up to six routing lines for each prompt
//
// Both hooks are built never to fail a session, and this wrapper keeps that promise: a
// missing script, a crash or a timeout returns null, never throws.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../exec.ts";
import { resolveTaisceRoot } from "../paths.ts";

export const SESSION_START_REL = "scripts/hooks/session-start.sh";
export const FRONT_DOOR_REL = "scripts/hooks/front-door.sh";

// session-start runs two scripts in parallel, each built for <2s; front-door is regex only
// and Claude Code gives it 5s. Same budgets here.
const SESSION_START_TIMEOUT_MS = 15_000;
const FRONT_DOOR_TIMEOUT_MS = 5_000;

export type HookRunner = (
  script: string,
  input: string,
  options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<{ readonly exitCode: number; readonly stdout: string }>;

// `bash <absolute script path>` — never `bash -c`. CLAUDE_PROJECT_DIR is what the hooks use
// to find the repo when Claude Code runs them; moss sets it the same way.
export const defaultHookRunner: HookRunner = async (script, input, options) => {
  const result = await run("bash", [script], {
    cwd: options.cwd,
    input,
    timeoutMs: options.timeoutMs,
    allowFailure: true,
    env: { CLAUDE_PROJECT_DIR: options.cwd },
  });
  return { exitCode: result.exitCode, stdout: result.stdout };
};

// session-start.sh prints `{"hookSpecificOutput": {"additionalContext": "..."}}`, or the
// plain text when python3 is missing. Either shape is accepted.
export function parseSessionStartOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput?: { additionalContext?: unknown };
    };
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    if (typeof ctx === "string" && ctx.trim().length > 0) return ctx.trim();
    return null;
  } catch {
    return trimmed;
  }
}

async function runHook(
  rel: string,
  input: string,
  timeoutMs: number,
  root: string,
  runner: HookRunner,
): Promise<string | null> {
  const script = join(root, rel);
  if (!existsSync(script)) return null;
  try {
    const result = await runner(script, input, { cwd: root, timeoutMs });
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

export async function runSessionStartHook(
  root: string = resolveTaisceRoot(),
  runner: HookRunner = defaultHookRunner,
): Promise<string | null> {
  const stdout = await runHook(
    SESSION_START_REL,
    JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
    SESSION_START_TIMEOUT_MS,
    root,
    runner,
  );
  return stdout === null ? null : parseSessionStartOutput(stdout);
}

// Returns the routing lines for this prompt, or null when nothing matched (silence is the
// hook's correct output for most prompts).
export async function runFrontDoorHook(
  prompt: string,
  root: string = resolveTaisceRoot(),
  runner: HookRunner = defaultHookRunner,
): Promise<string | null> {
  const stdout = await runHook(
    FRONT_DOOR_REL,
    JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }),
    FRONT_DOOR_TIMEOUT_MS,
    root,
    runner,
  );
  const trimmed = stdout?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
