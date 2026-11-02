// The lane rows `moss status` (and the session's /status) add under the ladder rows:
// each lane up or down and why, the Ollama model resident right now, today's calls and
// spend per lane from the ledger, and when `moss bench` last ran.
import { lastBench } from "../lib/bench.ts";
import { type LaneUsage, localDay, readLedger } from "../lib/lanes/ledger.ts";
import { laneSwitchedOff, loadRoutingPolicy } from "../lib/lanes/policy.ts";
import { defaultSelectDeps } from "../lib/lanes/runtime.ts";
import { safeFetch } from "../lib/net.ts";
import { OLLAMA_BASE_URL } from "../lib/ollama.ts";
import type { ProviderId } from "../lib/providers/types.ts";
import { readTelemetry, telemetryPath } from "../lib/taisce/telemetry.ts";

export const ROUTED_LANES: readonly ProviderId[] = ["ollama", "claude-code", "anthropic-api"];

export interface LaneStatus {
  readonly lanes: ReadonlyArray<{ id: ProviderId; status: string; reason: string }>;
  readonly resident: readonly string[] | null; // null = could not ask Ollama
  readonly today: readonly LaneUsage[];
  readonly bench: ReturnType<typeof lastBench>;
}

export interface LaneStatusDeps {
  readonly probe: (lane: ProviderId) => Promise<{ status: string; reason: string }>;
  readonly resident: () => Promise<string[] | null>;
  readonly ledger: () => LaneUsage[];
  readonly bench: () => Record<string, unknown>[];
  readonly now: () => Date;
}

export const defaultLaneStatusDeps: LaneStatusDeps = {
  probe: async (lane) => {
    try {
      const off = laneSwitchedOff(loadRoutingPolicy(), lane);
      if (off !== null) return { status: "disabled", reason: off };
    } catch {
      // unreadable routing.yaml: fall through to the live probe
    }
    return defaultSelectDeps().probe(lane);
  },
  resident: async () => {
    try {
      const res = await safeFetch(`${OLLAMA_BASE_URL}/api/ps`, { timeoutMs: 2_000 });
      const body = JSON.parse(res.body) as { models?: Array<{ name?: string }> };
      return (body.models ?? []).map((m) => m.name ?? "?");
    } catch {
      return null;
    }
  },
  ledger: () => readLedger(),
  bench: () => readTelemetry(telemetryPath("model-bench")),
  now: () => new Date(),
};

export async function gatherLaneStatus(
  deps: LaneStatusDeps = defaultLaneStatusDeps,
): Promise<LaneStatus> {
  const [lanes, resident] = await Promise.all([
    Promise.all(ROUTED_LANES.map(async (id) => ({ id, ...(await deps.probe(id)) }))),
    deps.resident(),
  ]);
  const day = localDay(deps.now());
  return {
    lanes,
    resident,
    today: deps.ledger().filter((e) => localDay(new Date(e.ts)) === day),
    bench: lastBench(deps.bench()),
  };
}

export function formatLaneStatus(s: LaneStatus): string {
  const rows = ["lanes (config/routing.yaml)"];
  for (const lane of s.lanes) {
    rows.push(
      `  ${lane.id.padEnd(15)}${lane.status === "available" ? "up  " : lane.status === "disabled" ? "off " : "down"}  ${lane.reason}`,
    );
  }
  rows.push(
    `  resident model: ${s.resident === null ? "unknown (Ollama not reachable)" : s.resident.length > 0 ? s.resident.join(", ") : "none loaded"}`,
  );
  const spend = ROUTED_LANES.map((id) => {
    const calls = s.today.filter((e) => e.lane === id);
    const eur = calls.reduce((sum, e) => sum + (e.eur ?? 0), 0);
    const billing =
      id === "anthropic-api" ? `€${eur.toFixed(2)}` : id === "claude-code" ? "sub" : "€0";
    return `${id} ${calls.length} call${calls.length === 1 ? "" : "s"} (${billing})`;
  });
  rows.push(`  today's spend:  ${spend.join(" · ")}`);
  rows.push(
    `  last bench:     ${s.bench === null ? "never — run `moss bench`" : `${s.bench.ts.slice(0, 16).replace("T", " ")} UTC, ${s.bench.passed}/${s.bench.models} models passed`}`,
  );
  return rows.join("\n");
}
