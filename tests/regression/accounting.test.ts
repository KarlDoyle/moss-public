import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAskCommand } from "../../src/commands/ask.ts";
import { formatCost, totals } from "../../src/commands/cost.ts";
import { formatLaneStatus, gatherLaneStatus } from "../../src/commands/lane-status.ts";
import {
  accountingWarnings,
  eurSpent,
  type LaneUsage,
  localDay,
  readLedger,
  readLedgerState,
  recordLaneUsage,
} from "../../src/lib/lanes/ledger.ts";
import { dispatchChoice } from "../../src/lib/lanes/runtime.ts";
import { selectLane } from "../../src/lib/lanes/select.ts";
import { createAnthropicApiProvider } from "../../src/lib/providers/anthropic-api.ts";
import type { Provider } from "../../src/lib/providers/types.ts";
import { recordUsageBestEffort } from "../../src/lib/usage/log.ts";
import { lanes, policy, policyApiOn } from "../lib/lanes/fixtures.ts";

const now = () => new Date("2026-11-02T12:00:00Z");
const entry = (extra: Partial<LaneUsage> = {}): LaneUsage => ({
  ts: now().toISOString(),
  lane: "anthropic-api",
  model: "sonnet",
  task: "reason",
  by: "moss",
  cost: "eur",
  eur: 0.1,
  tokens_in: 10,
  tokens_out: 5,
  ...extra,
});

describe("API usage remains unknown when absent/invalid", () => {
  it.each([
    undefined,
    {},
    { input_tokens: -1, output_tokens: -3 },
    { input_tokens: "12", output_tokens: null },
    { input_tokens: 1.5, output_tokens: 1e20 },
    { cache_read_input_tokens: 10 },
  ])("does not manufacture zero tokens/cost from %j", async (usage) => {
    const post = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        content: [{ type: "text", text: "synthetic" }],
        ...(usage !== undefined ? { usage } : {}),
      }),
    }));
    const provider = createAnthropicApiProvider({
      keychain: {
        env: { ANTHROPIC_API_KEY: ["synthetic", "fixture"].join("-") },
        readKeychain: async () => {
          throw new Error("Keychain forbidden");
        },
      },
      post,
    });
    const result = await provider.generate?.({ task: "ask", prompt: "fixture", model: "sonnet" });
    expect(result).toBeDefined();
    expect(result?.inputTokens).toBeUndefined();
    expect(result?.outputTokens).toBeUndefined();
    expect(result?.costUsd).toBeUndefined();
    expect(accountingWarnings(result as NonNullable<typeof result>).join(" ")).toContain("unknown");
    expect(post).toHaveBeenCalledOnce();
  });
  it("keeps a reported zero while preserving missing input usage as unknown", async () => {
    const provider = createAnthropicApiProvider({
      keychain: { env: { ANTHROPIC_API_KEY: "synthetic" }, readKeychain: async () => null },
      post: async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({ usage: { output_tokens: 0 }, content: [] }),
      }),
    });
    const result = await provider.generate?.({ task: "ask", prompt: "fixture", model: "sonnet" });
    expect(result?.outputTokens).toBe(0);
    expect(result?.inputTokens).toBeUndefined();
    expect(result?.costUsd).toBeUndefined();
  });
});

describe("independent usage/ledger writes", () => {
  it.each([false, true])(
    "known API usage records configured EUR even when secondary append fails=%s",
    async (failLog) => {
      const recordLane = vi.fn(async () => true);
      const recorded = await recordUsageBestEffort(
        {
          command: "ask",
          providerId: "anthropic-api",
          model: "sonnet",
          inputTokens: 1_000_000,
          outputTokens: 10_000,
        },
        {
          now,
          mossVersion: "fixture",
          usdToEur: () => policy.fx.usd_to_eur,
          appendFile: async () => {
            if (failLog) throw new Error("synthetic disk error");
          },
          recordLane,
        },
      );
      expect(recorded).toBe(!failLog);
      expect(recordLane).toHaveBeenCalledOnce();
      expect(recordLane).toHaveBeenCalledWith(
        expect.objectContaining({
          cost: "eur",
          eur: 2.1 * policy.fx.usd_to_eur,
          tokens_in: 1_000_000,
          tokens_out: 10_000,
        }),
      );
    },
  );
  it.each(["false", "throw"])(
    "ledger failure %s is reported despite successful secondary append",
    async (failure) => {
      const appendFile = vi.fn(async () => undefined);
      expect(
        await recordUsageBestEffort(
          { command: "ask", providerId: "ollama", model: "fixture" },
          {
            now,
            mossVersion: "fixture",
            appendFile,
            recordLane: async () => {
              if (failure === "throw") throw new Error("fixture");
              return false;
            },
          },
        ),
      ).toBe(false);
      expect(appendFile).toHaveBeenCalledOnce();
    },
  );
  it("unpriced metered metadata retains unknown cost and reports incompleteness", async () => {
    const recorded: Array<Omit<LaneUsage, "by">> = [];
    expect(
      await recordUsageBestEffort(
        {
          command: "ask",
          providerId: "anthropic-api",
          model: "unpriced",
          inputTokens: 10,
          outputTokens: 5,
        },
        {
          now,
          mossVersion: "fixture",
          usdToEur: () => 0.8,
          appendFile: async () => undefined,
          recordLane: async (e) => {
            recorded.push(e);
            return true;
          },
        },
      ),
    ).toBe(false);
    expect(recorded[0]).not.toHaveProperty("eur");
    expect(recorded[0]).toMatchObject({ cost: "eur", tokens_in: 10 });
  });
  it.each([false, true])(
    "ask exposes accounting failure (throw=%s) without losing the answer",
    async (throwing) => {
      const errors: string[] = [],
        output: string[] = [];
      const provider: Provider = {
        id: "ollama",
        executionType: "local_dispatch",
        requiresModel: true,
        probe: async () => ({
          id: "ollama",
          status: "available",
          reason: "fixture",
          capabilities: { ask: "available", "code-review": "available" },
          lastProbedAt: now().toISOString(),
        }),
        generate: async () => ({
          providerId: "ollama",
          model: "fixture",
          response: "answer",
          inputTokens: 1,
          outputTokens: 1,
        }),
      };
      const result = await runAskCommand({
        prompt: "fixture",
        model: "fixture",
        emitJson: true,
        out: (s) => output.push(s),
        err: (s) => errors.push(s),
        routerDeps: {
          now,
          listProviders: () => ["ollama"],
          getProvider: () => provider,
          policy: () => policy,
        },
        recordUsage: async () => {
          if (throwing) throw new Error("fixture");
          return false;
        },
      });
      expect(result.ok).toBe(true);
      expect(JSON.parse(output[0] ?? "{}").warnings.join(" ")).toContain("Accounting incomplete");
      expect(errors.join(" ")).toContain("Accounting incomplete");
    },
  );
});

describe("validated ledger state and advisory budget", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function file() {
    const root = mkdtempSync(join(tmpdir(), "moss-accounting-"));
    roots.push(root);
    return join(root, "ledger.jsonl");
  }
  it.each([
    "{malformed\n",
    `${JSON.stringify(entry({ ts: "0" }))}\n`,
    `${JSON.stringify(entry({ eur: -1 }))}\n`,
    `${JSON.stringify(entry({ tokens_in: -1 }))}\n`,
    `${JSON.stringify(entry({ eur: 1e20 }))}\n`,
    `${JSON.stringify({ ts: now().toISOString(), lane: "anthropic-api" })}\n`,
    `${JSON.stringify(entry({ cost: "local" }))}\n`,
    `${JSON.stringify(entry())}\n{"ts":`,
    JSON.stringify(entry()),
  ])("flags malformed/incomplete data and blocks budgeted API selection: %j", async (contents) => {
    const path = file();
    writeFileSync(path, contents);
    expect(readLedgerState(path).issues.length).toBeGreaterThan(0);
    expect(() => readLedger(path)).toThrow("Incomplete accounting");
    const select = lanes({ "anthropic-api": "available" });
    const result = await selectLane(
      policyApiOn,
      { task: "reason", pinLane: "anthropic-api", promptTokens: 10 },
      {
        ...select,
        eurSpentToday: () => eurSpent(readLedger(path), "anthropic-api", localDay(now())),
      },
    );
    expect(result.lane).toBeNull();
    expect(result.verdicts[0]?.reason).toContain("incomplete accounting");
    const state = readLedgerState(path);
    expect(formatCost(state.entries, now(), 2, path, state.issues)).toContain(
      "API cap today: unknown",
    );
  });
  it("valid metered rows with missing EUR make recorded spend unknown", () => {
    expect(
      eurSpent(
        [entry({ eur: undefined } as unknown as Partial<LaneUsage>)],
        "anthropic-api",
        localDay(now()),
      ),
    ).toBeNaN();
    expect(
      totals([entry({ eur: undefined } as unknown as Partial<LaneUsage>)], ["anthropic-api"])[0]
        ?.eur,
    ).toBeNull();
  });
  it("concurrent synthetic appends preserve complete records without claiming a spend reservation", async () => {
    const path = file();
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        recordLaneUsage({ ...entry({ eur: 0.01, command: `fixture-${n}` }) }, path),
      ),
    );
    const result = readLedgerState(path);
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(20);
    expect(eurSpent(result.entries, "anthropic-api", localDay(now()))).toBeCloseTo(0.2);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });
  it("an unknown-cost generation records metadata, warns, then blocks another budgeted API call", async () => {
    const path = file();
    const generate = vi.fn(async () => ({
      providerId: "anthropic-api" as const,
      model: "sonnet",
      response: "synthetic answer",
    }));
    const provider: Provider = {
      id: "anthropic-api",
      executionType: "remote_dispatch",
      requiresModel: false,
      probe: async () => ({
        id: "anthropic-api",
        status: "available",
        reason: "synthetic",
        capabilities: { ask: "available", "code-review": "available" },
        lastProbedAt: now().toISOString(),
      }),
      generate,
    };
    const errors: string[] = [];
    const request = {
      prompt: "fixture",
      provider: "anthropic-api" as const,
      emitJson: false,
      out: () => undefined,
      err: (s: string) => errors.push(s),
      routerDeps: {
        now,
        listProviders: () => ["anthropic-api" as const],
        getProvider: () => provider,
        policy: () => policyApiOn,
        eurSpentToday: () => eurSpent(readLedger(path), "anthropic-api", localDay(now())),
      },
      recordUsage: (input: Parameters<typeof recordUsageBestEffort>[0]) =>
        recordUsageBestEffort(input, {
          now,
          mossVersion: "fixture",
          usdToEur: () => policy.fx.usd_to_eur,
          appendFile: async () => undefined,
          recordLane: (e) => recordLaneUsage(e, path),
        }),
    };
    expect((await runAskCommand(request)).ok).toBe(true);
    expect(readLedger(path)).toHaveLength(1);
    expect(readLedger(path)[0]).not.toHaveProperty("eur");
    expect(errors.join(" ")).toContain("Accounting incomplete");
    expect((await runAskCommand(request)).ok).toBe(false);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("invalid writes are rejected", async () => {
    const path = file();
    expect(await recordLaneUsage(entry({ eur: -1 }), path)).toBe(false);
    expect(readLedgerState(path)).toEqual({ entries: [], issues: [] });
  });
});

describe("dispatchChoice independently enforces API policy and reports recording failures", () => {
  async function choice() {
    return selectLane(
      policyApiOn,
      { task: "edit", pinLane: "anthropic-api", promptTokens: 1 },
      lanes({ "anthropic-api": "available" }),
    );
  }
  it.each(["disabled", "exhausted", "unknown"])(
    "a previously selected API cannot dispatch when %s",
    async (why) => {
      const getProvider = vi.fn();
      await expect(
        dispatchChoice(
          why === "disabled" ? policy : policyApiOn,
          await choice(),
          { prompt: "fixture", command: "chat" },
          {
            now,
            getProvider,
            record: vi.fn(),
            eurSpentToday: () => (why === "unknown" ? Number.NaN : 100),
          },
        ),
      ).rejects.toThrow();
      expect(getProvider).not.toHaveBeenCalled();
    },
  );
  it("successful output survives a thrown ledger append and exposes its failure", async () => {
    const provider: Provider = {
      id: "anthropic-api",
      executionType: "remote_dispatch",
      requiresModel: false,
      probe: vi.fn(),
      generate: async () => ({ providerId: "anthropic-api", model: "sonnet", response: "answer" }),
    };
    const result = await dispatchChoice(
      policyApiOn,
      await choice(),
      { prompt: "fixture", command: "chat" },
      {
        now,
        getProvider: () => provider,
        record: async () => {
          throw new Error("fixture append failure");
        },
        eurSpentToday: () => 0,
      },
    );
    expect(result.response).toBe("answer");
    expect(result.warnings?.join(" ")).toContain("ledger write failed");
    expect(result.warnings?.join(" ")).toContain("unknown");
  });
});

describe("cost row identity and unknown output", () => {
  it("prototype-like extra lane IDs remain unknown rather than looking free", () => {
    const text = formatCost(
      [entry({ lane: "constructor", cost: "unknown", ts: "2026-11-01T10:00:00Z" })],
      now(),
      2,
      "synthetic",
    );
    expect(text.split("\n").find((s) => s.includes("constructor"))).toContain("unknown cost");
  });
  it("joins extra lanes and month-only lanes by identity", () => {
    const extra = [
      entry({ lane: "month-only", cost: "unknown", ts: "2026-11-01T10:00:00Z" }),
      entry({ lane: "today-extra", cost: "unknown" }),
      entry({ lane: "month-only", cost: "unknown", ts: "2026-11-01T11:00:00Z" }),
      entry(),
    ];
    const text = formatCost(extra, now(), 2, "synthetic");
    expect(text.split("\n").find((s) => s.includes("month-only"))).toMatch(/0 calls.*2 calls/);
    expect(text.split("\n").find((s) => s.includes("today-extra"))).toMatch(/1 calls.*1 calls/);
    expect(
      formatCost([...extra].reverse(), now(), 2, "synthetic")
        .split("\n")
        .find((s) => s.includes("month-only")),
    ).toMatch(/0 calls.*2 calls/);
  });
  it("unknown usage/cost stays null in totals and is explicit in human output", () => {
    const { eur: _eur, tokens_in: _in, tokens_out: _out, ...missing } = entry();
    expect(totals([missing], ["anthropic-api"])[0]).toMatchObject({
      eur: null,
      tokensIn: null,
      tokensOut: null,
    });
    const text = formatCost([missing], now(), 2, "synthetic");
    expect(text).toContain("unknown tok");
    expect(text).toContain("API cap today: unknown");
    expect(text.split("\n").find((s) => /^ {2}anthropic-api/.test(s))).not.toContain("€0");
  });
  it("status surfaces ledger failure instead of reporting an empty/free API day", async () => {
    const result = await gatherLaneStatus({
      now,
      probe: async () => ({ status: "unavailable", reason: "synthetic" }),
      resident: async () => [],
      bench: () => [],
      ledger: () => {
        throw new Error("fixture corrupt ledger");
      },
    });
    expect(formatLaneStatus(result)).toContain("anthropic-api unknown calls (unknown)");
    expect(formatLaneStatus(result)).toContain("Accounting incomplete");
  });
});
