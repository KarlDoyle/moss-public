import { getActiveMilestone } from "./policy.ts";

export class NetworkBoundaryError extends Error {
  constructor(target: string, reason: string) {
    super(
      `Network call to '${target}' rejected by the Moss safety boundary: ${reason}. All HTTP calls go through src/lib/net.ts and are constrained by the active milestone policy.`,
    );
    this.name = "NetworkBoundaryError";
  }
}

interface UrlPolicy {
  readonly host: string;
  readonly port: number;
  readonly protocol: "http:" | "https:";
}

const M1_ALLOWED: readonly UrlPolicy[] = [
  { host: "127.0.0.1", port: 11434, protocol: "http:" },
  { host: "localhost", port: 11434, protocol: "http:" },
];

// M5: session-local allowlist for the configured LiteLLM endpoint.
// Populated exactly once at session bootstrap from
// `config/litellm.json` (D-0015 — localhost-only). The session
// installer is responsible for calling `setLiteLlmEndpoint` BEFORE any
// fetch through the LiteLLM lane fires. The `null` shape means "no
// dynamic endpoint registered for this session" and is the default.
let liteLlmAllowed: UrlPolicy | null = null;

export function setLiteLlmEndpoint(policy: UrlPolicy | null): void {
  if (policy === null) {
    liteLlmAllowed = null;
    return;
  }
  // Belt-and-braces: even though `loadLiteLlmConfig` rejects non-
  // localhost URLs at schema parse time, we re-enforce the bound here
  // so that nothing else in the process can register a non-localhost
  // entry. Defence in depth.
  const localhostHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!localhostHosts.has(policy.host)) {
    throw new NetworkBoundaryError(
      `${policy.protocol}//${policy.host}:${policy.port}`,
      "setLiteLlmEndpoint refuses a non-localhost host — the M5 LiteLLM lane is localhost-only per D-0015",
    );
  }
  liteLlmAllowed = policy;
}

export function getLiteLlmEndpoint(): UrlPolicy | null {
  return liteLlmAllowed;
}

// M6: session-local allowlist for configured MCP server endpoints
// (D-0016 — localhost-only, operator-run servers).
let mcpAllowed: readonly UrlPolicy[] = [];

export function setMcpEndpoints(policies: readonly UrlPolicy[]): void {
  const localhostHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  for (const policy of policies) {
    if (!localhostHosts.has(policy.host)) {
      throw new NetworkBoundaryError(
        `${policy.protocol}//${policy.host}:${policy.port}`,
        "setMcpEndpoints refuses a non-localhost host — MCP is localhost-only per D-0016",
      );
    }
  }
  mcpAllowed = [...policies];
}

export function getMcpEndpoints(): readonly UrlPolicy[] {
  return mcpAllowed;
}

// 2026-09-18 (unified router): the ONE remote destination moss may call — the Anthropic
// Messages API, used only by the `anthropic-api` lane (src/lib/providers/anthropic-api.ts),
// which is metered and capped per day in config/routing.yaml. HTTPS on 443 only. The
// claude-code lane needs no entry: it runs the `claude` CLI, which does its own networking.
export const ANTHROPIC_API_POLICY: UrlPolicy = {
  host: "api.anthropic.com",
  port: 443,
  protocol: "https:",
};

function dynamicAllowlist(): readonly UrlPolicy[] {
  const extra: UrlPolicy[] = [ANTHROPIC_API_POLICY];
  if (liteLlmAllowed !== null) extra.push(liteLlmAllowed);
  extra.push(...mcpAllowed);
  return [...M1_ALLOWED, ...extra];
}

function policiesForActiveMilestone(): readonly UrlPolicy[] {
  switch (getActiveMilestone()) {
    case "M1":
    case "M2":
      // M2 introduces no new network destinations — the only network user
      // remains the local Ollama daemon at 127.0.0.1:11434.
      return M1_ALLOWED;
    case "M3":
      // M3 adds multi-provider routing but introduces NO new network
      // destinations. Cursor-manual is a copy/paste handoff (no
      // network).
      // Ollama remains the only outbound HTTP target. Any future M3
      // ticket that adds a new destination must extend this case
      // explicitly and update docs/design/M3-provider-routing.md.
      return M1_ALLOWED;
    case "M4":
      // M4 introduces evals (latency, format adherence, simple QA)
      // that run via the existing Ollama provider — no new outbound
      // destinations. Every eval prompt flows through the same
      // 127.0.0.1:11434 endpoint that M1 allowlisted. No remote eval
      // datasets in M4 (the M4 doc forbids them without an explicit
      // ADR).
      return M1_ALLOWED;
    case "M5":
      // M5 adds an OPTIONAL LiteLLM lane bound to localhost only
      // (D-0015). The configured endpoint is installed for the
      // session via `setLiteLlmEndpoint` from the LiteLLM config
      // loader; until that happens, the lane has no allowlist entry.
      // External endpoints are out of scope for M5 and require a
      // future ADR. If `config/litellm.json` is absent or has
      // `enabled: false`, behave identically to M4.
      return dynamicAllowlist();
    case "M6":
    case "M7":
    case "M8":
      // M6 adds OPTIONAL MCP server endpoints (D-0016 — localhost-only,
      // operator-run). Installed at bootstrap via `setMcpEndpoints`.
      // LiteLLM dynamic allowlist from M5 is preserved.
      return dynamicAllowlist();
    default:
      // Conservative fallback: if a new milestone is added without an
      // explicit case, we treat it as M1-equivalent. New milestones MUST
      // add an explicit case above before broadening the policy.
      return M1_ALLOWED;
  }
}

function assertUrlAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetworkBoundaryError(rawUrl, "URL is not parseable");
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const policies = policiesForActiveMilestone();
  const allowed = policies.some(
    (p) => p.host === url.hostname && p.port === port && p.protocol === url.protocol,
  );
  if (!allowed) {
    const milestone = getActiveMilestone();
    throw new NetworkBoundaryError(
      rawUrl,
      `host=${url.hostname} port=${port} protocol=${url.protocol} is not in the active ${milestone} allowlist (localhost Ollama, configured localhost endpoints, and api.anthropic.com:443 only)`,
    );
  }
  return url;
}

export interface FetchOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface FetchResult {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
}

export async function safeFetch(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  const url = assertUrlAllowed(rawUrl);

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );

  let externalAbort: (() => void) | undefined;
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      const handler = () => controller.abort(options.signal?.reason);
      options.signal.addEventListener("abort", handler, { once: true });
      externalAbort = () => options.signal?.removeEventListener("abort", handler);
    }
  }

  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      signal: controller.signal,
      redirect: "manual",
    };
    if (options.body !== undefined) {
      init.body = options.body;
    }
    const res = await fetch(url, init);
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      throw new NetworkBoundaryError(
        url.toString(),
        `redirect response (${res.status}) is not permitted; redirects are disabled to preserve the network allowlist`,
      );
    }
    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
    externalAbort?.();
  }
}
