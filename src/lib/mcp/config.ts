import { readFile } from "node:fs/promises";
import { z } from "zod";
import { joinInsideProject } from "../paths.ts";
import { type McpConfig, McpServerConfigSchema } from "./types.ts";

const CONFIG_RELATIVE = "config/mcp.json";

const LOCALHOST_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const localhostUrl = z.string().refine(
  (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOCALHOST_HOSTS.has(url.hostname);
  },
  {
    message:
      "endpointUrl must be a localhost http(s) URL (D-0016). External MCP endpoints require a future ADR.",
  },
);

export const McpConfigFileSchema = z
  .object({
    enabled: z.boolean(),
    servers: z
      .array(
        McpServerConfigSchema.extend({
          endpointUrl: localhostUrl,
        }),
      )
      .default([]),
    notes: z.string().optional(),
  })
  .strict();

export class McpConfigInvalidError extends Error {
  constructor(path: string, detail: string) {
    super(`MCP config at ${path} is malformed: ${detail}.`);
    this.name = "McpConfigInvalidError";
  }
}

export interface McpConfigLoaderDeps {
  readonly readFile: (path: string) => Promise<string>;
}

export const defaultMcpConfigLoaderDeps: McpConfigLoaderDeps = {
  readFile: (path) => readFile(path, "utf8"),
};

export function mcpConfigPath(): string {
  return joinInsideProject(CONFIG_RELATIVE);
}

export async function loadMcpConfig(
  deps: McpConfigLoaderDeps = defaultMcpConfigLoaderDeps,
): Promise<McpConfig | null> {
  const path = mcpConfigPath();
  let raw: string;
  try {
    raw = await deps.readFile(path);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpConfigInvalidError(path, message);
  }

  const result = McpConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new McpConfigInvalidError(path, result.error.message);
  }
  return result.data;
}

export function enabledLocalhostEndpoints(
  config: McpConfig | null,
): ReadonlyArray<{ host: string; port: number; protocol: "http:" | "https:" }> {
  if (config === null || config.enabled !== true) return [];
  const out: Array<{ host: string; port: number; protocol: "http:" | "https:" }> = [];
  for (const server of config.servers) {
    const url = new URL(server.endpointUrl);
    out.push({
      host: url.hostname,
      port:
        url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number.parseInt(url.port, 10),
      protocol: url.protocol === "https:" ? "https:" : "http:",
    });
  }
  return out;
}
