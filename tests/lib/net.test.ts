import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkBoundaryError, safeFetch } from "../../src/lib/net.ts";
import { getActiveMilestone, setActiveMilestone } from "../../src/lib/policy.ts";

describe("net.safeFetch — M1 boundary", () => {
  const originalMilestone = getActiveMilestone();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setActiveMilestone("M1");
  });

  afterEach(() => {
    setActiveMilestone(originalMilestone);
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("allows http://127.0.0.1:11434", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch as typeof fetch;

    const result = await safeFetch("http://127.0.0.1:11434/api/tags");
    expect(result.ok).toBe(true);
    expect(result.body).toBe("ok");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("allows http://localhost:11434", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = mockFetch as typeof fetch;
    const result = await safeFetch("http://localhost:11434/api/tags");
    expect(result.status).toBe(200);
  });

  it("rejects non-localhost hosts", async () => {
    await expect(safeFetch("https://api.openai.com/v1/models")).rejects.toBeInstanceOf(
      NetworkBoundaryError,
    );
  });

  it("rejects localhost on the wrong port", async () => {
    await expect(safeFetch("http://127.0.0.1:8080/api/tags")).rejects.toBeInstanceOf(
      NetworkBoundaryError,
    );
  });

  it("rejects https on localhost:11434 (ollama is http)", async () => {
    await expect(safeFetch("https://127.0.0.1:11434/api/tags")).rejects.toBeInstanceOf(
      NetworkBoundaryError,
    );
  });

  it("rejects an unparseable URL", async () => {
    await expect(safeFetch("not a url")).rejects.toBeInstanceOf(NetworkBoundaryError);
  });

  it("disables redirects and rejects redirect responses without following them", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/collect" },
      }),
    );
    globalThis.fetch = mockFetch as typeof fetch;

    await expect(safeFetch("http://127.0.0.1:11434/api/tags")).rejects.toBeInstanceOf(
      NetworkBoundaryError,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("passes method, headers, and body through to fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = mockFetch as typeof fetch;

    await safeFetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs).toBeDefined();
    const init = callArgs?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ model: "x" }));
  });
});

describe("net.safeFetch — the one remote host (unified router)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("allows https://api.anthropic.com:443 and nothing else remote", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = mockFetch as typeof fetch;
    await expect(safeFetch("https://api.anthropic.com/v1/messages")).resolves.toMatchObject({
      ok: true,
    });
    for (const url of [
      "http://api.anthropic.com/v1/messages",
      "https://api.anthropic.com:8443/v1/messages",
      "https://evil.api.anthropic.com/v1/messages",
      "https://api.openai.com/v1/models",
    ]) {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(NetworkBoundaryError);
    }
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
