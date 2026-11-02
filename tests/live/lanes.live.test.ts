// One live smoke per lane, each skipped when its lane is not available on this machine.
// Opt-in: set MOSS_LIVE=1 (the default `pnpm test` stays hermetic and free).
//   ollama        — needs the daemon and qwen2.5:3b-instruct pulled
//   claude-code   — needs `claude` logged in (one tiny Haiku call, billed to the subscription)
//   anthropic-api — needs a real key; one tiny Haiku call, a fraction of a cent
import { describe, expect, it } from "vitest";
import { anthropicApiProvider } from "../../src/lib/providers/anthropic-api.ts";
import { claudeCodeProvider } from "../../src/lib/providers/claude-code.ts";
import { ollamaProvider } from "../../src/lib/providers/ollama.ts";

const live = process.env.MOSS_LIVE === "1";
const status = async (p: { probe: () => Promise<{ status: string }> }) =>
  live ? (await p.probe()).status : "skipped";

const [ollama, claude, api] = await Promise.all([
  status(ollamaProvider),
  status(claudeCodeProvider),
  status(anthropicApiProvider),
]);

const PROMPT = "Reply with the single word ok.";

describe("live lanes", () => {
  it.skipIf(ollama !== "available")(
    "ollama answers",
    async () => {
      const r = await ollamaProvider.generate?.({
        task: "ask",
        prompt: PROMPT,
        model: "qwen2.5:3b-instruct",
      });
      expect(r?.response.toLowerCase()).toContain("ok");
    },
    120_000,
  );

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
