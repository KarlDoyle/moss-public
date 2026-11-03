// Explicit local-only checks of chat and read-only diff review against a
// disposable repository. The normal suite skips both live model requests.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type LaneSessionDeps, routedGenerate } from "../../src/commands/chat-lanes.ts";
import { runRunCommand } from "../../src/commands/run.ts";
import { loadRoutingPolicy } from "../../src/lib/lanes/policy.ts";
import { dispatchChoice } from "../../src/lib/lanes/runtime.ts";
import { getProjectRoot, setProjectRoot } from "../../src/lib/paths.ts";
import {
  createOllamaProvider,
  defaultOllamaProviderDependencies,
  type OllamaProviderDependencies,
} from "../../src/lib/providers/ollama.ts";
import {
  defaultRouterDependencies,
  type RouterDependencies,
} from "../../src/lib/providers/router.ts";
import type { ProviderId } from "../../src/lib/providers/types.ts";
import {
  defaultGenerateViaRouter,
  defaultSkillRunDependencies,
} from "../../src/lib/skills/runner.ts";
import type { UsageWriteInput } from "../../src/lib/usage/log.ts";
import { type ChatSessionDeps, runChatSession } from "../../src/repl/session.ts";

const live = process.env.MOSS_LIVE_WORKFLOWS === "1";
const model = process.env.MOSS_LIVE_OLLAMA_MODEL || "qwen2.5:3b-instruct";
const originalRoot = getProjectRoot();
const routingPolicy = loadRoutingPolicy();
const allowedUrls = new Set([
  "http://127.0.0.1:11434/api/tags",
  "http://127.0.0.1:11434/api/generate",
]);
const localFetch: OllamaProviderDependencies = {
  netFetch: (url, options) => {
    if (!allowedUrls.has(url)) throw new Error(`Local workflow test refused network: ${url}`);
    return defaultOllamaProviderDependencies.netFetch(url, options);
  },
};
const provider = createOllamaProvider(localFetch);
const getLocalProvider = (id: ProviderId) => {
  if (id !== "ollama") throw new Error(`Local workflow test refused provider: ${id}`);
  return provider;
};
const localRouter: RouterDependencies = {
  ...defaultRouterDependencies,
  listProviders: () => ["ollama"],
  getProvider: getLocalProvider,
  policy: () => routingPolicy,
};

async function* linesOf(lines: readonly string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

afterEach(() => setProjectRoot(originalRoot));

describe("local workflows live validation", () => {
  it.skipIf(!live)(
    "keeps a two-turn chat on Ollama and carries bounded session context",
    async () => {
      const output: string[] = [];
      const errors: string[] = [];
      const prompts: string[] = [];
      const responses: string[] = [];
      const ledger: string[] = [];
      const deps: LaneSessionDeps = {
        policy: () => routingPolicy,
        select: () => ({
          probe: async (id) => {
            const result = await getLocalProvider(id).probe();
            return { status: result.status, reason: result.reason };
          },
          localModels: async () => [model],
          eurSpentToday: () => 0,
        }),
        dispatch: (policy, choice, input) => {
          prompts.push(input.prompt);
          return dispatchChoice(policy, choice, input, {
            getProvider: getLocalProvider,
            record: async (entry) => {
              ledger.push(entry.lane);
              return true;
            },
            now: () => new Date(),
          });
        },
      };
      const session: ChatSessionDeps = {
        lines: linesOf(["Say hello in one word.", "Say goodbye in one word.", "/exit"]),
        initialProvider: "ollama",
        initialModel: model,
        batchMode: true,
        out: (line) => output.push(line),
        err: (line) => errors.push(line),
        generate: async (params) => {
          const result = await routedGenerate(params, deps);
          if (result.ok) responses.push(result.response ?? "");
          return result;
        },
      };

      await runChatSession(session);

      expect(errors).toEqual([]);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("Say hello in one word.");
      expect(prompts[1]).toContain("Say hello in one word.");
      expect(prompts[1]).toContain("Say goodbye in one word.");
      expect(ledger).toEqual(["ollama", "ollama"]);
      expect(responses).toHaveLength(2);
      expect(responses.every((response) => response.trim().length > 0)).toBe(true);
      expect(output.filter((line) => line.includes(`ollama · ${model}`))).toHaveLength(2);
    },
    120_000,
  );

  it.skipIf(!live)(
    "runs both bundled reviews on Ollama and leaves target bytes unchanged",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "moss-live-workflows-"));
      const mossRoot = join(root, "moss");
      const target = join(root, "target");
      mkdirSync(join(mossRoot, "skills", "code-review"), { recursive: true });
      mkdirSync(join(mossRoot, "rooms", "review"), { recursive: true });
      mkdirSync(join(mossRoot, "skills", "security-review"), { recursive: true });
      mkdirSync(join(mossRoot, "rooms", "security-review"), { recursive: true });
      mkdirSync(target);
      try {
        git(target, "init", "-b", "main");
        const file = join(target, "sample.txt");
        writeFileSync(file, "alpha\n");
        git(target, "add", "sample.txt");
        git(
          target,
          "-c",
          "user.name=Moss Test",
          "-c",
          "user.email=moss@example.invalid",
          "commit",
          "-m",
          "initial",
        );
        writeFileSync(file, "alpha\nbeta\n");
        writeFileSync(
          join(mossRoot, "skills", "code-review", "SKILL.md"),
          readFileSync(join(originalRoot, "skills", "code-review", "SKILL.md")),
        );
        writeFileSync(
          join(mossRoot, "rooms", "review", "CONTEXT.md"),
          readFileSync(join(originalRoot, "rooms", "review", "CONTEXT.md")),
        );
        writeFileSync(
          join(mossRoot, "skills", "security-review", "SKILL.md"),
          readFileSync(join(originalRoot, "skills", "security-review", "SKILL.md")),
        );
        writeFileSync(
          join(mossRoot, "rooms", "security-review", "CONTEXT.md"),
          readFileSync(join(originalRoot, "rooms", "security-review", "CONTEXT.md")),
        );
        setProjectRoot(mossRoot);

        const beforeFile = readFileSync(file);
        const beforeIndex = readFileSync(join(target, ".git", "index"));
        const beforeHead = git(target, "rev-parse", "HEAD");
        const beforeStatus = git(target, "status", "--porcelain=v1");
        for (const skillId of ["code-review", "security-review"] as const) {
          const output: string[] = [];
          const errors: string[] = [];
          const usage: UsageWriteInput[] = [];
          const ok = await runRunCommand({
            skillId,
            cwd: target,
            emitJson: true,
            writeReport: false,
            modelOverride: model,
            timeoutMs: 90_000,
            out: (line) => output.push(line),
            err: (line) => errors.push(line),
            recordUsage: async (entry) => {
              usage.push(entry);
              return true;
            },
            deps: {
              ...defaultSkillRunDependencies,
              generate: (options) => defaultGenerateViaRouter(options, localRouter),
            },
          });

          expect(ok, errors.join("\n")).toBe(true);
          expect(JSON.parse(output.join("\n"))).toMatchObject({
            skill: { id: skillId },
            providerId: "ollama",
            model,
            unchanged: true,
            diffSource: "working-tree",
            response: expect.stringMatching(/\S/),
          });
          expect(usage).toHaveLength(1);
          expect(usage[0]).toMatchObject({
            command: "run",
            providerId: "ollama",
            model,
            skill: skillId,
          });
          expect(usage[0]?.inputTokens).toBeGreaterThan(0);
          expect(usage[0]?.outputTokens).toBeGreaterThan(0);
          expect(readFileSync(file)).toEqual(beforeFile);
          expect(readFileSync(join(target, ".git", "index"))).toEqual(beforeIndex);
          expect(git(target, "rev-parse", "HEAD")).toBe(beforeHead);
          expect(git(target, "status", "--porcelain=v1")).toBe(beforeStatus);
        }
      } finally {
        setProjectRoot(originalRoot);
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
