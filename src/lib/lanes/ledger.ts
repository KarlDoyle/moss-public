// Metadata-only lane usage. Missing usage/cost remains unknown. The budget is an
// advisory local estimate; malformed or incomplete records cannot establish spend.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Billing } from "../providers/metadata.ts";
import type { ProviderGenerateResult } from "../providers/types.ts";
import { appendTelemetry, telemetryPath } from "../taisce/telemetry.ts";

export interface LaneUsage {
  readonly ts: string;
  readonly lane: string;
  readonly model: string;
  readonly task: string;
  readonly tokens_in?: number;
  readonly tokens_out?: number;
  readonly cost: Billing;
  readonly eur?: number;
  readonly usd_list?: number;
  readonly command?: string;
  readonly by: "moss";
}

const tokens = z.number().int().min(0).max(1_000_000_000);
const money = z.number().min(0).max(1_000_000);
export const LaneUsageSchema = z
  .object({
    ts: z
      .string()
      .refine(
        (s) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(s) &&
          Number.isFinite(Date.parse(s)) &&
          new Date(`${s.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === s.slice(0, 10),
      ),
    lane: z.string().min(1),
    model: z.string().min(1),
    task: z.string().min(1),
    tokens_in: tokens.optional(),
    tokens_out: tokens.optional(),
    cost: z.enum(["local", "sub", "eur", "manual", "unknown"]),
    eur: money.optional(),
    usd_list: money.optional(),
    command: z.string().optional(),
    by: z.literal("moss"),
  })
  .superRefine((entry, ctx) => {
    const expected =
      entry.lane === "anthropic-api"
        ? "eur"
        : entry.lane === "claude-code"
          ? "sub"
          : entry.lane === "ollama"
            ? "local"
            : entry.lane === "cursor-manual"
              ? "manual"
              : undefined;
    if (expected !== undefined && entry.cost !== expected)
      ctx.addIssue({ code: "custom", message: "lane/billing mismatch" });
  });

export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return telemetryPath("lane-usage", env);
}

export async function recordLaneUsage(
  entry: Omit<LaneUsage, "by">,
  path = ledgerPath(),
): Promise<boolean> {
  try {
    const valid = LaneUsageSchema.parse({ ...entry, by: "moss" });
    await appendTelemetry(path, valid);
    return true;
  } catch {
    return false;
  }
}

export interface LedgerState {
  readonly entries: LaneUsage[];
  readonly issues: string[];
}

export function readLedgerState(path = ledgerPath()): LedgerState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      entries: [],
      issues:
        (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : ["ledger could not be read"],
    };
  }
  const entries: LaneUsage[] = [];
  const issues: string[] = [];
  if (text !== "" && !text.endsWith("\n")) issues.push("ledger ends with an incomplete record");
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const result = LaneUsageSchema.safeParse(JSON.parse(line));
      if (result.success) entries.push(result.data as LaneUsage);
      else issues.push(`invalid ledger record on line ${index + 1}`);
    } catch {
      issues.push(`malformed ledger record on line ${index + 1}`);
    }
  }
  return { entries, issues };
}

export function readLedger(path = ledgerPath()): LaneUsage[] {
  const state = readLedgerState(path);
  if (state.issues.length > 0)
    throw new Error(`Incomplete accounting: ${state.issues.join("; ")}.`);
  return state.entries;
}

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// NaN is deliberately non-spendable: both routers refuse an unknown balance.
export function eurSpent(entries: readonly LaneUsage[], lane: string, day: string): number {
  let total = 0;
  for (const entry of entries) {
    if (!LaneUsageSchema.safeParse(entry).success) return Number.NaN;
    if (entry.lane !== lane || localDay(new Date(entry.ts)) !== day) continue;
    if (entry.cost !== "eur") {
      if (lane === "anthropic-api") return Number.NaN;
      continue;
    }
    if (entry.eur === undefined) return Number.NaN;
    total += entry.eur;
  }
  return Number.isFinite(total) ? total : Number.NaN;
}

export function accountingWarnings(
  result: Pick<
    ProviderGenerateResult,
    "providerId" | "inputTokens" | "outputTokens" | "costUsd" | "handoff"
  >,
): string[] {
  if (result.handoff !== undefined) return [];
  const warnings: string[] = [];
  if (result.inputTokens === undefined || result.outputTokens === undefined)
    warnings.push("Accounting incomplete: provider token usage is unknown.");
  if (result.providerId === "anthropic-api" && result.costUsd === undefined)
    warnings.push("Accounting incomplete: metered cost is unknown.");
  return warnings;
}
