// Built-in eval specs for M4.
//
// These are intentionally tiny. The M4 acceptance criteria forbid
// large benchmarks and remote datasets. Every spec here is:
//   - source-code-fixed (no fetching, no datasets)
//   - deterministic (the response side is variable; the spec is not)
//   - safety-respecting (no PII in prompts, no creds, no exfiltration)
//
// Adding a new spec is a deliberate edit of this file. The closed
// `EvalDimension` union plus `EvalSpecSchema` mean a bad spec is
// rejected at parse time.

import type { EvalSpec } from "./types.ts";

// -----------------------------------------------------------------------------
// Latency
// -----------------------------------------------------------------------------

// Tiny prompt → tiny response. We measure wall-clock dispatch time.
// 1500ms is a generous budget for a small local model (7B-class on
// modest hardware); 8000ms is the failure threshold. These constants
// are deliberately conservative — we never want the eval itself to be
// flaky in the operator's setup.
export const LATENCY_OK: EvalSpec = {
  id: "latency-ok",
  dimension: "latency",
  prompt: "Reply with exactly the word: ok",
  budgetMs: 1500,
  failureMs: 8000,
};

// -----------------------------------------------------------------------------
// Format adherence
// -----------------------------------------------------------------------------

// Asks the model to emit a single JSON object with a known shape. The
// scorer requires both the substring `"ok":true` (proving the model
// didn't just produce prose) AND that the JSON parses with the
// expected key/value pair. Permissive whitespace/quoting is handled
// by the JSON parser.
export const FORMAT_JSON_OK: EvalSpec = {
  id: "format-json-ok",
  dimension: "format",
  prompt:
    'Respond with EXACTLY one JSON object: {"ok": true}. No prose, no markdown, no code fence, no extra keys.',
  requiresSubstring: '"ok"',
  expectJson: { key: "ok", equals: true },
};

// -----------------------------------------------------------------------------
// Simple QA
// -----------------------------------------------------------------------------

// Three tiny QA prompts. Each is deliberately mundane and unambiguous:
// the model would need to be catastrophically broken to fail them. The
// QA scorer accepts any of the listed substrings (case-insensitive).
export const QA_ARITHMETIC: EvalSpec = {
  id: "qa-arithmetic",
  dimension: "qa",
  prompt: "What is 2 + 2? Reply with just the number.",
  expectedSubstrings: ["4", "four"],
};

export const QA_SUCCESSION: EvalSpec = {
  id: "qa-succession",
  dimension: "qa",
  prompt: "The year that comes immediately after 1999 is what number?",
  expectedSubstrings: ["2000"],
};

export const QA_CAPITAL: EvalSpec = {
  id: "qa-capital",
  dimension: "qa",
  prompt: "What is the capital city of France? Reply with one word.",
  expectedSubstrings: ["paris"],
};

// -----------------------------------------------------------------------------
// Canonical set
// -----------------------------------------------------------------------------

export const DEFAULT_EVAL_SPECS: readonly EvalSpec[] = [
  LATENCY_OK,
  FORMAT_JSON_OK,
  QA_ARITHMETIC,
  QA_SUCCESSION,
  QA_CAPITAL,
];
