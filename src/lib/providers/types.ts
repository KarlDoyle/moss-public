// Provider/task/status type machinery for M3.
//
// Every public name in this file is part of the M3 multi-provider
// contract pinned by docs/design/M3-provider-routing.md. All unions are
// closed (Karl decision C-1, recorded in D-0011): adding a new provider
// id or status value is a deliberate edit here, not a runtime accident.
//
// Layering:
//   - types.ts                  — pure types + Zod schemas + ordered ids.
//   - index.ts                  — provider registry; resolves id -> impl.
//   - <provider>.ts             — per-provider implementation of Provider.
//   - router.ts (lands in T02)  — deterministic dispatch over providers.
//
// Nothing in this file performs I/O or imports a provider implementation.
// The provider implementations import FROM this file, not the other way
// around. That keeps the dependency graph one-directional and prevents
// the types module from accidentally pulling in subprocess/network code.

import { z } from "zod";

// -----------------------------------------------------------------------------
// Provider identity (closed union per D-0011)
// -----------------------------------------------------------------------------

// The ordered list of provider ids. The order IS the default route lane
// order from the M3 design memo, decision 1. The router (T02) consumes
// this array as the deterministic preference list, so reordering this
// constant is a routing-behaviour change and requires a memo amendment.
//
// 2026-09-18 (unified router): the three lanes moss routes between — local Ollama, the
// Claude Code subscription (`claude -p`) and the metered Anthropic API — then the two
// optional lanes. The four detection-only lanes (codex, copilot-cli, opencode, apple-local)
// were removed: they could never generate, so no route could ever pick them.
export const PROVIDER_IDS = [
  "ollama",
  "claude-code",
  "anthropic-api",
  "litellm",
  "cursor-manual",
] as const satisfies readonly string[];

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const ProviderIdSchema = z.enum(PROVIDER_IDS);

// -----------------------------------------------------------------------------
// Task identity (closed union)
// -----------------------------------------------------------------------------

// Task ids identify what the operator is asking a provider to do. M3
// inherits the M2 surface plus the generic "ask" task. Adding a new
// task is a deliberate edit here (and an associated router/provider
// update). New skills land as new TaskIds; not every provider supports
// every task and the per-task capability matrix is part of probe output.
export const TASK_IDS = ["ask", "code-review"] as const satisfies readonly string[];

export type TaskId = (typeof TASK_IDS)[number];

export const TaskIdSchema = z.enum(TASK_IDS);

// -----------------------------------------------------------------------------
// Status union (closed)
// -----------------------------------------------------------------------------

// The provider status union. Originally the seven values pinned in the M3
// memo (decision 3); extended for M11 to give routing/fallback richer
// availability signal (D-0011 amendment, recorded in docs/DECISIONS.md):
//   - `auth_required` was renamed to `unauthenticated` to match the M11
//     vocabulary.
//   - `quota_limited`, `offline`, `unhealthy`, `disabled` were added so a
//     probe can say WHY a lane is unusable (rate/quota hit, no network,
//     probe unhealthy, operator-disabled) rather than a flat `unavailable`.
// The existing granular values (`not_installed`, `not_configured`,
// `unsupported`) are kept — they carry information the new set does not.
// `unknown` remains the safe default for any capability the implementation
// has not actively verified. Implementations MUST NOT default to
// `available` without an evidence-bearing probe in the current run. Only
// `available` is selectable by the router; every other value is a
// non-selectable reason.
export const PROVIDER_STATUSES = [
  "available",
  "unavailable",
  "not_installed",
  "not_configured",
  "unauthenticated",
  "unsupported",
  "quota_limited",
  "offline",
  "unhealthy",
  "disabled",
  "unknown",
] as const satisfies readonly string[];

export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const ProviderStatusSchema = z.enum(PROVIDER_STATUSES);

// -----------------------------------------------------------------------------
// Probe output
// -----------------------------------------------------------------------------

// Per-(provider, task) capability. The router (T02) uses the matrix to
// decide whether a given provider can execute a given task; a provider
// whose overall `status` is `available` may still report
// `capabilities[task] = "unsupported"` for tasks it does not support.
export const ProviderCapabilitiesSchema = z.object({
  ask: ProviderStatusSchema,
  "code-review": ProviderStatusSchema,
});

export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

// Probe result for a single provider. The router consumes one of these
// per provider per invocation. `confidence` is omitted (not zero) when
// the provider has no opinion — see the M3 memo, decision 5.
export const ProviderProbeResultSchema = z.object({
  id: ProviderIdSchema,
  status: ProviderStatusSchema,
  reason: z.string(),
  capabilities: ProviderCapabilitiesSchema,
  confidence: z.number().min(0).max(1).optional(),
  lastProbedAt: z.string(),
});

export type ProviderProbeResult = z.infer<typeof ProviderProbeResultSchema>;

// -----------------------------------------------------------------------------
// Execution type (closed union per D-0011, extended for T05)
// -----------------------------------------------------------------------------

// Describes HOW a provider executes a task, not WHAT it executes. The
// router surfaces this on the route explanation so operators can tell
// at a glance whether a successful selection means "Moss talked to a
// local model on your behalf" or "Moss prepared a packet for you to
// hand to another agent". A provider MUST declare its execution type
// truthfully — claiming `local_dispatch` while behaving as a handoff
// (or vice versa) is a routing-correctness bug.
//
// - local_dispatch  — provider contacts a tool running on this box and
//                     returns the tool's output (e.g. Ollama daemon).
// - manual_handoff  — provider builds a structured packet for the
//                     operator to hand to another agent; Moss does NOT
//                     execute the task (e.g. cursor-manual).
// - detection_only  — provider can be probed but has no `generate`
//                     implementation in this build (e.g. T06 lanes
//                     where the underlying CLI is not yet wired).
// - remote_dispatch — reserved for cloud lanes that may land post-M3.
// - unknown         — synthesised when a lane id has no implementation
//                     at all (registry returned undefined).
export const EXECUTION_TYPES = [
  "local_dispatch",
  "manual_handoff",
  "detection_only",
  "remote_dispatch",
  "unknown",
] as const satisfies readonly string[];

export type ExecutionType = (typeof EXECUTION_TYPES)[number];

export const ExecutionTypeSchema = z.enum(EXECUTION_TYPES);

// -----------------------------------------------------------------------------
// Generation surface
// -----------------------------------------------------------------------------

// The generic shape used by the router to invoke a provider. Each
// provider may extend this with provider-specific options via a
// provider-typed sub-options object (M3 keeps the surface minimal; the
// detection-only lanes do not implement `generate` in M3).
//
// `model` is optional: lanes whose `Provider.requiresModel` is `false`
// (e.g. cursor-manual) accept `undefined` and just record the absence
// in their output. Lanes that need a model (e.g. ollama) MUST validate
// `model !== undefined` and throw a clear error if it is.
export interface ProviderGenerateOptions {
  readonly task: TaskId;
  readonly prompt: string;
  readonly model?: string;
  readonly system?: string;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  // Output cap for lanes that take one (anthropic-api `max_tokens`). Ollama keeps its own
  // num_predict cap in src/lib/ollama.ts.
  readonly maxTokens?: number;
  // Context window for local lanes (Ollama num_ctx), from the routing.yaml task row.
  readonly numCtx?: number;
}

// Structured handoff packet (T05). Returned by providers with
// `executionType: "manual_handoff"`. The router does NOT inspect this
// — it just propagates the field on `ProviderGenerateResult`. Consumers
// (`moss ask`) render it as either prose or JSON. The schemaVersion is
// part of the public contract: bumping it is a docs-as-code event.
export const HandoffPacketSchema = z.object({
  schemaVersion: z.literal("handoff_v1"),
  task: TaskIdSchema,
  intendedLane: ProviderIdSchema,
  intendedModel: z.string().nullable(),
  prompt: z.string(),
  system: z.string().optional(),
  temperature: z.number().optional(),
  receivingAgentShouldDo: z.array(z.string()).readonly(),
  receivingAgentMustNotDo: z.array(z.string()).readonly(),
  safetyBoundaries: z.array(z.string()).readonly(),
  provenance: z.object({
    generatedBy: z.string(),
    generatedAt: z.string(),
    lane: ProviderIdSchema,
  }),
});

export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;

export interface ProviderGenerateResult {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly response: string;
  readonly warnings?: readonly string[];
  readonly durationMs?: number;
  // Token usage reported by the provider for this generation, when it
  // exposes one (e.g. Ollama's prompt_eval_count / eval_count). Optional
  // and additive per the minimal-surface note above: providers that
  // cannot report usage omit these, and consumers MUST treat absence as
  // "unknown", never zero. Consumed by the usage log (src/lib/usage); see
  // docs/DECISIONS.md D-0019.
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  // List-price cost of this call in USD, when the lane can say (claude-code reports its own
  // `total_cost_usd`; anthropic-api is computed from usage x the metadata price table).
  // On the subscription lane this is notional — what it would cost on the API.
  readonly costUsd?: number;
  // Set only by providers with executionType='manual_handoff'. When
  // present, callers MUST treat this as authoritative over `response`
  // (which is just the human-rendered view of the same data) and MUST
  // NOT claim the task was executed.
  readonly handoff?: HandoffPacket;
}

// -----------------------------------------------------------------------------
// Provider interface
// -----------------------------------------------------------------------------

// Every provider implements this interface. `generate` is optional
// because detection-only lanes in M3 (`codex`, `copilot-cli`,
// `opencode`, `apple-local` until proven otherwise) do not execute a
// request directly. The router inspects `generate`'s presence to decide
// whether a provider can be the selected provider for a given task, or
// merely a listed lane in the route explanation.
//
// `executionType` is mandatory per T05: every provider declares HOW it
// would execute a task. This is independent of probe status — a lane
// can be `unavailable` AND have `executionType: 'local_dispatch'`. The
// router surfaces the selected provider's execution type on the
// explanation so downstream callers can decide how to render the
// result (in particular, to avoid claiming a handoff lane "executed"
// the task).
//
// `requiresModel` lets callers (notably `moss ask`) skip the registry
// load when the pinned provider can run without a model name. Defaults
// to true at the type level; lanes that genuinely don't need a model
// (cursor-manual in T05; detection-only lanes that lack `generate` in
// T06) override it to false.
export interface Provider {
  readonly id: ProviderId;
  readonly executionType: ExecutionType;
  readonly requiresModel: boolean;
  // Probe the provider's current state. MUST be side-effect-free beyond
  // the explicit "safe probe" calls each provider documents (see
  // src/lib/providers/<id>.ts for the per-provider list). Probes MUST
  // honour the read-only guarantee from D-0009 and decision 4 of the
  // M3 memo: no credential reads, no shell-profile edits, no global
  // installs, no interactive logins.
  probe(now?: () => Date): Promise<ProviderProbeResult>;
  // Execute a task. Optional in M3; absent on detection-only lanes.
  generate?(options: ProviderGenerateOptions): Promise<ProviderGenerateResult>;
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

// All capabilities default to `"unknown"` per decision 3. A provider's
// `probe()` overrides individual entries when it has evidence. The
// router treats any `"unknown"` capability as ineligible for selection
// — the provider must positively assert `"available"` to be picked.
export function defaultUnknownCapabilities(): ProviderCapabilities {
  return {
    ask: "unknown",
    "code-review": "unknown",
  };
}

export function allCapabilitiesAs(status: ProviderStatus): ProviderCapabilities {
  return {
    ask: status,
    "code-review": status,
  };
}
