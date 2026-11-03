// Hosted live smoke only. Explicit opt-in: set MOSS_LIVE_HOSTED=1.
// MOSS_LIVE=1 is deliberately no longer sufficient: it used to probe hosted
// providers while an operator was trying to validate local Ollama.
//   claude-code   — needs `claude` logged in (one tiny Haiku call, billed to the subscription)
//   anthropic-api — needs a real key; one tiny Haiku call, a fraction of a cent
import { describe, expect, it } from "vitest";
import { anthropicApiProvider } from "../../src/lib/providers/anthropic-api.ts";
import { claudeCodeProvider } from "../../src/lib/providers/claude-code.ts";

const live = process.env.MOSS_LIVE_HOSTED === "1";
const status = async (p: { probe: () => Promise<{ status: string }> }) =>
  live ? (await p.probe()).status : "skipped";

const [claude, api] = await Promise.all([status(claudeCodeProvider), status(anthropicApiProvider)]);

const PROMPT = "Reply with the single word ok.";

describe("hosted live lanes", () => {
  it.skipIf(claude !== "available")(
    "claude-code answers",
    async () => {
      const r = await claudeCodeProvider.generate?.({
        task: "ask",
        prompt: PROMPT,
        model: "haiku",
      });
      expect(r?.response.toLowerCase()).toContain("ok");
      expect(r?.inputTokens).toBeGreaterThan(0);
    },
    120_000,
  );

  it.skipIf(api !== "available")(
    "anthropic-api answers",
    async () => {
      const r = await anthropicApiProvider.generate?.({
        task: "ask",
        prompt: PROMPT,
        model: "haiku",
        maxTokens: 16,
      });
      expect(r?.response.toLowerCase()).toContain("ok");
    },
    120_000,
  );
});
