// The policy wired to the real world: live probes, pulled Ollama models, the ledger, and
// dispatch to the chosen lane with its routing.yaml settings. Every call is logged.
import { safeFetch } from "../net.ts";
import { OLLAMA_BASE_URL } from "../ollama.ts";
import { ensureOllama, ollamaUse } from "../ollama-lifecycle.ts";
import { getProvider } from "../providers/index.ts";
import { getProviderMetadata, listPriceUsd } from "../providers/metadata.ts";
import type { ProviderGenerateResult, ProviderId } from "../providers/types.ts";
import { accountingWarnings, eurSpent, localDay, readLedger, recordLaneUsage } from "./ledger.ts";
import type { RoutingPolicy } from "./policy.ts";
import { type LaneChoice, meteredRefusal, type SelectDeps } from "./select.ts";

export async function pulledOllamaModels(): Promise<string[]> {
  try {
    const res = await safeFetch(`${OLLAMA_BASE_URL}/api/tags`, { timeoutMs: 3_000 });
    const body = JSON.parse(res.body) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name ?? "").filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

// `autoStartOllama`: when a request actually reaches the local lane and the daemon is down,
// start it (and remember that this process did, so it turns it off again). Off for --explain
// and status, which must never start anything.
export function defaultSelectDeps(
  now: () => Date = () => new Date(),
  opts: { readonly autoStartOllama?: boolean } = {},
): SelectDeps {
  let pulled: Promise<string[]> | undefined;
  return {
    probe: async (lane: ProviderId) => {
      const provider = getProvider(lane);
      if (provider === undefined) return { status: "not_installed", reason: "no implementation." };
      try {
        const first = await provider.probe(now);
        if (lane !== "ollama" || first.status === "available" || opts.autoStartOllama !== true)
          return first;
        if (!(await ensureOllama()))
          return { ...first, reason: `${first.reason} Tried to start it; it did not come up.` };
        pulled = undefined;
        return await provider.probe(now);
      } catch (error) {
        return {
          status: "unknown",
          reason: `probe threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    localModels: () => {
      pulled ??= pulledOllamaModels();
      return pulled;
    },
    eurSpentToday: (lane) => eurSpent(readLedger(), lane, localDay(now())),
  };
}

export interface DispatchInput {
  readonly prompt: string;
  readonly system?: string;
  readonly command: string;
}

export interface DispatchDeps {
  readonly getProvider: typeof getProvider;
  readonly record: typeof recordLaneUsage;
  readonly now: () => Date;
  readonly eurSpentToday?: (lane: ProviderId) => number;
}

export const defaultDispatchDeps: DispatchDeps = {
  getProvider,
  record: (entry) => recordLaneUsage(entry),
  now: () => new Date(),
};

// Run the chosen lane once, and log the call. Throws the lane's own error on failure — the
// caller decides whether to fall back; nothing here routes around a failure silently.
export async function dispatchChoice(
  policy: RoutingPolicy,
  choice: LaneChoice,
  input: DispatchInput,
  deps: DispatchDeps = defaultDispatchDeps,
): Promise<ProviderGenerateResult> {
  if (choice.lane === null || choice.model === null || choice.settings === null) {
    throw new Error(`no lane can run task '${choice.task}' right now.`);
  }
  const s = choice.settings;
  const cap = s.max_tokens ?? s.num_predict;
  if (choice.lane === "anthropic-api") {
    const refusal = meteredRefusal(
      policy,
      choice.model,
      Math.ceil(((input.system ?? "") + input.prompt).length / 4),
      cap ?? 8192,
      () =>
        deps.eurSpentToday?.("anthropic-api") ??
        eurSpent(readLedger(), "anthropic-api", localDay(deps.now())),
    );
    if (refusal !== null) throw new Error(refusal);
  }
  const provider = deps.getProvider(choice.lane);
  if (provider?.generate === undefined) throw new Error(`lane ${choice.lane} cannot generate.`);
  const result = await provider.generate({
    task: "ask",
    prompt: input.prompt,
    model: choice.model,
    ...(input.system !== undefined ? { system: input.system } : {}),
    ...(s.num_ctx !== undefined ? { numCtx: s.num_ctx } : {}),
    ...(cap !== undefined ? { maxTokens: cap } : {}),
  });
  if (choice.lane === "ollama") ollamaUse.used = true;
  const billing = getProviderMetadata(choice.lane).billing;
  const costUsd =
    result.costUsd ??
    (result.inputTokens !== undefined && result.outputTokens !== undefined
      ? listPriceUsd(result.model, result.inputTokens, result.outputTokens)
      : undefined);
  const accounted = { ...result, ...(costUsd !== undefined ? { costUsd } : {}) };
  const warnings = [...(result.warnings ?? []), ...accountingWarnings(accounted)];
  try {
    const recorded = await deps.record({
      ts: deps.now().toISOString(),
      lane: choice.lane,
      model: result.model,
      task: choice.task,
      command: input.command,
      ...(result.inputTokens !== undefined ? { tokens_in: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { tokens_out: result.outputTokens } : {}),
      cost: billing,
      ...(billing === "eur" && costUsd !== undefined
        ? { eur: costUsd * policy.fx.usd_to_eur }
        : {}),
      ...(billing === "sub" && costUsd !== undefined ? { usd_list: costUsd } : {}),
    });
    if (!recorded) warnings.push("Accounting incomplete: lane ledger write failed.");
  } catch {
    warnings.push("Accounting incomplete: lane ledger write failed.");
  }
  return { ...accounted, ...(warnings.length > 0 ? { warnings } : {}) };
}
