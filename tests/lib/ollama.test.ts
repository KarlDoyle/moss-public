import { describe, expect, it } from "vitest";
import {
  assertChatModel,
  DEFAULT_CODER_MODEL,
  DEFAULT_NUM_CTX,
  DEFAULT_NUM_PREDICT,
  isReasoningModel,
  ollamaSafety,
  ReasoningModelRefusedError,
  resolveCoderModel,
  resolveNumCtx,
  resolveNumPredict,
} from "../../src/lib/ollama.ts";

describe("ollama safety defaults (one place)", () => {
  it("always sets num_ctx, num_predict and think:false", () => {
    const safety = ollamaSafety({}, {});
    expect(safety.think).toBe(false);
    expect(safety.options).toEqual({ num_ctx: DEFAULT_NUM_CTX, num_predict: DEFAULT_NUM_PREDICT });
  });

  it("keeps temperature and a per-call num_ctx alongside the caps", () => {
    expect(ollamaSafety({ numCtx: 8192, temperature: 0.1 }, {}).options).toEqual({
      num_ctx: 8192,
      num_predict: DEFAULT_NUM_PREDICT,
      temperature: 0.1,
    });
  });

  it("reads overrides from the environment and ignores nonsense", () => {
    expect(resolveNumCtx({ MOSS_OLLAMA_NUM_CTX: "32768" })).toBe(32768);
    expect(resolveNumCtx({ MOSS_OLLAMA_NUM_CTX: "12" })).toBe(DEFAULT_NUM_CTX);
    expect(resolveNumPredict({ MOSS_OLLAMA_NUM_PREDICT: "512" })).toBe(512);
    expect(resolveNumPredict({ MOSS_OLLAMA_NUM_PREDICT: "lots" })).toBe(DEFAULT_NUM_PREDICT);
  });
});

describe("reasoning models are never used for chat", () => {
  it("recognises the reasoning families", () => {
    for (const name of ["qwen3:4b", "qwen3", "deepseek-r1:8b", "qwq:32b", "QWEN3:8b"]) {
      expect(isReasoningModel(name), name).toBe(true);
    }
    for (const name of ["llama3.1:latest", "qwen2.5:3b-instruct", "qwen2.5-coder:7b"]) {
      expect(isReasoningModel(name), name).toBe(false);
    }
  });

  it("assertChatModel throws for a reasoning model and passes the rest", () => {
    expect(() => assertChatModel("qwen3:4b")).toThrow(ReasoningModelRefusedError);
    expect(() => assertChatModel("llama3.1:latest")).not.toThrow();
  });
});

describe("coder model", () => {
  it("defaults to qwen2.5-coder:7b and honours MOSS_CODER_MODEL", () => {
    expect(resolveCoderModel({})).toBe(DEFAULT_CODER_MODEL);
    expect(DEFAULT_CODER_MODEL).toBe("qwen2.5-coder:7b");
    expect(resolveCoderModel({ MOSS_CODER_MODEL: "rnj-1" })).toBe("rnj-1");
    expect(resolveCoderModel({ MOSS_CODER_MODEL: "  " })).toBe(DEFAULT_CODER_MODEL);
  });
});
