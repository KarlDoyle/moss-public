import { describe, expect, it } from "vitest";
import {
  allCapabilitiesAs,
  defaultUnknownCapabilities,
  PROVIDER_IDS,
  PROVIDER_STATUSES,
  ProviderCapabilitiesSchema,
  ProviderIdSchema,
  ProviderProbeResultSchema,
  ProviderStatusSchema,
  TASK_IDS,
  TaskIdSchema,
} from "../../../src/lib/providers/types.ts";

describe("src/lib/providers/types.ts", () => {
  describe("closed unions", () => {
    it("PROVIDER_IDS is the documented lane order (unified router: local, sub, eur, then the two optional lanes)", () => {
      expect([...PROVIDER_IDS]).toEqual([
        "ollama",
        "claude-code",
        "anthropic-api",
        "litellm",
        "cursor-manual",
      ]);
    });

    it("TASK_IDS pins the M3 task surface", () => {
      expect([...TASK_IDS]).toEqual(["ask", "code-review"]);
    });

    it("PROVIDER_STATUSES is the M11-extended union (rename + new states)", () => {
      expect([...PROVIDER_STATUSES].sort()).toEqual(
        [
          "available",
          "unavailable",
          "not_installed",
          "not_configured",
          "unauthenticated",
          "unsupported",
          "quota_limited",
          "offline",
          "unhealthy",
          "disabled",
          "unknown",
        ].sort(),
      );
    });

    it("does not retain the pre-M11 'auth_required' name", () => {
      expect([...PROVIDER_STATUSES]).not.toContain("auth_required");
      expect([...PROVIDER_STATUSES]).toContain("unauthenticated");
    });
  });

  describe("zod schemas reject unknown values", () => {
    it("ProviderIdSchema rejects unknown provider names", () => {
      expect(() => ProviderIdSchema.parse("does-not-exist")).toThrow();
      // Sanity: every documented id parses.
      for (const id of PROVIDER_IDS) {
        expect(() => ProviderIdSchema.parse(id)).not.toThrow();
      }
    });

    it("ProviderStatusSchema rejects unknown statuses", () => {
      expect(() => ProviderStatusSchema.parse("maybe")).toThrow();
      expect(() => ProviderStatusSchema.parse("OK")).toThrow();
      for (const status of PROVIDER_STATUSES) {
        expect(() => ProviderStatusSchema.parse(status)).not.toThrow();
      }
    });

    it("TaskIdSchema rejects unknown tasks", () => {
      expect(() => TaskIdSchema.parse("memory-recall")).toThrow();
      for (const task of TASK_IDS) {
        expect(() => TaskIdSchema.parse(task)).not.toThrow();
      }
    });

    it("ProviderProbeResultSchema rejects malformed shapes", () => {
      expect(() => ProviderProbeResultSchema.parse({})).toThrow();
      expect(() =>
        ProviderProbeResultSchema.parse({
          id: "ollama",
          status: "available",
          reason: "ok",
          capabilities: { ask: "available" },
          lastProbedAt: "2026-05-22T15:00:00.000Z",
        }),
      ).toThrow();
      const ok = ProviderProbeResultSchema.parse({
        id: "ollama",
        status: "available",
        reason: "ok",
        capabilities: { ask: "available", "code-review": "available" },
        lastProbedAt: "2026-05-22T15:00:00.000Z",
      });
      expect(ok.id).toBe("ollama");
    });

    it("ProviderProbeResultSchema rejects confidence outside [0,1]", () => {
      const base = {
        id: "ollama",
        status: "available",
        reason: "ok",
        capabilities: { ask: "available", "code-review": "available" },
        lastProbedAt: "2026-05-22T15:00:00.000Z",
      };
      expect(() => ProviderProbeResultSchema.parse({ ...base, confidence: -0.01 })).toThrow();
      expect(() => ProviderProbeResultSchema.parse({ ...base, confidence: 1.01 })).toThrow();
      expect(() => ProviderProbeResultSchema.parse({ ...base, confidence: 0.5 })).not.toThrow();
    });
  });

  describe("default helpers", () => {
    it("defaultUnknownCapabilities returns unknown for every task", () => {
      const caps = defaultUnknownCapabilities();
      expect(caps.ask).toBe("unknown");
      expect(caps["code-review"]).toBe("unknown");
      expect(ProviderCapabilitiesSchema.parse(caps)).toEqual(caps);
    });

    it("allCapabilitiesAs replicates the given status across every task", () => {
      const caps = allCapabilitiesAs("unavailable");
      expect(caps.ask).toBe("unavailable");
      expect(caps["code-review"]).toBe("unavailable");
    });

    it("allCapabilitiesAs covers every TaskId without omission", () => {
      // If a future commit adds a TaskId without updating the helpers,
      // this test fails loudly.
      const caps = allCapabilitiesAs("available") as Record<string, string>;
      for (const task of TASK_IDS) {
        expect(caps[task]).toBe("available");
      }
      expect(Object.keys(caps).sort()).toEqual([...TASK_IDS].sort());
    });
  });
});
