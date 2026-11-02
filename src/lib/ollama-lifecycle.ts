// Ollama on demand: started when a request actually reaches the local lane, turned off when
// the session (or a one-off command that started it) is done — so nothing sits in memory while
// you do other things. "Off" = every loaded model unloaded, then Ollama stopped (SIGTERM).
//
// It is never turned off from under someone else: if another moss process or Aider is
// running, it is left alone and the reason is said. `moss off --force` overrides that.
import { existsSync } from "node:fs";
import { run, runDetached } from "./exec.ts";
import { safeFetch } from "./net.ts";
import { OLLAMA_BASE_URL } from "./ollama.ts";

export const OLLAMA_APP = "/Applications/Ollama.app";

// What this process did with Ollama — read at exit to decide whether to turn it off.
export const ollamaUse = { used: false, started: false };

export function resetOllamaUse(): void {
  ollamaUse.used = false;
  ollamaUse.started = false;
}

export interface LifecycleDeps {
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string }>;
  readonly startServe: () => void;
  readonly reachable: () => Promise<boolean>;
  readonly appInstalled: () => boolean;
  readonly wait: (ms: number) => Promise<void>;
  readonly pid: number;
}

export const defaultLifecycleDeps: LifecycleDeps = {
  run: async (command, args) => {
    try {
      const r = await run(command, args, { allowFailure: true, timeoutMs: 30_000 });
      return { exitCode: r.exitCode, stdout: r.stdout };
    } catch {
      return { exitCode: 127, stdout: "" };
    }
  },
  startServe: () => runDetached("ollama", ["serve"]),
  reachable: async () => {
    try {
      return (await safeFetch(`${OLLAMA_BASE_URL}/api/tags`, { timeoutMs: 1_500 })).ok;
    } catch {
      return false;
    }
  },
  appInstalled: () => existsSync(OLLAMA_APP),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pid: process.pid,
};

// The test suite sets this (vitest.config.ts): the REAL start/stop path must never launch or
// kill Ollama from a test — found 2026-09-18 when a test run started the app. Injected deps
// (the unit tests) are unaffected.
function lifecycleDisabled(deps: LifecycleDeps): boolean {
  return deps === defaultLifecycleDeps && process.env.MOSS_NO_OLLAMA_LIFECYCLE === "1";
}

// Make sure the daemon is up; start it (the app if installed, else `ollama serve`) if not.
export async function ensureOllama(deps: LifecycleDeps = defaultLifecycleDeps): Promise<boolean> {
  if (await deps.reachable()) return true;
  if (lifecycleDisabled(deps)) return false;
  if (deps.appInstalled()) await deps.run("open", ["-a", "Ollama"]);
  else deps.startServe();
  for (let i = 0; i < 30; i += 1) {
    await deps.wait(500);
    if (await deps.reachable()) {
      ollamaUse.started = true;
      return true;
    }
  }
  return false;
}

export function parseOllamaPs(text: string): string[] {
  return text
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter((n) => n.length > 0);
}

// Other processes that may be using Ollama right now: another moss, or Aider.
export async function otherOllamaUsers(
  deps: LifecycleDeps = defaultLifecycleDeps,
): Promise<string[]> {
  const r = await deps.run("pgrep", ["-fl", "moss.*src/cli\\.ts|/aider( |$)"]);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(`${deps.pid} `))
    .map((l) => (/\/aider/.test(l) ? "aider" : "another moss"));
}

export interface OffResult {
  readonly off: boolean;
  readonly message: string;
}

export async function turnOffOllama(
  opts: { readonly force?: boolean } = {},
  deps: LifecycleDeps = defaultLifecycleDeps,
): Promise<OffResult> {
  if (lifecycleDisabled(deps))
    return { off: false, message: "Ollama lifecycle disabled (MOSS_NO_OLLAMA_LIFECYCLE=1)." };
  if (!(await deps.reachable())) return { off: true, message: "Ollama is already off." };
  const others = opts.force === true ? [] : await otherOllamaUsers(deps);
  if (others.length > 0) {
    return {
      off: false,
      message: `Ollama left running — in use by ${[...new Set(others)].join(" and ")} (moss off --force to stop it anyway).`,
    };
  }
  const models = parseOllamaPs((await deps.run("ollama", ["ps"])).stdout);
  for (const m of models) await deps.run("ollama", ["stop", m]);
  // The app refuses an AppleScript quit ("User cancelled", measured 2026-09-18); SIGTERM ends
  // it and its `ollama serve` child cleanly in about a second.
  await deps.run("pkill", ["-TERM", "-x", deps.appInstalled() ? "Ollama" : "ollama"]);
  for (let i = 0; i < 20; i += 1) {
    if (!(await deps.reachable())) {
      return {
        off: true,
        message: `Ollama turned off (${models.length > 0 ? `unloaded ${models.join(", ")}; ` : ""}stopped).`,
      };
    }
    await deps.wait(250);
  }
  return {
    off: false,
    message: "asked Ollama to stop, but it is still answering — quit it from the menu bar.",
  };
}
