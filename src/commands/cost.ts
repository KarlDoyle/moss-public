// `moss cost` — today's and this month's model calls and spend per lane, from the lane-usage
// ledger (Taisce System/telemetry/lane-usage.jsonl). EUR is metered API spend at list price;
// the subscription shows its notional list-price value; local is €0.
import type { Command } from "commander";
import { type LaneUsage, ledgerPath, localDay, readLedger } from "../lib/lanes/ledger.ts";
import { loadRoutingPolicy } from "../lib/lanes/policy.ts";
import { ROUTED_LANES } from "./lane-status.ts";

export interface LaneTotals {
  readonly lane: string;
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly eur: number;
  readonly usdList: number;
}

export function totals(entries: readonly LaneUsage[], lanes: readonly string[]): LaneTotals[] {
  const seen = [...new Set([...lanes, ...entries.map((e) => e.lane)])];
  return seen.map((lane) => {
    const mine = entries.filter((e) => e.lane === lane);
    const sum = (f: (e: LaneUsage) => number | undefined) =>
      mine.reduce((n, e) => n + (f(e) ?? 0), 0);
    return {
      lane,
      calls: mine.length,
      tokensIn: sum((e) => e.tokens_in),
      tokensOut: sum((e) => e.tokens_out),
      eur: sum((e) => e.eur),
      usdList: sum((e) => e.usd_list),
    };
  });
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function cell(t: LaneTotals): string {
  const money =
    t.lane === "anthropic-api"
      ? `€${t.eur.toFixed(2)}`
      : t.lane === "claude-code"
        ? `sub (~$${t.usdList.toFixed(2)} list)`
        : "€0";
  return `${String(t.calls).padStart(4)} calls · ${k(t.tokensIn + t.tokensOut).padStart(6)} tok · ${money}`;
}

export function formatCost(
  entries: readonly LaneUsage[],
  now: Date,
  capEur: number | null,
  file: string,
): string {
  const day = localDay(now);
  const month = day.slice(0, 7);
  const today = totals(
    entries.filter((e) => localDay(new Date(e.ts)) === day),
    ROUTED_LANES,
  );
  const monthly = totals(
    entries.filter((e) => localDay(new Date(e.ts)).startsWith(month)),
    ROUTED_LANES,
  );
  const rows = [
    `moss cost — ${file}`,
    `  ${"lane".padEnd(15)}${`today (${day})`.padEnd(46)}month (${month})`,
  ];
  for (let i = 0; i < monthly.length; i += 1) {
    const t = today[i] as LaneTotals;
    rows.push(`  ${t.lane.padEnd(15)}${cell(t).padEnd(46)}${cell(monthly[i] as LaneTotals)}`);
  }
  const api = today.find((t) => t.lane === "anthropic-api");
  if (capEur !== null)
    rows.push(
      `  API cap today: €${(api?.eur ?? 0).toFixed(2)} of €${capEur.toFixed(2)} (caps.anthropic-api.daily_eur)`,
    );
  rows.push(
    "  EUR = metered API spend at list price; sub = no per-call bill (notional list value); local = €0.",
  );
  return rows.join("\n");
}

export function registerCost(program: Command): void {
  program
    .command("cost")
    .description(
      "Model calls and spend per lane, today and this month (from the lane-usage ledger)",
    )
    .option("--json", "Emit today's and this month's totals as JSON")
    .action((opts: { json?: boolean }) => {
      const now = new Date();
      const entries = readLedger();
      let cap: number | null = null;
      try {
        cap = loadRoutingPolicy().caps["anthropic-api"].daily_eur;
      } catch {
        cap = null;
      }
      if (opts.json === true || program.opts<{ json?: boolean }>().json === true) {
        const day = localDay(now);
        process.stdout.write(
          `${JSON.stringify(
            {
              today: totals(
                entries.filter((e) => localDay(new Date(e.ts)) === day),
                ROUTED_LANES,
              ),
              month: totals(
                entries.filter((e) => localDay(new Date(e.ts)).startsWith(day.slice(0, 7))),
                ROUTED_LANES,
              ),
              capEur: cap,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      process.stdout.write(`${formatCost(entries, now, cap, ledgerPath())}\n`);
    });
}
