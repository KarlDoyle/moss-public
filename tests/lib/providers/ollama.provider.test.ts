import { describe, expect, it } from "vitest";
import {
  type OllamaProviderDependencies,
  ollamaGenerate,
  ollamaProbe,
  ollamaProvider,
} from "../../../src/lib/providers/ollama.ts";
import { ProviderProbeResultSchema } from "../../../src/lib/providers/types.ts";

// Helper: builds a `OllamaProviderDependencies` whose `netFetch` returns
// a single canned response. Used to drive the probe and generate
// branches deterministically without touching the real daemon.
function fakeDeps(canned: {
  status: number;
  ok: boolean;
  body: string;
}): OllamaProviderDependencies {
  return {
    netFetch: async () => ({ status: canned.status, ok: canned.ok, body: canned.body }),
  };
}

const FIXED_NOW = () => new Date(Date.UTC(2026, 4, 22, 15, 0, 0, 0));

describe("ollamaProvider (M3 Provider interface adapter)", () => {
  it("has id 'ollama' and exposes both probe and generate", () => {
    expect(ollamaProvider.id).toBe("ollama");
    expect(typeof ollamaProvider.probe).toBe("function");
    expect(typeof ollamaProvider.generate).toBe("function");
  });

  describe("ollamaProbe", () => {
    it("returns a schema-valid ProviderProbeResult when the daemon is reachable", async () => {
      const result = await ollamaProbe(FIXED_NOW, fakeDeps({ status: 200, ok: true, body: "{}" }));
      expect(ProviderProbeResultSchema.parse(result)).toEqual(result);
      expect(result.id).toBe("ollama");
      expect(result.status).toBe("available");
      expect(result.capabilities.ask).toBe("available");
      expect(result.capabilities["code-review"]).toBe("available");
      expect(result.lastProbedAt).toBe("2026-05-22T15:00:00.000Z");
      expect(result.reason).toMatch(/reachable/);
    });

    it("returns status='unavailable' across all capabilities when the daemon is unreachable", async () => {
      const result = await ollamaProbe(FIXED_NOW, fakeDeps({ status: 500, ok: false, body: "" }));
      expect(result.status).toBe("unavailable");
      expect(result.capabilities.ask).toBe("unavailable");
      expect(result.capabilities["code-review"]).toBe("unavailable");
      expect(result.reason).toMatch(/not reachable/);
    });

    it("never returns 'unknown' — Ollama always has evidence either way (D-0011 no-guessing rule)", async () => {
      const a = await ollamaProbe(FIXED_NOW, fakeDeps({ status: 200, ok: true, body: "{}" }));
      const b = await ollamaProbe(FIXED_NOW, fakeDeps({ status: 503, ok: false, body: "" }));
      expect(a.status).not.toBe("unknown");
      expect(b.status).not.toBe("unknown");
    });
  });

  describe("ollamaGenerate", () => {
    it("refuses to dispatch without a resolved model", async () => {
      await expect(
        ollamaGenerate(
          {
            task: "ask",
            prompt: "hello",
          },
          fakeDeps({ status: 200, ok: true, body: "{}" }),
        ),
      ).rejects.toThrow(/model is required/);
    });

    it("returns a ProviderGenerateResult tagged with providerId='ollama' on success", async () => {
      const body = JSON.stringify({ model: "llama3.2:3b", response: "hello world", done: true });
      const result = await ollamaGenerate(
        { task: "ask", prompt: "hi", model: "llama3.2:3b" },
        fakeDeps({ status: 200, ok: true, body }),
      );
      expect(result.providerId).toBe("ollama");
      expect(result.model).toBe("llama3.2:3b");
      expect(result.response).toBe("hello world");
    });
  });

  it("ollamaProvider.probe() forwards to ollamaProbe() with default deps", async () => {
    // We cannot inject deps through the Provider interface (it would
    // bloat every provider). Instead we sanity-check that the wrapper
    // exists, is callable, and returns a schema-valid shape against the
    // real default deps. The real call will likely return either
    // 'available' (if Ollama is running locally) or 'unavailable' (if
    // not); either is acceptable as long as the shape is correct.
    const result = await ollamaProvider.probe(FIXED_NOW);
    expect(ProviderProbeResultSchema.parse(result)).toEqual(result);
    expect(result.id).toBe("ollama");
    expect(["available", "unavailable"]).toContain(result.status);
  });
});
