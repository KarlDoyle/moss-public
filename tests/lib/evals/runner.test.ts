import { describe, expect, it } from "vitest";
import {
  type EvalDispatcher,
  type EvalRunnerDependencies,
  runModelEvals,
} from "../../../src/lib/evals/runner.ts";
import type { EvalSpec } from "../../../src/lib/evals/types.ts";
import { NetworkBoundaryError } from "../../../src/lib/net.ts";

const FROZEN_NOW = new Date("2026-05-22T18:00:00.000Z");

function fixedDeps(monotonicSequence: number[]): EvalRunnerDependencies {
  let i = 0;
  return {
    now: () => FROZEN_NOW,
    monotonic: () => monotonicSequence[Math.min(i++, monotonicSequence.length - 1)] ?? 0,
    mossVersion: "test-0.0.0",
  };
}

function dispatcherFromResponses(responses: Record<string, string>): EvalDispatcher {
  return {
    providerId: "ollama",
    generate: async ({ prompt }) => {
      const response = responses[prompt];
      if (response === undefined) {
        throw new Error(`No fake response wired for prompt: ${prompt}`);
      }
      return { response };
    },
  };
}

const LAT: EvalSpec = {
  id: "lat",
  dimension: "latency",
  prompt: "lat?",
  budgetMs: 100,
  failureMs: 1000,
};
const FMT: EvalSpec = {
  id: "fmt",
  dimension: "format",
  prompt: "fmt?",
  expectJson: { key: "ok", equals: true },
  requiresSubstring: '"ok"',
};
const QA: EvalSpec = {
  id: "qa",
  dimension: "qa",
  prompt: "qa?",
  expectedSubstrings: ["paris"],
};

describe("runModelEvals", () => {
  it("scores every spec and returns a clean ModelEvals rollup", async () => {
    // Two monotonic samples per eval (start, end). 3 specs ⇒ 6 samples.
    const deps = fixedDeps([0, 50, 100, 150, 200, 220]);
    const dispatcher = dispatcherFromResponses({
      "lat?": "ok",
      "fmt?": '{"ok": true}',
      "qa?": "Paris.",
    });
    const evals = await runModelEvals("llama3.2:3b", [LAT, FMT, QA], dispatcher, deps);
    expect(evals.lastRunAt).toBe(FROZEN_NOW.toISOString());
    expect(evals.recordedBy).toBe("moss@test-0.0.0");
    expect(evals.provider).toBe("ollama");
    expect(evals.results.length).toBe(3);
    for (const r of evals.results) {
      expect(r.outcome).toBe("pass");
      expect(r.score).toBe(1);
    }
    expect(evals.aggregateScore).toBe(1);
  });

  it("records dispatch errors as outcome='error' with score 0", async () => {
    const dispatcher: EvalDispatcher = {
      providerId: "ollama",
      generate: async ({ prompt }) => {
        if (prompt === "fmt?") throw new Error("daemon unreachable");
        return { response: "Paris" };
      },
    };
    const deps = fixedDeps([0, 10, 20, 30, 40, 50]);
    const evals = await runModelEvals("m", [LAT, FMT, QA], dispatcher, deps);
    const fmtResult = evals.results.find((r) => r.id === "fmt");
    expect(fmtResult?.outcome).toBe("error");
    expect(fmtResult?.score).toBe(0);
    expect(fmtResult?.reason).toContain("daemon unreachable");
    // Aggregate must drop because one eval failed.
    expect(evals.aggregateScore).toBeLessThan(1);
  });

  it("propagates NetworkBoundaryError verbatim (does not swallow)", async () => {
    const boundaryError = new NetworkBoundaryError(
      "http://evil.example.com/",
      "host not allowlisted",
    );
    const dispatcher: EvalDispatcher = {
      providerId: "ollama",
      generate: async () => {
        throw boundaryError;
      },
    };
    const deps = fixedDeps([0, 10]);
    await expect(runModelEvals("m", [LAT], dispatcher, deps)).rejects.toBe(boundaryError);
  });

  it("rejects an empty spec list with EvalRunnerError", async () => {
    const dispatcher = dispatcherFromResponses({});
    await expect(runModelEvals("m", [], dispatcher, fixedDeps([0]))).rejects.toThrow(
      /spec list is empty/,
    );
  });

  it("rounds and clamps duration to a non-negative integer", async () => {
    const deps = fixedDeps([100, 100.4]); // 0.4ms ⇒ rounds to 0
    const dispatcher = dispatcherFromResponses({ "qa?": "Paris" });
    const evals = await runModelEvals("m", [QA], dispatcher, deps);
    expect(evals.results[0]?.durationMs).toBe(0);
  });

  it("records latency below budget as a pass", async () => {
    const deps = fixedDeps([0, 50]);
    const dispatcher = dispatcherFromResponses({ "lat?": "ok" });
    const evals = await runModelEvals("m", [LAT], dispatcher, deps);
    expect(evals.results[0]?.outcome).toBe("pass");
    expect(evals.results[0]?.score).toBe(1);
  });
});
