// Pure scoring functions for M4 evals.
//
// Every function in this module is deterministic and side-effect free:
// no I/O, no `Date.now()`, no `process.env`. Determinism is the whole
// point — running the same eval against the same response MUST yield
// the same score, both in tests and in production.

import type { EvalResult, EvalSpec } from "./types.ts";

// -----------------------------------------------------------------------------
// Per-dimension scorers
// -----------------------------------------------------------------------------

// Latency: 1.0 at or below `budgetMs`, 0.0 at or above `failureMs`,
// linear in between. If either is missing we cannot score this eval
// and return 0 with an explanation — callers should treat this as a
// spec error, not a model failure.
export function scoreLatency(
  spec: EvalSpec,
  durationMs: number,
): { score: number; reason: string } {
  if (spec.budgetMs === undefined || spec.failureMs === undefined) {
    return {
      score: 0,
      reason: `Latency eval '${spec.id}' is missing budgetMs/failureMs; cannot score.`,
    };
  }
  if (spec.failureMs <= spec.budgetMs) {
    return {
      score: 0,
      reason: `Latency eval '${spec.id}' has failureMs (${spec.failureMs}) <= budgetMs (${spec.budgetMs}); spec is invalid.`,
    };
  }
  if (durationMs <= spec.budgetMs) {
    return {
      score: 1,
      reason: `Response in ${durationMs}ms is at or under the ${spec.budgetMs}ms budget.`,
    };
  }
  if (durationMs >= spec.failureMs) {
    return {
      score: 0,
      reason: `Response in ${durationMs}ms exceeded the ${spec.failureMs}ms failure threshold.`,
    };
  }
  const range = spec.failureMs - spec.budgetMs;
  const over = durationMs - spec.budgetMs;
  const score = Math.max(0, Math.min(1, 1 - over / range));
  return {
    score,
    reason: `Response in ${durationMs}ms is between budget ${spec.budgetMs}ms and failure ${spec.failureMs}ms; linear score ${score.toFixed(3)}.`,
  };
}

// Format: requires the response to (a) contain `requiresSubstring`
// (case-sensitive, if provided) and/or (b) parse as JSON and contain
// the `expectJson` key/value pair at the top level. Both checks pass →
// 1.0; either fail → 0.0. We do NOT partial-credit a format eval: it
// either adhered to the requested shape or it didn't.
export function scoreFormat(spec: EvalSpec, response: string): { score: number; reason: string } {
  const failures: string[] = [];
  if (spec.requiresSubstring !== undefined) {
    if (!response.includes(spec.requiresSubstring)) {
      failures.push(`response did not contain the required substring '${spec.requiresSubstring}'`);
    }
  }
  if (spec.expectJson !== undefined) {
    const parsed = safeParseJsonObject(response);
    if (parsed === null) {
      failures.push("response did not parse as a JSON object");
    } else if (!Object.hasOwn(parsed, spec.expectJson.key)) {
      failures.push(`response JSON missing required key '${spec.expectJson.key}'`);
    } else if (parsed[spec.expectJson.key] !== spec.expectJson.equals) {
      const actual = JSON.stringify(parsed[spec.expectJson.key]);
      const expected = JSON.stringify(spec.expectJson.equals);
      failures.push(
        `response JSON key '${spec.expectJson.key}' was ${actual}, expected ${expected}`,
      );
    }
  }
  if (failures.length === 0) {
    return { score: 1, reason: `Response matched the expected format for eval '${spec.id}'.` };
  }
  return {
    score: 0,
    reason: `Format eval '${spec.id}' failed: ${failures.join("; ")}.`,
  };
}

// QA: any of `expectedSubstrings` found in the response (case-insensitive)
// → 1.0. None found → 0.0. We intentionally do not penalise extra
// content: the model is allowed to be verbose, just not wrong.
export function scoreQa(spec: EvalSpec, response: string): { score: number; reason: string } {
  if (spec.expectedSubstrings === undefined || spec.expectedSubstrings.length === 0) {
    return {
      score: 0,
      reason: `QA eval '${spec.id}' has no expectedSubstrings; cannot score.`,
    };
  }
  const responseLower = response.toLowerCase();
  for (const expected of spec.expectedSubstrings) {
    if (responseLower.includes(expected.toLowerCase())) {
      return {
        score: 1,
        reason: `Response contained expected substring '${expected}'.`,
      };
    }
  }
  return {
    score: 0,
    reason: `Response contained none of: ${spec.expectedSubstrings.map((s) => `'${s}'`).join(", ")}.`,
  };
}

// -----------------------------------------------------------------------------
// Aggregate
// -----------------------------------------------------------------------------

// Confidence = arithmetic mean of per-eval scores, with `error` outcomes
// counted as 0 (NOT excluded). That way a model whose dispatch errors
// out doesn't get a free pass — its aggregate score drops. Returns 0
// if there are no results (defensive; callers should not invoke this
// with an empty list).
export function aggregateConfidence(results: readonly EvalResult[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, r) => acc + r.score, 0);
  const mean = sum / results.length;
  return Math.max(0, Math.min(1, mean));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function safeParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
