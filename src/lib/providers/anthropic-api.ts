// The anthropic-api lane — Claude on the metered Messages API, capped per day by
// config/routing.yaml. Key from the Keychain (src/lib/providers/keychain.ts), never a file.
//
// One non-streaming POST through net.ts's safeFetch — the only remote host moss may reach
// (ANTHROPIC_API_POLICY). Raw HTTP rather than the SDK on purpose: the SDK does its own
// networking, and every moss request must pass the one choke point the boundary tests guard.
import { type FetchResult, NetworkBoundaryError, safeFetch } from "../net.ts";
import { defaultKeychainDeps, type KeychainDeps, resolveApiKey } from "./keychain.ts";
import { claudeModel, listPriceUsd } from "./metadata.ts";
import {
  allCapabilitiesAs,
  type Provider,
  type ProviderGenerateOptions,
  type ProviderGenerateResult,
  type ProviderProbeResult,
} from "./types.ts";

export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8_192;
const TIMEOUT_MS = 600_000;

export class AnthropicApiDispatchError extends Error {
  public readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(`anthropic-api lane: ${message}`);
    this.name = "AnthropicApiDispatchError";
    this.status = status;
  }
}

export interface AnthropicApiDeps {
  readonly keychain: KeychainDeps;
  readonly post: (
    url: string,
    headers: Record<string, string>,
    body: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<FetchResult>;
}

export const defaultAnthropicApiDeps: AnthropicApiDeps = {
  keychain: defaultKeychainDeps,
  post: (url, headers, body, options) =>
    safeFetch(url, {
      method: "POST",
      headers,
      body,
      timeoutMs: options?.timeoutMs ?? TIMEOUT_MS,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    }),
};

interface MessagesResponse {
  model?: string;
  stop_reason?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { type?: string; message?: string };
}

export function createAnthropicApiProvider(
  deps: AnthropicApiDeps = defaultAnthropicApiDeps,
): Provider {
  const probe = async (now: () => Date = () => new Date()): Promise<ProviderProbeResult> => {
    // No network: a key that exists is "available"; whether the budget allows a call is the
    // policy's cap check, and a bad key surfaces as a 401 that falls back to the next lane.
    const key = await resolveApiKey(deps.keychain);
    const status = key === null ? "not_configured" : "available";
    const reason =
      key === null
        ? "no API key: none in the Keychain (item anthropic-api-key) and ANTHROPIC_API_KEY is unset. One-time setup: security add-generic-password -s anthropic-api-key -a \"$USER\" -w '<Console key>'."
        : `API key found (${key.source === "env" ? "ANTHROPIC_API_KEY, exported by `moss api`" : "macOS Keychain"}); metered, capped per day by routing.yaml.`;
    return {
      id: "anthropic-api",
      status,
      reason,
      capabilities: allCapabilitiesAs(status),
      lastProbedAt: now().toISOString(),
    };
  };

  const generate = async (options: ProviderGenerateOptions): Promise<ProviderGenerateResult> => {
    const key = await resolveApiKey(deps.keychain);
    if (key === null)
      throw new AnthropicApiDispatchError("no API key (Keychain or ANTHROPIC_API_KEY).");
    const alias = options.model ?? "sonnet";
    const model = claudeModel(alias)?.id ?? alias;
    const body = JSON.stringify({
      model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(options.system !== undefined && options.system.trim().length > 0
        ? { system: options.system }
        : {}),
      messages: [{ role: "user", content: options.prompt }],
    });
    const started = Date.now();
    let res: FetchResult;
    try {
      res = await deps.post(
        MESSAGES_URL,
        {
          "content-type": "application/json",
          "x-api-key": key.value,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
        {
          timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof NetworkBoundaryError) throw error;
      throw new AnthropicApiDispatchError(error instanceof Error ? error.message : String(error));
    }
    let parsed: MessagesResponse;
    try {
      parsed = JSON.parse(res.body) as MessagesResponse;
    } catch {
      throw new AnthropicApiDispatchError(`HTTP ${res.status}: unreadable body`, res.status);
    }
    if (!res.ok) {
      throw new AnthropicApiDispatchError(
        `HTTP ${res.status}: ${parsed.error?.message ?? parsed.error?.type ?? "error"}`,
        res.status,
      );
    }
    if (parsed.stop_reason === "refusal")
      throw new AnthropicApiDispatchError("the model refused this request.");
    const text = (parsed.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const u = parsed.usage;
    const count = (n: unknown): n is number =>
      typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000;
    const reportedInput =
      count(u?.input_tokens) &&
      (u?.cache_read_input_tokens === undefined || count(u.cache_read_input_tokens)) &&
      (u?.cache_creation_input_tokens === undefined || count(u.cache_creation_input_tokens))
        ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        : undefined;
    const inputTokens = count(reportedInput) ? reportedInput : undefined;
    const outputTokens = count(u?.output_tokens) ? u.output_tokens : undefined;
    const costUsd =
      inputTokens !== undefined && outputTokens !== undefined
        ? listPriceUsd(model, inputTokens, outputTokens)
        : undefined;
    return {
      providerId: "anthropic-api",
      model: alias,
      response: text,
      durationMs: Date.now() - started,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  };

  return {
    id: "anthropic-api",
    executionType: "remote_dispatch",
    requiresModel: false,
    probe,
    generate,
  };
}

export const anthropicApiProvider: Provider = createAnthropicApiProvider();
