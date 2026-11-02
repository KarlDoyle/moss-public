import type { Command } from "commander";
import { safeMcpCallTool, safeMcpListTools } from "../lib/mcp/client.ts";
import { loadMcpConfig } from "../lib/mcp/config.ts";
import { assertCapability } from "../lib/policy.ts";

const STARTER_CONFIG = `{
  "enabled": false,
  "servers": [
    {
      "id": "example-echo",
      "endpointUrl": "http://127.0.0.1:3001",
      "allowedTools": ["echo"],
      "notes": "Example allowlisted server. Run your MCP server locally; Moss never spawns it."
    }
  ],
  "notes": "M6: localhost-only MCP endpoints (D-0016). Set enabled:true only after reviewing allowedTools."
}
`;

export interface ToolsCommandOptions {
  readonly mode: "print-config" | "check" | "list" | "call";
  readonly serverId?: string;
  readonly toolName?: string;
  readonly argsJson?: string;
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export async function runToolsCommand(options: ToolsCommandOptions): Promise<number> {
  assertCapability("mcp");

  if (options.mode === "print-config") {
    options.out(STARTER_CONFIG);
    return 0;
  }

  let config: Awaited<ReturnType<typeof loadMcpConfig>>;
  try {
    config = await loadMcpConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss tools: ${message}`);
    return 1;
  }

  if (config === null) {
    options.err(
      "No MCP config at config/mcp.json. Run `moss tools --print-config > config/mcp.json` and edit.",
    );
    return 1;
  }

  if (options.mode === "check") {
    const summary = {
      enabled: config.enabled,
      servers: config.servers.map((s) => ({
        id: s.id,
        endpointUrl: s.endpointUrl,
        allowedTools: s.allowedTools,
      })),
    };
    if (options.emitJson) {
      options.out(JSON.stringify(summary, null, 2));
    } else {
      options.out(`MCP enabled: ${config.enabled}`);
      for (const s of config.servers) {
        options.out(`  - ${s.id} @ ${s.endpointUrl}  allowlist=[${s.allowedTools.join(", ")}]`);
      }
    }
    return config.enabled ? 0 : 1;
  }

  if (options.mode === "list") {
    if (config.enabled !== true) {
      options.err("MCP is disabled. Set enabled:true in config/mcp.json first.");
      return 1;
    }
    const rows: Array<{ serverId: string; tools: Awaited<ReturnType<typeof safeMcpListTools>> }> =
      [];
    for (const server of config.servers) {
      try {
        const tools = await safeMcpListTools(server.id);
        rows.push({ serverId: server.id, tools });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.err(`moss tools --list: ${server.id}: ${message}`);
      }
    }
    if (options.emitJson) {
      options.out(JSON.stringify({ servers: rows }, null, 2));
    } else {
      for (const row of rows) {
        options.out(`Server ${row.serverId}:`);
        for (const tool of row.tools) {
          options.out(`  - ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`);
        }
      }
    }
    return rows.length > 0 ? 0 : 1;
  }

  // call
  const serverId = options.serverId;
  const toolName = options.toolName;
  if (serverId === undefined || toolName === undefined) {
    options.err("Usage: moss tools --server <id> --call-tool <name> [--args '{...}']");
    return 1;
  }
  let args: Record<string, unknown> = {};
  if (options.argsJson !== undefined) {
    try {
      const parsed = JSON.parse(options.argsJson) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        options.err("--args must be a JSON object");
        return 1;
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.err(`--args is not valid JSON: ${message}`);
      return 1;
    }
  }

  try {
    const result = await safeMcpCallTool(serverId, toolName, args);
    if (options.emitJson) {
      options.out(JSON.stringify({ ok: !result.isError, ...result }, null, 2));
    } else {
      options.out(result.content);
    }
    return result.isError ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss tools --call failed: ${message}`);
    return 1;
  }
}

export function registerTools(program: Command): void {
  program
    .command("tools")
    .description("Inspect and use allowlisted MCP tools. Off by default; localhost-only.")
    .option(
      "--print-config",
      "Print a starter MCP config to stdout. Redirect to config/mcp.json and edit.",
    )
    .option(
      "--check",
      "Validate config/mcp.json and print the allowlist (default when no action flag).",
    )
    .option("--list", "List tools from each configured MCP server (requires enabled:true).")
    .option("--server <id>", "MCP server id (with --call-tool).")
    .option("--call-tool <name>", "Invoke an allowlisted tool on --server.")
    .option("--args <json>", "JSON object of tool arguments (with --call-tool).")
    .option("--json", "Emit JSON instead of human-readable text.")
    .action(
      async (commandOpts: {
        printConfig?: boolean;
        check?: boolean;
        list?: boolean;
        server?: string;
        callTool?: string;
        args?: string;
        json?: boolean;
      }) => {
        const globalOpts = program.opts<{ json?: boolean }>();
        let mode: ToolsCommandOptions["mode"] = "check";
        if (commandOpts.printConfig === true) mode = "print-config";
        else if (commandOpts.list === true) mode = "list";
        else if (commandOpts.server !== undefined && commandOpts.callTool !== undefined)
          mode = "call";

        const exitCode = await runToolsCommand({
          mode,
          emitJson: Boolean(commandOpts.json) || Boolean(globalOpts.json),
          out: (line) => process.stdout.write(`${line}\n`),
          err: (line) => process.stderr.write(`${line}\n`),
          ...(commandOpts.server !== undefined ? { serverId: commandOpts.server } : {}),
          ...(commandOpts.callTool !== undefined ? { toolName: commandOpts.callTool } : {}),
          ...(commandOpts.args !== undefined ? { argsJson: commandOpts.args } : {}),
        });
        if (exitCode !== 0) process.exitCode = exitCode;
      },
    );
}
