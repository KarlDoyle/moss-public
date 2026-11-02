import { z } from "zod";
import { type FetchResult, NetworkBoundaryError, safeFetch } from "../net.ts";
import { ollamaSafety } from "../ollama.ts";
import {
  allCapabilitiesAs,
  type Provider,
  type ProviderGenerateOptions,
  type ProviderGenerateResult,
  type ProviderProbeResult,
} from "./types.ts";

const TAGS_URL = "http://127.0.0.1:11434/api/tags";
const GENERATE_URL = "http://127.0.0.1:11434/api/generate";

export interface OllamaProviderDependencies {
  readonly netFetch: (
    url: string,
    options?: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    },
  ) => Promise<FetchResult>;
}

export const defaultOllamaProviderDependencies: OllamaProviderDependencies = {
  netFetch: (url, options) =>
    safeFetch(url, {
      method: options?.method ?? "GET",
      ...(options?.headers !== undefined ? { headers: options.headers } : {}),
      ...(options?.body !== undefined ? { body: options.body } : {}),
      timeoutMs: options?.timeoutMs ?? 60_000,
    }),
};

export class OllamaDaemonUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `Ollama daemon at 127.0.0.1:11434 is unavailable: ${detail}. Start the daemon and confirm \`curl http://127.0.0.1:11434/api/tags\`.`,
    );
    this.name = "OllamaDaemonUnavailableError";
  }
}

export class OllamaModelMissingError extends Error {
  public readonly model: string;
  constructor(model: string) {
    super(
      `Ollama model '${model}' is not installed locally. ` +
        `Pull it with \`ollama pull ${model}\` or run \`moss models --refresh\` to update the registry.`,
    );
    this.name = "OllamaModelMissingError";
    this.model = model;
  }
}

const GenerateResponseSchema = z.object({
  model: z.string().optional(),
  response: z.string().optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
  total_duration: z.number().optional(),
  // Token counts reported by Ollama's /api/generate (present on a
  // completed non-streamed response). prompt_eval_count is the number of
  // tokens in the prompt (input); eval_count is the number generated
  // (output). Both optional so an older daemon or a malformed body still
  // parses — usage is recorded as "unknown" rather than failing the call.
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

export interface OllamaGenerateOptions {
  readonly model: string;
  readonly prompt: string;
  readonly system?: string;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  // Context window in tokens. Defaults to resolveNumCtx(); see generate() for why it is
  // never left to the daemon.
  readonly numCtx?: number;
  // Output cap (num_predict) for this call; defaults to resolveNumPredict().
  readonly numPredict?: number;
}

// num_ctx / think / num_predict defaults live in src/lib/ollama.ts — the one place for them.
// Re-exported so existing importers keep working.
export { DEFAULT_NUM_CTX, resolveNumCtx } from "../ollama.ts";

// Local generation is slow — measured 9 tok/s output and ~55 tok/s prompt eval for an 8B
// model on this Mac — and nothing is billed while it waits. 60s capped a reply at roughly
// 500 tokens and could not even read a large prompt; five minutes does both.
export const DEFAULT_GENERATE_TIMEOUT_MS = 300_000;

export interface OllamaGenerateResult {
  readonly model: string;
  readonly response: string;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  // The lane that actually served this generation, when known. The
  // skill runner's router-backed default sets it (and may select a
  // non-Ollama lane); the bare Ollama path leaves it undefined. Lets the
  // usage log record the true provider instead of assuming Ollama.
  readonly providerId?: string;
}

export async function isDaemonReachable(
  deps: OllamaProviderDependencies = defaultOllamaProviderDependencies,
): Promise<boolean> {
  try {
    const result = await deps.netFetch(TAGS_URL, { timeoutMs: 3000 });
    return result.ok;
  } catch (error) {
    // A NetworkBoundaryError means the Moss safety boundary rejected
    // the probe destination itself. That is a security signal, not a
    // "the daemon is down" signal — propagate it so the caller can
    // surface the boundary violation to the user verbatim. Pinned by
    // tests/commands/ask.test.ts ("surfaces a NetworkBoundaryError
    // verbatim").
    if (error instanceof NetworkBoundaryError) {
      throw error;
    }
    return false;
  }
}

export async function generate(
  options: OllamaGenerateOptions,
  deps: OllamaProviderDependencies = defaultOllamaProviderDependencies,
): Promise<OllamaGenerateResult> {
  const requestBody: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
    stream: false,
  };
  if (options.system !== undefined) requestBody.system = options.system;
  // num_ctx, think:false and a num_predict cap are ALWAYS sent (src/lib/ollama.ts). Left
  // unset, Ollama uses the daemon's default window (4096 on this Mac) and silently drops
  // whatever does not fit — the truncation gotcha from the 2026-07-06 portability drill —
  // and a reasoning model thinks until the timeout. Nothing warns when either happens.
  const safety = ollamaSafety({
    ...(options.numCtx !== undefined ? { numCtx: options.numCtx } : {}),
    ...(options.numPredict !== undefined ? { numPredict: options.numPredict } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  requestBody.think = safety.think;
  requestBody.options = safety.options;

  let result: FetchResult;
  try {
    result = await deps.netFetch(GENERATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      timeoutMs: options.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof NetworkBoundaryError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new OllamaDaemonUnavailableError(message);
  }

  if (!result.ok) {
    if (result.status === 404) {
      throw new OllamaModelMissingError(options.model);
    }
    const bodyLower = result.body.toLowerCase();
    if (
      bodyLower.includes("model") &&
      (bodyLower.includes("not found") || bodyLower.includes("does not exist"))
    ) {
      throw new OllamaModelMissingError(options.model);
    }
    throw new OllamaDaemonUnavailableError(`HTTP ${result.status}: ${result.body.slice(0, 200)}`);
  }

  let parsed: z.infer<typeof GenerateResponseSchema>;
  try {
    parsed = GenerateResponseSchema.parse(JSON.parse(result.body));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OllamaDaemonUnavailableError(`malformed response: ${message}`);
  }

  if (parsed.error) {
    const errorLower = parsed.error.toLowerCase();
    if (
      errorLower.includes("model") &&
      (errorLower.includes("not found") || errorLower.includes("does not exist"))
    ) {
      throw new OllamaModelMissingError(options.model);
    }
    throw new OllamaDaemonUnavailableError(parsed.error);
  }

  if (parsed.response === undefined) {
    throw new OllamaDaemonUnavailableError("response body did not include a 'response' field");
  }

  const out: OllamaGenerateResult = {
    model: parsed.model ?? options.model,
    response: parsed.response,
    ...(parsed.total_duration ? { durationMs: parsed.total_duration / 1_000_000 } : {}),
    ...(parsed.prompt_eval_count !== undefined ? { inputTokens: parsed.prompt_eval_count } : {}),
    ...(parsed.eval_count !== undefined ? { outputTokens: parsed.eval_count } : {}),
  };
  return out;
}

// -----------------------------------------------------------------------------
// M3 Provider interface adapter
//
// The Ollama provider as seen by the M3 router. This is a thin shim
// over the existing functions above; the router and call sites in T02
// will dispatch through this object rather than the bare functions.
// We keep the bare exports for the existing (M2) call sites in
// src/commands/ask.ts and src/lib/skills/runner.ts — those rewire to
// the router in M3-T02. Leaving the old surface in place keeps T01
// additive and lets T02 land as a focused router-only change.
//
// Probe contract: side-effect-free beyond a single 3-second GET to the
// allow-listed `http://127.0.0.1:11434/api/tags` endpoint via safeFetch.
// No credential reads, no subprocess invocation. Honours the M3 memo
// decision 4 (read-only `moss auth`) and D-0011's "no guessing" rule:
// if the daemon is unreachable, the probe returns `unavailable`, never
// a speculative `available`.
// -----------------------------------------------------------------------------

// Exported for tests so they can inject `OllamaProviderDependencies`
// without resorting to module-level mocking. Production code uses the
// `ollamaProvider.probe(...)` wrapper below, which forwards to this
// with the default deps.
export async function ollamaProbe(
  now: () => Date = () => new Date(),
  deps: OllamaProviderDependencies = defaultOllamaProviderDependencies,
): Promise<ProviderProbeResult> {
  const lastProbedAt = now().toISOString();
  const reachable = await isDaemonReachable(deps);
  if (reachable) {
    return {
      id: "ollama",
      status: "available",
      reason: "Ollama daemon reachable at 127.0.0.1:11434/api/tags.",
      capabilities: allCapabilitiesAs("available"),
      lastProbedAt,
    };
  }
  return {
    id: "ollama",
    status: "unavailable",
    reason:
      "Ollama daemon not reachable at 127.0.0.1:11434/api/tags. Start the daemon with `ollama serve` or confirm via `curl http://127.0.0.1:11434/api/tags`.",
    capabilities: allCapabilitiesAs("unavailable"),
    lastProbedAt,
  };
}

// Exported for tests. Production code uses `ollamaProvider.generate(...)`.
export async function ollamaGenerate(
  options: ProviderGenerateOptions,
  deps: OllamaProviderDependencies = defaultOllamaProviderDependencies,
): Promise<ProviderGenerateResult> {
  if (options.model === undefined) {
    // The router is responsible for resolving the model name from the
    // registry before calling generate(). If we got here without one
    // it's a router bug, not a user error.
    throw new Error(
      "ollamaProvider.generate: options.model is required. The router must resolve a model before dispatching to Ollama.",
    );
  }
  const generateOptions: OllamaGenerateOptions = {
    model: options.model,
    prompt: options.prompt,
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.numCtx !== undefined ? { numCtx: options.numCtx } : {}),
    ...(options.maxTokens !== undefined ? { numPredict: options.maxTokens } : {}),
  };
  const result = await generate(generateOptions, deps);
  const adapted: ProviderGenerateResult = {
    providerId: "ollama",
    model: result.model,
    response: result.response,
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
  };
  return adapted;
}

export const ollamaProvider: Provider = {
  id: "ollama",
  executionType: "local_dispatch",
  requiresModel: true,
  probe: (now) => ollamaProbe(now),
  generate: (options) => ollamaGenerate(options),
};

// Builder for an Ollama provider with explicit deps. Used by tests and
// by callers (`moss ask`) that already accept `OllamaProviderDependencies`
// as their injection point — the router can be handed a per-call
// Ollama provider built from those deps, instead of forcing every
// caller to learn the full RouterDependencies surface.
export function createOllamaProvider(deps: OllamaProviderDependencies): Provider {
  return {
    id: "ollama",
    executionType: "local_dispatch",
    requiresModel: true,
    probe: (now) => ollamaProbe(now, deps),
    generate: (options) => ollamaGenerate(options, deps),
  };
}
