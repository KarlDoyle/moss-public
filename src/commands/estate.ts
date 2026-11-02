// `moss status | local | api | sub | credits` — the fallback-ladder switches that used to be
// mac-setup's `estate-mode` shell function (Taisce System/fallback-ladder.md). estate-mode is
// now a one-line alias to moss.
//
// Two of them cannot be done by a child process, and moss does not pretend otherwise:
// `api` and `sub` change ANTHROPIC_API_KEY in the operator's own shell, which only a shell
// function can do. The mac-setup `moss` function handles those two itself — the API key goes
// from the macOS Keychain into that shell and never passes through moss, a file, or stdout —
// and forwards everything else here. Called directly, these two print that and exit 1.
import type { Command } from "commander";
import { runDetached } from "../lib/exec.ts";
import { isReasoningModel, resolveCoderModel, resolveNumCtx } from "../lib/ollama.ts";
import {
  type DoctorDependencies,
  type DoctorReport,
  defaultDoctorDependencies,
  gatherDiagnostics,
} from "./doctor.ts";
import {
  defaultLaneStatusDeps,
  formatLaneStatus,
  gatherLaneStatus,
  type LaneStatusDeps,
} from "./lane-status.ts";

// Same wording as estate-mode's `_estate_mode_tier`, which the shell banner still uses, so
// the banner and `moss status` can never disagree. Tier 1 (usage credits) is not visible
// from a shell, so Tier 0 and 1 are reported together.
export function tierLabel(apiKeyPresent: boolean): string {
  return apiKeyPresent ? "Tier 2 — API key" : "Tier 0/1 — subscription or usage credits";
}

// The rows estate-mode status printed, in the same order and wording, from the same
// `moss doctor` data estate-mode used to shell out for.
// The tier you are actually on, from which lanes answered their probe — not from whether an
// API key happens to be set (which said "subscription" even after the subscription ended).
export function tierFromLanes(lanes: ReadonlyArray<{ id: string; status: string }>): string {
  const up = (id: string) => lanes.some((l) => l.id === id && l.status === "available");
  if (up("claude-code")) return "Tier 0 — subscription (claude-code lane up)";
  if (up("anthropic-api")) return "Tier 2 — API key (metered, capped per day)";
  if (up("ollama")) return "Tier 3 — local (Ollama only)";
  return "Tier 4 — manual (no lane up)";
}

export function formatStatus(
  report: DoctorReport,
  lanes?: ReadonlyArray<{ id: string; status: string }>,
): string {
  const models = report.ollama.models.map((m) => m.name);
  const div = report.taisce.divergence;
  return [
    "moss status",
    `  active tier:     ${lanes !== undefined ? tierFromLanes(lanes) : tierLabel(report.tier.apiKeyPresent)}`,
    `  api key set:     ${report.tier.apiKeyPresent ? "yes" : "no"}`,
    `  ollama:          ${report.ollama.reachable ? "running" : "not running"}`,
    `  models pulled:   ${models.length > 0 ? models.join(", ") : "none"}`,
    `  local (Tier 3):  ${report.tier.localReady ? "ready" : "not ready"}`,
    `  taisce root:     ${report.taisce.root}`,
    `  taisce git:      ${
      div === null
        ? "unknown (no checkout, or no origin/main)"
        : `behind ${div.left}, ahead ${div.right} (origin/main...HEAD)`
    }`,
  ].join("\n");
}

export const CREDITS_TEXT = [
  "Tier 1 (usage credits) is a claude.ai account setting, not a local switch:",
  "  claude.ai -> Settings -> Usage -> enable usage credits, set a monthly cap.",
  "  Once enabled, Claude Code keeps working past the plan limit, billed at API rates.",
  "  Nothing to run locally; re-run 'moss status' to see the API-key tier only.",
].join("\n");

export function shellOnlyMessage(sub: "api" | "sub"): string {
  const what =
    sub === "api"
      ? "exports ANTHROPIC_API_KEY from the macOS Keychain into your shell"
      : "unsets ANTHROPIC_API_KEY in your shell";
  return [
    `moss ${sub} ${what}, which a child process cannot do.`,
    "It is handled by the `moss` shell function in mac-setup (dotfiles/zsh/.zshrc); this binary",
    "was called directly, so that function is not loaded in this shell. Open a new terminal, or",
    "`source ~/.zshrc`, then run it again. The key never passes through moss.",
  ].join("\n");
}

export interface LocalDeps {
  readonly report: () => Promise<DoctorReport>;
  readonly startOllama: (numCtx: number) => void;
  readonly aiderInstalled: () => Promise<boolean>;
  readonly wait: (ms: number) => Promise<void>;
  readonly env: NodeJS.ProcessEnv;
}

export const defaultLocalDeps: LocalDeps = {
  report: () => gatherDiagnostics(defaultDoctorDependencies),
  // OLLAMA_CONTEXT_LENGTH sets the daemon's window. moss sends num_ctx on every call anyway
  // (src/lib/ollama.ts); this covers Aider and anything else talking to the same daemon.
  startOllama: (numCtx) =>
    runDetached("ollama", ["serve"], { env: { OLLAMA_CONTEXT_LENGTH: String(numCtx) } }),
  aiderInstalled: async () => {
    const { run } = await import("../lib/exec.ts");
    try {
      const result = await run("aider", ["--version"], { allowFailure: true, timeoutMs: 30_000 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  env: process.env,
};

// Tier 3: make sure Ollama is up, then say whether the session can chat and edit. Never
// installs a package or pulls a model — it names the command and stops.
export async function runLocal(
  out: (line: string) => void,
  err: (line: string) => void,
  deps: LocalDeps = defaultLocalDeps,
): Promise<boolean> {
  const numCtx =
    Number.parseInt(deps.env.OLLAMA_CONTEXT_LENGTH ?? "", 10) || resolveNumCtx(deps.env);
  let report = await deps.report();
  if (report.ollama.reachable) {
    out(
      `ollama already running. A NEW daemon would get OLLAMA_CONTEXT_LENGTH=${numCtx}; moss sends num_ctx on every call regardless.`,
    );
  } else {
    out(
      `starting ollama with OLLAMA_CONTEXT_LENGTH=${numCtx} (the 2026-07-06 truncation gotcha: set explicitly, the default silently truncates)...`,
    );
    try {
      deps.startOllama(numCtx);
    } catch (error) {
      err(
        `moss local: could not start ollama (${error instanceof Error ? error.message : String(error)}). Not installing it — run 'brew install ollama' yourself first.`,
      );
      return false;
    }
    for (let i = 0; i < 10 && !report.ollama.reachable; i++) {
      await deps.wait(500);
      report = await deps.report();
    }
    if (!report.ollama.reachable) {
      err("moss local: ollama did not come up within 5s. Try 'ollama serve' in another terminal.");
      return false;
    }
  }

  const models = report.ollama.models.map((m) => m.name);
  const chat = models.filter((m) => !isReasoningModel(m));
  const coder = resolveCoderModel(deps.env);
  let ok = true;
  if (chat.length === 0) {
    err(
      "moss local: no non-reasoning model is pulled. Not pulling one — run e.g. 'ollama pull llama3.1' yourself (~5GB, needs your go-ahead).",
    );
    ok = false;
  } else {
    out(`chat model:  ${chat.join(", ")} (reasoning models are never used for chat)`);
  }
  if (models.includes(coder) || models.includes(`${coder}:latest`)) {
    out(`coder model: ${coder} — /edit is ready`);
  } else {
    err(
      `moss local: coder model ${coder} is not pulled; /edit needs it. Run 'ollama pull ${coder}' yourself.`,
    );
    ok = false;
  }
  if (await deps.aiderInstalled()) {
    out("aider:       installed — /edit runs it dry-run first and applies only on 'go'");
  } else {
    err("moss local: aider is not installed; /edit needs it. Run 'brew install aider' yourself.");
    ok = false;
  }
  out("");
  out("Next: moss   (the session — brief, skills as /commands, /edit)");
  return ok;
}

export function registerEstate(
  program: Command,
  doctorDeps?: DoctorDependencies,
  laneDeps: LaneStatusDeps = defaultLaneStatusDeps,
): void {
  program
    .command("status")
    .description("Tier, lanes up/down, models, today’s spend, last bench, Taisce git")
    .action(async () => {
      const [report, lanes] = await Promise.all([
        gatherDiagnostics(doctorDeps ?? defaultDoctorDependencies),
        gatherLaneStatus(laneDeps),
      ]);
      process.stdout.write(`${formatStatus(report, lanes.lanes)}\n${formatLaneStatus(lanes)}\n`);
    });

  program
    .command("local")
    .description(
      "Tier 3: start Ollama with its context window set; check the chat/coder models and Aider",
    )
    .action(async () => {
      const ok = await runLocal(
        (line) => process.stdout.write(`${line}\n`),
        (line) => process.stderr.write(`${line}\n`),
      );
      if (!ok) process.exitCode = 1;
    });

  program
    .command("credits")
    .description("Tier 1: the steps to enable usage credits (a claude.ai setting)")
    .action(() => {
      process.stdout.write(`${CREDITS_TEXT}\n`);
    });

  for (const sub of ["api", "sub"] as const) {
    program
      .command(sub)
      .description(
        sub === "api"
          ? "Tier 2: export ANTHROPIC_API_KEY from the Keychain (shell function only)"
          : "Tier 0: unset ANTHROPIC_API_KEY (shell function only)",
      )
      .action(() => {
        process.stderr.write(`${shellOnlyMessage(sub)}\n`);
        process.exitCode = 1;
      });
  }
}
