// Deterministic multi-provider router for M3.
//
// The router answers two questions for every request:
//   1. EXPLAIN — given a task and the current provider statuses, which
//      provider would Moss dispatch to, what is the fallback order, and
//      which providers are unavailable (with reasons)?
//   2. ROUTE — actually dispatch the task to the selected provider and
//      return the generation result alongside the explanation.
//
// Determinism contract (per M3 design memo, decision 5):
//   For any fixed input `(task, providerListing, probeStatuses)` the
//   router MUST produce the same `ProviderRouteExplanation`. This is
//   enforced
//   by:
//     - PROVIDER_ORDER being a fixed constant (single source of truth).
//     - Probes being threaded through a single dependency-injectable
//       function so tests can pin the probe outputs.
//     - No randomness, no Date.now() in selection logic — the only
//       date in the explanation is `probedAt`, captured once per call.
//     - Selection rule is a pure first-match scan over PROVIDER_ORDER.
//
// In M3-T02 only Ollama is implemented (registry returns undefined for
// the other five lane ids). The router records every unimplemented lane
// as `not_installed` with a stable reason string. T05/T06 fill the
// registry; the router code does not change.

import { accountingWarnings, eurSpent, localDay, readLedger } from "../lanes/ledger.ts";
import { loadRoutingPolicy, type RoutingPolicy, settingsFor } from "../lanes/policy.ts";
import { meteredRefusal } from "../lanes/select.ts";
import { requestPins } from "../lanes/skill-plan.ts";
import { NetworkBoundaryError } from "../net.ts";
import { utf8Bytes } from "../utf8.ts";
import { classifyGenerateFailure } from "./failure.ts";
import {
  getProvider as defaultGetProvider,
  type ExecutionType,
  PROVIDER_ORDER,
  type Provider,
  type ProviderGenerateOptions,
  type ProviderGenerateResult,
  type ProviderId,
  type ProviderProbeResult,
  type ProviderStatus,
  type TaskId,
} from "./index.ts";

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export class NoProviderAvailableError extends Error {
  public readonly task: TaskId;
  public readonly explanation: ProviderRouteExplanation;
  constructor(task: TaskId, explanation: ProviderRouteExplanation) {
    const unavailableLines = explanation.unavailableProviders
      .map((u) => `  - ${u.id} (${u.status}): ${u.reason}`)
      .join("\n");
    super(
      `No provider can execute task '${task}'. All providers reported unavailable:\n${unavailableLines}`,
    );
    this.name = "NoProviderAvailableError";
    this.task = task;
    this.explanation = explanation;
  }
}

// One lane's generation failure, captured during a fallback cascade.
export interface ProviderFailureEntry {
  readonly id: ProviderId;
  readonly error: Error;
}

// Thrown when EVERY eligible lane was attempted and each failed with a
// retryable error (M11). Distinct from `NoProviderAvailableError`, which
// fires when NO lane is eligible at probe time — this fires when lanes were
// eligible and dispatched to, but all generations failed. Only thrown when
// more than one lane was attempted; a single-lane failure re-throws that
// lane's original error unchanged, so type-based handlers (e.g. `moss ask`)
// still recognise `OllamaModelMissingError` and friends.
export class AllProvidersFailedError extends Error {
  public readonly task: TaskId;
  public readonly explanation: ProviderRouteExplanation;
  public readonly failures: readonly ProviderFailureEntry[];
  constructor(
    task: TaskId,
    explanation: ProviderRouteExplanation,
    failures: readonly ProviderFailureEntry[],
  ) {
    const lines = failures.map((f) => `  - ${f.id}: ${f.error.message}`).join("\n");
    super(`All eligible providers failed to generate for task '${task}':\n${lines}`);
    this.name = "AllProvidersFailedError";
    this.task = task;
    this.explanation = explanation;
    this.failures = failures;
  }
}

// -----------------------------------------------------------------------------
// Public shapes
// -----------------------------------------------------------------------------

export interface UnavailableProviderEntry {
  readonly id: ProviderId;
  readonly status: ProviderStatus;
  readonly reason: string;
}

// Provider-level routing explanation: which provider would Moss
// dispatch to (or did, in routeAndGenerate), why, and what the
// fallback chain looks like. Distinct from M2's
// `src/lib/route.ts:RouteExplanation`, which is a registry-model-level
// explanation used by `moss models --explain <task>`. T07 will
// consolidate the two layers; for now the names are kept separate so
// neither module shadows the other.
export interface ProviderRouteExplanation {
  readonly task: TaskId;
  readonly selectedProvider: ProviderId | null;
  readonly selectedReason: string;
  // Execution typing of the selected provider, surfaced so callers
  // can render results honestly: `local_dispatch` results were
  // produced by Moss against a local tool; `manual_handoff` results
  // are packets the operator must act on; `detection_only` and
  // friends are never selectable (router excludes them earlier).
  // `null` when no provider was selected. See T05.
  readonly selectedExecutionType: ExecutionType | null;
  readonly fallbackProviders: readonly ProviderId[];
  readonly unavailableProviders: readonly UnavailableProviderEntry[];
  readonly unknownCapabilities: readonly { readonly id: ProviderId; readonly task: TaskId }[];
  readonly confidence?: number;
  readonly probedAt: string;
  readonly selectedModel?: string;
  readonly models?: Partial<Record<ProviderId, string>>;
}

export interface RouterDependencies {
  // The ordered lane list. Defaults to PROVIDER_ORDER. Tests can shrink
  // this to make assertions deterministic and small.
  readonly listProviders: () => readonly ProviderId[];
  // Resolves a provider id to an implementation. Defaults to the
  // module-level provider registry. Tests can inject fakes here.
  readonly getProvider: (id: ProviderId) => Provider | undefined;
  // Single `Date` source for `probedAt`. Injected so tests can pin it.
  readonly now: () => Date;
  readonly policy?: () => RoutingPolicy;
  readonly eurSpentToday?: (lane: ProviderId) => number;
}

export const defaultRouterDependencies: RouterDependencies = {
  listProviders: () => PROVIDER_ORDER,
  getProvider: defaultGetProvider,
  now: () => new Date(),
};

// -----------------------------------------------------------------------------
// Probing
// -----------------------------------------------------------------------------

// Synthetic probe result used when a lane id has no implementation in
// this build (provider registry returns undefined). We classify it as
// `not_installed` rather than `unknown` because in this codebase the
// determining fact is unambiguous: there is no provider implementation
// at all. This DOES NOT mean the underlying tool is absent from the
// user's machine — that's a separate concern that the per-provider
// probe will address once the lane lands. The reason string is
// milestone-neutral on purpose so the message stays accurate as more
// lanes are wired.
function syntheticNotInstalled(id: ProviderId, now: () => Date): ProviderProbeResult {
  return {
    id,
    status: "not_installed",
    reason: `No Moss provider implementation registered for lane '${id}' in this build.`,
    capabilities: {
      ask: "not_installed",
      "code-review": "not_installed",
    },
    lastProbedAt: now().toISOString(),
  };
}

async function probeOne(id: ProviderId, deps: RouterDependencies): Promise<ProviderProbeResult> {
  const impl = deps.getProvider(id);
  if (impl === undefined) {
    return syntheticNotInstalled(id, deps.now);
  }
  try {
    return await impl.probe(deps.now);
  } catch (error) {
    // Safety-boundary violations must NEVER be downgraded to an
    // "unknown" routing classification. A `NetworkBoundaryError`
    // means a provider's probe tried to talk to a destination outside
    // the active milestone's allowlist; that's a security signal we
    // want to surface verbatim to the caller, not silently route
    // around. Re-throwing here also ensures the boundary message
    // reaches `ask`/`run` error handlers unchanged.
    if (error instanceof NetworkBoundaryError) {
      throw error;
    }
    // Any other thrown error becomes `unknown` rather than
    // `available` — per D-0011 we never default-success. The reason
    // string carries the error message so the explanation is honest.
    const message = error instanceof Error ? error.message : String(error);
    return {
      id,
      status: "unknown",
      reason: `Probe threw an error: ${message}`,
      capabilities: {
        ask: "unknown",
        "code-review": "unknown",
      },
      lastProbedAt: deps.now().toISOString(),
    };
  }
}

// -----------------------------------------------------------------------------
// Selection
// -----------------------------------------------------------------------------

// Returns whether a (provider, task) pair can be selected:
// - overall provider status must be `available`,
// - per-task capability must be `available`,
// - provider must implement `generate` (detection-only lanes are not
//   selectable as executors even if both statuses say `available`).
function canSelect(
  provider: Provider | undefined,
  probe: ProviderProbeResult,
  task: TaskId,
): boolean {
  if (provider === undefined) return false;
  if (provider.generate === undefined) return false;
  if (probe.status !== "available") return false;
  if (probe.capabilities[task] !== "available") return false;
  return true;
}

function reasonFor(
  probe: ProviderProbeResult,
  task: TaskId,
  hasImpl: boolean,
  hasGenerate: boolean,
): string {
  // Order matters: a probe that couldn't classify the provider as
  // 'available' takes precedence over the static "detection-only"
  // classification, because the probe reason carries the more
  // operational signal (the exact daemon error, the network boundary
  // refusal, the "Probe threw" wrapper, etc.). Detection-only is the
  // right reason only when the provider IS otherwise available but
  // has no `generate` implementation wired yet.
  if (!hasImpl) return probe.reason;
  if (probe.status !== "available") return probe.reason;
  if (!hasGenerate) return "Lane is detection-only in this build — no generate() implementation.";
  const taskStatus = probe.capabilities[task];
  if (taskStatus !== "available") {
    return `Provider is ${probe.status} overall but cannot execute task '${task}' (capability=${taskStatus}).`;
  }
  return probe.reason;
}

function buildExplanation(
  task: TaskId,
  ids: readonly ProviderId[],
  probes: readonly ProviderProbeResult[],
  deps: RouterDependencies,
): ProviderRouteExplanation {
  const probedAt = deps.now().toISOString();
  const eligible: ProviderId[] = [];
  const unavailable: UnavailableProviderEntry[] = [];
  const unknowns: { id: ProviderId; task: TaskId }[] = [];

  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i] as ProviderId;
    const probe = probes[i] as ProviderProbeResult;
    const impl = deps.getProvider(id);
    const hasGenerate = impl?.generate !== undefined;
    if (canSelect(impl, probe, task)) {
      eligible.push(id);
      continue;
    }
    unavailable.push({
      id,
      status: probe.status,
      reason: reasonFor(probe, task, impl !== undefined, hasGenerate),
    });
    if (probe.capabilities[task] === "unknown") {
      unknowns.push({ id, task });
    }
  }

  if (eligible.length === 0) {
    return {
      task,
      selectedProvider: null,
      selectedReason:
        "No provider satisfies all of: overall status='available', capability='available' for this task, and generate() implementation present.",
      selectedExecutionType: null,
      fallbackProviders: [],
      unavailableProviders: unavailable,
      unknownCapabilities: unknowns,
      probedAt,
    };
  }

  const selected = eligible[0] as ProviderId;
  const fallbacks = eligible.slice(1);
  const selectedProbe = probes[ids.indexOf(selected)] as ProviderProbeResult;
  const selectedImpl = deps.getProvider(selected) as Provider;
  const orderPosition = PROVIDER_ORDER.indexOf(selected);
  const orderNote =
    orderPosition === 0
      ? "first in the default route order"
      : `position ${orderPosition + 1} in the default route order (no earlier provider was available)`;
  const explanation: ProviderRouteExplanation = {
    task,
    selectedProvider: selected,
    selectedReason: `${selected}: status=${selectedProbe.status}, capability[${task}]=${selectedProbe.capabilities[task]}, execution=${selectedImpl.executionType}, ${orderNote}.`,
    selectedExecutionType: selectedImpl.executionType,
    fallbackProviders: fallbacks,
    unavailableProviders: unavailable,
    unknownCapabilities: unknowns,
    probedAt,
    ...(selectedProbe.confidence !== undefined ? { confidence: selectedProbe.confidence } : {}),
  };
  return explanation;
}

// -----------------------------------------------------------------------------
// Public entry points
// -----------------------------------------------------------------------------

export interface RouteRequest extends ProviderGenerateOptions {
  readonly provider?: ProviderId;
  readonly localOnly?: boolean;
  // A registry-selected local default is not an explicit model pin. Hosted
  // fallback resolves its own configured model instead of receiving a local id.
  readonly modelIsDefault?: boolean;
  // Optional total UTF-8 budget enforced immediately before each generation.
  readonly maxRequestBytes?: number;
}

function laneOptions(
  task: TaskId,
  id: ProviderId,
  policy: RoutingPolicy,
  request: Partial<RouteRequest>,
): ProviderGenerateOptions {
  const settings = settingsFor(policy, task === "code-review" ? "reason" : "brief", id);
  const model =
    request.model !== undefined &&
    (!request.modelIsDefault || id === "ollama" || id === "litellm" || id === "cursor-manual")
      ? request.model
      : settings?.model;
  return {
    task,
    prompt: request.prompt ?? "",
    ...(model !== undefined ? { model } : {}),
    ...(request.system !== undefined ? { system: request.system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(id === "anthropic-api"
      ? { maxTokens: request.maxTokens ?? settings?.max_tokens ?? settings?.num_predict ?? 8192 }
      : request.maxTokens !== undefined
        ? { maxTokens: request.maxTokens }
        : {}),
    ...(request.numCtx !== undefined ? { numCtx: request.numCtx } : {}),
  };
}

function apiRefusal(
  deps: RouterDependencies,
  policy: RoutingPolicy,
  options: ProviderGenerateOptions,
): string | null {
  return meteredRefusal(
    policy,
    options.model ?? "sonnet",
    Math.ceil(((options.system ?? "") + options.prompt).length / 4),
    options.maxTokens ?? 8192,
    () =>
      deps.eurSpentToday?.("anthropic-api") ??
      eurSpent(readLedger(), "anthropic-api", localDay(deps.now())),
  );
}

async function requestRoute(
  task: TaskId,
  deps: RouterDependencies,
  request: Partial<RouteRequest>,
) {
  const policy = (deps.policy ?? loadRoutingPolicy)();
  const pins = requestPins(
    request.modelIsDefault ? undefined : request.model,
    request.provider,
    request.localOnly,
  );
  const ids = deps
    .listProviders()
    .filter((id) => pins.pinLane === undefined || pins.pinLane === id);
  const options = new Map(ids.map((id) => [id, laneOptions(task, id, policy, request)]));
  const probes = await Promise.all(
    ids.map(async (id) => {
      if (id === "anthropic-api" && deps.getProvider(id) !== undefined) {
        const refusal = apiRefusal(deps, policy, options.get(id) as ProviderGenerateOptions);
        if (refusal !== null)
          return {
            id,
            status: "disabled" as const,
            reason: refusal,
            capabilities: { ask: "disabled" as const, "code-review": "disabled" as const },
            lastProbedAt: deps.now().toISOString(),
          };
      }
      return probeOne(id, deps);
    }),
  );
  const built = buildExplanation(task, ids, probes, deps);
  // Manual handoff is never an automatic executor fallback.
  const explanation: ProviderRouteExplanation = {
    ...built,
    fallbackProviders: built.fallbackProviders.filter((id) => {
      const type = deps.getProvider(id)?.executionType;
      return type === "local_dispatch" || type === "remote_dispatch";
    }),
    models: Object.fromEntries(ids.map((id) => [id, options.get(id)?.model])),
    ...(built.selectedProvider !== null && options.get(built.selectedProvider)?.model !== undefined
      ? { selectedModel: options.get(built.selectedProvider)?.model as string }
      : {}),
  };
  return { explanation, options, policy };
}

// Preview and execution resolve the same request, policy checks, pins, models and
// fallback list. Probes may have documented effects; no requested generation runs.
export async function explainProviderRoute(
  task: TaskId,
  deps: RouterDependencies = defaultRouterDependencies,
  request: Partial<RouteRequest> = {},
): Promise<ProviderRouteExplanation> {
  return (await requestRoute(task, deps, request)).explanation;
}

// Executes the task against the selected provider. Returns the result
// alongside the explanation that drove the selection.
//
// On no-provider-available, throws `NoProviderAvailableError` whose
// `.explanation` field carries the same `ProviderRouteExplanation`
// callers would have received from `explainProviderRoute(task)`.
export async function routeAndGenerate(
  task: TaskId,
  options: RouteRequest,
  deps: RouterDependencies = defaultRouterDependencies,
): Promise<{
  readonly result: ProviderGenerateResult;
  readonly explanation: ProviderRouteExplanation;
}> {
  const resolved = await requestRoute(task, deps, options);
  const { explanation } = resolved;
  if (explanation.selectedProvider === null) {
    throw new NoProviderAvailableError(task, explanation);
  }

  // M11 fallback policy. Dispatch to the selected provider first, then to
  // each fallback in the deterministic route order. On a RETRYABLE failure
  // (an operational failure of this lane — see failure.ts) advance to the
  // next lane, re-dispatching the SAME options so the prompt is never lost.
  // On a TERMINAL failure (NetworkBoundaryError or anything unrecognised)
  // propagate immediately — D-0012 invariant 3 forbids routing around a
  // safety-boundary violation, and we never mask an unknown error.
  //
  // The returned `explanation` is the pre-dispatch routing DECISION and is
  // left unchanged (deterministic, identical to explainProviderRoute); the
  // lane that actually served is carried on `result.providerId` (D-0019).
  // Per-lane options resolve a default model; explicit pins never broaden.
  const attemptOrder: readonly ProviderId[] = [
    explanation.selectedProvider,
    ...explanation.fallbackProviders,
  ];
  const failures: ProviderFailureEntry[] = [];
  for (let i = 0; i < attemptOrder.length; i += 1) {
    const id = attemptOrder[i] as ProviderId;
    const provider = deps.getProvider(id);
    if (provider?.generate === undefined) {
      // Defence in depth: buildExplanation already excludes providers
      // without `generate`. Hitting this branch means the dep injection
      // changed mid-call, which would itself be a determinism bug.
      throw new NoProviderAvailableError(task, explanation);
    }
    // Only auto-cascade to lanes that actually DISPATCH (produce a model
    // answer). A `manual_handoff` lane emits a packet for the operator to
    // act on — silently substituting it for a failed executor would change
    // the contract (the caller asked for an answer, not a to-do). So a
    // handoff/other non-dispatching lane is used only as the PRIMARY
    // selection (i === 0), never as an automatic fallback target.
    const isFallback = i > 0;
    const dispatches =
      provider.executionType === "local_dispatch" || provider.executionType === "remote_dispatch";
    if (isFallback && !dispatches) {
      continue;
    }
    const effective = resolved.options.get(id) as ProviderGenerateOptions;
    if (options.maxRequestBytes !== undefined) {
      const requestBytes = utf8Bytes(effective.prompt) + utf8Bytes(effective.system ?? "");
      if (!Number.isSafeInteger(options.maxRequestBytes) || options.maxRequestBytes <= 0) {
        throw new Error("request byte limit must be a positive safe integer");
      }
      if (requestBytes > options.maxRequestBytes) {
        throw new Error(
          `request is ${requestBytes} bytes; the combined prompt and system context limit is ${options.maxRequestBytes} bytes. Shorten the prompt or remove context before retrying.`,
        );
      }
    }
    // Recheck immediately before every attempt, including retries/fallback.
    if (id === "anthropic-api") {
      const refusal = apiRefusal(deps, (deps.policy ?? loadRoutingPolicy)(), effective);
      if (refusal !== null) throw new Error(refusal);
    }
    try {
      const result = await provider.generate(effective);
      const warnings = [...(result.warnings ?? []), ...accountingWarnings(result)];
      return { result: { ...result, ...(warnings.length > 0 ? { warnings } : {}) }, explanation };
    } catch (error) {
      if (classifyGenerateFailure(error) === "terminal") {
        throw error;
      }
      failures.push({ id, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  // Every eligible lane failed with a retryable error. Preserve the
  // single-lane behaviour by re-throwing the original error unchanged, so
  // callers' type-based handlers still recognise it; aggregate only when
  // more than one lane was actually attempted.
  const [firstFailure] = failures;
  if (failures.length === 1 && firstFailure !== undefined) {
    throw firstFailure.error;
  }
  throw new AllProvidersFailedError(task, explanation, failures);
}
