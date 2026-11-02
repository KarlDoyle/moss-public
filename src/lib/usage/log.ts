import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MOSS_VERSION } from "../../version.ts";
import { type LaneUsage, recordLaneUsage } from "../lanes/ledger.ts";
import { loadRoutingPolicy } from "../lanes/policy.ts";
import { listPriceUsd, PROVIDER_METADATA } from "../providers/metadata.ts";
import type { ProviderId } from "../providers/types.ts";
import { usageLogPath } from "./paths.ts";
import { type UsageCommand, type UsageEntry, UsageEntrySchema } from "./types.ts";

export interface UsageLogDeps {
  readonly appendFile: (path: string, data: string) => Promise<void>;
  readonly now: () => Date;
  readonly mossVersion: string;
  readonly usdToEur?: () => number;
  // Also append the call to Taisce's lane-usage ledger (unified router, 2026-09-18), so the
  // pre-router paths (`moss ask`, room skills, a /provider-pinned session) are counted too.
  // Only the default deps set it; a test's own deps never write to the ledger.
  readonly recordLane?: (entry: Omit<LaneUsage, "by">) => Promise<boolean>;
}

export const defaultUsageLogDeps: UsageLogDeps = {
  appendFile: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, data, "utf8");
  },
  now: () => new Date(),
  mossVersion: MOSS_VERSION,
  usdToEur: () => loadRoutingPolicy().fx.usd_to_eur,
  recordLane: (entry) => recordLaneUsage(entry),
};

function laneEntry(input: UsageWriteInput, ts: string, deps: UsageLogDeps): Omit<LaneUsage, "by"> {
  const known = Object.hasOwn(PROVIDER_METADATA, input.providerId);
  const billing = known ? PROVIDER_METADATA[input.providerId as ProviderId].billing : "unknown";
  const usd =
    input.costUsd !== undefined
      ? Number.isFinite(input.costUsd) && input.costUsd >= 0
        ? input.costUsd
        : undefined
      : input.inputTokens !== undefined && input.outputTokens !== undefined
        ? listPriceUsd(input.model, input.inputTokens, input.outputTokens)
        : undefined;
  let eur: number | undefined;
  if (billing === "eur" && usd !== undefined) {
    try {
      const fx = deps.usdToEur?.();
      if (fx !== undefined && Number.isFinite(fx) && fx > 0) eur = usd * fx;
    } catch {
      /* metadata still records unknown cost */
    }
  }
  return {
    ts,
    lane: input.providerId,
    model: input.model,
    task: input.task ?? input.skill ?? input.command,
    command: input.command,
    ...(input.inputTokens !== undefined ? { tokens_in: input.inputTokens } : {}),
    ...(input.outputTokens !== undefined ? { tokens_out: input.outputTokens } : {}),
    cost: billing,
    ...(eur !== undefined ? { eur } : {}),
    ...(billing === "sub" && usd !== undefined ? { usd_list: usd } : {}),
  };
}

export interface UsageWriteInput {
  readonly command: UsageCommand;
  readonly providerId: string;
  readonly model: string;
  readonly task?: string;
  readonly skill?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

// Append one validated usage record to output/usage/usage.jsonl.
// Mirrors the memory/MCP audit writers: schema-validated, append-only,
// path resolved through joinInsideProject so a write can never escape
// the project root. The record carries metadata only — never the prompt
// or response.
export async function writeUsageEntry(
  input: UsageWriteInput,
  deps: UsageLogDeps = defaultUsageLogDeps,
): Promise<UsageEntry> {
  const entry: UsageEntry = UsageEntrySchema.parse({
    schemaVersion: 1,
    timestamp: deps.now().toISOString(),
    command: input.command,
    providerId: input.providerId,
    model: input.model,
    ...(input.task !== undefined ? { task: input.task } : {}),
    ...(input.skill !== undefined ? { skill: input.skill } : {}),
    ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    recordedBy: `moss@${deps.mossVersion}`,
  });
  const line = `${JSON.stringify(entry)}\n`;
  await deps.appendFile(usageLogPath(), line);
  return entry;
}

// Best-effort variant for hot paths (e.g. `moss ask`): usage logging is
// an audit side-effect and must never fail the operator's
// actual request. Reports write/validation errors and reports
// whether the line was recorded, so callers can stay silent on success
// and need no try/catch of their own.
export async function recordUsageBestEffort(
  input: UsageWriteInput,
  deps: UsageLogDeps = defaultUsageLogDeps,
): Promise<boolean> {
  let logOk = false;
  let ledgerOk = deps.recordLane === undefined;
  // Separate attempts: a secondary log failure must not suppress the ledger.
  try {
    await writeUsageEntry(input, deps);
    logOk = true;
  } catch {
    /* reported by return value */
  }
  if (deps.recordLane !== undefined) {
    try {
      const entry = laneEntry(input, deps.now().toISOString(), deps);
      ledgerOk = await deps.recordLane(entry);
      if (entry.cost === "eur" && entry.eur === undefined) ledgerOk = false;
    } catch {
      ledgerOk = false;
    }
  }
  return logOk && ledgerOk;
}
