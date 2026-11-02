import { z } from "zod";

// Closed unions for MCP audit entries (D-0016).
export const MCP_AUDIT_DECISIONS = ["allowed", "denied", "error"] as const;
export const McpAuditDecisionSchema = z.enum(MCP_AUDIT_DECISIONS);
export type McpAuditDecision = (typeof MCP_AUDIT_DECISIONS)[number];

export const McpServerConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "server id must be lowercase alphanumeric with hyphens"),
    endpointUrl: z.string().min(1),
    // Exact-match allowlist of tool names Moss may invoke on this server.
    allowedTools: z.array(z.string().min(1)).min(1),
    notes: z.string().optional(),
  })
  .strict();

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z
  .object({
    enabled: z.boolean(),
    servers: z.array(McpServerConfigSchema).default([]),
    notes: z.string().optional(),
  })
  .strict();

export type McpConfig = z.infer<typeof McpConfigSchema>;

export const McpAuditEntrySchema = z
  .object({
    timestamp: z.string().min(1),
    serverId: z.string().min(1),
    toolName: z.string().min(1),
    decision: McpAuditDecisionSchema,
    reason: z.string().min(1),
    argsDigest: z.string().min(1),
    durationMs: z.number().int().nonnegative().optional(),
    recordedBy: z.string().min(1),
  })
  .strict();

export type McpAuditEntry = z.infer<typeof McpAuditEntrySchema>;

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
}

export interface McpToolCallResult {
  readonly content: string;
  readonly isError: boolean;
}
