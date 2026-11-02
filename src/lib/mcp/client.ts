// Controlled MCP client — all tool calls go through this module (D-0016).
//
// Moss does NOT spawn MCP servers. The operator runs them locally; Moss
// connects via HTTP JSON-RPC (Streamable HTTP subset). Every call is
// allowlist-checked BEFORE network I/O and logged to reports/mcp-audit.jsonl.

import { type FetchResult, NetworkBoundaryError, safeFetch } from "../net.ts";
import { assertToolAllowlisted, McpToolNotAllowedError, sanitizeToolName } from "./allowlist.ts";
import { defaultMcpAuditDeps, digestArgs, type McpAuditDeps, writeMcpAuditEntry } from "./audit.ts";
import { loadMcpConfig } from "./config.ts";
import type { McpConfig, McpToolCallResult, McpToolDescriptor } from "./types.ts";

export class McpCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCallError";
  }
}

export class McpNotConfiguredError extends Error {
  constructor(detail: string) {
    super(
      `${detail} Run \`moss tools --print-config\` and edit config/mcp.json before enabling MCP.`,
    );
    this.name = "McpNotConfiguredError";
  }
}

export interface McpClientDeps {
  readonly netFetch: (
    url: string,
    options?: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    },
  ) => Promise<FetchResult>;
  readonly loadConfig: () => Promise<McpConfig | null>;
  readonly audit: McpAuditDeps;
  readonly monotonic: () => number;
}

export const defaultMcpClientDeps: McpClientDeps = {
  netFetch: (url, options) =>
    safeFetch(url, {
      method: options?.method ?? "POST",
      ...(options?.headers !== undefined ? { headers: options.headers } : {}),
      ...(options?.body !== undefined ? { body: options.body } : {}),
      timeoutMs: options?.timeoutMs ?? 30_000,
    }),
  loadConfig: () => loadMcpConfig(),
  audit: defaultMcpAuditDeps,
  monotonic: () => performance.now(),
};

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { message?: string };
}

async function mcpJsonRpc(
  endpointUrl: string,
  method: string,
  params: Record<string, unknown>,
  deps: McpClientDeps,
): Promise<unknown> {
  const url = `${trimTrailingSlash(endpointUrl)}/mcp`;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let response: FetchResult;
  try {
    response = await deps.netFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body,
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof NetworkBoundaryError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new McpCallError(`network error calling MCP endpoint: ${message}`);
  }

  if (!response.ok) {
    throw new McpCallError(`MCP endpoint returned HTTP ${response.status}`);
  }

  const parsed = parseJsonRpcBody(response.body);
  if (parsed.error !== undefined) {
    throw new McpCallError(parsed.error.message ?? "MCP JSON-RPC error");
  }
  return parsed.result;
}

function parseJsonRpcBody(body: string): JsonRpcResponse {
  // Streamable HTTP may return SSE; take first data: line with JSON.
  if (body.startsWith("event:") || body.includes("\ndata: ")) {
    for (const line of body.split("\n")) {
      if (line.startsWith("data: ")) {
        return JSON.parse(line.slice(6)) as JsonRpcResponse;
      }
    }
    throw new McpCallError("MCP SSE response contained no data line");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export async function safeMcpListTools(
  serverId: string,
  deps: McpClientDeps = defaultMcpClientDeps,
): Promise<readonly McpToolDescriptor[]> {
  const config = await requireEnabledConfig(deps);
  const server = findServerOrThrow(config, serverId);
  const result = await mcpJsonRpc(server.endpointUrl, "tools/list", {}, deps);
  return parseToolList(result);
}

export async function safeMcpCallTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  deps: McpClientDeps = defaultMcpClientDeps,
): Promise<McpToolCallResult> {
  sanitizeToolName(toolName);
  const start = deps.monotonic();
  const argsDigest = digestArgs(args);

  let config: McpConfig;
  try {
    config = await requireEnabledConfig(deps);
    assertToolAllowlisted(config, serverId, toolName);
  } catch (error) {
    if (error instanceof McpToolNotAllowedError) {
      await writeMcpAuditEntry(
        {
          serverId,
          toolName,
          decision: "denied",
          reason: error.message,
          argsDigest,
        },
        deps.audit,
      );
    }
    throw error;
  }

  const server = findServerOrThrow(config, serverId);

  try {
    const result = await mcpJsonRpc(
      server.endpointUrl,
      "tools/call",
      { name: toolName, arguments: args },
      deps,
    );
    const parsed = parseToolCallResult(result);
    const durationMs = Math.round(deps.monotonic() - start);
    await writeMcpAuditEntry(
      {
        serverId,
        toolName,
        decision: "allowed",
        reason: parsed.isError ? "tool returned isError=true" : "tool call succeeded",
        argsDigest,
        durationMs,
      },
      deps.audit,
    );
    return parsed;
  } catch (error) {
    const durationMs = Math.round(deps.monotonic() - start);
    const message = error instanceof Error ? error.message : String(error);
    await writeMcpAuditEntry(
      {
        serverId,
        toolName,
        decision: "error",
        reason: message,
        argsDigest,
        durationMs,
      },
      deps.audit,
    );
    if (error instanceof NetworkBoundaryError) throw error;
    throw error instanceof McpCallError ? error : new McpCallError(message);
  }
}

async function requireEnabledConfig(deps: McpClientDeps): Promise<McpConfig> {
  let config: McpConfig | null;
  try {
    config = await deps.loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpNotConfiguredError(`MCP config is invalid: ${message}`);
  }
  if (config === null) {
    throw new McpNotConfiguredError("No MCP config at config/mcp.json.");
  }
  if (config.enabled !== true) {
    throw new McpNotConfiguredError("MCP is disabled (`enabled: false`).");
  }
  return config;
}

function findServerOrThrow(config: McpConfig, serverId: string) {
  const server = config.servers.find((s) => s.id === serverId);
  if (server === undefined) {
    throw new McpNotConfiguredError(`Unknown MCP server id '${serverId}'.`);
  }
  return server;
}

function parseToolList(result: unknown): readonly McpToolDescriptor[] {
  if (result === null || typeof result !== "object") return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  const out: McpToolDescriptor[] = [];
  for (const t of tools) {
    if (t === null || typeof t !== "object") continue;
    const name = (t as { name?: unknown }).name;
    if (typeof name !== "string") continue;
    const description = (t as { description?: unknown }).description;
    out.push(typeof description === "string" ? { name, description } : { name });
  }
  return out;
}

function parseToolCallResult(result: unknown): McpToolCallResult {
  if (result === null || typeof result !== "object") {
    throw new McpCallError("tools/call result was not an object");
  }
  const isError = Boolean((result as { isError?: unknown }).isError);
  const contentBlocks = (result as { content?: unknown }).content;
  if (!Array.isArray(contentBlocks)) {
    return { content: JSON.stringify(result), isError };
  }
  const textParts: string[] = [];
  for (const block of contentBlocks) {
    if (block !== null && typeof block === "object") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") textParts.push(text);
    }
  }
  return { content: textParts.join("\n"), isError };
}

// Re-export for tests
export { assertToolAllowlisted, isToolAllowlisted } from "./allowlist.ts";
