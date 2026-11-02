// Recorded usage estimates, not provider-account spend or a hard billing cap.
import type { Command } from "commander";
import {
  type LaneUsage,
  LaneUsageSchema,
  ledgerPath,
  localDay,
  readLedgerState,
} from "../lib/lanes/ledger.ts";
import { loadRoutingPolicy } from "../lib/lanes/policy.ts";
import { type Billing, PROVIDER_METADATA } from "../lib/providers/metadata.ts";
import type { ProviderId } from "../lib/providers/types.ts";
import { ROUTED_LANES } from "./lane-status.ts";

export interface LaneTotals {
  readonly lane: string;
  readonly calls: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly eur: number | null;
  readonly usdList: number | null;
  readonly billing: Billing;
}

export function totals(
  entries: readonly LaneUsage[],
  lanes: readonly string[],
  incomplete = false,
): LaneTotals[] {
  const seen = [...new Set([...lanes, ...entries.map((e) => e.lane)])];
  return seen.map((lane) => {
    const mine = entries.filter((e) => e.lane === lane);
    const invalid = mine.some((e) => !LaneUsageSchema.safeParse(e).success);
    const kinds = new Set(mine.map((e) => e.cost));
    const billing: Billing =
      invalid || incomplete
        ? "unknown"
        : kinds.size === 1
          ? (mine[0]?.cost ?? "unknown")
          : kinds.size > 1
            ? "unknown"
            : Object.hasOwn(PROVIDER_METADATA, lane)
              ? PROVIDER_METADATA[lane as ProviderId].billing
              : "unknown";
    const sum = (f: (e: LaneUsage) => number | undefined): number | null => {
      if (incomplete || invalid) return null;
      let total = 0;
      for (const entry of mine) {
        const n = f(entry);
        if (
          n === undefined ||
          !Number.isFinite(n) ||
          n < 0 ||
          !LaneUsageSchema.safeParse(entry).success
        )
          return null;
        total += n;
      }
      return Number.isFinite(total) ? total : null;
    };
    return {
      lane,
      calls: mine.length,
      billing,
      tokensIn: sum((e) => e.tokens_in),
      tokensOut: sum((e) => e.tokens_out),
      eur: billing === "eur" ? sum((e) => e.eur) : billing === "unknown" ? null : 0,
      usdList: billing === "sub" ? sum((e) => e.usd_list) : 0,
    };
  });
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const euro = (n: number | null) => (n === null ? "unknown" : `€${n.toFixed(2)}`);
function cell(t: LaneTotals): string {
  const money =
    t.billing === "eur"
      ? euro(t.eur)
      : t.billing === "sub"
        ? `sub (${t.usdList === null ? "unknown" : `~$${t.usdList.toFixed(2)} list`})`
        : t.billing === "unknown"
          ? "unknown cost"
          : t.billing === "manual"
            ? "manual"
            : "€0";
  const tokens =
    t.tokensIn === null || t.tokensOut === null ? "unknown" : k(t.tokensIn + t.tokensOut);
  return `${String(t.calls).padStart(4)} calls · ${tokens.padStart(6)} tok · ${money}`;
}

export function formatCost(
  entries: readonly LaneUsage[],
  now: Date,
  capEur: number | null,
  file: string,
  issues: readonly string[] = [],
): string {
  const day = localDay(now);
  const month = day.slice(0, 7);
  const lanes = [...new Set([...ROUTED_LANES, ...entries.map((e) => e.lane)])];
  const today = totals(
    entries.filter((e) => localDay(new Date(e.ts)) === day),
    lanes,
    issues.length > 0,
  );
  const monthly = new Map(
    totals(
      entries.filter((e) => localDay(new Date(e.ts)).startsWith(month)),
      lanes,
      issues.length > 0,
    ).map((e) => [e.lane, e]),
  );
  const rows = [
    `moss cost — ${file}`,
    `  ${"lane".padEnd(15)}${`today (${day})`.padEnd(46)}month (${month})`,
  ];
  for (const t of today) {
    const m = monthly.get(t.lane);
    if (m !== undefined) rows.push(`  ${t.lane.padEnd(15)}${cell(t).padEnd(46)}${cell(m)}`);
  }
  const api = today.find((t) => t.lane === "anthropic-api");
  if (capEur !== null)
    rows.push(
      `  API cap today: ${issues.length > 0 ? "unknown" : euro(api?.eur ?? null)} of €${capEur.toFixed(2)} (caps.anthropic-api.daily_eur)`,
    );
  if (
    issues.length > 0 ||
    entries.some((e) => !LaneUsageSchema.safeParse(e).success) ||
    [...today, ...monthly.values()].some(
      (t) => t.tokensIn === null || t.tokensOut === null || t.eur === null || t.usdList === null,
    )
  )
    rows.push(
      "  Accounting incomplete: unknown values are not zero; recorded totals may be partial.",
    );
  for (const issue of issues) rows.push(`  Warning: ${issue}`);
  rows.push(
    "  EUR = recorded list-price usage × configured dated FX; sub = notional list value; local = no per-call provider charge. Advisory estimate, not a provider-side spending cap.",
  );
  return rows.join("\n");
}

export function registerCost(program: Command): void {
  program
    .command("cost")
    .description("Recorded usage and estimated spend per lane, today and this month")
    .option("--json", "Emit totals; unknown usage/cost is null")
    .action((opts: { json?: boolean }) => {
      const now = new Date();
      const { entries, issues } = readLedgerState();
      let cap: number | null = null;
      try {
        cap = loadRoutingPolicy().caps["anthropic-api"].daily_eur;
      } catch {
        cap = null;
      }
      if (opts.json === true || program.opts<{ json?: boolean }>().json === true) {
        const day = localDay(now);
        const lanes = [...new Set([...ROUTED_LANES, ...entries.map((e) => e.lane)])];
        const today = totals(
          entries.filter((e) => localDay(new Date(e.ts)) === day),
          lanes,
          issues.length > 0,
        );
        const month = totals(
          entries.filter((e) => localDay(new Date(e.ts)).startsWith(day.slice(0, 7))),
          lanes,
          issues.length > 0,
        );
        const incomplete =
          issues.length > 0 ||
          [...today, ...month].some(
            (t) =>
              t.tokensIn === null || t.tokensOut === null || t.eur === null || t.usdList === null,
          );
        process.stdout.write(
          `${JSON.stringify({ today, month, capEur: cap, incomplete, warnings: issues }, null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(`${formatCost(entries, now, cap, ledgerPath(), issues)}\n`);
    });
}
