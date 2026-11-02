import { z } from "zod";
import { PROVIDER_IDS } from "../providers/types.ts";

// -----------------------------------------------------------------------------
// Closed-union dimensions and outcomes
// -----------------------------------------------------------------------------

// What we measure per eval. Closed by design (D-0011 spirit).
// `latency`    — wall-clock dispatch-to-response time, scored on a
//                deterministic decay curve.
// `format`     — adherence to a requested response shape (e.g. valid
//                JSON containing a specified field).
// `qa`         — small QA correctness via case-insensitive substring
//                match (deliberately tiny; not a benchmark).
export const EVAL_DIMENSIONS = ["latency", "format", "qa"] as const;
export const EvalDimensionSchema = z.enum(EVAL_DIMENSIONS);
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

// Per-eval outcome. `error` means the dispatch itself failed (timeout,
// network boundary, provider error). We score this as a clean 0 for
// confidence and surface the cause; we never silently coerce errors
// into "passing" (D-0011: default-to-unknown, never default-to-success).
export const EVAL_OUTCOMES = ["pass", "fail", "error"] as const;
export const EvalOutcomeSchema = z.enum(EVAL_OUTCOMES);
export type EvalOutcome = (typeof EVAL_OUTCOMES)[number];

// -----------------------------------------------------------------------------
// Eval spec — the recipe for one eval
// -----------------------------------------------------------------------------

export const EvalSpecSchema = z
  .object({
    id: z.string().min(1),
    dimension: EvalDimensionSchema,
    prompt: z.string().min(1),
    // Latency evals: target wall-clock millisecond budget. A response
    // at or below `budgetMs` scores 1.0; longer responses decay
    // linearly to 0 at `failureMs`. Format/qa evals ignore these.
    budgetMs: z.number().int().positive().optional(),
    failureMs: z.number().int().positive().optional(),
    // Format evals: a substring (case-sensitive) that MUST appear in
    // the response. Combined with `expectJson` it also asserts JSON
    // parse and a top-level key/value pair.
    requiresSubstring: z.string().optional(),
    expectJson: z
      .object({
        key: z.string().min(1),
        equals: z.union([z.string(), z.number(), z.boolean()]),
      })
      .optional(),
    // QA evals: any of the listed substrings (case-insensitive) found
    // in the response counts as `pass`. Deliberately permissive — we
    // are checking the model isn't catastrophically wrong, not running
    // a benchmark.
    expectedSubstrings: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type EvalSpec = z.infer<typeof EvalSpecSchema>;

// -----------------------------------------------------------------------------
// Per-eval result + per-model rollup
// -----------------------------------------------------------------------------

export const EvalResultSchema = z
  .object({
    id: z.string().min(1),
    dimension: EvalDimensionSchema,
    outcome: EvalOutcomeSchema,
    // [0, 1]. 1.0 = perfect, 0.0 = total failure / error.
    score: z.number().min(0).max(1),
    durationMs: z.number().int().nonnegative(),
    // One-line operator-facing explanation of WHY this score was
    // assigned. Must not contain credentials or PII (the eval prompts
    // are fixed in source; the response is the operator's own
    // model's output).
    reason: z.string().min(1),
  })
  .strict();
export type EvalResult = z.infer<typeof EvalResultSchema>;

export const ModelEvalsSchema = z
  .object({
    // ISO timestamp of the last `moss models --eval` run for this model.
    lastRunAt: z.string().min(1),
    // Source-of-truth identifier — the moss version that recorded the
    // run. Lets future Moss versions decide whether to trust older
    // eval results.
    recordedBy: z.string().min(1),
    // The provider that dispatched the eval. Currently always `ollama`;
    // recorded against the closed provider union for future-proofing.
    provider: z.enum(PROVIDER_IDS),
    // Aggregate confidence in [0, 1] computed from the per-eval scores
    // by `aggregateConfidence`. Persisted so we don't need to recompute
    // it on every read.
    aggregateScore: z.number().min(0).max(1),
    results: z.array(EvalResultSchema).min(1),
  })
  .strict();
export type ModelEvals = z.infer<typeof ModelEvalsSchema>;
