// M4 eval runner.
//
// Given a model name, a set of eval specs, and an injectable dispatch
// function + clock, runs each spec and returns a scored ModelEvals
// rollup. The runner never throws on individual eval failure — a
// dispatch error becomes an `error` outcome with score 0, the model
// stays in the registry, and the run continues with the next spec.
// This satisfies the M4 acceptance criterion: "A failed eval lowers
// confidence but does not break the tool."

import { MOSS_VERSION } from "../../version.ts";
import { NetworkBoundaryError } from "../net.ts";
import type { ProviderId } from "../providers/types.ts";
import { aggregateConfidence, scoreFormat, scoreLatency, scoreQa } from "./scoring.ts";
import type { EvalDimension, EvalResult, EvalSpec, ModelEvals } from "./types.ts";

// Minimal dispatch surface the runner needs. Mirrors the Ollama
// provider's generate method but is deliberately narrower so tests
// can pin behaviour without faking the whole Provider interface.
export interface EvalDispatcher {
  readonly providerId: ProviderId;
  readonly generate: (input: {
    readonly model: string;
    readonly prompt: string;
  }) => Promise<{ readonly response: string }>;
}

export interface EvalRunnerDependencies {
  readonly now: () => Date;
  // High-resolution monotonic clock for measuring latency. We use a
  // separate clock from `now()` because `Date.now()` can jump on a
  // system clock change. In tests, an injected counter is fine; in
  // production we use `performance.now()`.
  readonly monotonic: () => number;
  readonly mossVersion: string;
}

export const defaultEvalRunnerDependencies: EvalRunnerDependencies = {
  now: () => new Date(),
  monotonic: () => performance.now(),
  mossVersion: MOSS_VERSION,
};

// Cap any single eval at 30s. This is independent of the per-spec
// `failureMs` (which is a scoring threshold, not an abort threshold).
// 30s is enough for a slow local model on warm CPU; longer than that
// almost always means the dispatch itself hung.
const MAX_EVAL_DURATION_MS = 30_000;

export class EvalRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalRunnerError";
  }
}

export async function runModelEvals(
  modelName: string,
  specs: readonly EvalSpec[],
  dispatcher: EvalDispatcher,
  deps: EvalRunnerDependencies = defaultEvalRunnerDependencies,
): Promise<ModelEvals> {
  if (specs.length === 0) {
    throw new EvalRunnerError(
      `Cannot run evals for '${modelName}': spec list is empty. Edit src/lib/evals/specs.ts to add at least one spec.`,
    );
  }

  const results: EvalResult[] = [];
  for (const spec of specs) {
    const start = deps.monotonic();
    try {
      const dispatchPromise = dispatcher.generate({ model: modelName, prompt: spec.prompt });
      const response = await withCap(dispatchPromise, MAX_EVAL_DURATION_MS);
      const durationMs = clampDurationMs(deps.monotonic() - start);
      const { score, reason } = scoreSpec(spec, response.response, durationMs);
      results.push({
        id: spec.id,
        dimension: spec.dimension,
        outcome: score >= 1 ? "pass" : score > 0 ? "pass" : "fail",
        score,
        durationMs,
        reason,
      });
    } catch (error) {
      // NetworkBoundaryError must propagate verbatim (D-0012 — the
      // safety surface preserves named errors). We can't continue
      // running evals if the boundary is rejecting traffic.
      if (error instanceof NetworkBoundaryError) {
        throw error;
      }
      const durationMs = clampDurationMs(deps.monotonic() - start);
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: spec.id,
        dimension: spec.dimension,
        outcome: "error",
        score: 0,
        durationMs,
        reason: `Eval '${spec.id}' did not dispatch cleanly: ${message}`,
      });
    }
  }

  const aggregateScore = aggregateConfidence(results);
  return {
    lastRunAt: deps.now().toISOString(),
    recordedBy: `moss@${deps.mossVersion}`,
    provider: dispatcher.providerId,
    aggregateScore,
    results,
  };
}

function scoreSpec(
  spec: EvalSpec,
  response: string,
  durationMs: number,
): { score: number; reason: string } {
  switch (spec.dimension as EvalDimension) {
    case "latency":
      return scoreLatency(spec, durationMs);
    case "format":
      return scoreFormat(spec, response);
    case "qa":
      return scoreQa(spec, response);
  }
}

function clampDurationMs(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.round(raw);
}

async function withCap<T>(promise: Promise<T>, capMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Eval dispatch exceeded the ${capMs}ms hard cap.`));
    }, capMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
