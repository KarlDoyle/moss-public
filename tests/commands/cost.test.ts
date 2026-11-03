import { describe, expect, it } from "vitest";
import { formatCost, totals } from "../../src/commands/cost.ts";
import type { LaneUsage } from "../../src/lib/lanes/ledger.ts";

const now = new Date("2026-09-18T15:00:00");
const e = (lane: string, ts: string, extra: Partial<LaneUsage> = {}): LaneUsage => ({
  ts,
  lane,
  model: "m",
  task: "reason",
  cost: lane === "anthropic-api" ? "eur" : lane === "claude-code" ? "sub" : "local",
  by: "moss",
  ...extra,
});

const ledger = [
  e("anthropic-api", "2026-09-18T12:00:00", { eur: 0.3, tokens_in: 1000, tokens_out: 500 }),
  e("anthropic-api", "2026-09-02T12:00:00", { eur: 1.2 }),
  e("claude-code", "2026-09-18T09:00:00", { usd_list: 0.05, tokens_in: 2000 }),
  e("ollama", "2026-08-30T09:00:00", { tokens_in: 10 }),
  e("litellm", "2026-09-18T09:00:00"),
];

describe("moss cost", () => {
  it("totals calls, tokens and money per lane, keeping every routed lane even at zero", () => {
    const t = totals(ledger, ["ollama", "claude-code", "anthropic-api"]);
    expect(t.map((x) => x.lane)).toEqual(["ollama", "claude-code", "anthropic-api", "litellm"]);
    expect(t.find((x) => x.lane === "anthropic-api")).toMatchObject({
      calls: 2,
      eur: 1.5,
      tokensIn: null,
      tokensOut: null,
    });
  });

  it("splits today from this month and shows the cap", () => {
    const text = formatCost(ledger, now, 2, "/x/lane-usage.jsonl");
    expect(text).toContain("today (2026-09-18)");
    expect(text).toMatch(
      /anthropic-api +1 calls · +1\.5k tok · €0\.30 +2 calls · +unknown tok · €1\.50/,
    );
    expect(text).toMatch(/claude-code +1 calls · +unknown tok · sub \(~\$0\.05 list\)/);
    expect(text).toMatch(/ollama +0 calls · +0 tok · €0 +0 calls/);
    expect(text).toContain("API cap today: €0.30 of €2.00");
    expect(formatCost([], now, null, "f")).not.toContain("API cap");
  });
});
