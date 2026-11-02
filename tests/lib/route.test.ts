import { describe, expect, it } from "vitest";
import type { Registry } from "../../src/lib/registry.ts";
import { explainRoute, formatRouteExplanationHuman, normaliseTask } from "../../src/lib/route.ts";

function makeRegistry(models: Registry["models"]): Registry {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-22T10:00:00.000Z",
    generatedBy: "moss@test",
    source: "http://127.0.0.1:11434/api/tags",
    models,
  };
}

describe("route.normaliseTask", () => {
  it("recognises known tasks", () => {
    expect(normaliseTask("ask")).toBe("ask");
    expect(normaliseTask("Code-Review")).toBe("code-review");
    expect(normaliseTask("summarise")).toBe("summarise");
    expect(normaliseTask("general")).toBe("general");
  });

  it("falls back to general for unknown input", () => {
    expect(normaliseTask("anything-else")).toBe("general");
    expect(normaliseTask("")).toBe("general");
  });
});

describe("route.explainRoute", () => {
  it("returns null chosen for an empty registry, with actionable rationale", () => {
    const result = explainRoute(makeRegistry([]), "ask");
    expect(result.chosen).toBeNull();
    expect(result.considered).toEqual([]);
    expect(result.rationale.some((r) => r.includes("--refresh"))).toBe(true);
  });

  it("picks the highest-confidence model", () => {
    const registry = makeRegistry([
      { name: "small", provider: "ollama", confidence: 0.8, parameterSize: "3.0B" },
      { name: "big", provider: "ollama", confidence: 0.6, parameterSize: "13.0B" },
    ]);
    const result = explainRoute(registry, "ask");
    expect(result.chosen?.name).toBe("small");
    expect(result.considered.map((m) => m.name)).toEqual(["small", "big"]);
  });

  it("lists 'considered' alternatives separately from chosen", () => {
    const registry = makeRegistry([
      { name: "a", provider: "ollama", confidence: 0.9 },
      { name: "b", provider: "ollama", confidence: 0.5 },
      { name: "c", provider: "ollama", confidence: 0.3 },
    ]);
    const result = explainRoute(registry, "code-review");
    const consideredLine = result.rationale.find((r) => r.startsWith("Considered:"));
    expect(consideredLine).toContain("b (0.50)");
    expect(consideredLine).toContain("c (0.30)");
    expect(consideredLine ?? "").not.toContain("a (0.90)");
  });

  it("explains the multi-lane router and the generation-ready Ollama lane", () => {
    const registry = makeRegistry([{ name: "x", provider: "ollama", confidence: 0.5 }]);
    const result = explainRoute(registry, "ask");
    expect(result.rationale.some((r) => r.includes("multi-lane router"))).toBe(true);
    expect(result.rationale.some((r) => r.toLowerCase().includes("ollama"))).toBe(true);
  });

  it("is deterministic given the same input", () => {
    const registry = makeRegistry([
      { name: "x", provider: "ollama", confidence: 0.7 },
      { name: "y", provider: "ollama", confidence: 0.6 },
    ]);
    const a = explainRoute(registry, "ask");
    const b = explainRoute(registry, "ask");
    expect(a).toEqual(b);
  });
});

describe("route.formatRouteExplanationHuman", () => {
  it("includes the chosen model and rationale", () => {
    const registry = makeRegistry([
      { name: "llama3.2:3b", provider: "ollama", confidence: 0.75, parameterSize: "3.0B" },
    ]);
    const explanation = explainRoute(registry, "ask");
    const formatted = formatRouteExplanationHuman(explanation);
    expect(formatted).toContain("moss models --explain ask");
    expect(formatted).toContain("Chosen: llama3.2:3b");
    expect(formatted).toContain("Rationale:");
  });

  it("shows (none) when the registry is empty", () => {
    const explanation = explainRoute(makeRegistry([]), "general");
    expect(formatRouteExplanationHuman(explanation)).toContain("Chosen: (none");
  });
});
