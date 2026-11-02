import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as askModule from "../../src/commands/ask.ts";
import { type AskCommandOptions, runAskCommand } from "../../src/commands/ask.ts";
import { chatGenerate } from "../../src/commands/chat.ts";
import {
  claudeDiff,
  editRoute,
  type LaneSessionDeps,
  routedGenerate,
} from "../../src/commands/chat-lanes.ts";
import { type ExplainDeps, explainInvocation } from "../../src/commands/explain.ts";
import { defaultTaisceRunDeps } from "../../src/commands/run-taisce.ts";
import type { RoutingPolicy } from "../../src/lib/lanes/policy.ts";
import { dispatchChoice } from "../../src/lib/lanes/runtime.ts";
import * as lifecycle from "../../src/lib/ollama-lifecycle.ts";
import * as providerRegistry from "../../src/lib/providers/index.ts";
import {
  OllamaDaemonUnavailableError,
  OllamaModelMissingError,
} from "../../src/lib/providers/ollama.ts";
import {
  explainProviderRoute,
  type RouterDependencies,
  routeAndGenerate,
} from "../../src/lib/providers/router.ts";
import {
  allCapabilitiesAs,
  type Provider,
  type ProviderId,
} from "../../src/lib/providers/types.ts";
import { defaultGenerateViaRouter } from "../../src/lib/skills/runner.ts";
import { type ChatGenerateParams, runChatSession } from "../../src/repl/session.ts";
import { lanes, policy, policyApiOn } from "../lib/lanes/fixtures.ts";

const now = () => new Date("2026-11-02T12:00:00Z");
const DIFF = "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n";

function fixture(selectedPolicy: RoutingPolicy = policyApiOn, spent: () => number = () => 0) {
  const providers = Object.fromEntries(
    (["ollama", "claude-code", "anthropic-api", "litellm", "cursor-manual"] as const).map((id) => [
      id,
      {
        id,
        executionType:
          id === "ollama"
            ? ("local_dispatch" as const)
            : id === "cursor-manual"
              ? ("manual_handoff" as const)
              : ("remote_dispatch" as const),
        requiresModel: id === "ollama",
        probe: vi.fn(async () => ({
          id,
          status: "available" as const,
          reason: "synthetic available",
          capabilities: allCapabilitiesAs("available"),
          lastProbedAt: now().toISOString(),
        })),
        generate: vi.fn(async (o: Parameters<NonNullable<Provider["generate"]>>[0]) => ({
          providerId: id,
          model: o.model ?? "fixture",
          response: o.prompt.includes("Write a unified diff") ? DIFF : "synthetic answer",
          inputTokens: 10,
          outputTokens: 5,
          ...(id === "anthropic-api" ? { costUsd: 0.001 } : {}),
        })),
      },
    ]),
  ) as Record<
    ProviderId,
    Provider & { probe: ReturnType<typeof vi.fn>; generate: ReturnType<typeof vi.fn> }
  >;
  const deps: RouterDependencies = {
    listProviders: () => Object.keys(providers) as ProviderId[],
    getProvider: (id) => providers[id],
    now,
    policy: () => selectedPolicy,
    eurSpentToday: spent,
  };
  return { deps, providers };
}

function io() {
  const out: string[] = [],
    err: string[] = [];
  return { out, err, o: (s: string) => out.push(s), e: (s: string) => err.push(s) };
}

describe("effective request parity", () => {
  it.each(["local-only", "local-model"])(
    "%s constrains the initial route as well as fallback",
    async (kind) => {
      const { deps, providers } = fixture();
      providers.ollama.probe.mockResolvedValue({
        id: "ollama",
        status: "unavailable",
        reason: "synthetic down",
        capabilities: allCapabilitiesAs("unavailable"),
        lastProbedAt: now().toISOString(),
      });
      const request = kind === "local-only" ? { localOnly: true } : { model: "local-fixture" };
      const preview = await explainProviderRoute("ask", deps, request);
      expect(preview.selectedProvider).toBeNull();
      expect(preview.fallbackProviders).toEqual([]);
      await expect(
        routeAndGenerate("ask", { task: "ask", prompt: "fixture", ...request }, deps),
      ).rejects.toThrow();
      for (const [id, provider] of Object.entries(providers))
        if (id !== "ollama") {
          expect(provider.probe).not.toHaveBeenCalled();
          expect(provider.generate).not.toHaveBeenCalled();
        }
    },
  );
  it.each<[{ provider: ProviderId; model: string }]>([
    [{ provider: "ollama", model: "local-fixture" }],
    [{ provider: "claude-code", model: "sonnet" }],
    [{ provider: "anthropic-api", model: "sonnet" }],
    [{ provider: "litellm", model: "proxy-fixture" }],
    [{ provider: "cursor-manual", model: "packet-fixture" }],
  ])("global/standalone preview and dispatch share %j", async (pin) => {
    const { deps, providers } = fixture();
    const s = io();
    const options: AskCommandOptions = {
      prompt: "synthetic prompt",
      ...pin,
      system: "synthetic system",
      task: "code-review",
      emitJson: true,
      out: s.o,
      err: s.e,
      routerDeps: deps,
    };
    await runAskCommand({ ...options, explain: true });
    const standalone = JSON.parse(s.out.pop() ?? "{}");
    const explainDeps: ExplainDeps = {
      policy: () => policyApiOn,
      select: () => lanes({}),
      frontDoor: async () => {
        throw new Error("standalone ask does not run this hook");
      },
      taisce: defaultTaisceRunDeps,
      ask: (input) => runAskCommand({ ...input, routerDeps: deps }),
    };
    await explainInvocation(
      [
        "ask",
        "synthetic prompt",
        "--provider",
        pin.provider,
        "--model",
        pin.model,
        "--system",
        "synthetic system",
        "--task",
        "code-review",
        "--json",
      ],
      s.o,
      s.e,
      explainDeps,
    );
    const global = JSON.parse(s.out.pop() ?? "{}");
    expect(global).toEqual(standalone);
    expect(global.selectedProvider).toBe(pin.provider);
    expect(global.selectedModel).toBe(pin.model);
    expect(global.fallbackProviders).toEqual([]);
    for (const p of Object.values(providers)) expect(p.generate).not.toHaveBeenCalled();
    expect((await runAskCommand(options)).ok).toBe(true);
    expect(providers[pin.provider].generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: pin.model,
        task: "code-review",
        prompt: "synthetic prompt",
        system: "synthetic system",
      }),
    );
    for (const [id, p] of Object.entries(providers))
      if (id !== pin.provider) {
        expect(p.generate).not.toHaveBeenCalled();
        expect(p.probe).not.toHaveBeenCalled();
      }
  });

  it("resolves the same registry default in preview and dispatch; hosted fallback gets its configured model", async () => {
    const { deps, providers } = fixture();
    providers.ollama.generate.mockRejectedValue(new OllamaModelMissingError("registered-local"));
    const s = io();
    const registryDeps = {
      now,
      netFetch: vi.fn(),
      writeFile: vi.fn(),
      readFile: async () =>
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: now().toISOString(),
          generatedBy: "moss@test",
          source: "http://127.0.0.1:11434/api/tags",
          models: [{ name: "registered-local", provider: "ollama", confidence: 0.8 }],
        }),
    };
    const request = {
      prompt: "fixture",
      emitJson: true,
      out: s.o,
      err: s.e,
      routerDeps: deps,
      registryDeps,
    };
    await runAskCommand({ ...request, explain: true });
    const preview = JSON.parse(s.out.pop() ?? "{}");
    expect(preview.selectedModel).toBe("registered-local");
    expect(preview.fallbackProviders).toContain("claude-code");
    expect(preview.models["claude-code"]).toBe("sonnet");
    expect((await runAskCommand(request)).ok).toBe(true);
    expect(providers["claude-code"].generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "sonnet", prompt: "fixture" }),
    );
  });

  it.each(["ollama", "claude-code"] as const)(
    "a %s pin has no fallback after retryable failure",
    async (provider) => {
      const { deps, providers } = fixture();
      const model = provider === "ollama" ? "local-fixture" : "sonnet";
      providers[provider].generate.mockRejectedValue(
        new OllamaDaemonUnavailableError("synthetic failure"),
      );
      await expect(
        routeAndGenerate("ask", { task: "ask", prompt: "fixture", provider, model }, deps),
      ).rejects.toBeInstanceOf(OllamaDaemonUnavailableError);
      for (const [id, p] of Object.entries(providers))
        if (id !== provider) {
          expect(p.generate).not.toHaveBeenCalled();
          expect(p.probe).not.toHaveBeenCalled();
        }
    },
  );

  it.each([
    ["ollama", "sonnet"],
    ["claude-code", "local-fixture"],
    ["anthropic-api", "local-fixture"],
  ] as const)(
    "rejects incompatible provider/model %s/%s before probing",
    async (provider, model) => {
      const { deps, providers } = fixture();
      await expect(explainProviderRoute("ask", deps, { provider, model })).rejects.toThrow(
        "incompatible",
      );
      await expect(
        routeAndGenerate("ask", { task: "ask", prompt: "fixture", provider, model }, deps),
      ).rejects.toThrow("incompatible");
      for (const p of Object.values(providers)) {
        expect(p.probe).not.toHaveBeenCalled();
        expect(p.generate).not.toHaveBeenCalled();
      }
    },
  );
});

describe("metered API dispatch boundary", () => {
  it("a gated task cannot override an explicit local provider", async () => {
    const { deps, providers } = fixture();
    const select = lanes({
      ollama: "available",
      "claude-code": "available",
      "anthropic-api": "available",
    });
    const d: LaneSessionDeps = {
      policy: () => policyApiOn,
      select: () => select,
      dispatch: (p, c, i) =>
        dispatchChoice(p, c, i, {
          now,
          getProvider: deps.getProvider,
          record: async () => true,
          eurSpentToday: () => 0,
        }),
    };
    const result = await routedGenerate(
      {
        prompt: "synthetic gated request",
        provider: "ollama",
        task: "edit",
        frontDoor: "Domains: irreversible",
      },
      d,
    );
    expect(result.ok).toBe(true);
    expect(result.route).toContain("ollama");
    expect(select.probed).toEqual(["ollama"]);
    expect(providers["claude-code"].generate).not.toHaveBeenCalled();
    expect(providers["anthropic-api"].generate).not.toHaveBeenCalled();
  });
  const unpriced = structuredClone(policyApiOn);
  unpriced.tasks.reason["anthropic-api"] = { model: "unpriced-fixture", max_tokens: 8192 };
  const noBudget: RoutingPolicy = {
    ...policyApiOn,
    caps: { ...policyApiOn.caps, "anthropic-api": { enabled: true, daily_eur: 0 } },
  };
  it.each([
    ["disabled", policy, 0],
    ["exhausted", noBudget, 0],
    ["unpriced", unpriced, 0],
    ["unknown balance", policyApiOn, Number.NaN],
    ["negative balance", policyApiOn, -1],
  ] as const)(
    "standalone asks refuse %s API without probing or dispatching",
    async (_label, p, spent) => {
      const { deps, providers } = fixture(p, () => spent);
      const s = io();
      const options: AskCommandOptions = {
        prompt: "fixture",
        provider: "anthropic-api",
        emitJson: true,
        out: s.o,
        err: s.e,
        routerDeps: deps,
      };
      await runAskCommand({ ...options, explain: true });
      expect(JSON.parse(s.out.pop() ?? "{}").selectedProvider).toBeNull();
      expect((await runAskCommand(options)).ok).toBe(false);
      expect(providers["anthropic-api"].probe).not.toHaveBeenCalled();
      expect(providers["anthropic-api"].generate).not.toHaveBeenCalled();
    },
  );

  it("API fallback rechecks the balance immediately before dispatch", async () => {
    let spent = 0;
    const { deps, providers } = fixture(policyApiOn, () => spent);
    const local = providers.ollama;
    local.generate.mockImplementation(async () => {
      spent = 100;
      throw new OllamaDaemonUnavailableError("fixture");
    });
    await expect(
      routeAndGenerate(
        "ask",
        { task: "ask", prompt: "fixture" },
        { ...deps, listProviders: () => ["ollama", "anthropic-api"] },
      ),
    ).rejects.toThrow("daily cap");
    expect(local.generate).toHaveBeenCalledOnce();
    expect(providers["anthropic-api"].generate).not.toHaveBeenCalled();
  });

  it("disabled API is excluded from fallback before probes", async () => {
    const { deps, providers } = fixture(policy);
    providers.ollama.generate.mockRejectedValue(new OllamaDaemonUnavailableError("fixture"));
    await expect(
      routeAndGenerate(
        "ask",
        { task: "ask", prompt: "fixture" },
        { ...deps, listProviders: () => ["ollama", "anthropic-api"] },
      ),
    ).rejects.toBeInstanceOf(OllamaDaemonUnavailableError);
    expect(providers["anthropic-api"].probe).not.toHaveBeenCalled();
    expect(providers["anthropic-api"].generate).not.toHaveBeenCalled();
  });
});

describe("bundled reviews stay on Ollama", () => {
  it.each(["down", "missing-model", "success"])(
    "%s never probes or dispatches hosted",
    async (outcome) => {
      const { deps, providers } = fixture();
      if (outcome === "down")
        providers.ollama.probe.mockResolvedValue({
          id: "ollama",
          status: "unavailable",
          reason: "fixture outage",
          capabilities: allCapabilitiesAs("unavailable"),
          lastProbedAt: now().toISOString(),
        });
      if (outcome === "missing-model")
        providers.ollama.generate.mockRejectedValue(new OllamaModelMissingError("local-fixture"));
      const result = defaultGenerateViaRouter(
        { model: "local-fixture", prompt: "synthetic review" },
        deps,
      );
      if (outcome === "success") expect((await result).providerId).toBe("ollama");
      else await expect(result).rejects.toThrow();
      for (const id of ["claude-code", "anthropic-api", "litellm"] as const) {
        expect(providers[id].probe).not.toHaveBeenCalled();
        expect(providers[id].generate).not.toHaveBeenCalled();
      }
    },
  );
});

describe("production profile-chat and preview wiring", () => {
  it.each(["ollama", "anthropic-api"] as const)(
    "profile chat preserves %s and its API policy check",
    async (id) => {
      const { deps, providers } = fixture(policy);
      const actual = askModule.runAskCommand;
      const spy = vi.spyOn(askModule, "runAskCommand").mockImplementation((options) => {
        // Capture the profile name, then supply synthetic request data at the ask
        // seam. Profile-reader confinement is deferred to Phase 3.
        const { karlContextProfile: _profile, ...request } = options;
        return actual({ ...request, routerDeps: deps, recordUsage: async () => true });
      });
      try {
        const result = await chatGenerate({
          prompt: "synthetic profile request",
          contextProfile: "fixture-profile",
          provider: id,
          model: id === "ollama" ? "local-fixture" : "sonnet",
          task: "reason",
        });
        expect(spy.mock.calls[0]?.[0]).toMatchObject({
          provider: id,
          karlContextProfile: "fixture-profile",
          task: "code-review",
        });
        expect(result.ok).toBe(id === "ollama");
        expect(providers["anthropic-api"].generate).not.toHaveBeenCalled();
        expect(providers["claude-code"].generate).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("the default external-skill preview selector never starts Ollama", async () => {
    const { providers } = fixture();
    providers.ollama.probe.mockResolvedValue({
      id: "ollama",
      status: "unavailable",
      reason: "synthetic daemon down",
      capabilities: allCapabilitiesAs("unavailable"),
      lastProbedAt: now().toISOString(),
    });
    const provider = vi.spyOn(providerRegistry, "getProvider").mockReturnValue(providers.ollama);
    const start = vi.spyOn(lifecycle, "ensureOllama").mockImplementation(async () => {
      throw new Error("service start forbidden");
    });
    try {
      const result = await defaultTaisceRunDeps.previewSelect?.().probe("ollama");
      expect(result?.status).toBe("unavailable");
      expect(start).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
      start.mockRestore();
    }
  });
});

describe("session edit provider intent", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  async function session(provider: ProviderId, p = policyApiOn, model?: string, slashPin = false) {
    const root = mkdtempSync(join(tmpdir(), "moss-intent-"));
    roots.push(root);
    writeFileSync(join(root, "f.txt"), "old\n");
    const { deps, providers } = fixture(p);
    const record = vi.fn(async () => true);
    const d: LaneSessionDeps = {
      policy: () => p,
      select: () =>
        lanes({ ollama: "available", "claude-code": "available", "anthropic-api": "available" }),
      dispatch: (policy, choice, input) =>
        dispatchChoice(policy, choice, input, {
          getProvider: deps.getProvider,
          record,
          now,
          eurSpentToday: () => 0,
        }),
    };
    const received: ChatGenerateParams[] = [];
    const route = vi.fn((ask, pin, provider) => editRoute(ask, pin, null, d, provider));
    const aider = vi.fn(async () => ({ exitCode: 0, output: "mock dry run" }));
    const s = io();
    async function* input() {
      if (slashPin) yield `/provider ${provider}`;
      yield "/edit change f.txt";
      yield "n";
      yield "/exit";
    }
    await runChatSession({
      lines: input(),
      out: s.o,
      err: s.e,
      ...(slashPin ? {} : { initialProvider: provider }),
      ...(model !== undefined ? { initialModel: model } : {}),
      generate: async (params) => {
        received.push(params);
        return routedGenerate(params, d);
      },
      edit: {
        resolveRepo: async () => root,
        trackedFiles: async () => ["f.txt"],
        checkFiles: () => undefined,
        coderModel: () => "mock-coder",
        aider,
        diffStat: async () => "",
        buildPlanPrompt: () => "synthetic plan",
        parsePlan: () => ({ files: "f.txt", plan: "change it" }),
        pickFiles: () => ["f.txt"],
        route,
        claudeDiff: (repo, plan, files, route) => claudeDiff(repo, plan, files, route, d),
        applyPatch: async () => ({ ok: true, output: "" }),
      },
    });
    return { providers, received, route, aider, messages: s.err };
  }
  it.each([false, true])("local pin reaches edit planning (slash=%s)", async (slash) => {
    const s = await session("ollama", policyApiOn, undefined, slash);
    expect(s.received[0]?.provider).toBe("ollama");
    expect(s.route.mock.calls[0]?.[2]).toBe("ollama");
    expect(s.providers.ollama.generate).toHaveBeenCalledOnce();
    expect(s.aider).toHaveBeenCalledOnce();
    for (const id of ["claude-code", "anthropic-api"] as const) {
      expect(s.providers[id].probe).not.toHaveBeenCalled();
      expect(s.providers[id].generate).not.toHaveBeenCalled();
    }
  });
  it.each(["claude-code", "anthropic-api"] as const)(
    "explicit %s stays pinned through planning and diff generation",
    async (id) => {
      const s = await session(id);
      expect(s.received[0]?.provider).toBe(id);
      expect(s.providers[id].generate).toHaveBeenCalledTimes(2);
      for (const [other, provider] of Object.entries(s.providers))
        if (other !== id) expect(provider.generate).not.toHaveBeenCalled();
      expect(s.aider).not.toHaveBeenCalled();
    },
  );
  it("disabled API edit never starts planning", async () => {
    const s = await session("anthropic-api", policy);
    expect(s.received.every((p) => p.prompt === "n")).toBe(true);
    expect(s.providers["anthropic-api"].generate).not.toHaveBeenCalled();
    expect(s.messages.join("\n")).toContain("no lane can edit");
  });
  it("conflicting local/hosted pins fail before planning", async () => {
    const s = await session("ollama", policyApiOn, "sonnet");
    expect(s.received.every((p) => p.prompt === "n")).toBe(true);
    expect(s.providers["claude-code"].generate).not.toHaveBeenCalled();
    expect(s.messages.join("\n")).toContain("incompatible");
  });
});
