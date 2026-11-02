import { z } from "zod";

export const DOCUMENT_CLASSIFICATIONS = [
  "markdown",
  "text",
  "json",
  "yaml",
  "html",
  "pdf",
  "image",
  "unknown",
] as const;

export const DocumentClassificationSchema = z.enum(DOCUMENT_CLASSIFICATIONS);
export type DocumentClassification = z.infer<typeof DocumentClassificationSchema>;

export const CONVERTIBLE_CLASSIFICATIONS: ReadonlySet<DocumentClassification> = new Set([
  "markdown",
  "text",
  "json",
  "yaml",
  "html",
]);

export const InventoryItemSchema = z.object({
  relativePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string(),
  classification: DocumentClassificationSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const InventoryManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  generatedBy: z.string(),
  approvedFolder: z.string().min(1),
  items: z.array(InventoryItemSchema),
});

export type InventoryManifest = z.infer<typeof InventoryManifestSchema>;

export const ReviewStatusSchema = z.enum(["pending_review", "approved", "rejected"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ReviewQueueItemSchema = z.object({
  id: z.string().min(1),
  sourceRelativePath: z.string().min(1),
  classification: DocumentClassificationSchema,
  derivativeRelativePath: z.string().min(1).optional(),
  status: ReviewStatusSchema,
  note: z.string().optional(),
  updatedAt: z.string(),
});

export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const ReviewQueueSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  generatedBy: z.string(),
  items: z.array(ReviewQueueItemSchema),
});

export type ReviewQueue = z.infer<typeof ReviewQueueSchema>;

export const DocsConfigSchema = z
  .object({
    enabled: z.boolean(),
    approvedFolder: z.string().min(1),
    outputFolder: z.string().min(1).default("output/docs"),
    reviewQueuePath: z.string().min(1).default("output/review/queue.json"),
    notes: z.string().optional(),
  })
  .strict();

export type DocsConfig = z.infer<typeof DocsConfigSchema>;
