import { describe, expect, it, vi } from "vitest";
import { runModelsCommand } from "../../src/commands/models.ts";
import type { RegistryDependencies } from "../../src/lib/registry.ts";

const FROZEN_NOW = new Date("2026-05-22T10:00:00.000Z");

function fakeDeps(initialBody?: string): RegistryDependencies {
  const writes = new Map<string, string>();
  return {
    netFetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      body:
        initialBody ??
        JSON.stringify({
          models: [
            {
              name: "llama3.2:3b",
              size: 2000000000,
              details: { family: "llama", parameter_size: "3.0B", quantization_level: "Q4_K_M" },
            },
          ],
        }),
    })),
    readFile: vi.fn(async (p: string) => {
      const stored = writes.get(p);
      if (stored === undefined) {
        const err = new Error("ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      }
      return stored;
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      writes.set(p, c);
    }),
    now: () => FROZEN_NOW,
  };
}

describe("runModelsCommand", () => {
  it("--refresh writes the registry and prints it", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const result = await runModelsCommand({
      refresh: true,
      emitJson: false,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      deps: fakeDeps(),
    });
    expect(result).not.toBeNull();
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("llama3.2:3b");
    expect(out[0]).toContain("confidence=");
  });

  it("reads the registry after a refresh", async () => {
    const deps = fakeDeps();
    const out: string[] = [];
    const err: string[] = [];
    await runModelsCommand({
      refresh: true,
      emitJson: false,
      out: () => undefined,
      err: () => undefined,
      deps,
    });
    const result = await runModelsCommand({
      refresh: false,
      emitJson: true,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      deps,
    });
    expect(result).not.toBeNull();
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] ?? "");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.models[0].name).toBe("llama3.2:3b");
  });

  it("returns null and writes to err when no registry exists", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const result = await runModelsCommand({
      refresh: false,
      emitJson: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      deps: fakeDeps(),
    });
    expect(result).toBeNull();
    expect(out).toEqual([]);
    expect(err[0]).toContain("Registry file not found");
    expect(err[0]).toContain("--refresh");
  });

  it("--explain prints a route explanation including the chosen model", async () => {
    const deps = fakeDeps();
    const out: string[] = [];
    const err: string[] = [];
    await runModelsCommand({
      refresh: true,
      emitJson: false,
      out: () => undefined,
      err: () => undefined,
      deps,
    });
    const result = await runModelsCommand({
      refresh: false,
      explain: "ask",
      emitJson: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      deps,
    });
    expect(result).not.toBeNull();
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("moss models --explain ask");
    expect(out[0]).toContain("Chosen: llama3.2:3b");
  });

  it("--explain --json returns a JSON explanation", async () => {
    const deps = fakeDeps();
    await runModelsCommand({
      refresh: true,
      emitJson: false,
      out: () => undefined,
      err: () => undefined,
      deps,
    });
    const out: string[] = [];
    const err: string[] = [];
    const result = await runModelsCommand({
      refresh: false,
      explain: "code-review",
      emitJson: true,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      deps,
    });
    expect(result).not.toBeNull();
    expect(err).toEqual([]);
    const parsed = JSON.parse(out[0] ?? "");
    // M3-T07: --explain now emits a two-layer envelope. The M2
    // model-level explanation lives under `modelExplanation`; the M3
    // provider-level explanation lives under `providerExplanation`
    // (or `null` for tasks outside the closed TASK_IDS union).
    expect(parsed.modelExplanation.task).toBe("code-review");
    expect(parsed.modelExplanation.chosen.name).toBe("llama3.2:3b");
    expect(Array.isArray(parsed.modelExplanation.rationale)).toBe(true);
    expect(parsed.providerExplanation).not.toBeNull();
    expect(parsed.providerExplanation.task).toBe("code-review");
    expect(Array.isArray(parsed.providerExplanation.providers)).toBe(true);
  });

  it("handles an empty Ollama response with helpful text", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const result = await runModelsCommand({
      refresh: true,
      emitJson: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      deps: fakeDeps(JSON.stringify({ models: [] })),
    });
    expect(result).not.toBeNull();
    expect(err).toEqual([]);
    expect(out[0]).toContain("No models registered");
  });
});

describe("runModelsCommand --eval (M4)", () => {
  const SPEC = {
    id: "qa-paris",
    dimension: "qa" as const,
    prompt: "What is the capital city of France?",
    expectedSubstrings: ["paris"],
  };

  function fixedRunnerDeps() {
    let i = 0;
    return {
      now: () => FROZEN_NOW,
      monotonic: () => [0, 25, 50, 75][Math.min(i++, 3)] ?? 0,
      mossVersion: "test-0.0.0",
    };
  }

  function passingDispatcher() {
    return {
      providerId: "ollama" as const,
      generate: async () => ({ response: "Paris" }),
    };
  }

  it("runs the eval suite, persists results, and updates confidence", async () => {
    const deps = fakeDeps();
    // First refresh so the registry exists.
    await runModelsCommand({
      refresh: true,
      emitJson: false,
      out: () => undefined,
      err: () => undefined,
      deps,
    });

    const out: string[] = [];
    const err: string[] = [];
    const result = await runModelsCommand({
      refresh: false,
      evalAll: true,
      emitJson: true,
      evalSpecs: [SPEC],
      evalDispatcher: passingDispatcher(),
      evalRunnerDeps: fixedRunnerDeps(),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      deps,
    });
    expect(err).toEqual([]);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(out[0] ?? "{}");
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0].model).toBe("llama3.2:3b");
    expect(parsed.models[0].aggregateScore).toBe(1);
    expect(parsed.models[0].results[0].id).toBe("qa-paris");
    // The registry must now carry the eval rollup and updated
    // confidence.
    expect(result?.models[0]?.confidence).toBe(1);
    expect(result?.models[0]?.evals?.aggregateScore).toBe(1);
  });

  it("emits an empty result list (not an error) when the registry has no models", async () => {
    const deps = fakeDeps(JSON.stringify({ models: [] }));
    await runModelsCommand({
      refresh: true,
      emitJson: false,
      out: () => undefined,
      err: () => undefined,
      deps,
    });
    const out: string[] = [];
    const err: string[] = [];
    const result = await runModelsCommand({
      refresh: false,
      evalAll: true,
      emitJson: true,
      evalSpecs: [SPEC],
      evalDispatcher: passingDispatcher(),
      evalRunnerDeps: fixedRunnerDeps(),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      deps,
    });
    expect(err).toEqual([]);
    expect(result).not.toBeNull();
    expect(JSON.parse(out[0] ?? "{}")).toEqual({ models: [] });
  });

  it("returns RegistryNotFoundError cleanly when no registry exists", async () => {
    const deps = fakeDeps();
    const out: string[] = [];
    const err: string[] = [];
    const result = await runModelsCommand({
      refresh: false,
      evalAll: true,
      emitJson: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      deps,
    });
    expect(result).toBeNull();
    expect(err.join("\n")).toContain("Registry file not found");
  });
});
