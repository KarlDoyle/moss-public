import { z } from "zod";

export const MEMORY_TYPES = ["note", "fact", "preference", "reminder", "unknown"] as const;
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MEMORY_CONFIDENCE_LEVELS = ["verified", "inferred", "unknown"] as const;
export const MemoryConfidenceSchema = z.enum(MEMORY_CONFIDENCE_LEVELS);
export type MemoryConfidence = z.infer<typeof MemoryConfidenceSchema>;

export const MEMORY_STATUSES = ["active", "forgotten"] as const;
export const MemoryStatusSchema = z.enum(MEMORY_STATUSES);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MEMORY_PRIVACY_LEVELS = ["local"] as const;
export const MemoryPrivacyLevelSchema = z.enum(MEMORY_PRIVACY_LEVELS);
export type MemoryPrivacyLevel = z.infer<typeof MemoryPrivacyLevelSchema>;

export const MemorySourceSchema = z
  .object({
    kind: z.literal("operator_cli"),
    command: z.enum(["remember", "recall", "compact", "forget"]),
    generatedBy: z.string().min(1),
  })
  .strict();

export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MemoryEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    content: z.string().min(1),
    type: MemoryTypeSchema,
    tags: z.array(z.string().min(1)).default([]),
    source: MemorySourceSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    confidence: MemoryConfidenceSchema,
    status: MemoryStatusSchema,
    privacyLevel: MemoryPrivacyLevelSchema,
  })
  .strict();

export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const MEMORY_AUDIT_ACTIONS = ["remember", "recall", "compact", "forget"] as const;
export const MemoryAuditActionSchema = z.enum(MEMORY_AUDIT_ACTIONS);
export type MemoryAuditAction = z.infer<typeof MemoryAuditActionSchema>;

export const MemoryAuditEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    timestamp: z.string(),
    action: MemoryAuditActionSchema,
    memoryId: z.string().optional(),
    recordedBy: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict();

export type MemoryAuditEntry = z.infer<typeof MemoryAuditEntrySchema>;

export const RecallResultSchema = z.object({
  ok: z.literal(true),
  query: z.string().optional(),
  tag: z.string().optional(),
  count: z.number().int().nonnegative(),
  entries: z.array(MemoryEntrySchema),
});

export type RecallResult = z.infer<typeof RecallResultSchema>;
