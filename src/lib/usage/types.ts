import { z } from "zod";

// Which command produced a generation. Closed union, like the rest of
// Moss's schemas: adding a new producer is a deliberate edit here.
// `ask` records direct model calls; `run` records skill executions;
// `chat` records interactive-session turns (M10). A chat turn must log as
// `chat`, never masquerade as `ask`. See docs/DECISIONS.md D-0019, D-0020.
export const USAGE_COMMANDS = ["ask", "run", "chat"] as const;
export const UsageCommandSchema = z.enum(USAGE_COMMANDS);
export type UsageCommand = z.infer<typeof UsageCommandSchema>;

// One append-only record per local generation. Token counts and
// duration are optional because a provider may not report them; absence
// means "unknown", never zero. The record never contains the prompt or
// the response — only metadata — so the usage log carries no operator
// content and stays safe to keep locally without a privacy review.
export const UsageEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    timestamp: z.string(),
    command: UsageCommandSchema,
    providerId: z.string().min(1),
    model: z.string().min(1),
    task: z.string().min(1).optional(),
    skill: z.string().min(1).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    recordedBy: z.string().min(1),
  })
  .strict();

export type UsageEntry = z.infer<typeof UsageEntrySchema>;
