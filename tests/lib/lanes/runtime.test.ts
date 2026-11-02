import { describe, expect, it, vi } from "vitest";
import {
  type DispatchDeps,
  defaultSelectDeps,
  dispatchChoice,
} from "../../../src/lib/lanes/runtime.ts";
import { selectLane } from "../../../src/lib/lanes/select.ts";
import type { Provider } from "../../../src/lib/providers/types.ts";
import { lanes, policy, policyApiOn } from "./fixtures.ts";

function fake(id: Provider["id"], costUsd?: number): Provider {
  return {
    id,
    executionType: "remote_dispatch",
    requiresModel: false,
    probe: async () => ({
      id,
      status: "available",
      reason: "ok",
      capabilities: { ask: "available", "code-review": "available" },
      lastProbedAt: "",
    }),
    generate: vi.fn(async (o) => ({
      providerId: id,
      model: o.model ?? "?",
      response: "answer",
      inputTokens: 100,
      outputTokens: 10,
      ...(costUsd !== undefined ? { costUsd } : {}),
    })),
  };
}

function deps(provider: Provider) {
  const record = vi.fn(async (_entry: Record<string, unknown>) => true);
  const d: DispatchDeps = {
    getProvider: () => provider,
    record,
    now: () => new Date("2026-09-18T12:00:00Z"),
  };
  return { d, record };
}

describe("dispatchChoice", () => {
  it("sends the routing.yaml settings and logs the metered call in EUR", async () => {
    const choice = await selectLane(
      policyApiOn,
      { task: "reason", promptTokens: 10 },
      lanes({ "claude-code": "unauthenticated", "anthropic-api": "available" }),
    );
    const api = fake("anthropic-api", 1);
    const { d, record } = deps(api);
    const result = await dispatchChoice(
      policyApiOn,
      choice,
      { prompt: "p", system: "s", command: "run" },
      d,
    );
    expect(result.response).toBe("answer");
    expect(api.generate).toHaveBeenCalledWith({
      task: "ask",
      prompt: "p",
      system: "s",
      model: "sonnet",
      maxTokens: 8192,
    });
    expect(record).toHaveBeenCalledWith({
      ts: "2026-09-18T12:00:00.000Z",
      lane: "anthropic-api",
      model: "sonnet",
      task: "reason",
      command: "run",
      tokens_in: 100,
      tokens_out: 10,
      cost: "eur",
      eur: policy.fx.usd_to_eur,
    });
  });

  it("logs the subscription at notional list price, and local at €0", async () => {
    const sub = await selectLane(
      policy,
      { task: "edit", promptTokens: 10 },
      lanes({ "claude-code": "available" }),
    );
    const a = deps(fake("claude-code", 0.02));
    await dispatchChoice(policy, sub, { prompt: "p", command: "chat" }, a.d);
    expect(a.record.mock.calls[0]?.[0]).toMatchObject({ cost: "sub", usd_list: 0.02 });
    const local = await selectLane(
      policy,
      { task: "brief", promptTokens: 10 },
      lanes({ ollama: "available" }),
    );
    const b = deps(fake("ollama"));
    await dispatchChoice(policy, local, { prompt: "p", command: "run" }, b.d);
    expect(b.record.mock.calls[0]?.[0]).toMatchObject({ cost: "local", model: "llama3.1:latest" });
    expect(b.record.mock.calls[0]?.[0]).not.toHaveProperty("eur");
  });

  it("refuses to dispatch when nothing was picked", async () => {
    const none = await selectLane(policy, { task: "vision", promptTokens: 1 }, lanes({}));
    await expect(
      dispatchChoice(policy, none, { prompt: "p", command: "run" }, deps(fake("ollama")).d),
    ).rejects.toThrow("no lane can run task 'vision'");
  });
});

describe("defaultSelectDeps", () => {
  it("wraps a throwing probe as unknown rather than available", async () => {
    const d = defaultSelectDeps();
    expect(typeof d.eurSpentToday("anthropic-api")).toBe("number");
    expect(typeof (await d.localModels()).length).toBe("number");
  });
});
