// Provider registry.
//
// This module resolves a `ProviderId` to its concrete `Provider` impl
// and exposes the ordered lane list. It is the only module that knows
// which provider implementations exist; the router (T02) talks to this
// module, never to individual provider files.
//
// In M3-T01 there is exactly one wired provider — Ollama. The other
// five lane ids declared in `PROVIDER_ORDER` exist in the type system
// but have no implementation yet. The router (T02) and detection-only
// lanes (T05/T06) will fill in the remaining entries.

import { anthropicApiProvider } from "./anthropic-api.ts";
import { claudeCodeProvider } from "./claude-code.ts";
import { cursorManualProvider } from "./cursor-manual.ts";
import { liteLlmProvider } from "./litellm.ts";
import { ollamaProvider } from "./ollama.ts";
import { PROVIDER_IDS, type Provider, type ProviderId } from "./types.ts";

// The default route lane order is exactly `PROVIDER_IDS` — that
// constant is the single source of truth for the order documented in
// the M3 design memo, decision 1. Re-exporting under a routing-flavoured
// name makes the intent obvious at call sites.
export const PROVIDER_ORDER: readonly ProviderId[] = PROVIDER_IDS;

// Maps a provider id to its concrete implementation. Lanes that have
// no implementation yet are absent from the map; `getProvider(id)`
// returns `undefined` for those, and the router treats them as
// `not_installed`. T05 wires `cursor-manual`; T06 wires the rest.
const REGISTRY: Partial<Record<ProviderId, Provider>> = {
  ollama: ollamaProvider,
  "claude-code": claudeCodeProvider,
  "anthropic-api": anthropicApiProvider,
  litellm: liteLlmProvider,
  "cursor-manual": cursorManualProvider,
};

export function getProvider(id: ProviderId): Provider | undefined {
  return REGISTRY[id];
}

// Returns every provider id that currently has an implementation, in
// the documented lane order. Useful for tests and for the router's
// "what can actually run?" question.
export function implementedProviders(): readonly ProviderId[] {
  return PROVIDER_ORDER.filter((id) => REGISTRY[id] !== undefined);
}

// Re-exports so callers depending on the public surface don't have to
// reach into the types module directly. Keep this list minimal — every
// re-export here is part of the M3 public contract.
export {
  allCapabilitiesAs,
  defaultUnknownCapabilities,
  EXECUTION_TYPES,
  type ExecutionType,
  ExecutionTypeSchema,
  type HandoffPacket,
  HandoffPacketSchema,
  PROVIDER_IDS,
  PROVIDER_STATUSES,
  type Provider,
  type ProviderCapabilities,
  ProviderCapabilitiesSchema,
  type ProviderGenerateOptions,
  type ProviderGenerateResult,
  type ProviderId,
  ProviderIdSchema,
  type ProviderProbeResult,
  ProviderProbeResultSchema,
  type ProviderStatus,
  ProviderStatusSchema,
  TASK_IDS,
  type TaskId,
  TaskIdSchema,
} from "./types.ts";
