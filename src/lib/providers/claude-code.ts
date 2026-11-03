// The claude-code lane — Claude through the subscription, via `claude -p`.
//
// Every call is isolated: no tools, no hooks or settings, no MCP servers, no slash commands,
// no session saved, moss's own system prompt instead of Claude Code's, run from the temp dir
// so no CLAUDE.md is discovered. The model sees exactly what moss sends and can do nothing
// but answer. Measured 2026-09-18: a one-word reply costs ~390 input tokens this way, against
// ~25k with Claude Code's defaults.
//
// Availability = `claude` on PATH AND logged in, proven by a 1-token call. The answer is
// cached for 15 minutes (per CLAUDE_CONFIG_DIR) in output/lanes/, so moss does not spend a
// call on every command.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { run } from "../exec.ts";
import { type LaneUsage, recordLaneUsage } from "../lanes/ledger.ts";
import { joinInsideProject } from "../paths.ts";
import { buildClaudeArgs, parseClaudeJson } from "./claude-cli.ts";
import { binaryOnPath, defaultDetectionEnv } from "./detection.ts";

export {
  buildClaudeArgs,
  CLAUDE_ISOLATION_ARGS,
  type ClaudeJson,
  parseClaudeJson,
} from "./claude-cli.ts";

import {
  allCapabilitiesAs,
  type Provider,
  type ProviderGenerateOptions,
  type ProviderGenerateResult,
  type ProviderProbeResult,
  type ProviderStatus,
} from "./types.ts";

const PROBE_MODEL = "haiku";
const PROBE_TTL_MS = 15 * 60_000;
const GENERATE_TIMEOUT_MS = 600_000;

export class ClaudeCodeDispatchError extends Error {
  constructor(message: string) {
    super(`claude-code lane: ${message}`);
    this.name = "ClaudeCodeDispatchError";
  }
}

export interface ClaudeCodeDeps {
  readonly onPath: () => boolean;
  readonly exec: (
    args: readonly string[],
    input: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly readCache: (
    key: string,
  ) => { at: number; status: ProviderStatus; reason: string } | null;
  readonly writeCache: (
    key: string,
    value: { at: number; status: ProviderStatus; reason: string },
  ) => void;
  readonly cacheKey: () => string;
  // The probe is a real (1-token) call on the subscription, so it is logged like any other.
  readonly record?: (entry: Omit<LaneUsage, "by">) => Promise<boolean>;
}

function cacheFile(): string {
  return joinInsideProject("output", "lanes", "claude-code-probe.json");
}

export const defaultClaudeCodeDeps: ClaudeCodeDeps = {
  onPath: () => binaryOnPath("claude", defaultDetectionEnv),
  exec: (args, input, timeoutMs, signal) =>
    run("claude", args, {
      cwd: tmpdir(),
      input,
      timeoutMs,
      allowFailure: true,
      ...(signal !== undefined ? { signal } : {}),
    }),
  readCache: (key) => {
    try {
      const all = JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, never>;
      return all[key] ?? null;
    } catch {
      return null;
    }
  },
  writeCache: (key, value) => {
    try {
      const file = cacheFile();
      const all = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as object) : {};
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ ...all, [key]: value }));
    } catch {
      // a cache that cannot be written only costs another probe
    }
  },
  cacheKey: () => process.env.CLAUDE_CONFIG_DIR ?? "default",
  record: (entry) => recordLaneUsage(entry),
};

async function liveProbe(
  deps: ClaudeCodeDeps,
): Promise<{ status: ProviderStatus; reason: string }> {
  const out = await deps.exec(
    buildClaudeArgs(PROBE_MODEL, "Reply with the single word ok."),
    "ok",
    60_000,
  );
  const parsed = parseClaudeJson(out.stdout);
  if (out.exitCode === 0 && parsed !== null && !parsed.isError && deps.record !== undefined) {
    await deps.record({
      ts: new Date().toISOString(),
      lane: "claude-code",
      model: PROBE_MODEL,
      task: "probe",
      command: "probe",
      ...(parsed.inputTokens !== undefined ? { tokens_in: parsed.inputTokens } : {}),
      ...(parsed.outputTokens !== undefined ? { tokens_out: parsed.outputTokens } : {}),
      cost: "sub",
      ...(parsed.costUsd !== undefined ? { usd_list: parsed.costUsd } : {}),
    });
  }
  if (out.exitCode === 0 && parsed !== null && !parsed.isError) {
    return {
      status: "available",
      reason: "claude is logged in (1-token probe answered); billed to the subscription.",
    };
  }
  const said =
    ((out.exitCode === 0 ? parsed?.result : undefined) || out.stderr || out.stdout)
      .trim()
      .split("\n")[0] ?? "";
  if (/not logged in|\/login|authenticat/i.test(said)) {
    return {
      status: "unauthenticated",
      reason: `claude is on PATH but not logged in (claude says: ${said}).`,
    };
  }
  return {
    status: "unavailable",
    reason: `claude probe failed: ${said || `exit ${out.exitCode}`}.`,
  };
}

export function createClaudeCodeProvider(deps: ClaudeCodeDeps = defaultClaudeCodeDeps): Provider {
  const probe = async (now: () => Date = () => new Date()): Promise<ProviderProbeResult> => {
    const lastProbedAt = now().toISOString();
    let verdict: { status: ProviderStatus; reason: string };
    if (!deps.onPath()) {
      verdict = { status: "not_installed", reason: "claude is not on PATH." };
    } else {
      const key = deps.cacheKey();
      const cached = deps.readCache(key);
      if (cached !== null && now().getTime() - cached.at < PROBE_TTL_MS) {
        verdict = {
          status: cached.status,
          reason: `${cached.reason} (probed ${Math.round((now().getTime() - cached.at) / 60_000)} min ago)`,
        };
      } else {
        verdict = await liveProbe(deps);
        deps.writeCache(key, { at: now().getTime(), ...verdict });
      }
    }
    return {
      id: "claude-code",
      ...verdict,
      capabilities: allCapabilitiesAs(verdict.status),
      lastProbedAt,
    };
  };

  const generate = async (options: ProviderGenerateOptions): Promise<ProviderGenerateResult> => {
    const model = options.model ?? "sonnet";
    const started = Date.now();
    const out = await deps.exec(
      buildClaudeArgs(model, options.system),
      options.prompt,
      options.timeoutMs ?? GENERATE_TIMEOUT_MS,
      options.signal,
    );
    const parsed = parseClaudeJson(out.stdout);
    if (out.exitCode !== 0) {
      throw new ClaudeCodeDispatchError(
        `process exited ${out.exitCode}${out.stderr.trim() ? `: ${out.stderr.trim().slice(0, 200)}` : ""}`,
      );
    }
    if (parsed === null) {
      throw new ClaudeCodeDispatchError(
        `unreadable output or invalid result: ${out.stderr.trim().slice(0, 200)}`,
      );
    }
    if (parsed.isError) throw new ClaudeCodeDispatchError(parsed.result || `exit ${out.exitCode}`);
    return {
      providerId: "claude-code",
      model,
      response: parsed.result,
      durationMs: Date.now() - started,
      ...(parsed.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
      ...(parsed.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
      ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
    };
  };

  return {
    id: "claude-code",
    executionType: "remote_dispatch",
    requiresModel: false,
    probe,
    generate,
  };
}

export const claudeCodeProvider: Provider = createClaudeCodeProvider();
