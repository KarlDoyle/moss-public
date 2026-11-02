import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MOSS_VERSION } from "../../version.ts";
import { joinInsideProject } from "../paths.ts";
import { type McpAuditEntry, McpAuditEntrySchema } from "./types.ts";

const AUDIT_RELATIVE = "reports/mcp-audit.jsonl";

export interface McpAuditDeps {
  readonly appendFile: (path: string, data: string) => Promise<void>;
  readonly now: () => Date;
  readonly mossVersion: string;
}

export const defaultMcpAuditDeps: McpAuditDeps = {
  appendFile: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, data, "utf8");
  },
  now: () => new Date(),
  mossVersion: MOSS_VERSION,
};

export function mcpAuditPath(): string {
  return joinInsideProject(AUDIT_RELATIVE);
}

export function digestArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args ?? {});
    if (json.length <= 120) return json;
    return `${json.slice(0, 117)}...`;
  } catch {
    return "(unserializable)";
  }
}

export async function writeMcpAuditEntry(
  partial: Omit<McpAuditEntry, "timestamp" | "recordedBy">,
  deps: McpAuditDeps = defaultMcpAuditDeps,
): Promise<McpAuditEntry> {
  const entry: McpAuditEntry = McpAuditEntrySchema.parse({
    ...partial,
    timestamp: deps.now().toISOString(),
    recordedBy: `moss@${deps.mossVersion}`,
  });
  const line = `${JSON.stringify(entry)}\n`;
  await deps.appendFile(mcpAuditPath(), line);
  return entry;
}
