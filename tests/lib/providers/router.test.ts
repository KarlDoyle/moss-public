import { describe, expect, it, vi } from "vitest";
import { NetworkBoundaryError } from "../../../src/lib/net.ts";
import {
  allCapabilitiesAs,
  PROVIDER_ORDER,
  type Provider,
  type ProviderId,
  type ProviderProbeResult,
  type TaskId,
} from "../../../src/lib/providers/index.ts";
import {
  OllamaDaemonUnavailableError,
  OllamaModelMissingError,
} from "../../../src/lib/providers/ollama.ts";
import {
  AllProvidersFailedError,
  explainProviderRoute,
  NoProviderAvailableError,
  type RouterDependencies,
  routeAndGenerate,
} from "../../../src/lib/providers/router.ts";
import { policyApiOn } from "../lanes/fixtures.ts";

const FROZEN_NOW = () => new Date("2026-05-22T15:00:00.000Z");

function fakeProvider(opts: {
  id: ProviderId;
  status: ProviderProbeResult["status"];
  capabilities?: ProviderProbeResult["capabilities"];
  reason?: string;
  generate?: Provider["generate"];
  probeThrows?: Error;
  executionType?: Provider["executionType"];
  requiresModel?: boolean;
}): Provider {
  const probe = async (now: () => Date = FROZEN_NOW): Promise<ProviderProbeResult> => {
    if (opts.probeThrows !== undefined) throw opts.probeThrows;
    return {
      id: opts.id,
      status: opts.status,
      reason: opts.reason ?? `${opts.id} probe → ${opts.status}`,
      capabilities: opts.capabilities ?? allCapabilitiesAs(opts.status),
      lastProbedAt: now().toISOString(),
    };
  };
  const provider: Provider = {
    id: opts.id,
    executionType: opts.executionType ?? "local_dispatch",
    requiresModel: opts.requiresModel ?? true,
    probe,
    ...(opts.generate !== undefined ? { generate: opts.generate } : {}),
  };
  return provider;
}

function depsWithProviders(
  providers: Partial<Record<ProviderId, Provider>>,
  listProviders: () => readonly ProviderId[] = () => PROVIDER_ORDER,
): RouterDependencies {
  return {
    listProviders,
    getProvider: (id) => providers[id],
    now: FROZEN_NOW,
    policy: () => policyApiOn,
    eurSpentToday: () => 0,
  };
}

describe("router.explainProviderRoute", () => {
  it("selects the first eligible provider in PROVIDER_ORDER", async () => {
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => ({
        providerId: "ollama",
        model: "llama3.2:3b",
        response: "x",
      }),
    });
    const explanation = await explainProviderRoute("ask", depsWithProviders({ ollama }));
    expect(explanation.selectedProvider).toBe("ollama");
    expect(explanation.fallbackProviders).toEqual([]);
    expect(explanation.task).toBe("ask");
    expect(explanation.probedAt).toBe("2026-05-22T15:00:00.000Z");
    // Every lane without an implementation must be listed as
    // unavailable with the synthetic 'not_installed' status.
    for (const id of PROVIDER_ORDER.filter((id) => id !== "ollama")) {
      const entry = explanation.unavailableProviders.find((u) => u.id === id);
      expect(entry).toBeDefined();
      expect(entry?.status).toBe("not_installed");
    }
  });

  it("lists fallbacks in PROVIDER_ORDER when multiple lanes are eligible", async () => {
    const generate = async () => ({
      providerId: "ollama" as ProviderId,
      model: "m",
      response: "r",
    });
    const ollama = fakeProvider({ id: "ollama", status: "available", generate });
    const anthropicApi = fakeProvider({ id: "anthropic-api", status: "available", generate });
    const litellm = fakeProvider({ id: "litellm", status: "available", generate });
    const explanation = await explainProviderRoute(
      "ask",
      depsWithProviders({ ollama, "anthropic-api": anthropicApi, litellm }),
    );
    expect(explanation.selectedProvider).toBe("ollama");
    expect(explanation.fallbackProviders).toEqual(["anthropic-api", "litellm"]);
  });

  it("excludes providers whose generate() is missing (detection-only lanes)", async () => {
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => ({ providerId: "ollama", model: "m", response: "r" }),
    });
    // Detection-only: probe says available, but no generate impl.
    const litellm = fakeProvider({ id: "litellm", status: "available" });
    const explanation = await explainProviderRoute("ask", depsWithProviders({ ollama, litellm }));
    expect(explanation.selectedProvider).toBe("ollama");
    expect(explanation.fallbackProviders).not.toContain("litellm");
    const litellmEntry = explanation.unavailableProviders.find((u) => u.id === "litellm");
    expect(litellmEntry).toBeDefined();
    expect(litellmEntry?.reason).toMatch(/detection-only/i);
  });

  it("excludes providers whose per-task capability is not 'available'", async () => {
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      capabilities: { ask: "available", "code-review": "unsupported" },
      generate: async () => ({ providerId: "ollama", model: "m", response: "r" }),
    });
    const askExp = await explainProviderRoute("ask", depsWithProviders({ ollama }));
    expect(askExp.selectedProvider).toBe("ollama");
    const reviewExp = await explainProviderRoute("code-review", depsWithProviders({ ollama }));
    expect(reviewExp.selectedProvider).toBeNull();
    const entry = reviewExp.unavailableProviders.find((u) => u.id === "ollama");
    expect(entry?.reason).toMatch(/capability=unsupported/);
  });

  it("records 'unknown' capabilities under unknownCapabilities", async () => {
    const litellm = fakeProvider({
      id: "litellm",
      status: "available",
      capabilities: { ask: "unknown", "code-review": "unknown" },
      generate: async () => ({ providerId: "litellm" as ProviderId, model: "m", response: "r" }),
    });
    const explanation = await explainProviderRoute("ask", depsWithProviders({ litellm }));
    expect(explanation.selectedProvider).toBeNull();
    expect(explanation.unknownCapabilities).toEqual([{ id: "litellm", task: "ask" }]);
  });

  it("returns selectedProvider=null with reasons when nothing is eligible", async () => {
    const ollamaDown = fakeProvider({
      id: "ollama",
      status: "unavailable",
      reason: "daemon down",
      generate: async () => ({ providerId: "ollama", model: "m", response: "r" }),
    });
    const explanation = await explainProviderRoute(
      "ask",
      depsWithProviders({ ollama: ollamaDown }),
    );
    expect(explanation.selectedProvider).toBeNull();
    expect(explanation.fallbackProviders).toEqual([]);
    const entry = explanation.unavailableProviders.find((u) => u.id === "ollama");
    expect(entry?.reason).toContain("daemon down");
  });

  it("treats non-NetworkBoundary probe errors as status='unknown' (no default-success)", async () => {
    const flaky = fakeProvider({
      id: "ollama",
      status: "available",
      probeThrows: new Error("boom"),
    });
    const explanation = await explainProviderRoute("ask", depsWithProviders({ ollama: flaky }));
    expect(explanation.selectedProvider).toBeNull();
    const entry = explanation.unavailableProviders.find((u) => u.id === "ollama");
    expect(entry?.status).toBe("unknown");
    expect(entry?.reason).toMatch(/Probe threw/);
  });

  it("propagates NetworkBoundaryError from a probe without downgrading to 'unknown'", async () => {
    const malicious = fakeProvider({
      id: "ollama",
      status: "available",
      probeThrows: new NetworkBoundaryError("https://evil", "not in M1 allowlist"),
    });
    await expect(
      explainProviderRoute("ask", depsWithProviders({ ollama: malicious })),
    ).rejects.toBeInstanceOf(NetworkBoundaryError);
  });

  it("is deterministic across repeated calls with the same probe outputs", async () => {
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => ({ providerId: "ollama", model: "m", response: "r" }),
    });
    const a = await explainProviderRoute("ask", depsWithProviders({ ollama }));
    const b = await explainProviderRoute("ask", depsWithProviders({ ollama }));
    expect(a).toEqual(b);
  });
});

describe("provider request byte budget", () => {
  it("refuses a multibyte prompt before any provider generation", async () => {
    const generate = vi.fn(async () => ({
      providerId: "ollama" as const,
      model: "m",
      response: "r",
    }));
    const ollama = fakeProvider({ id: "ollama", status: "available", generate });
    await expect(
      routeAndGenerate(
        "ask",
        { task: "ask", prompt: "ééé", model: "fixture", maxRequestBytes: 5 },
        depsWithProviders({ ollama }, () => ["ollama"]),
      ),
    ).rejects.toThrow(/request is 6 bytes.*limit is 5 bytes/);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("router.routeAndGenerate", () => {
  it("dispatches to the selected provider and returns its result + explanation", async () => {
    const generate = vi.fn(async () => ({
      providerId: "ollama" as ProviderId,
      model: "llama3.2:3b",
      response: "world",
    }));
    const ollama = fakeProvider({ id: "ollama", status: "available", generate });
    const { result, explanation } = await routeAndGenerate(
      "ask",
      { task: "ask", prompt: "hi", model: "llama3.2:3b" },
      depsWithProviders({ ollama }),
    );
    expect(generate).toHaveBeenCalledOnce();
    expect(result.providerId).toBe("ollama");
    expect(result.response).toBe("world");
    expect(explanation.selectedProvider).toBe("ollama");
  });

  it("throws NoProviderAvailableError when no provider is eligible, with the explanation attached", async () => {
    const ollamaDown = fakeProvider({
      id: "ollama",
      status: "unavailable",
      reason: "daemon down",
      generate: async () => ({ providerId: "ollama", model: "m", response: "r" }),
    });
    let caught: unknown;
    try {
      await routeAndGenerate(
        "ask",
        { task: "ask", prompt: "hi", model: "x" },
        depsWithProviders({ ollama: ollamaDown }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NoProviderAvailableError);
    const err = caught as NoProviderAvailableError;
    expect(err.task).toBe("ask");
    expect(err.explanation.selectedProvider).toBeNull();
    expect(err.explanation.unavailableProviders.some((u) => u.id === "ollama")).toBe(true);
    expect(err.message).toContain("daemon down");
  });

  it("does NOT call generate when the selected provider's status is not 'available'", async () => {
    const generate = vi.fn(async () => ({
      providerId: "ollama" as ProviderId,
      model: "m",
      response: "r",
    }));
    const ollamaDown = fakeProvider({
      id: "ollama",
      status: "unavailable",
      generate,
    });
    await expect(
      routeAndGenerate(
        "ask",
        { task: "ask", prompt: "hi", model: "x" },
        depsWithProviders({ ollama: ollamaDown }),
      ),
    ).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(generate).not.toHaveBeenCalled();
  });

  it("scans listProviders() in order — selection is order-stable regardless of probe completion order", async () => {
    // Use a custom listProviders that has anthropic-api BEFORE ollama.
    // Both are available; the order should determine the winner.
    const generate = async () => ({
      providerId: "ollama" as ProviderId,
      model: "m",
      response: "r",
    });
    const ollama = fakeProvider({ id: "ollama", status: "available", generate });
    const anthropicApi = fakeProvider({ id: "anthropic-api", status: "available", generate });
    const customOrder: readonly ProviderId[] = ["anthropic-api", "ollama"];
    const explanation = await explainProviderRoute(
      "ask",
      depsWithProviders({ ollama, "anthropic-api": anthropicApi }, () => customOrder),
    );
    expect(explanation.selectedProvider).toBe("anthropic-api");
    expect(explanation.fallbackProviders).toEqual(["ollama"]);
  });
});

describe("router → ask/run integration shapes (sanity)", () => {
  it("covers every task id with no missed branches", async () => {
    const tasks: readonly TaskId[] = ["ask", "code-review"];
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => ({ providerId: "ollama", model: "m", response: "r" }),
    });
    for (const task of tasks) {
      const explanation = await explainProviderRoute(task, depsWithProviders({ ollama }));
      expect(explanation.task).toBe(task);
      expect(explanation.selectedProvider).toBe("ollama");
    }
  });
});

describe("router.routeAndGenerate — M11 fallback cascade", () => {
  const okGenerate = (id: ProviderId): Provider["generate"] => {
    return async (options) => ({ providerId: id, model: "m", response: `${id}:${options.prompt}` });
  };

  it("falls back to the next dispatching lane on a retryable failure, prompt preserved", async () => {
    let litellmSawPrompt: string | undefined;
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => {
        throw new OllamaDaemonUnavailableError("connection refused");
      },
    });
    const litellm = fakeProvider({
      id: "litellm",
      status: "available",
      executionType: "remote_dispatch",
      generate: async (options) => {
        litellmSawPrompt = options.prompt;
        return { providerId: "litellm", model: "m", response: "served by litellm" };
      },
    });
    const { result, explanation } = await routeAndGenerate(
      "ask",
      { task: "ask", prompt: "hello", model: "m", modelIsDefault: true },
      depsWithProviders({ ollama, litellm }, () => ["ollama", "litellm"]),
    );
    expect(result.providerId).toBe("litellm");
    expect(result.response).toBe("served by litellm");
    // The prompt is never lost when cascading.
    expect(litellmSawPrompt).toBe("hello");
    // The explanation stays the pre-dispatch DECISION (deterministic).
    expect(explanation.selectedProvider).toBe("ollama");
    expect(explanation.fallbackProviders).toEqual(["litellm"]);
  });

  it("propagates a NetworkBoundaryError immediately without attempting fallback", async () => {
    let litellmCalled = false;
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => {
        throw new NetworkBoundaryError("http://evil", "not in allowlist");
      },
    });
    const litellm = fakeProvider({
      id: "litellm",
      status: "available",
      executionType: "remote_dispatch",
      generate: async () => {
        litellmCalled = true;
        return { providerId: "litellm", model: "m", response: "x" };
      },
    });
    await expect(
      routeAndGenerate(
        "ask",
        { task: "ask", prompt: "p", model: "m", modelIsDefault: true },
        depsWithProviders({ ollama, litellm }, () => ["ollama", "litellm"]),
      ),
    ).rejects.toBeInstanceOf(NetworkBoundaryError);
    expect(litellmCalled).toBe(false);
  });

  it("propagates an unknown (terminal) error immediately without fallback", async () => {
    let litellmCalled = false;
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => {
        throw new Error("unexpected bug");
      },
    });
    const litellm = fakeProvider({
      id: "litellm",
      status: "available",
      executionType: "remote_dispatch",
      generate: async () => {
        litellmCalled = true;
        return { providerId: "litellm", model: "m", response: "x" };
      },
    });
    await expect(
      routeAndGenerate(
        "ask",
        { task: "ask", prompt: "p", model: "m", modelIsDefault: true },
        depsWithProviders({ ollama, litellm }, () => ["ollama", "litellm"]),
      ),
    ).rejects.toThrow("unexpected bug");
    expect(litellmCalled).toBe(false);
  });

  it("re-throws the original error unchanged when only one lane was attempted", async () => {
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => {
        throw new OllamaModelMissingError("ghost");
      },
    });
    await expect(
      routeAndGenerate(
        "ask",
        { task: "ask", prompt: "p", model: "ghost" },
        depsWithProviders({ ollama }, () => ["ollama"]),
      ),
    ).rejects.toBeInstanceOf(OllamaModelMissingError);
  });

  it("throws AllProvidersFailedError when >1 dispatching lane all fail retryably", async () => {
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => {
        throw new OllamaDaemonUnavailableError("down");
      },
    });
    const litellm = fakeProvider({
      id: "litellm",
      status: "available",
      executionType: "remote_dispatch",
      generate: async () => {
        throw new OllamaDaemonUnavailableError("also down");
      },
    });
    const error = await routeAndGenerate(
      "ask",
      { task: "ask", prompt: "p", model: "m", modelIsDefault: true },
      depsWithProviders({ ollama, litellm }, () => ["ollama", "litellm"]),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(AllProvidersFailedError);
    expect((error as AllProvidersFailedError).failures.map((f) => f.id)).toEqual([
      "ollama",
      "litellm",
    ]);
  });

  it("does not auto-fall-back to a manual_handoff lane (re-throws the executor's error)", async () => {
    let handoffCalled = false;
    const ollama = fakeProvider({
      id: "ollama",
      status: "available",
      generate: async () => {
        throw new OllamaModelMissingError("ghost");
      },
    });
    const cursor = fakeProvider({
      id: "cursor-manual",
      status: "available",
      executionType: "manual_handoff",
      requiresModel: false,
      generate: async () => {
        handoffCalled = true;
        return { providerId: "cursor-manual", model: "m", response: "packet" };
      },
    });
    await expect(
      routeAndGenerate(
        "ask",
        { task: "ask", prompt: "p", model: "ghost" },
        depsWithProviders({ ollama, "cursor-manual": cursor }, () => ["ollama", "cursor-manual"]),
      ),
    ).rejects.toBeInstanceOf(OllamaModelMissingError);
    // The handoff lane is NOT invoked as an automatic fallback.
    expect(handoffCalled).toBe(false);
  });

  it("still selects a manual_handoff lane when it is the PRIMARY choice", async () => {
    const cursor = fakeProvider({
      id: "cursor-manual",
      status: "available",
      executionType: "manual_handoff",
      requiresModel: false,
      generate: okGenerate("cursor-manual"),
    });
    const { result } = await routeAndGenerate(
      "ask",
      { task: "ask", prompt: "hi", model: "m", modelIsDefault: true, provider: "cursor-manual" },
      depsWithProviders({ "cursor-manual": cursor }, () => ["cursor-manual"]),
    );
    expect(result.providerId).toBe("cursor-manual");
  });
});
