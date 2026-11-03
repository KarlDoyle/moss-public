import { describe, expect, it } from "vitest";
import { NetworkBoundaryError } from "../../../src/lib/net.ts";
import { DEFAULT_NUM_PREDICT } from "../../../src/lib/ollama.ts";
import {
  DEFAULT_GENERATE_TIMEOUT_MS,
  DEFAULT_NUM_CTX,
  generate,
  isDaemonReachable,
  OllamaDaemonUnavailableError,
  OllamaModelMissingError,
  type OllamaProviderDependencies,
  resolveNumCtx,
} from "../../../src/lib/providers/ollama.ts";

function fakeDeps(fetchImpl: OllamaProviderDependencies["netFetch"]): OllamaProviderDependencies {
  return { netFetch: fetchImpl };
}

describe("ollama.isDaemonReachable", () => {
  it("returns true when /api/tags responds 200", async () => {
    const deps = fakeDeps(async () => ({ ok: true, status: 200, body: "{}" }));
    expect(await isDaemonReachable(deps)).toBe(true);
  });

  it("returns false when fetch throws", async () => {
    const deps = fakeDeps(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await isDaemonReachable(deps)).toBe(false);
  });

  it("returns false on non-2xx", async () => {
    const deps = fakeDeps(async () => ({ ok: false, status: 502, body: "" }));
    expect(await isDaemonReachable(deps)).toBe(false);
  });
});

describe("ollama.generate", () => {
  it("returns response text on success", async () => {
    const deps = fakeDeps(async (_url, _opts) => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        model: "llama3.2:3b",
        response: "hello world",
        done: true,
        total_duration: 5_000_000_000,
      }),
    }));
    const result = await generate({ model: "llama3.2:3b", prompt: "hi" }, deps);
    expect(result.response).toBe("hello world");
    expect(result.model).toBe("llama3.2:3b");
    expect(result.durationMs).toBe(5000);
  });

  it("parses prompt_eval_count and eval_count into input/output tokens", async () => {
    const deps = fakeDeps(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        model: "llama3.2:3b",
        response: "hi",
        done: true,
        prompt_eval_count: 42,
        eval_count: 7,
      }),
    }));
    const result = await generate({ model: "llama3.2:3b", prompt: "hi" }, deps);
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(7);
  });

  it("omits token counts when the daemon does not report them", async () => {
    const deps = fakeDeps(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ model: "m", response: "hi" }),
    }));
    const result = await generate({ model: "m", prompt: "hi" }, deps);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  it("posts JSON to /api/generate with stream=false", async () => {
    interface CapturedCall {
      readonly url: string;
      readonly method: string;
      readonly body: string;
    }
    const calls: CapturedCall[] = [];
    const deps = fakeDeps(async (url, opts) => {
      calls.push({ url, method: opts?.method ?? "GET", body: opts?.body ?? "" });
      return { ok: true, status: 200, body: JSON.stringify({ response: "ok" }) };
    });
    await generate({ model: "x", prompt: "p" }, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/generate");
    expect(calls[0]?.method).toBe("POST");
    // num_ctx, think:false and num_predict are always present (src/lib/ollama.ts) — this
    // used to pin a body without them, which is the silent truncation bug and the runaway
    // reasoning-model bug. Still an exact match, so nothing else can creep in unnoticed.
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      model: "x",
      prompt: "p",
      stream: false,
      think: false,
      options: { num_ctx: DEFAULT_NUM_CTX, num_predict: DEFAULT_NUM_PREDICT },
    });
  });

  it("includes system and temperature when provided", async () => {
    let capturedBody = "";
    const deps = fakeDeps(async (_url, opts) => {
      capturedBody = opts?.body ?? "";
      return { ok: true, status: 200, body: JSON.stringify({ response: "ok" }) };
    });
    await generate({ model: "x", prompt: "p", system: "you are helpful", temperature: 0.2 }, deps);
    const parsedBody = JSON.parse(capturedBody);
    expect(parsedBody.system).toBe("you are helpful");
    expect(parsedBody.options).toEqual({
      num_ctx: DEFAULT_NUM_CTX,
      num_predict: DEFAULT_NUM_PREDICT,
      temperature: 0.2,
    });
  });

  it("throws OllamaModelMissingError on HTTP 404", async () => {
    const deps = fakeDeps(async () => ({ ok: false, status: 404, body: "not found" }));
    await expect(generate({ model: "ghost", prompt: "x" }, deps)).rejects.toBeInstanceOf(
      OllamaModelMissingError,
    );
  });

  it("throws OllamaModelMissingError when body says model not found", async () => {
    const deps = fakeDeps(async () => ({
      ok: false,
      status: 500,
      body: JSON.stringify({ error: "model 'ghost' not found, try pulling it first" }),
    }));
    await expect(generate({ model: "ghost", prompt: "x" }, deps)).rejects.toBeInstanceOf(
      OllamaModelMissingError,
    );
  });

  it("throws OllamaDaemonUnavailableError when fetch itself fails", async () => {
    const deps = fakeDeps(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(generate({ model: "x", prompt: "p" }, deps)).rejects.toBeInstanceOf(
      OllamaDaemonUnavailableError,
    );
  });

  it("propagates NetworkBoundaryError without wrapping it", async () => {
    const deps = fakeDeps(async () => {
      throw new NetworkBoundaryError("https://evil.example.com", "not in M1 allowlist");
    });
    await expect(generate({ model: "x", prompt: "p" }, deps)).rejects.toBeInstanceOf(
      NetworkBoundaryError,
    );
  });

  it("throws OllamaDaemonUnavailableError when response field is missing", async () => {
    const deps = fakeDeps(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ done: true }),
    }));
    await expect(generate({ model: "x", prompt: "p" }, deps)).rejects.toBeInstanceOf(
      OllamaDaemonUnavailableError,
    );
  });

  it("throws OllamaDaemonUnavailableError on malformed JSON", async () => {
    const deps = fakeDeps(async () => ({ ok: true, status: 200, body: "{not json" }));
    await expect(generate({ model: "x", prompt: "p" }, deps)).rejects.toBeInstanceOf(
      OllamaDaemonUnavailableError,
    );
  });
});

// The 2026-07-06 truncation gotcha: with num_ctx unset Ollama uses the daemon default
// (4096 here) and silently drops the rest of the prompt. `moss run standup` hit exactly
// that on 2026-09-18. These pin that the window is always sent, never left to the daemon.
describe("ollama.generate never leaves the context window to the daemon", () => {
  function capture() {
    const seen: {
      body?: string | undefined;
      timeoutMs?: number | undefined;
      signal: AbortSignal | undefined;
    } = { signal: undefined };
    const deps: OllamaProviderDependencies = {
      netFetch: async (_url, options) => {
        seen.body = options?.body;
        seen.timeoutMs = options?.timeoutMs;
        seen.signal = options?.signal;
        return {
          status: 200,
          ok: true,
          body: JSON.stringify({ model: "m", response: "ok", done: true }),
        };
      },
    };
    return { seen, deps };
  }

  it("sends num_ctx on every call, defaulting to 16k", async () => {
    const { seen, deps } = capture();
    await generate({ model: "m", prompt: "p" }, deps);
    expect(JSON.parse(seen.body ?? "{}").options.num_ctx).toBe(DEFAULT_NUM_CTX);
    expect(DEFAULT_NUM_CTX).toBe(16_384);
  });

  it("keeps temperature alongside num_ctx rather than replacing it", async () => {
    const { seen, deps } = capture();
    await generate({ model: "m", prompt: "p", temperature: 0.2, numCtx: 8192 }, deps);
    expect(JSON.parse(seen.body ?? "{}").options).toEqual({
      num_ctx: 8192,
      num_predict: DEFAULT_NUM_PREDICT,
      temperature: 0.2,
    });
  });

  it("waits five minutes by default, because local generation is slow", async () => {
    const { seen, deps } = capture();
    await generate({ model: "m", prompt: "p" }, deps);
    expect(seen.timeoutMs).toBe(DEFAULT_GENERATE_TIMEOUT_MS);
    expect(DEFAULT_GENERATE_TIMEOUT_MS).toBe(300_000);
  });

  it("forwards a caller timeout and cancellation signal", async () => {
    const { seen, deps } = capture();
    const controller = new AbortController();
    await generate({ model: "m", prompt: "p", timeoutMs: 1234, signal: controller.signal }, deps);
    expect(seen.timeoutMs).toBe(1234);
    expect(seen.signal).toBe(controller.signal);
  });

  it("honours MOSS_OLLAMA_NUM_CTX, and ignores nonsense or tiny values", () => {
    expect(resolveNumCtx({ MOSS_OLLAMA_NUM_CTX: "32768" })).toBe(32_768);
    expect(resolveNumCtx({ MOSS_OLLAMA_NUM_CTX: "banana" })).toBe(DEFAULT_NUM_CTX);
    expect(resolveNumCtx({ MOSS_OLLAMA_NUM_CTX: "512" })).toBe(DEFAULT_NUM_CTX);
    expect(resolveNumCtx({})).toBe(DEFAULT_NUM_CTX);
  });
});
