// Lane selection: the first lane in the task's preference list that can do the task, is
// available right now, and — for the metered lane — has room under today's cap. Lanes are
// probed in order and probing stops at the pick, so a local-only task never spends a
// Claude probe. Every skipped lane carries its reason; that list IS the --explain output.
import { getProviderMetadata, type LaneTaskType, listPriceUsd } from "../providers/metadata.ts";
import type { ProviderId, ProviderProbeResult } from "../providers/types.ts";
import {
  type LaneSettings,
  laneSwitchedOff,
  lanesFor,
  type RoutingPolicy,
  settingsFor,
} from "./policy.ts";

export interface LaneVerdict {
  readonly lane: ProviderId;
  readonly picked: boolean;
  readonly reason: string;
}

export interface LaneEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd?: number; // list price, when the model has one
  readonly eur?: number;
}

export interface LaneChoice {
  readonly task: LaneTaskType;
  readonly lane: ProviderId | null;
  readonly model: string | null;
  readonly settings: LaneSettings | null;
  readonly gates: readonly string[];
  readonly stageOnly: boolean;
  readonly verdicts: readonly LaneVerdict[];
  readonly estimate: LaneEstimate | null;
}

export interface SelectInput {
  readonly task: LaneTaskType;
  readonly gates?: readonly string[];
  readonly promptTokens: number; // estimated tokens of prompt + system
  readonly pinLane?: ProviderId;
  readonly pinModel?: string; // e.g. "opus", or an Ollama model name
}

export interface SelectDeps {
  readonly probe: (lane: ProviderId) => Promise<Pick<ProviderProbeResult, "status" | "reason">>;
  readonly localModels: () => Promise<readonly string[]>;
  readonly eurSpentToday: (lane: ProviderId) => number;
}

function modelFor(
  policy: RoutingPolicy,
  lane: ProviderId,
  settings: LaneSettings,
  pin: string | undefined,
): string {
  if (pin !== undefined) return pin;
  if (
    lane === "claude-code" &&
    policy.caps["claude-code"].sonnet_first &&
    settings.model === "opus"
  )
    return "sonnet";
  return settings.model;
}

function isPulled(model: string, pulled: readonly string[]): boolean {
  return (
    pulled.includes(model) ||
    pulled.includes(`${model}:latest`) ||
    pulled.includes(model.replace(/:latest$/, ""))
  );
}

const eur2 = (n: number) => `€${n.toFixed(2)}`;

export async function selectLane(
  policy: RoutingPolicy,
  input: SelectInput,
  deps: SelectDeps,
): Promise<LaneChoice> {
  const gates = input.gates ?? [];
  const stageOnly = gates.length > 0;
  const order: readonly ProviderId[] =
    input.pinLane !== undefined
      ? [input.pinLane]
      : stageOnly
        ? policy.stakes.best_order
        : lanesFor(policy, input.task);
  const verdicts: LaneVerdict[] = [];
  const base = { task: input.task, gates, stageOnly };
  for (const lane of order) {
    const skip = (reason: string) => verdicts.push({ lane, picked: false, reason });
    const off = laneSwitchedOff(policy, lane);
    if (off !== null) {
      skip(off);
      continue;
    }
    if (!getProviderMetadata(lane).capabilities.includes(input.task)) {
      skip(`cannot do '${input.task}'.`);
      continue;
    }
    const settings = settingsFor(policy, input.task, lane);
    if (settings === undefined) {
      skip(`routing.yaml gives it no model for '${input.task}'.`);
      continue;
    }
    const probe = await deps.probe(lane);
    if (probe.status !== "available") {
      skip(probe.reason);
      continue;
    }
    const model = modelFor(
      policy,
      lane,
      settings,
      input.pinLane === lane ? input.pinModel : undefined,
    );
    if (lane === "ollama" && !isPulled(model, await deps.localModels())) {
      skip(`${model} is not pulled (\`ollama pull ${model}\` — moss never pulls for you).`);
      continue;
    }
    const outputTokens = settings.max_tokens ?? settings.num_predict ?? 2048;
    const usd = listPriceUsd(model, input.promptTokens, outputTokens);
    const eur = usd === undefined ? undefined : usd * policy.fx.usd_to_eur;
    const estimate: LaneEstimate = {
      inputTokens: input.promptTokens,
      outputTokens,
      ...(usd !== undefined ? { usd } : {}),
      ...(eur !== undefined ? { eur } : {}),
    };
    if (getProviderMetadata(lane).billing === "eur") {
      const cap = policy.caps["anthropic-api"].daily_eur;
      const spent = deps.eurSpentToday(lane);
      const next = eur ?? 0;
      if (spent + next > cap) {
        skip(
          `refused: over the daily cap — ${eur2(spent)} spent today + up to ${eur2(next)} for this call > ${eur2(cap)} (caps.anthropic-api.daily_eur).`,
        );
        continue;
      }
    }
    const why = stageOnly
      ? `gate ${gates.join(" + ")} forces the best available lane; the result is stage-only.`
      : input.pinLane === lane
        ? "pinned for this session."
        : `first available lane for '${input.task}' in routing.yaml.`;
    verdicts.push({ lane, picked: true, reason: `${probe.reason} → ${why}` });
    return { ...base, lane, model, settings, verdicts, estimate };
  }
  return { ...base, lane: null, model: null, settings: null, verdicts, estimate: null };
}
