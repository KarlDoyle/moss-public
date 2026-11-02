import { describe, expect, it } from "vitest";
import {
  aggregateConfidence,
  scoreFormat,
  scoreLatency,
  scoreQa,
} from "../../../src/lib/evals/scoring.ts";
import type { EvalResult, EvalSpec } from "../../../src/lib/evals/types.ts";

const LAT_SPEC: EvalSpec = {
  id: "lat",
  dimension: "latency",
  prompt: "ok",
  budgetMs: 100,
  failureMs: 1000,
};

describe("scoreLatency", () => {
  it("returns 1.0 at or below budget", () => {
    expect(scoreLatency(LAT_SPEC, 50).score).toBe(1);
    expect(scoreLatency(LAT_SPEC, 100).score).toBe(1);
  });

  it("returns 0.0 at or above failureMs", () => {
    expect(scoreLatency(LAT_SPEC, 1000).score).toBe(0);
    expect(scoreLatency(LAT_SPEC, 5000).score).toBe(0);
  });

  it("decays linearly between budget and failure", () => {
    const mid = scoreLatency(LAT_SPEC, 550).score;
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });

  it("returns 0 with a reason when budgetMs/failureMs are missing", () => {
    const spec: EvalSpec = { id: "x", dimension: "latency", prompt: "p" };
    const result = scoreLatency(spec, 50);
    expect(result.score).toBe(0);
    expect(result.reason).toContain("missing budgetMs");
  });

  it("returns 0 if failureMs <= budgetMs (invalid spec)", () => {
    const spec: EvalSpec = {
      id: "x",
      dimension: "latency",
      prompt: "p",
      budgetMs: 1000,
      failureMs: 500,
    };
    const result = scoreLatency(spec, 50);
    expect(result.score).toBe(0);
    expect(result.reason).toContain("spec is invalid");
  });
});

const FORMAT_SPEC: EvalSpec = {
  id: "fmt",
  dimension: "format",
  prompt: "p",
  requiresSubstring: '"ok"',
  expectJson: { key: "ok", equals: true },
};

describe("scoreFormat", () => {
  it("returns 1.0 when substring + JSON both match", () => {
    expect(scoreFormat(FORMAT_SPEC, '{"ok": true}').score).toBe(1);
  });

  it("returns 0 when JSON parses but key is missing", () => {
    const result = scoreFormat(FORMAT_SPEC, '{"foo": 1, "ok": true}');
    // Has both: substring is `"ok"`, JSON has the key set to true. PASS.
    expect(result.score).toBe(1);
  });

  it("returns 0 when JSON value is wrong", () => {
    const result = scoreFormat(FORMAT_SPEC, '{"ok": false}');
    expect(result.score).toBe(0);
    expect(result.reason).toContain("expected true");
  });

  it("returns 0 when response is not JSON at all", () => {
    expect(scoreFormat(FORMAT_SPEC, "Sure! Here is JSON: yes ok").score).toBe(0);
  });

  it("substring check is case-sensitive", () => {
    expect(scoreFormat(FORMAT_SPEC, '{"OK": true}').score).toBe(0);
  });
});

const QA_SPEC: EvalSpec = {
  id: "qa",
  dimension: "qa",
  prompt: "p",
  expectedSubstrings: ["4", "four"],
};

describe("scoreQa", () => {
  it("matches case-insensitively against any expected substring", () => {
    expect(scoreQa(QA_SPEC, "The answer is 4.").score).toBe(1);
    expect(scoreQa(QA_SPEC, "The answer is FOUR.").score).toBe(1);
    expect(scoreQa(QA_SPEC, "I think it's five.").score).toBe(0);
  });

  it("returns 0 when expectedSubstrings is missing or empty", () => {
    const empty: EvalSpec = { id: "x", dimension: "qa", prompt: "p", expectedSubstrings: [] };
    expect(scoreQa(empty, "anything").score).toBe(0);
  });
});

describe("aggregateConfidence", () => {
  const r = (score: number): EvalResult => ({
    id: "x",
    dimension: "qa",
    outcome: score > 0 ? "pass" : "fail",
    score,
    durationMs: 0,
    reason: "test",
  });

  it("is the arithmetic mean", () => {
    expect(aggregateConfidence([r(1), r(0), r(0.5)])).toBeCloseTo(0.5);
  });

  it("counts errors as 0 (no free pass)", () => {
    const errorResult: EvalResult = { ...r(0), outcome: "error" };
    expect(aggregateConfidence([r(1), errorResult])).toBeCloseTo(0.5);
  });

  it("clamps into [0, 1]", () => {
    expect(aggregateConfidence([])).toBe(0);
  });
});
