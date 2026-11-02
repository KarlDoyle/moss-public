import { describe, expect, it, vi } from "vitest";
import type { ModelEvals } from "../../src/lib/evals/types.ts";
import type { FetchResult } from "../../src/lib/net.ts";
import { PROVIDER_IDS } from "../../src/lib/providers/types.ts";
import {
  applyEvalResults,
  bestModel,
  isReasoningModel,
  loadRegistry,
  ModelEntrySchema,
  type Registry,
  type RegistryDependencies,
  RegistryInvalidError,
  RegistryNotFoundError,
  refreshRegistry,
  registryPath,
} from "../../src/lib/registry.ts";

const FROZEN_NOW = new Date("2026-05-22T10:00:00.000Z");

const SAMPLE_BODY = JSON.stringify({
  models: [
    {
      name: "llama3.1:latest",
      size: 4920753328,
      details: {
        family: "llama",
        parameter_size: "8.0B",
        quantization_level: "Q4_K_M",
      },
    },
    {
      name: "llama3.2:3b",
      size: 2000000000,
      details: {
        family: "llama",
        parameter_size: "3.0B",
        quantization_level: "Q4_K_M",
      },
    },
  ],
});

function fakeDeps(overrides: Partial<RegistryDependencies> = {}): RegistryDependencies {
  const writes = new Map<string, string>();
  return {
    netFetch: vi.fn(
      async (): Promise<FetchResult> => ({ ok: true, status: 200, body: SAMPLE_BODY }),
    ),
    readFile: vi.fn(async (path: string) => {
      const stored = writes.get(path);
      if (stored === undefined) {
        const error = new Error("ENOENT") as Error & { code?: string };
        error.code = "ENOENT";
        throw error;
      }
      return stored;
    }),
    writeFile: vi.fn(async (path: string, contents: string) => {
      writes.set(path, contents);
    }),
    now: () => FROZEN_NOW,
    ...overrides,
  };
}

describe("registry.refreshRegistry", () => {
  it("writes a schema-version-1 registry from the Ollama tags response", async () => {
    const deps = fakeDeps();
    const registry = await refreshRegistry(deps);
    expect(registry.schemaVersion).toBe(1);
    expect(registry.generatedAt).toBe(FROZEN_NOW.toISOString());
    expect(registry.generatedBy).toMatch(/^moss@\d+\.\d+\.\d+/);
    expect(registry.source).toBe("http://127.0.0.1:11434/api/tags");
    expect(registry.models).toHaveLength(2);
    const names = registry.models.map((m) => m.name).sort();
    expect(names).toEqual(["llama3.1:latest", "llama3.2:3b"]);
  });

  it("assigns higher confidence to smaller models (3B beats 8B)", async () => {
    const deps = fakeDeps();
    const registry = await refreshRegistry(deps);
    const b3 = registry.models.find((m) => m.name === "llama3.2:3b");
    const b8 = registry.models.find((m) => m.name === "llama3.1:latest");
    expect(b3).toBeDefined();
    expect(b8).toBeDefined();
    expect((b3 as (typeof registry.models)[number]).confidence).toBeGreaterThan(
      (b8 as (typeof registry.models)[number]).confidence,
    );
  });

  it("persists provenance fields and a trailing newline", async () => {
    const writeFile = vi.fn();
    const deps = fakeDeps({ writeFile });
    await refreshRegistry(deps);
    expect(writeFile).toHaveBeenCalledOnce();
    const args = writeFile.mock.calls[0];
    expect(args).toBeDefined();
    const contents = args?.[1] as string;
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents).toContain('"schemaVersion": 1');
    expect(contents).toContain('"generatedBy"');
    expect(contents).toContain('"source"');
  });

  it("throws when the Ollama daemon returns non-2xx", async () => {
    const deps = fakeDeps({
      netFetch: vi.fn(async () => ({ ok: false, status: 503, body: "" })),
    });
    await expect(refreshRegistry(deps)).rejects.toThrowError(/HTTP 503/);
  });
});

describe("registry.loadRegistry", () => {
  it("returns the parsed registry written by refreshRegistry", async () => {
    const deps = fakeDeps();
    const refreshed = await refreshRegistry(deps);
    const loaded = await loadRegistry(deps);
    expect(loaded).toEqual(refreshed);
  });

  it("throws RegistryNotFoundError when the file is missing", async () => {
    const deps = fakeDeps();
    await expect(loadRegistry(deps)).rejects.toBeInstanceOf(RegistryNotFoundError);
  });

  it("throws RegistryInvalidError on malformed JSON", async () => {
    const deps = fakeDeps({
      readFile: vi.fn(async () => "{not json"),
    });
    await expect(loadRegistry(deps)).rejects.toBeInstanceOf(RegistryInvalidError);
  });

  it("throws RegistryInvalidError on schema mismatch", async () => {
    const deps = fakeDeps({
      readFile: vi.fn(async () => JSON.stringify({ schemaVersion: 99, models: [] })),
    });
    await expect(loadRegistry(deps)).rejects.toBeInstanceOf(RegistryInvalidError);
  });
});

describe("registry.bestModel", () => {
  it("returns the highest-confidence model", () => {
    const registry: Registry = {
      schemaVersion: 1,
      generatedAt: FROZEN_NOW.toISOString(),
      generatedBy: "moss@test",
      source: "test",
      models: [
        { name: "big", provider: "ollama", confidence: 0.4 },
        { name: "best", provider: "ollama", confidence: 0.9 },
        { name: "small", provider: "ollama", confidence: 0.7 },
      ],
    };
    expect(bestModel(registry)?.name).toBe("best");
  });

  it("returns undefined for an empty registry", () => {
    const registry: Registry = {
      schemaVersion: 1,
      generatedAt: FROZEN_NOW.toISOString(),
      generatedBy: "moss@test",
      source: "test",
      models: [],
    };
    expect(bestModel(registry)).toBeUndefined();
  });
});

describe("registry.applyEvalResults (M4)", () => {
  const SAMPLE_EVALS: ModelEvals = {
    lastRunAt: FROZEN_NOW.toISOString(),
    recordedBy: "moss@test-0.0.0",
    provider: "ollama",
    aggregateScore: 0.4,
    results: [
      {
        id: "lat",
        dimension: "latency",
        outcome: "pass",
        score: 1,
        durationMs: 50,
        reason: "fast",
      },
      {
        id: "fmt",
        dimension: "format",
        outcome: "fail",
        score: 0,
        durationMs: 30,
        reason: "not json",
      },
    ],
  };

  it("overwrites confidence with the eval aggregate and persists results", async () => {
    const deps = fakeDeps();
    await refreshRegistry(deps);
    const updated = await applyEvalResults("llama3.2:3b", SAMPLE_EVALS, deps);
    const target = updated.models.find((m) => m.name === "llama3.2:3b");
    expect(target?.confidence).toBe(0.4);
    expect(target?.evals?.aggregateScore).toBe(0.4);
    expect(target?.evals?.results.length).toBe(2);
  });

  it("leaves other models untouched", async () => {
    const deps = fakeDeps();
    await refreshRegistry(deps);
    const initial = await loadRegistry(deps);
    const beforeOther = initial.models.find((m) => m.name === "llama3.1:latest");
    const updated = await applyEvalResults("llama3.2:3b", SAMPLE_EVALS, deps);
    const afterOther = updated.models.find((m) => m.name === "llama3.1:latest");
    expect(afterOther?.confidence).toBe(beforeOther?.confidence);
    expect(afterOther?.evals).toBeUndefined();
  });

  it("throws when the model is not in the registry", async () => {
    const deps = fakeDeps();
    await refreshRegistry(deps);
    await expect(applyEvalResults("unknown-model", SAMPLE_EVALS, deps)).rejects.toThrow(
      /is not in the registry/,
    );
  });

  it("updates generatedAt to the current time", async () => {
    const deps = fakeDeps();
    await refreshRegistry(deps);
    const updated = await applyEvalResults("llama3.2:3b", SAMPLE_EVALS, deps);
    expect(updated.generatedAt).toBe(FROZEN_NOW.toISOString());
  });
});

describe("registry.registryPath", () => {
  it("resolves under the project root", () => {
    expect(registryPath().endsWith("/registry/models.json")).toBe(true);
  });
});

describe("ModelEntrySchema.provider (M3 C-1 widening)", () => {
  // Per D-0011, the provider field is a closed enum derived from the
  // PROVIDER_IDS constant in src/lib/providers/types.ts. These tests
  // assert (a) every known provider parses, (b) unknown strings fail,
  // (c) the existing single-provider Ollama fixtures still parse, and
  // (d) the schema cannot accept arbitrary strings (no z.string()
  // regression).

  function baseEntry(provider: string): Record<string, unknown> {
    return {
      name: "model-x",
      provider,
      confidence: 0.5,
    };
  }

  it("accepts every documented M3 provider id", () => {
    for (const id of PROVIDER_IDS) {
      expect(() => ModelEntrySchema.parse(baseEntry(id))).not.toThrow();
    }
  });

  it("rejects unknown provider names", () => {
    expect(() => ModelEntrySchema.parse(baseEntry("openai-cloud"))).toThrow();
    expect(() => ModelEntrySchema.parse(baseEntry("does-not-exist"))).toThrow();
    expect(() => ModelEntrySchema.parse(baseEntry(""))).toThrow();
  });

  it("rejects non-string provider values", () => {
    expect(() => ModelEntrySchema.parse({ ...baseEntry("ollama"), provider: 42 })).toThrow();
    expect(() => ModelEntrySchema.parse({ ...baseEntry("ollama"), provider: null })).toThrow();
    expect(() => ModelEntrySchema.parse({ ...baseEntry("ollama"), provider: undefined })).toThrow();
  });

  it("the existing M1/M2 single-provider 'ollama' fixture still parses", async () => {
    // Backwards compatibility: a registry produced by M1 or M2 only ever
    // contained `provider: "ollama"`. The M3 widened schema must
    // continue to accept that exact shape without complaint.
    const deps = fakeDeps();
    const refreshed = await refreshRegistry(deps);
    for (const entry of refreshed.models) {
      expect(() => ModelEntrySchema.parse(entry)).not.toThrow();
    }
  });
});

// Gotcha 3 of Taisce's fallback ladder: a reasoning model without think:false emits thinking
// tokens without limit and looks like a hung daemon. The registry on this Mac ranks qwen3:4b
// first by confidence; picking it cost a five-minute timeout on 2026-09-18.
describe("registry.bestModel skips reasoning models", () => {
  const reg = (models: Registry["models"]): Registry => ({
    schemaVersion: 1,
    generatedAt: FROZEN_NOW.toISOString(),
    generatedBy: "moss@test",
    source: "test",
    models,
  });

  it("prefers a lower-confidence ordinary model over a reasoning one", () => {
    const registry = reg([
      { name: "qwen3:4b", provider: "ollama", confidence: 0.78 },
      { name: "qwen2.5:3b-instruct", provider: "ollama", confidence: 0.78 },
      { name: "llama3.1:latest", provider: "ollama", confidence: 0.7 },
    ]);
    expect(bestModel(registry)?.name).toBe("qwen2.5:3b-instruct");
  });

  it("still returns a reasoning model when it is the only one installed", () => {
    expect(bestModel(reg([{ name: "qwen3:4b", provider: "ollama", confidence: 0.5 }]))?.name).toBe(
      "qwen3:4b",
    );
  });

  it("recognises the reasoning families and leaves near-names alone", () => {
    for (const n of ["qwen3:4b", "qwen3", "deepseek-r1:8b", "qwq:32b", "QWEN3:8b"]) {
      expect(isReasoningModel(n)).toBe(true);
    }
    for (const n of ["qwen2.5:3b-instruct", "llama3.1:latest", "qwen30:1b", "deepseek-coder"]) {
      expect(isReasoningModel(n)).toBe(false);
    }
  });
});
