import { loadRoutingPolicy } from "../../../src/lib/lanes/policy.ts";
import type { SelectDeps } from "../../../src/lib/lanes/select.ts";
import type { ProviderId, ProviderStatus } from "../../../src/lib/providers/types.ts";

// The real config/routing.yaml — tests assert the shipped policy, not a copy of it.
export const policy = loadRoutingPolicy(
  new URL("../../../config/routing.yaml", import.meta.url).pathname,
);

export function lanes(
  status: Partial<Record<ProviderId, ProviderStatus>>,
  pulled: readonly string[] = ["llama3.1:latest", "qwen2.5:3b-instruct", "qwen2.5-coder:7b"],
  spent = 0,
): SelectDeps & { probed: ProviderId[] } {
  const probed: ProviderId[] = [];
  return {
    probed,
    probe: async (lane) => {
      probed.push(lane);
      const s = status[lane] ?? "unavailable";
      return { status: s, reason: `${lane} is ${s}.` };
    },
    localModels: async () => pulled,
    eurSpentToday: () => spent,
  };
}

// The same policy with the metered lane switched on — for tests of how it behaves when on.
export const policyApiOn = {
  ...policy,
  caps: { ...policy.caps, "anthropic-api": { ...policy.caps["anthropic-api"], enabled: true } },
};

// Everything routing.yaml's reason row needs locally (gemma4:12b since 2026-09-18).
export const PULLED_WITH_GEMMA = [
  "llama3.1:latest",
  "qwen2.5:3b-instruct",
  "qwen2.5-coder:7b",
  "gemma4:12b",
];
