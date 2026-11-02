// Shared renderer for `ProviderRouteExplanation`.
//
// `moss auth` and `moss ask --explain` both surface the same router
// explanation; they MUST produce byte-identical formatting for the
// same input. Having one renderer ensures the operator-facing status
// (auth) and the dispatch-time preview (ask --explain) cannot drift.
//
// T07 may consolidate this with the M2 model-level explanation in
// `src/lib/route.ts`; until then, this module is the single source
// of truth for provider-level explanation rendering.

import {
  type ExecutionType,
  PROVIDER_ORDER,
  type ProviderId,
  type ProviderStatus,
} from "./index.ts";
import { getProviderMetadata, type ProviderMetadata } from "./metadata.ts";
import type { ProviderRouteExplanation } from "./router.ts";

export interface ExplanationRow {
  readonly id: ProviderId;
  readonly status: ProviderStatus;
  readonly executionReadiness: string;
  readonly reason: string;
  readonly isSelected: boolean;
  // Declarative M11 metadata for this lane (cost/latency/context/offline/
  // suitability). Additive: surfaced in the JSON render for preference-aware
  // callers (M14); the human table does not add a column for it.
  readonly metadata: ProviderMetadata;
}

function executionTypeFor(id: ProviderId, explanation: ProviderRouteExplanation): ExecutionType {
  if (explanation.selectedProvider === id && explanation.selectedExecutionType !== null) {
    return explanation.selectedExecutionType;
  }
  switch (id) {
    case "ollama":
    case "litellm":
      return "local_dispatch";
    case "claude-code":
    case "anthropic-api":
      return "remote_dispatch";
    case "cursor-manual":
      return "manual_handoff";
  }
}

function executionReadiness(
  id: ProviderId,
  status: ProviderStatus,
  explanation: ProviderRouteExplanation,
): string {
  const executionType = executionTypeFor(id, explanation);
  // Any non-available status is a reason the lane can't be used right now;
  // render it directly. Only `available` lanes fall through to the
  // execution-type readiness labels below.
  if (status !== "available") {
    switch (status) {
      case "unavailable":
        return "unavailable";
      case "not_installed":
        return "not installed";
      case "not_configured":
        return "not configured";
      case "unauthenticated":
        return "unauthenticated";
      case "unsupported":
        return "unsupported";
      case "quota_limited":
        return "quota limited";
      case "offline":
        return "offline";
      case "unhealthy":
        return "unhealthy";
      case "disabled":
        return "disabled";
      default:
        return "unknown";
    }
  }
  if (executionType === "manual_handoff") return "manual handoff";
  if (executionType === "detection_only") return "detection-only, no generate implementation";
  if (executionType === "local_dispatch") return "generation-ready";
  if (executionType === "remote_dispatch") return "remote dispatch";
  return "unknown";
}

// Builds one row per `PROVIDER_ORDER` lane from a single explanation.
// Determinism note: iteration order is `PROVIDER_ORDER`, not the
// explanation's `unavailableProviders` order; this keeps the rendered
// output stable across calls and across lanes-added-or-removed events
// (the renderer always shows the full M3 lane surface).
export function rowsFromExplanation(
  explanation: ProviderRouteExplanation,
): readonly ExplanationRow[] {
  const rows: ExplanationRow[] = [];
  for (const id of PROVIDER_ORDER) {
    const metadata = getProviderMetadata(id);
    if (explanation.selectedProvider === id) {
      rows.push({
        id,
        status: "available",
        executionReadiness: executionReadiness(id, "available", explanation),
        reason: explanation.selectedReason,
        isSelected: true,
        metadata,
      });
      continue;
    }
    const fallback = explanation.fallbackProviders.includes(id);
    if (fallback) {
      rows.push({
        id,
        status: "available",
        executionReadiness: executionReadiness(id, "available", explanation),
        reason:
          "Eligible fallback for this task; would be selected if the primary becomes unavailable.",
        isSelected: false,
        metadata,
      });
      continue;
    }
    const unavailable = explanation.unavailableProviders.find((u) => u.id === id);
    if (unavailable !== undefined) {
      rows.push({
        id,
        status: unavailable.status,
        executionReadiness: executionReadiness(id, unavailable.status, explanation),
        reason: unavailable.reason,
        isSelected: false,
        metadata,
      });
      continue;
    }
    // Defensive: explainProviderRoute always classifies every id in
    // its `listProviders()` result. If we get here, the caller has
    // pinned a custom `listProviders()` that omits this id (e.g. a
    // `--provider` pin in T04). Surface that honestly rather than
    // guessing.
    rows.push({
      id,
      status: "unknown",
      executionReadiness: executionReadiness(id, "unknown", explanation),
      reason: "Provider id not present in the active router's listProviders() result.",
      isSelected: false,
      metadata,
    });
  }
  return rows;
}

export interface FormatHumanOptions {
  // Heading line. Each caller supplies their own (e.g. `moss auth`
  // says "Moss provider status", `moss ask --explain` says
  // "Route preview"). Keeping the heading parameterised means the
  // body is shared exactly.
  readonly heading: string;
  // Footer line. Optional; if omitted, no footer is appended. Used
  // by `moss auth` to print the read-only disclaimer.
  readonly footer?: string;
}

// Renders the explanation as a human-readable, column-aligned table.
// The body (after the heading and before the footer) is identical
// across callers — this is the property that prevents drift between
// `moss auth` and `moss ask --explain`.
export function formatRouteExplanationHuman(
  explanation: ProviderRouteExplanation,
  options: FormatHumanOptions,
): string {
  const rows = rowsFromExplanation(explanation);
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  const statusWidth = Math.max(...rows.map((r) => `${r.status} / ${r.executionReadiness}`.length));
  const lines: string[] = [];
  lines.push(`${options.heading} — task='${explanation.task}', probed at ${explanation.probedAt}.`);
  lines.push("");
  for (const row of rows) {
    const marker = row.isSelected ? "*" : " ";
    const id = row.id.padEnd(idWidth);
    const status = `${row.status} / ${row.executionReadiness}`.padEnd(statusWidth);
    lines.push(`${marker} ${id}  ${status}  ${row.reason}`);
  }
  lines.push("");
  if (explanation.selectedProvider !== null) {
    const execNote =
      explanation.selectedExecutionType !== null
        ? ` (execution: ${explanation.selectedExecutionType})`
        : "";
    lines.push(`Selected provider: ${explanation.selectedProvider}${execNote}.`);
    if (explanation.selectedModel !== undefined)
      lines.push(`Selected model: ${explanation.selectedModel}.`);
    if (explanation.selectedExecutionType === "manual_handoff") {
      lines.push(
        "Note: this is a manual-handoff lane. Moss will NOT execute the task; it will produce a structured packet for you to paste into the receiving agent.",
      );
    }
    if (explanation.fallbackProviders.length > 0) {
      lines.push(`Fallback chain: ${explanation.fallbackProviders.join(" -> ")}.`);
    } else {
      lines.push("Fallback chain: (none — no other eligible providers).");
    }
  } else {
    lines.push("Selected provider: none.");
    lines.push(
      "Hint: no provider currently satisfies the active task. See the per-row reason above for each lane.",
    );
  }
  if (explanation.unknownCapabilities.length > 0) {
    lines.push(
      `Unknown capabilities: ${explanation.unknownCapabilities
        .map((u) => `${u.id}/${u.task}`)
        .join(", ")}.`,
    );
  }
  lines.push(
    "Preview skips requested generation; availability probes may contact providers and write probe metadata.",
  );
  if (options.footer !== undefined) {
    lines.push("");
    lines.push(options.footer);
  }
  return lines.join("\n");
}

// Renders the explanation as a stable JSON object. The `providers[]`
// field is the rendered row list; the rest mirrors the router's
// explanation directly. Schema-stable: T07 may extend this with new
// fields, but existing field names + types must not change without
// a decision record.
export function formatRouteExplanationJson(explanation: ProviderRouteExplanation): {
  readonly task: string;
  readonly selectedModel?: string;
  readonly models?: Partial<Record<ProviderId, string>>;
  readonly probedAt: string;
  readonly selectedProvider: ProviderId | null;
  readonly selectedExecutionType: ExecutionType | null;
  readonly fallbackProviders: readonly ProviderId[];
  readonly unknownCapabilities: readonly { readonly id: ProviderId; readonly task: string }[];
  readonly providers: readonly {
    readonly id: ProviderId;
    readonly status: ProviderStatus;
    readonly executionReadiness: string;
    readonly reason: string;
    readonly isSelected: boolean;
    readonly metadata: ProviderMetadata;
  }[];
} {
  const rows = rowsFromExplanation(explanation);
  return {
    task: explanation.task,
    ...(explanation.selectedModel !== undefined
      ? { selectedModel: explanation.selectedModel }
      : {}),
    ...(explanation.models !== undefined ? { models: explanation.models } : {}),
    probedAt: explanation.probedAt,
    selectedProvider: explanation.selectedProvider,
    selectedExecutionType: explanation.selectedExecutionType,
    fallbackProviders: explanation.fallbackProviders,
    unknownCapabilities: explanation.unknownCapabilities,
    providers: rows.map((r) => ({
      id: r.id,
      status: r.status,
      executionReadiness: r.executionReadiness,
      reason: r.reason,
      isSelected: r.isSelected,
      metadata: r.metadata,
    })),
  };
}
