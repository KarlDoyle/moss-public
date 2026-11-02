// M5 LiteLLM provider lane.
//
// LiteLLM is an external OpenAI-API-compatible proxy that the operator
// runs themselves (Moss does NOT spawn or install it — that's a true
// stop condition per D-0014). When the operator has a local LiteLLM
// running and has populated `config/litellm.json` with `enabled: true`,
// the LiteLLM lane probes the configured endpoint and can dispatch
// `ask` and `code-review` tasks via the OpenAI Chat Completions API
// (the format LiteLLM exposes).
//
// Safety bounds (D-0015):
//   - Localhost-only endpoints. The config schema rejects non-localhost
//     URLs at parse time; `src/lib/net.ts:setLiteLlmEndpoint` rejects
//     non-localhost policies as defence-in-depth.
//   - Moss never spawns the LiteLLM process. The operator runs it.
//   - The operator's config never leaves the project root.
//   - Probe is bounded to a short timeout and never echoes the
//     operator's port choice in error messages routed to public logs.

import {
  defaultLiteLlmConfigLoaderDeps,
  type LiteLlmConfig,
  loadLiteLlmConfig,
} from "../litellm/config.ts";
import { type FetchResult, NetworkBoundaryError, safeFetch } from "../net.ts";
import {
  allCapabilitiesAs,
  type Provider,
  type ProviderGenerateOptions,
  type ProviderGenerateResult,
  type ProviderProbeResult,
} from "./types.ts";

export interface LiteLlmProviderDependencies {
  readonly netFetch: (
    url: string,
    options?: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    },
  ) => Promise<FetchResult>;
  readonly loadConfig: () => Promise<LiteLlmConfig | null>;
  readonly now: () => Date;
}

export const defaultLiteLlmProviderDependencies: LiteLlmProviderDependencies = {
  netFetch: (url, options) =>
    safeFetch(url, {
      method: options?.method ?? "GET",
      ...(options?.headers !== undefined ? { headers: options.headers } : {}),
      ...(options?.body !== undefined ? { body: options.body } : {}),
      timeoutMs: options?.timeoutMs ?? 30_000,
    }),
  loadConfig: () => loadLiteLlmConfig(defaultLiteLlmConfigLoaderDeps),
  now: () => new Date(),
};

// -----------------------------------------------------------------------------
// Probe
// -----------------------------------------------------------------------------

export async function liteLlmProbe(
  deps: LiteLlmProviderDependencies = defaultLiteLlmProviderDependencies,
): Promise<ProviderProbeResult> {
  const lastProbedAt = deps.now().toISOString();

  let config: LiteLlmConfig | null;
  try {
    config = await deps.loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: "litellm",
      status: "not_configured",
      reason: `LiteLLM config is malformed: ${message}. Run \`moss litellm --print-config\` to see the expected shape.`,
      capabilities: allCapabilitiesAs("not_configured"),
      lastProbedAt,
    };
  }

  if (config === null) {
    return {
      id: "litellm",
      status: "not_configured",
      reason:
        "No LiteLLM config at config/litellm.json. Run `moss litellm --print-config > config/litellm.json` and edit before enabling.",
      capabilities: allCapabilitiesAs("not_configured"),
      lastProbedAt,
    };
  }

  if (config.enabled !== true) {
    return {
      id: "litellm",
      status: "not_configured",
      reason:
        "LiteLLM config is present but `enabled: false`. Set `enabled: true` and run `moss litellm --check` to verify.",
      capabilities: allCapabilitiesAs("not_configured"),
      lastProbedAt,
    };
  }

  // Health probe. LiteLLM exposes a `/health` endpoint per the project
  // docs. We use a short timeout because the lane is opt-in and the
  // operator should see fast feedback.
  const healthUrl = `${trimTrailingSlash(config.endpointUrl)}/health`;
  let response: FetchResult;
  try {
    response = await deps.netFetch(healthUrl, { method: "GET", timeoutMs: 4_000 });
  } catch (error) {
    if (error instanceof NetworkBoundaryError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: "litellm",
      status: "unavailable",
      reason: `LiteLLM endpoint did not respond: ${message}. Confirm the proxy is running locally.`,
      capabilities: allCapabilitiesAs("unavailable"),
      lastProbedAt,
    };
  }

  if (!response.ok) {
    return {
      id: "litellm",
      status: "unavailable",
      reason: `LiteLLM /health returned HTTP ${response.status}.`,
      capabilities: allCapabilitiesAs("unavailable"),
      lastProbedAt,
    };
  }

  return {
    id: "litellm",
    status: "available",
    reason:
      "LiteLLM config is enabled and /health returned 2xx. Routing through LiteLLM is enabled for this session (D-0015 — localhost-only).",
    capabilities: allCapabilitiesAs("available"),
    lastProbedAt,
  };
}

// -----------------------------------------------------------------------------
// Generate
// -----------------------------------------------------------------------------

export class LiteLlmDispatchError extends Error {
  constructor(detail: string) {
    super(`LiteLLM dispatch failed: ${detail}.`);
    this.name = "LiteLlmDispatchError";
  }
}

export async function liteLlmGenerate(
  options: ProviderGenerateOptions,
  deps: LiteLlmProviderDependencies = defaultLiteLlmProviderDependencies,
): Promise<ProviderGenerateResult> {
  if (options.model === undefined) {
    throw new LiteLlmDispatchError(
      "Model is required for the LiteLLM lane. Pass --model or set a default model in the registry.",
    );
  }

  const config = await deps.loadConfig();
  if (config === null || config.enabled !== true) {
    throw new LiteLlmDispatchError(
      "LiteLLM is not configured. Run `moss litellm --print-config` and edit config/litellm.json before enabling.",
    );
  }

  const chatUrl = `${trimTrailingSlash(config.endpointUrl)}/v1/chat/completions`;
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: options.prompt });

  const requestBody: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: false,
  };
  if (options.temperature !== undefined) {
    requestBody.temperature = options.temperature;
  }

  let response: FetchResult;
  try {
    response = await deps.netFetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      timeoutMs: 120_000,
    });
  } catch (error) {
    if (error instanceof NetworkBoundaryError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new LiteLlmDispatchError(message);
  }

  if (!response.ok) {
    throw new LiteLlmDispatchError(`LiteLLM /v1/chat/completions returned HTTP ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LiteLlmDispatchError(`Response was not JSON: ${message}`);
  }

  const content = extractFirstMessageContent(parsed);
  if (content === null) {
    throw new LiteLlmDispatchError(
      "Response did not contain choices[0].message.content. Confirm the LiteLLM proxy is OpenAI-API-compatible.",
    );
  }

  return {
    providerId: "litellm",
    model: options.model,
    response: content,
  };
}

function extractFirstMessageContent(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (first === null || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") return null;
  return content;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

// -----------------------------------------------------------------------------
// Provider object
// -----------------------------------------------------------------------------

export const liteLlmProvider: Provider = {
  id: "litellm",
  executionType: "remote_dispatch",
  requiresModel: true,
  probe: () => liteLlmProbe(),
  generate: (options) => liteLlmGenerate(options),
};

export function createLiteLlmProvider(deps: LiteLlmProviderDependencies): Provider {
  return {
    id: "litellm",
    executionType: "remote_dispatch",
    requiresModel: true,
    probe: () => liteLlmProbe(deps),
    generate: (options) => liteLlmGenerate(options, deps),
  };
}
