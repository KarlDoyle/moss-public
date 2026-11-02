import { describe, expect, it } from "vitest";
import {
  getProvider,
  implementedProviders,
  PROVIDER_ORDER,
} from "../../../src/lib/providers/index.ts";
import { PROVIDER_IDS, type ProviderId } from "../../../src/lib/providers/types.ts";

describe("src/lib/providers/index.ts", () => {
  it("PROVIDER_ORDER mirrors PROVIDER_IDS (single source of truth)", () => {
    expect([...PROVIDER_ORDER]).toEqual([...PROVIDER_IDS]);
  });

  it("getProvider('ollama') returns the M3 Ollama provider implementation", () => {
    const provider = getProvider("ollama");
    expect(provider).toBeDefined();
    expect(provider?.id).toBe("ollama");
    expect(typeof provider?.probe).toBe("function");
    expect(typeof provider?.generate).toBe("function");
  });

  it("getProvider('cursor-manual') returns the M3-T05 handoff lane implementation", () => {
    const provider = getProvider("cursor-manual");
    expect(provider).toBeDefined();
    expect(provider?.id).toBe("cursor-manual");
    expect(provider?.executionType).toBe("manual_handoff");
    expect(provider?.requiresModel).toBe(false);
    expect(typeof provider?.probe).toBe("function");
    expect(typeof provider?.generate).toBe("function");
  });

  it("claude-code and anthropic-api are wired as remote_dispatch lanes that DO implement generate", () => {
    const remoteDispatch: ProviderId[] = ["claude-code", "anthropic-api"];
    for (const id of remoteDispatch) {
      const provider = getProvider(id);
      expect(provider, `provider ${id} should be defined`).toBeDefined();
      expect(provider?.id).toBe(id);
      expect(provider?.executionType).toBe("remote_dispatch");
      expect(provider?.requiresModel).toBe(false);
      expect(typeof provider?.probe).toBe("function");
      // Unlike the removed detection-only lanes, these DO execute.
      expect(typeof provider?.generate).toBe("function");
    }
  });

  it("implementedProviders() returns the full PROVIDER_ORDER after M3-T06", () => {
    expect([...implementedProviders()]).toEqual([...PROVIDER_ORDER]);
  });

  it("implementedProviders() preserves PROVIDER_ORDER", () => {
    // As more providers land in T05/T06, this test continues to assert
    // that the returned list is a stable subsequence of PROVIDER_ORDER.
    const result = [...implementedProviders()];
    let lastIndex = -1;
    for (const id of result) {
      const idx = PROVIDER_ORDER.indexOf(id);
      expect(idx, `provider ${id} not in PROVIDER_ORDER`).toBeGreaterThan(-1);
      expect(idx, `provider ${id} out of order`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });
});
