import type { McpConfig, McpServerConfig } from "./types.ts";

export class McpToolNotAllowedError extends Error {
  public readonly serverId: string;
  public readonly toolName: string;

  constructor(serverId: string, toolName: string, reason: string) {
    super(
      `MCP tool '${toolName}' on server '${serverId}' is not allowlisted: ${reason}. Edit config/mcp.json to add an explicit allowedTools entry.`,
    );
    this.name = "McpToolNotAllowedError";
    this.serverId = serverId;
    this.toolName = toolName;
  }
}

export function findServer(config: McpConfig, serverId: string): McpServerConfig | undefined {
  return config.servers.find((s) => s.id === serverId);
}

// Exact-match only — no globs, no prefixes (D-0016).
export function isToolAllowlisted(server: McpServerConfig, toolName: string): boolean {
  return server.allowedTools.includes(toolName);
}

export function assertToolAllowlisted(
  config: McpConfig,
  serverId: string,
  toolName: string,
): McpServerConfig {
  if (config.enabled !== true) {
    throw new McpToolNotAllowedError(
      serverId,
      toolName,
      "MCP is disabled (`enabled: false` in config/mcp.json)",
    );
  }
  const server = findServer(config, serverId);
  if (server === undefined) {
    throw new McpToolNotAllowedError(serverId, toolName, `unknown server id '${serverId}'`);
  }
  if (!isToolAllowlisted(server, toolName)) {
    throw new McpToolNotAllowedError(
      serverId,
      toolName,
      `tool is not in allowedTools [${server.allowedTools.join(", ")}]`,
    );
  }
  return server;
}

// Reject tool names that look like injection/path tricks even before
// allowlist lookup — defence in depth for poisoned tool catalogs.
const FORBIDDEN_TOOL_NAME = /[\s/\\<>]|^\.|\.\./;

export function sanitizeToolName(toolName: string): void {
  if (toolName.length === 0) {
    throw new McpToolNotAllowedError("?", toolName, "tool name is empty");
  }
  if (FORBIDDEN_TOOL_NAME.test(toolName)) {
    throw new McpToolNotAllowedError(
      "?",
      toolName,
      "tool name contains forbidden characters (exact alphanumeric/underscore/hyphen only)",
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(toolName)) {
    throw new McpToolNotAllowedError("?", toolName, "tool name must match ^[A-Za-z0-9_-]+$");
  }
}
