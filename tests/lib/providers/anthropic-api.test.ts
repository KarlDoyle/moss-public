import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_VERSION,
  type AnthropicApiDeps,
  createAnthropicApiProvider,
  MESSAGES_URL,
} from "../../../src/lib/providers/anthropic-api.ts";
import { classifyGenerateFailure } from "../../../src/lib/providers/failure.ts";
import { keychainItem, resolveApiKey } from "../../../src/lib/providers/keychain.ts";

// Built at runtime so no key-shaped literal sits in the repo (secret-scan).
const FAKE_KEY = ["sk", "ant", "unit", "test"].join("-");
const now = () => new Date("2026-09-18T12:00:00Z");

function deps(
  body: object,
  status = 200,
  env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: FAKE_KEY },
  keychain: string | null = null,
) {
  const post = vi.fn(async () => ({ status, ok: status < 400, body: JSON.stringify(body) }));
  const d: AnthropicApiDeps = { keychain: { env, readKeychain: async () => keychain }, post };
  return { d, post };
}

const reply = {
  model: "claude-sonnet-5",
  stop_reason: "end_turn",
  content: [
    { type: "thinking", text: "" },
    { type: "text", text: "Hello" },
    { type: "text", text: " there" },
  ],
  usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
};

describe("keychain", () => {
  it("prefers the env the `moss api` function exported, then the Keychain item", async () => {
    expect(
      await resolveApiKey({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, readKeychain: async () => "k2" }),
    ).toEqual({
      value: FAKE_KEY,
      source: "env",
    });
    const read = vi.fn(async () => "k2");
    expect(await resolveApiKey({ env: { USER: "karl" }, readKeychain: read })).toEqual({
      value: "k2",
      source: "keychain",
    });
    expect(read).toHaveBeenCalledWith("anthropic-api-key", "karl");
    expect(await resolveApiKey({ env: {}, readKeychain: async () => null })).toBeNull();
    expect(
      keychainItem({ ESTATE_MODE_API_KEY_SERVICE: "s", ESTATE_MODE_API_KEY_ACCOUNT: "a" }),
    ).toEqual({
      service: "s",
      account: "a",
    });
  });
});

describe("anthropic-api probe", () => {
  it("is available with a key and never touches the network", async () => {
    const { d, post } = deps(reply);
    const probe = await createAnthropicApiProvider(d).probe(now);
    expect(probe.status).toBe("available");
    expect(probe.reason).toContain("moss api");
    expect(probe.reason).not.toContain(FAKE_KEY);
    expect(post).not.toHaveBeenCalled();
  });

  it("is not_configured without a key, and says how to add one", async () => {
    const probe = await createAnthropicApiProvider(deps(reply, 200, {}).d).probe(now);
    expect(probe.status).toBe("not_configured");
    expect(probe.reason).toContain("security add-generic-password");
  });

  it("names the Keychain as the source when the key came from there", async () => {
    const probe = await createAnthropicApiProvider(deps(reply, 200, {}, "kc").d).probe(now);
    expect(probe.reason).toContain("macOS Keychain");
  });
});

describe("anthropic-api generate", () => {
  it("posts one Messages request with the model id, system and cap, and prices the call", async () => {
    const { d, post } = deps(reply);
    const controller = new AbortController();
    const result = await createAnthropicApiProvider(d).generate?.({
      task: "ask",
      prompt: "hi",
      system: "SYS",
      model: "sonnet",
      maxTokens: 100,
      timeoutMs: 1234,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      providerId: "anthropic-api",
      model: "sonnet",
      response: "Hello there",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costUsd: 12,
    });
    const [url, headers, body] = post.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      string,
    ];
    expect(url).toBe(MESSAGES_URL);
    expect(headers["x-api-key"]).toBe(FAKE_KEY);
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    const posted = post.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      string,
      { timeoutMs: number; signal: AbortSignal },
    ];
    expect(posted[3]).toEqual({ timeoutMs: 1234, signal: controller.signal });
    expect(JSON.parse(body)).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 100,
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("fails retryably on HTTP errors, refusals, bad bodies and no key — never echoing the key", async () => {
    const cases: Array<[AnthropicApiDeps, string]> = [
      [
        deps({ error: { type: "authentication_error", message: "invalid x-api-key" } }, 401).d,
        "HTTP 401: invalid x-api-key",
      ],
      [deps({ ...reply, stop_reason: "refusal" }).d, "refused"],
      [deps(reply, 200, {}).d, "no API key"],
    ];
    for (const [d, message] of cases) {
      const error = await createAnthropicApiProvider(d)
        .generate?.({ task: "ask", prompt: "x" })
        .catch((e: unknown) => e);
      expect(String(error)).toContain(message);
      expect(String(error)).not.toContain(FAKE_KEY);
      expect(classifyGenerateFailure(error)).toBe("retryable");
    }
    const bad: AnthropicApiDeps = {
      keychain: { env: { ANTHROPIC_API_KEY: FAKE_KEY }, readKeychain: async () => null },
      post: async () => ({ status: 502, ok: false, body: "<html>" }),
    };
    await expect(
      createAnthropicApiProvider(bad).generate?.({ task: "ask", prompt: "x" }),
    ).rejects.toThrow("HTTP 502: unreadable body");
    const thrown: AnthropicApiDeps = {
      ...bad,
      post: async () => Promise.reject(new Error("ECONNRESET")),
    };
    await expect(
      createAnthropicApiProvider(thrown).generate?.({ task: "ask", prompt: "x" }),
    ).rejects.toThrow("ECONNRESET");
  });
});
