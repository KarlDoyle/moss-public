import { describe, expect, it, vi } from "vitest";
import type { LiteLlmConfig } from "../../../src/lib/litellm/config.ts";
import {
  createLiteLlmProvider,
  LiteLlmDispatchError,
  type LiteLlmProviderDependencies,
  liteLlmGenerate,
  liteLlmProbe,
} from "../../../src/lib/providers/litellm.ts";

const FROZEN_NOW = new Date("2026-05-22T18:00:00.000Z");
const ENABLED: LiteLlmConfig = {
  enabled: true,
  endpointUrl: "http://127.0.0.1:4000",
  models: [{ name: "gpt-4o-mini", viaLiteLLM: true }],
};

function deps(overrides: Partial<LiteLlmProviderDependencies> = {}): LiteLlmProviderDependencies {
  return {
    netFetch: vi.fn(async () => ({ ok: true, status: 200, body: "" })),
    loadConfig: vi.fn(async () => null),
    now: () => FROZEN_NOW,
    ...overrides,
  };
}

describe("liteLlmProbe", () => {
  it("reports not_configured when no config exists", async () => {
    const result = await liteLlmProbe(deps());
    expect(result.status).toBe("not_configured");
    expect(result.reason).toContain("No LiteLLM config");
  });

  it("reports not_configured when config exists but enabled=false", async () => {
    const result = await liteLlmProbe(
      deps({ loadConfig: async () => ({ ...ENABLED, enabled: false }) }),
    );
    expect(result.status).toBe("not_configured");
    expect(result.reason).toContain("enabled: false");
  });

  it("reports available when config is enabled and /health returns 2xx", async () => {
    const netFetch = vi.fn(async () => ({ ok: true, status: 200, body: "ok" }));
    const result = await liteLlmProbe(deps({ loadConfig: async () => ENABLED, netFetch }));
    expect(result.status).toBe("available");
    expect(result.reason).toContain("/health returned 2xx");
    expect(netFetch).toHaveBeenCalledWith("http://127.0.0.1:4000/health", {
      method: "GET",
      timeoutMs: 4_000,
    });
  });

  it("reports unavailable when /health is not 2xx", async () => {
    const result = await liteLlmProbe(
      deps({
        loadConfig: async () => ENABLED,
        netFetch: async () => ({ ok: false, status: 503, body: "" }),
      }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("HTTP 503");
  });

  it("reports unavailable when /health fetch throws", async () => {
    const result = await liteLlmProbe(
      deps({
        loadConfig: async () => ENABLED,
        netFetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("ECONNREFUSED");
  });

  it("reports not_configured with a clear reason when the config is malformed", async () => {
    const result = await liteLlmProbe(
      deps({
        loadConfig: async () => {
          throw new Error("schema violation");
        },
      }),
    );
    expect(result.status).toBe("not_configured");
    expect(result.reason).toContain("malformed");
  });
});

describe("liteLlmGenerate", () => {
  it("POSTs an OpenAI-style chat completion request and extracts content", async () => {
    const netFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hi there" } }],
      }),
    }));
    const result = await liteLlmGenerate(
      { task: "ask", prompt: "say hi", model: "gpt-4o-mini" },
      deps({ loadConfig: async () => ENABLED, netFetch }),
    );
    expect(result.providerId).toBe("litellm");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.response).toBe("Hi there");
    const [url, options] = (netFetch as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:4000/v1/chat/completions");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);
    expect(body.stream).toBe(false);
  });

  it("includes a system message when provided", async () => {
    const netFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    }));
    await liteLlmGenerate(
      { task: "ask", prompt: "hi", model: "m", system: "You are a tester." },
      deps({ loadConfig: async () => ENABLED, netFetch }),
    );
    const body = JSON.parse(
      (netFetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].body as string,
    );
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a tester." });
  });

  it("forwards the requested timeout and cancellation signal", async () => {
    const netFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "fixture" } }] }),
    }));
    const controller = new AbortController();
    await liteLlmGenerate(
      { task: "ask", prompt: "fixture", model: "m", timeoutMs: 1234, signal: controller.signal },
      deps({ loadConfig: async () => ENABLED, netFetch }),
    );
    const call = netFetch.mock.calls[0] as unknown as [
      string,
      { timeoutMs: number; signal: AbortSignal },
    ];
    expect(call[1]).toMatchObject({ timeoutMs: 1234, signal: controller.signal });
  });

  it("rejects when no model is provided", async () => {
    await expect(
      liteLlmGenerate({ task: "ask", prompt: "hi" }, deps({ loadConfig: async () => ENABLED })),
    ).rejects.toBeInstanceOf(LiteLlmDispatchError);
  });

  it("rejects when config is missing or disabled", async () => {
    await expect(
      liteLlmGenerate(
        { task: "ask", prompt: "hi", model: "m" },
        deps({ loadConfig: async () => null }),
      ),
    ).rejects.toBeInstanceOf(LiteLlmDispatchError);
  });

  it("rejects non-2xx responses", async () => {
    await expect(
      liteLlmGenerate(
        { task: "ask", prompt: "hi", model: "m" },
        deps({
          loadConfig: async () => ENABLED,
          netFetch: async () => ({ ok: false, status: 502, body: "" }),
        }),
      ),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("rejects responses without choices[0].message.content", async () => {
    await expect(
      liteLlmGenerate(
        { task: "ask", prompt: "hi", model: "m" },
        deps({
          loadConfig: async () => ENABLED,
          netFetch: async () => ({ ok: true, status: 200, body: JSON.stringify({ choices: [] }) }),
        }),
      ),
    ).rejects.toThrow(/choices\[0\]/);
  });
});

describe("Provider object surface", () => {
  it("createLiteLlmProvider declares remote_dispatch + requiresModel=true", () => {
    const provider = createLiteLlmProvider(deps({ loadConfig: async () => ENABLED }));
    expect(provider.id).toBe("litellm");
    expect(provider.executionType).toBe("remote_dispatch");
    expect(provider.requiresModel).toBe(true);
    expect(typeof provider.probe).toBe("function");
    expect(typeof provider.generate).toBe("function");
  });
});
