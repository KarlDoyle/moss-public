import { describe, expect, it } from "vitest";
import { PROVIDER_IDS } from "../../../src/lib/providers/index.ts";
import {
  claudeModel,
  getProviderMetadata,
  LANE_TASK_TYPES,
  listPriceUsd,
  PROVIDER_METADATA,
} from "../../../src/lib/providers/metadata.ts";

const TEXT_TASKS = ["route", "brief", "reason", "edit"] as const;

describe("src/lib/providers/metadata.ts", () => {
  it("declares metadata for every provider id (closed coverage)", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_METADATA[id]).toBeDefined();
      expect(getProviderMetadata(id)).toBe(PROVIDER_METADATA[id]);
    }
    // No stray entries beyond the closed provider union.
    expect(Object.keys(PROVIDER_METADATA).sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it("ollama is billed local and serves all six lane task types", () => {
    const m = getProviderMetadata("ollama");
    expect(m.billing).toBe("local");
    expect([...m.capabilities].sort()).toEqual([...LANE_TASK_TYPES].sort());
    expect(m.offlineSupport).toBe(true);
  });

  it("claude-code is billed sub and text-only (route/brief/reason/edit)", () => {
    const m = getProviderMetadata("claude-code");
    expect(m.billing).toBe("sub");
    expect([...m.capabilities].sort()).toEqual([...TEXT_TASKS].sort());
  });

  it("anthropic-api is billed eur and text-only (route/brief/reason/edit)", () => {
    const m = getProviderMetadata("anthropic-api");
    expect(m.billing).toBe("eur");
    expect([...m.capabilities].sort()).toEqual([...TEXT_TASKS].sort());
  });

  it("uses only valid billing values and honest hints for every lane", () => {
    const validBilling = new Set(["local", "sub", "eur", "manual"]);
    for (const id of PROVIDER_IDS) {
      const m = getProviderMetadata(id);
      expect(validBilling.has(m.billing)).toBe(true);
      // maxContext is a positive number or explicitly null (unknown/model-dependent).
      expect(m.maxContext === null || m.maxContext > 0).toBe(true);
      expect(typeof m.offlineSupport).toBe("boolean");
      expect(Array.isArray(m.capabilities)).toBe(true);
      expect(Array.isArray(m.taskSuitability)).toBe(true);
    }
  });

  it("listPriceUsd computes list price for a known model", () => {
    expect(listPriceUsd("sonnet", 1_000_000, 1_000_000)).toBe(12);
  });

  it("listPriceUsd returns undefined for an unknown model, never a guess", () => {
    expect(listPriceUsd("does-not-exist", 1_000_000, 1_000_000)).toBeUndefined();
  });

  it("claudeModel resolves both aliases and raw model ids", () => {
    expect(claudeModel("opus")?.id).toBe("claude-opus-5");
    expect(claudeModel("claude-opus-5")?.id).toBe("claude-opus-5");
    expect(claudeModel("does-not-exist")).toBeUndefined();
  });
});
