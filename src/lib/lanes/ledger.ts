// The lane-usage ledger: one JSON line per model call, appended to Taisce
// System/telemetry/lane-usage.jsonl. Metadata only — never a prompt, answer or key.
//
//   {"ts":…,"lane":"anthropic-api","model":"sonnet","task":"reason","tokens_in":…,
//    "tokens_out":…,"cost":"eur","eur":0.0123,"by":"moss"}
//
// `cost` is how the call is paid: "eur" (metered — `eur` is the list-price estimate),
// "sub" (subscription, `usd_list` is notional), "local" (€0). The daily cap reads it back.
import type { Billing } from "../providers/metadata.ts";
import { appendTelemetry, readTelemetry, telemetryPath } from "../taisce/telemetry.ts";

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

export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return telemetryPath("lane-usage", env);
}

export async function recordLaneUsage(
  entry: Omit<LaneUsage, "by">,
  path = ledgerPath(),
): Promise<boolean> {
  try {
    await appendTelemetry(path, { ...entry, by: "moss" });
    return true;
  } catch {
    return false; // the ledger must never fail the call it records
  }
}

export function readLedger(path = ledgerPath()): LaneUsage[] {
  return readTelemetry(path).filter(
    (r): r is LaneUsage & Record<string, unknown> =>
      typeof r.ts === "string" && typeof r.lane === "string",
  ) as LaneUsage[];
}

// Local calendar day / month, so "today" means Karl's today.
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function eurSpent(entries: readonly LaneUsage[], lane: string, day: string): number {
  return entries
    .filter((e) => e.lane === lane && localDay(new Date(e.ts)) === day)
    .reduce((sum, e) => sum + (typeof e.eur === "number" ? e.eur : 0), 0);
}
