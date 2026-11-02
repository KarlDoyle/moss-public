// Declarative per-lane metadata: what each lane can do, what it costs, how much it holds.
//
// Data, not logic. The policy layer (src/lib/lanes/) reads this to explain a pick and
// estimate its cost; the router still gates on a live probe. Prices are LIST prices in USD
// per 1M tokens — time-sensitive facts, so the date they were verified is carried with them
// and re-checked at each monthly review of Taisce System/09-model-routing-rules.md.

import { DEFAULT_NUM_CTX } from "../ollama.ts";
import type { ProviderId, TaskId } from "./types.ts";

// The six task types routing is expressed in (config/routing.yaml, and the lane-order table
// in Taisce System/09-model-routing-rules.md).
export const LANE_TASK_TYPES = ["route", "brief", "reason", "edit", "embed", "vision"] as const;
export type LaneTaskType = (typeof LANE_TASK_TYPES)[number];

// How a lane's calls are paid for — also the `cost` field of every lane-usage ledger line.
//   local — on this Mac, €0.   sub — the Claude subscription (no per-call bill).
//   eur   — metered API spend, capped per day.   manual — a handoff, nothing is called.
export type Billing = "local" | "sub" | "eur" | "manual";

export interface ModelPrice {
  readonly id: string;
  readonly inUsd: number; // per 1M input tokens
  readonly outUsd: number; // per 1M output tokens
  readonly maxContext: number; // tokens
}

// Claude aliases moss uses (claude -p accepts the alias; the API needs the id).
export const CLAUDE_MODELS = {
  sonnet: { id: "claude-sonnet-5", inUsd: 2, outUsd: 10, maxContext: 1_000_000 },
  opus: { id: "claude-opus-5", inUsd: 5, outUsd: 25, maxContext: 1_000_000 },
  haiku: { id: "claude-haiku-4-5", inUsd: 1, outUsd: 5, maxContext: 200_000 },
} as const satisfies Record<string, ModelPrice>;

export type ClaudeAlias = keyof typeof CLAUDE_MODELS;

// Source: platform.claude.com pricing, as recorded in Taisce 09-model-routing-rules.md
// (verified 2026-08-29) and matching the claude-api reference table.
export const CLAUDE_PRICES_VERIFIED = "2026-08-29";

export function claudeModel(alias: string): ModelPrice | undefined {
  if (alias in CLAUDE_MODELS) return CLAUDE_MODELS[alias as ClaudeAlias];
  return Object.values(CLAUDE_MODELS).find((m) => m.id === alias);
}

// USD for one call at list price. Unknown model → undefined, never a guess.
export function listPriceUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const price = claudeModel(model);
  if (price === undefined) return undefined;
  return (inputTokens * price.inUsd + outputTokens * price.outUsd) / 1_000_000;
}

export interface ProviderMetadata {
  readonly billing: Billing;
  // Task types this lane can serve at all. The policy's per-task lane list is the preference;
  // this is the hard capability filter under it.
  readonly capabilities: readonly LaneTaskType[];
  // Largest context the lane's default model holds, in tokens; null when model-dependent.
  readonly maxContext: number | null;
  readonly offlineSupport: boolean;
  // The legacy router's task ids this lane can execute.
  readonly taskSuitability: readonly TaskId[];
}

const TEXT_TASKS: readonly LaneTaskType[] = ["route", "brief", "reason", "edit"];

export const PROVIDER_METADATA = {
  ollama: {
    billing: "local",
    capabilities: LANE_TASK_TYPES,
    maxContext: DEFAULT_NUM_CTX, // what moss sends as num_ctx; the model may hold more
    offlineSupport: true,
    taskSuitability: ["ask", "code-review"],
  },
  "claude-code": {
    billing: "sub",
    // Text only: moss runs `claude -p` with every tool off and the prompt on stdin.
    capabilities: TEXT_TASKS,
    maxContext: CLAUDE_MODELS.sonnet.maxContext,
    offlineSupport: false,
    taskSuitability: ["ask", "code-review"],
  },
  "anthropic-api": {
    billing: "eur",
    capabilities: TEXT_TASKS,
    maxContext: CLAUDE_MODELS.sonnet.maxContext,
    offlineSupport: false,
    taskSuitability: ["ask", "code-review"],
  },
  litellm: {
    billing: "local",
    capabilities: TEXT_TASKS,
    maxContext: null,
    offlineSupport: false,
    taskSuitability: ["ask", "code-review"],
  },
  "cursor-manual": {
    billing: "manual",
    capabilities: TEXT_TASKS,
    maxContext: null,
    offlineSupport: true,
    taskSuitability: ["ask", "code-review"],
  },
} as const satisfies Record<ProviderId, ProviderMetadata>;

export function getProviderMetadata(id: ProviderId): ProviderMetadata {
  return PROVIDER_METADATA[id];
}
