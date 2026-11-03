// Explicit local-only live check. The normal suite skips it; run with
// `pnpm test:live:ollama`. Hosted providers are never probed or invoked here.
import { describe, expect, it } from "vitest";
import { runAskCommand } from "../../src/commands/ask.ts";
import {
  createOllamaProvider,
  defaultOllamaProviderDependencies,
  type OllamaProviderDependencies,
} from "../../src/lib/providers/ollama.ts";
import type { RouterDependencies } from "../../src/lib/providers/router.ts";
import type { UsageWriteInput } from "../../src/lib/usage/log.ts";

const live = process.env.MOSS_LIVE_OLLAMA === "1";
const model = process.env.MOSS_LIVE_OLLAMA_MODEL || "qwen2.5:3b-instruct";
const allowedUrls = new Set([
  "http://127.0.0.1:11434/api/tags",
  "http://127.0.0.1:11434/api/generate",
]);

const localOnly: OllamaProviderDependencies = {
  netFetch: (url, options) => {
    if (!allowedUrls.has(url)) {
      throw new Error(`Live Ollama test refused network destination: ${url}`);
    }
    return defaultOllamaProviderDependencies.netFetch(url, options);
  },
};
const localProvider = createOllamaProvider(localOnly);
const localRouter: RouterDependencies = {
  listProviders: () => ["ollama"],
  getProvider: (id) => {
    if (id !== "ollama") throw new Error(`Live Ollama test refused provider: ${id}`);
    return localProvider;
  },
  now: () => new Date(),
};

describe("local Ollama live validation", () => {
  it.skipIf(!live)(
    "routes a pinned ask to the installed model and reports real usage",
    async () => {
      const output: string[] = [];
      const errors: string[] = [];
      const usage: UsageWriteInput[] = [];
      const result = await runAskCommand({
        prompt: "Reply with a short greeting.",
        provider: "ollama",
        model,
        emitJson: true,
        timeoutMs: 90_000,
        routerDeps: localRouter,
        out: (line) => output.push(line),
        err: (line) => errors.push(line),
        recordUsage: async (entry) => {
          usage.push(entry);
          return true;
        },
      });

      expect(result.ok, errors.join("\n")).toBe(true);
      expect(result.model).toBe(model);
      expect(result.response?.trim().length).toBeGreaterThan(0);
      expect(JSON.parse(output.join("\n"))).toMatchObject({
        ok: true,
        model,
        response: result.response,
      });
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        command: "ask",
        providerId: "ollama",
        model,
        task: "ask",
      });
      expect(usage[0]?.inputTokens).toBeGreaterThan(0);
      expect(usage[0]?.outputTokens).toBeGreaterThan(0);
    },
    120_000,
  );
});
