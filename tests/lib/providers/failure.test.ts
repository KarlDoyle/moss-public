import { describe, expect, it } from "vitest";
import { NetworkBoundaryError } from "../../../src/lib/net.ts";
import {
  classifyGenerateFailure,
  isRetryableGenerateFailure,
  RETRYABLE_GENERATE_ERROR_NAMES,
} from "../../../src/lib/providers/failure.ts";
import { LiteLlmDispatchError } from "../../../src/lib/providers/litellm.ts";
import {
  OllamaDaemonUnavailableError,
  OllamaModelMissingError,
} from "../../../src/lib/providers/ollama.ts";

describe("src/lib/providers/failure.ts", () => {
  describe("terminal failures (never routed around)", () => {
    it("classifies NetworkBoundaryError as terminal", () => {
      const error = new NetworkBoundaryError("https://evil.example", "outside allowlist");
      expect(classifyGenerateFailure(error)).toBe("terminal");
      expect(isRetryableGenerateFailure(error)).toBe(false);
    });

    it("classifies an unrecognised Error as terminal (never mask a bug)", () => {
      expect(classifyGenerateFailure(new Error("boom"))).toBe("terminal");
    });

    it("classifies non-Error throwables as terminal", () => {
      expect(classifyGenerateFailure("a string")).toBe("terminal");
      expect(classifyGenerateFailure(undefined)).toBe("terminal");
      expect(classifyGenerateFailure({ name: "OllamaModelMissingError" })).toBe("terminal");
    });

    it("does not treat a NetworkBoundaryError as retryable even if its name is spoofed", () => {
      const error = new NetworkBoundaryError("https://evil.example", "outside allowlist");
      // Safety boundary is matched by type, so a renamed instance is still terminal.
      (error as { name: string }).name = "OllamaDaemonUnavailableError";
      expect(classifyGenerateFailure(error)).toBe("terminal");
    });
  });

  describe("retryable failures (may fall back to the next lane)", () => {
    it("classifies OllamaDaemonUnavailableError as retryable", () => {
      expect(classifyGenerateFailure(new OllamaDaemonUnavailableError("connection refused"))).toBe(
        "retryable",
      );
    });

    it("classifies OllamaModelMissingError as retryable", () => {
      const error = new OllamaModelMissingError("qwen3:4b");
      expect(classifyGenerateFailure(error)).toBe("retryable");
      expect(isRetryableGenerateFailure(error)).toBe(true);
    });

    it("classifies LiteLlmDispatchError as retryable", () => {
      expect(classifyGenerateFailure(new LiteLlmDispatchError("HTTP 503"))).toBe("retryable");
    });
  });

  describe("allowlist", () => {
    it("names exactly the known provider dispatch errors", () => {
      expect([...RETRYABLE_GENERATE_ERROR_NAMES].sort()).toEqual(
        [
          "AnthropicApiDispatchError",
          "ClaudeCodeDispatchError",
          "LiteLlmDispatchError",
          "OllamaDaemonUnavailableError",
          "OllamaModelMissingError",
        ].sort(),
      );
    });

    it("every retryable name corresponds to a real provider error class", () => {
      // Guards against the allowlist drifting away from the actual classes.
      const instances = [
        new OllamaDaemonUnavailableError("x"),
        new OllamaModelMissingError("m"),
        new LiteLlmDispatchError("x"),
      ];
      for (const instance of instances) {
        expect(RETRYABLE_GENERATE_ERROR_NAMES).toContain(instance.name);
      }
    });
  });
});
