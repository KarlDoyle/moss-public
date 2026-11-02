import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASK_CONTEXT_FILE_MAX_BYTES, runAskCommand } from "../../src/commands/ask.ts";
import { NetworkBoundaryError } from "../../src/lib/net.ts";
import { DEFAULT_NUM_PREDICT } from "../../src/lib/ollama.ts";
import { getProjectRoot, setProjectRoot } from "../../src/lib/paths.ts";
import {
  allCapabilitiesAs,
  getProvider as defaultGetProvider,
  PROVIDER_ORDER,
  type Provider,
  type ProviderId,
  type ProviderProbeResult,
} from "../../src/lib/providers/index.ts";
import type { OllamaProviderDependencies } from "../../src/lib/providers/ollama.ts";
import {
  createOllamaProvider,
  DEFAULT_NUM_CTX,
  OllamaDaemonUnavailableError,
  OllamaModelMissingError,
} from "../../src/lib/providers/ollama.ts";
import {
  defaultRouterDependencies,
  type RouterDependencies,
} from "../../src/lib/providers/router.ts";
import type { Registry, RegistryDependencies } from "../../src/lib/registry.ts";

const FROZEN_NOW = new Date("2026-05-22T10:00:00.000Z");

function fakeRegistry(models: Registry["models"]): Registry {
  return {
    schemaVersion: 1,
    generatedAt: FROZEN_NOW.toISOString(),
    generatedBy: "moss@test",
    source: "http://127.0.0.1:11434/api/tags",
    models,
  };
}

function registryDeps(registry: Registry | null): RegistryDependencies {
  return {
    netFetch: vi.fn(),
    now: () => FROZEN_NOW,
    writeFile: vi.fn(),
    readFile: vi.fn(async () => {
      if (registry === null) {
        const err = new Error("ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      }
      return `${JSON.stringify(registry)}\n`;
    }),
  };
}

function providerDeps(
  netFetch: OllamaProviderDependencies["netFetch"],
): OllamaProviderDependencies {
  return { netFetch };
}

// Wraps a stubbed Ollama netFetch into a full RouterDependencies. Unlike
// passing bare `providerDeps` (which lets `ask.ts` fall through to the
// module-default registry for every other lane), this keeps claude-code
// and anthropic-api out of the loop entirely: their real probes spawn the
// `claude` binary and shell out to the macOS Keychain (`security`)
// respectively, neither of which a unit test may ever trigger. litellm and
// cursor-manual stay on the real (side-effect-free) defaults so fallback
// behaviour (e.g. the cursor-manual handoff test) is unaffected.
function fakeOllamaRouterDeps(
  netFetch: OllamaProviderDependencies["netFetch"],
): RouterDependencies {
  const ollama = createOllamaProvider(providerDeps(netFetch));
  return {
    ...defaultRouterDependencies,
    getProvider: (id: ProviderId): Provider | undefined => {
      if (id === "ollama") return ollama;
      if (id === "claude-code" || id === "anthropic-api") return undefined;
      return defaultGetProvider(id);
    },
  };
}

// Builds a deterministic router-deps fixture for T04 flag tests.
// `available` = the set of provider ids that should probe as available
// (every other id in PROVIDER_ORDER is reported as `unavailable`).
// `generators` = optional per-id generate impls, used when the test
// expects dispatch (e.g. `--task code-review`).
function fakeRouterDeps(opts: {
  available: ReadonlySet<ProviderId>;
  generators?: Partial<Record<ProviderId, NonNullable<Provider["generate"]>>>;
}): RouterDependencies {
  const now = () => FROZEN_NOW;
  const providers: Partial<Record<ProviderId, Provider>> = {};
  for (const id of PROVIDER_ORDER) {
    const isAvailable = opts.available.has(id);
    const status: ProviderProbeResult["status"] = isAvailable ? "available" : "unavailable";
    const provider: Provider = {
      id,
      executionType: "local_dispatch",
      requiresModel: true,
      probe: async () => ({
        id,
        status,
        reason: isAvailable ? `${id} is up` : `${id} is down`,
        capabilities: allCapabilitiesAs(status),
        lastProbedAt: now().toISOString(),
      }),
      ...(opts.generators?.[id] !== undefined
        ? { generate: opts.generators[id] as NonNullable<Provider["generate"]> }
        : isAvailable
          ? {
              generate: async () => ({
                providerId: id,
                model: "stub-model",
                response: `from ${id}`,
              }),
            }
          : {}),
    };
    providers[id] = provider;
  }
  return {
    now,
    listProviders: () => PROVIDER_ORDER,
    getProvider: (id) => providers[id],
  };
}

describe("runAskCommand", () => {
  it("returns a successful generation using the highest-confidence model", async () => {
    const registry = fakeRegistry([
      { name: "llama3.2:3b", provider: "ollama", confidence: 0.78 },
      { name: "llama3.1:latest", provider: "ollama", confidence: 0.7 },
    ]);
    const out: string[] = [];
    const err: string[] = [];
    const result = await runAskCommand({
      prompt: "hello",
      emitJson: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      registryDeps: registryDeps(registry),
      routerDeps: fakeOllamaRouterDeps(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({ model: "llama3.2:3b", response: "world" }),
      })),
    });
    expect(result.ok).toBe(true);
    expect(result.response).toBe("world");
    expect(result.model).toBe("llama3.2:3b");
    expect(out).toEqual(["world"]);
    expect(err).toEqual([]);
  });

  it("records one usage line per successful generation via the recordUsage seam", async () => {
    const registry = fakeRegistry([{ name: "llama3.2:3b", provider: "ollama", confidence: 0.78 }]);
    const calls: unknown[] = [];
    const result = await runAskCommand({
      prompt: "hello",
      emitJson: false,
      out: () => {},
      err: () => {},
      registryDeps: registryDeps(registry),
      routerDeps: fakeOllamaRouterDeps(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          model: "llama3.2:3b",
          response: "world",
          prompt_eval_count: 11,
          eval_count: 3,
        }),
      })),
      recordUsage: async (input) => {
        calls.push(input);
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "ask",
      providerId: "ollama",
      model: "llama3.2:3b",
      task: "ask",
      inputTokens: 11,
      outputTokens: 3,
    });
  });

  it("does not record usage when no recordUsage seam is provided", async () => {
    const registry = fakeRegistry([{ name: "llama3.2:3b", provider: "ollama", confidence: 0.78 }]);
    // No recordUsage seam → no side effect. This is the default for
    // library callers and existing tests; the real CLI wires the seam.
    const result = await runAskCommand({
      prompt: "hello",
      emitJson: false,
      out: () => {},
      err: () => {},
      registryDeps: registryDeps(registry),
      routerDeps: fakeOllamaRouterDeps(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({ model: "llama3.2:3b", response: "world" }),
      })),
    });
    expect(result.ok).toBe(true);
  });

  it("honours --model override and skips registry lookup", async () => {
    let receivedBody = "";
    const out: string[] = [];
    const result = await runAskCommand({
      prompt: "p",
      model: "explicit-model",
      emitJson: false,
      out: (l) => out.push(l),
      err: () => undefined,
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async (_url, opts) => {
        receivedBody = opts?.body ?? "";
        return { ok: true, status: 200, body: JSON.stringify({ response: "ok" }) };
      }),
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(receivedBody).model).toBe("explicit-model");
  });

  it("rejects an empty prompt with a clear error", async () => {
    const err: string[] = [];
    const result = await runAskCommand({
      prompt: "   ",
      emitJson: false,
      out: () => undefined,
      err: (l) => err.push(l),
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async () => ({ ok: true, status: 200, body: "{}" })),
    });
    expect(result.ok).toBe(false);
    expect(err[0]).toContain("prompt must not be empty");
  });

  it("fails clearly when no model is supplied and registry is missing", async () => {
    const err: string[] = [];
    const result = await runAskCommand({
      prompt: "p",
      emitJson: false,
      out: () => undefined,
      err: (l) => err.push(l),
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async () => ({ ok: true, status: 200, body: "{}" })),
    });
    expect(result.ok).toBe(false);
    expect(err[0]).toContain("Registry file not found");
    expect(err[0]).toContain("--refresh");
  });

  it("fails clearly when the registry is empty", async () => {
    const err: string[] = [];
    const result = await runAskCommand({
      prompt: "p",
      emitJson: false,
      out: () => undefined,
      err: (l) => err.push(l),
      registryDeps: registryDeps(fakeRegistry([])),
      routerDeps: fakeOllamaRouterDeps(async () => ({ ok: true, status: 200, body: "{}" })),
    });
    expect(result.ok).toBe(false);
    expect(err[0]).toContain("no models");
    expect(err[0]).toContain("--refresh");
  });

  it("fails clearly when the daemon is unreachable AND no other lane is in scope", async () => {
    // T05 fallback note: in the default route order Moss now considers
    // both ollama and cursor-manual, so a bare "daemon down" scenario
    // would silently fall back to the handoff lane. To pin the M2
    // behavioural contract (clear daemon-down message when there is no
    // fallback) we shrink listProviders to just `ollama`. The original
    // "Start the daemon" wording is propagated by the router via the
    // probe's `reason` string.
    const throwingOllama = createOllamaProvider({
      netFetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const onlyOllamaDeps = {
      now: () => FROZEN_NOW,
      listProviders: () => ["ollama" as const],
      getProvider: (id: ProviderId) => (id === "ollama" ? throwingOllama : undefined),
    };
    const err: string[] = [];
    const result = await runAskCommand({
      prompt: "p",
      model: "x",
      emitJson: false,
      out: () => undefined,
      err: (l) => err.push(l),
      registryDeps: registryDeps(null),
      routerDeps: onlyOllamaDeps,
    });
    expect(result.ok).toBe(false);
    expect(err[0]).toContain("Ollama daemon");
    expect(err[0]).toContain("Start the daemon");
  });

  it("falls back to cursor-manual handoff when Ollama is unreachable (T05)", async () => {
    // With the default lane list (which now includes cursor-manual),
    // Ollama-down is no longer a fatal error: the router selects the
    // handoff lane and returns a structured packet. This is the M3
    // memo decision 2 guarantee — every Moss box has a working answer.
    const out: string[] = [];
    const result = await runAskCommand({
      prompt: "review my diff",
      model: "x",
      emitJson: true,
      out: (l) => out.push(l),
      err: () => undefined,
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(out[0] ?? "");
    expect(parsed.mode).toBe("handoff");
    expect(parsed.providerId).toBe("cursor-manual");
    expect(parsed.handoff.schemaVersion).toBe("handoff_v1");
    expect(parsed.handoff.prompt).toBe("review my diff");
  });

  it("fails clearly when the requested model is missing (HTTP 404)", async () => {
    // In M3 the router probes the daemon before dispatch, so we need a
    // URL-aware mock here: `/api/tags` returns 200 (daemon is up) and
    // `/api/generate` returns 404 (the requested model is missing).
    // The user-facing "ollama pull <model>" message lives on the
    // generate-time OllamaModelMissingError.
    const err: string[] = [];
    const result = await runAskCommand({
      prompt: "p",
      model: "ghost",
      emitJson: false,
      out: () => undefined,
      err: (l) => err.push(l),
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async (url) => {
        if (url.endsWith("/api/tags")) {
          return { ok: true, status: 200, body: JSON.stringify({ models: [] }) };
        }
        return { ok: false, status: 404, body: "" };
      }),
    });
    expect(result.ok).toBe(false);
    expect(err[0]).toContain("not installed locally");
    expect(err[0]).toContain("ollama pull ghost");
  });

  it("surfaces a NetworkBoundaryError verbatim (does not wrap)", async () => {
    const err: string[] = [];
    const result = await runAskCommand({
      prompt: "p",
      model: "x",
      emitJson: false,
      out: () => undefined,
      err: (l) => err.push(l),
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async () => {
        throw new NetworkBoundaryError("https://evil", "not in M1 allowlist");
      }),
    });
    expect(result.ok).toBe(false);
    expect(err[0]).toContain("rejected by the Moss safety boundary");
  });

  it("emits JSON when emitJson=true", async () => {
    const out: string[] = [];
    const result = await runAskCommand({
      prompt: "p",
      model: "x",
      emitJson: true,
      out: (l) => out.push(l),
      err: () => undefined,
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({ model: "x", response: "y" }),
      })),
    });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(out[0] ?? "");
    expect(parsed).toEqual({ ok: true, model: "x", response: "y" });
  });

  it("forwards system and temperature in the request body", async () => {
    let body = "";
    await runAskCommand({
      prompt: "p",
      model: "x",
      system: "be helpful",
      temperature: 0.7,
      emitJson: false,
      out: () => undefined,
      err: () => undefined,
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async (_url, opts) => {
        body = opts?.body ?? "";
        return { ok: true, status: 200, body: JSON.stringify({ response: "ok" }) };
      }),
    });
    const parsed = JSON.parse(body);
    expect(parsed.system).toBe("be helpful");
    expect(parsed.options).toEqual({
      num_ctx: DEFAULT_NUM_CTX,
      num_predict: DEFAULT_NUM_PREDICT,
      temperature: 0.7,
    });
  });

  describe("--context-file", () => {
    const realRoot = getProjectRoot();
    let sandbox: string;
    let outside: string;

    beforeEach(() => {
      sandbox = mkdtempSync(join(tmpdir(), "moss-ask-context-"));
      outside = mkdtempSync(join(tmpdir(), "moss-ask-outside-"));
      setProjectRoot(sandbox);
      mkdirSync(join(sandbox, "docs"), { recursive: true });
    });

    afterEach(() => {
      setProjectRoot(realRoot);
      rmSync(sandbox, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    it("composes an explicit in-repo context file into the generated prompt", async () => {
      writeFileSync(join(sandbox, "docs/context.md"), "# Moss\n\nMoss v0.1.1 adds context.\n");
      let receivedPrompt = "";
      const generateSpy = vi.fn(async (opts) => {
        receivedPrompt = opts.prompt;
        return {
          providerId: "ollama" as const,
          model: "stub-model",
          response: "ok",
        };
      });
      const routerDeps = fakeRouterDeps({
        available: new Set(["ollama"]),
        generators: { ollama: generateSpy },
      });
      const out: string[] = [];
      const result = await runAskCommand({
        prompt: "What can Moss do?",
        contextFilePath: "docs/context.md",
        model: "stub",
        emitJson: true,
        out: (line) => out.push(line),
        err: () => undefined,
        routerDeps,
      });
      expect(result.ok).toBe(true);
      expect(receivedPrompt).toContain("operator-provided context");
      expect(receivedPrompt).toContain("Moss v0.1.1 adds context.");
      expect(receivedPrompt).toContain("USER_PROMPT:");
      expect(receivedPrompt).toContain("What can Moss do?");
      const parsed = JSON.parse(out[0] ?? "{}");
      expect(parsed.contextFile.path).toBe("docs/context.md");
      expect(parsed.contextFile.maxBytes).toBe(ASK_CONTEXT_FILE_MAX_BYTES);
    });

    it("rejects an absolute context file outside the project", async () => {
      const outsideFile = join(outside, "context.md");
      writeFileSync(outsideFile, "outside");
      const err: string[] = [];
      const result = await runAskCommand({
        prompt: "p",
        contextFilePath: outsideFile,
        model: "stub",
        emitJson: false,
        out: () => undefined,
        err: (line) => err.push(line),
        routerDeps: fakeRouterDeps({ available: new Set(["ollama"]) }),
      });
      expect(result.ok).toBe(false);
      expect(err.join("\n")).toContain("outside the project root");
    });

    it("rejects traversal segments before reading", async () => {
      writeFileSync(join(sandbox, "docs/context.md"), "ok");
      const err: string[] = [];
      const result = await runAskCommand({
        prompt: "p",
        contextFilePath: "docs/../docs/context.md",
        model: "stub",
        emitJson: false,
        out: () => undefined,
        err: (line) => err.push(line),
        routerDeps: fakeRouterDeps({ available: new Set(["ollama"]) }),
      });
      expect(result.ok).toBe(false);
      expect(err.join("\n")).toContain("traversal");
    });

    it("rejects a symlink escape", async () => {
      const outsideFile = join(outside, "context.md");
      writeFileSync(outsideFile, "outside");
      symlinkSync(outsideFile, join(sandbox, "docs/link.md"));
      const err: string[] = [];
      const result = await runAskCommand({
        prompt: "p",
        contextFilePath: "docs/link.md",
        model: "stub",
        emitJson: false,
        out: () => undefined,
        err: (line) => err.push(line),
        routerDeps: fakeRouterDeps({ available: new Set(["ollama"]) }),
      });
      expect(result.ok).toBe(false);
      expect(err.join("\n")).toContain("outside the project root");
    });

    it("rejects oversized files", async () => {
      writeFileSync(join(sandbox, "docs/large.md"), "x".repeat(ASK_CONTEXT_FILE_MAX_BYTES + 1));
      const err: string[] = [];
      const result = await runAskCommand({
        prompt: "p",
        contextFilePath: "docs/large.md",
        model: "stub",
        emitJson: false,
        out: () => undefined,
        err: (line) => err.push(line),
        routerDeps: fakeRouterDeps({ available: new Set(["ollama"]) }),
      });
      expect(result.ok).toBe(false);
      expect(err.join("\n")).toContain("maximum");
    });

    it("rejects directories", async () => {
      mkdirSync(join(sandbox, "docs/context.md"), { recursive: true });
      const err: string[] = [];
      const result = await runAskCommand({
        prompt: "p",
        contextFilePath: "docs/context.md",
        model: "stub",
        emitJson: false,
        out: () => undefined,
        err: (line) => err.push(line),
        routerDeps: fakeRouterDeps({ available: new Set(["ollama"]) }),
      });
      expect(result.ok).toBe(false);
      expect(err.join("\n")).toContain("directory");
    });

    it("does not read the context file in explain mode", async () => {
      const readFile = vi.fn(async () => {
        throw new Error("should not read");
      });
      const result = await runAskCommand({
        prompt: "",
        contextFilePath: "docs/missing.md",
        explain: true,
        emitJson: false,
        out: () => undefined,
        err: () => undefined,
        contextFileDeps: {
          stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 1 }),
          readFile,
        },
        routerDeps: fakeRouterDeps({ available: new Set(["ollama"]) }),
      });
      expect(result.ok).toBe(true);
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe("--explain (T04)", () => {
    it("prints the route preview and does not dispatch", async () => {
      const generateSpy = vi.fn();
      const routerDeps = fakeRouterDeps({
        available: new Set(["ollama"]),
        generators: { ollama: generateSpy },
      });
      const out: string[] = [];
      const err: string[] = [];
      const result = await runAskCommand({
        prompt: "",
        explain: true,
        emitJson: false,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        routerDeps,
      });
      expect(result.ok).toBe(true);
      expect(generateSpy).not.toHaveBeenCalled();
      expect(err).toEqual([]);
      const body = out.join("\n");
      expect(body).toContain("moss ask — route preview");
      expect(body).toContain("Selected provider: ollama");
    });

    it("does not require a prompt", async () => {
      const routerDeps = fakeRouterDeps({ available: new Set(["ollama"]) });
      const result = await runAskCommand({
        prompt: "   ",
        explain: true,
        emitJson: false,
        out: () => undefined,
        err: () => undefined,
        routerDeps,
      });
      expect(result.ok).toBe(true);
    });

    it("does not load the model registry in explain mode", async () => {
      const readFile = vi.fn();
      const routerDeps = fakeRouterDeps({ available: new Set(["ollama"]) });
      const result = await runAskCommand({
        prompt: "",
        explain: true,
        emitJson: false,
        out: () => undefined,
        err: () => undefined,
        registryDeps: {
          netFetch: vi.fn(),
          now: () => FROZEN_NOW,
          writeFile: vi.fn(),
          readFile,
        },
        routerDeps,
      });
      expect(result.ok).toBe(true);
      expect(readFile).not.toHaveBeenCalled();
    });

    it("emits the documented JSON shape with --explain --json", async () => {
      const routerDeps = fakeRouterDeps({ available: new Set(["ollama"]) });
      const out: string[] = [];
      const result = await runAskCommand({
        prompt: "",
        explain: true,
        emitJson: true,
        out: (l) => out.push(l),
        err: () => undefined,
        routerDeps,
      });
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(out[0] ?? "");
      expect(parsed.ok).toBe(true);
      expect(parsed.mode).toBe("explain");
      expect(parsed.task).toBe("ask");
      expect(parsed.selectedProvider).toBe("ollama");
      expect(Array.isArray(parsed.providers)).toBe(true);
      // One row per PROVIDER_ORDER lane; output order matches.
      expect(parsed.providers.map((r: { id: string }) => r.id)).toEqual([...PROVIDER_ORDER]);
      const selectedRow = parsed.providers.find((r: { id: string }) => r.id === "ollama");
      expect(selectedRow.isSelected).toBe(true);
      expect(selectedRow.status).toBe("available");
    });

    it("surfaces a NetworkBoundaryError verbatim in explain mode", async () => {
      const probeBoom: Provider = {
        id: "ollama",
        executionType: "local_dispatch",
        requiresModel: true,
        probe: async () => {
          throw new NetworkBoundaryError("https://evil", "not allowed");
        },
      };
      const routerDeps: RouterDependencies = {
        now: () => FROZEN_NOW,
        listProviders: () => ["ollama"],
        getProvider: (id) => (id === "ollama" ? probeBoom : undefined),
      };
      const err: string[] = [];
      const result = await runAskCommand({
        prompt: "",
        explain: true,
        emitJson: false,
        out: () => undefined,
        err: (l) => err.push(l),
        routerDeps,
      });
      expect(result.ok).toBe(false);
      expect(err[0]).toContain("rejected by the Moss safety boundary");
    });
  });

  describe("--task (T04)", () => {
    it("routes through the requested task id", async () => {
      const generateSpy = vi.fn(async (_opts) => ({
        providerId: "ollama" as const,
        model: "stub-model",
        response: "ok",
      }));
      const routerDeps = fakeRouterDeps({
        available: new Set(["ollama"]),
        generators: { ollama: generateSpy },
      });
      const result = await runAskCommand({
        prompt: "p",
        model: "x",
        task: "code-review",
        emitJson: false,
        out: () => undefined,
        err: () => undefined,
        routerDeps,
      });
      expect(result.ok).toBe(true);
      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(generateSpy.mock.calls[0]?.[0]?.task).toBe("code-review");
    });

    it("includes the chosen task in the explain output", async () => {
      const routerDeps = fakeRouterDeps({ available: new Set(["ollama"]) });
      const out: string[] = [];
      await runAskCommand({
        prompt: "",
        task: "code-review",
        explain: true,
        emitJson: true,
        out: (l) => out.push(l),
        err: () => undefined,
        routerDeps,
      });
      const parsed = JSON.parse(out[0] ?? "");
      expect(parsed.task).toBe("code-review");
    });
  });

  describe("--provider (T04)", () => {
    it("pins routing to the named lane and ignores other available lanes", async () => {
      // Two lanes report available; pin to a real lane and verify the
      // other one is NOT considered (no fallback chain entry, no
      // selection of it). We use 'ollama' as the pinned lane because
      // it is the only lane with a real implementation in this build;
      // here we mock both via the router deps so the test is purely
      // about the router's behaviour, not the registry.
      const ollamaGen = vi.fn(async () => ({
        providerId: "ollama" as const,
        model: "stub",
        response: "from ollama",
      }));
      const litellmGen = vi.fn(async () => ({
        providerId: "litellm" as const,
        model: "stub",
        response: "from litellm",
      }));
      const routerDeps = fakeRouterDeps({
        available: new Set<ProviderId>(["ollama", "litellm"]),
        generators: { ollama: ollamaGen, litellm: litellmGen },
      });
      const result = await runAskCommand({
        prompt: "p",
        model: "x",
        provider: "litellm",
        emitJson: false,
        out: () => undefined,
        err: () => undefined,
        routerDeps,
      });
      expect(result.ok).toBe(true);
      expect(litellmGen).toHaveBeenCalledTimes(1);
      expect(ollamaGen).not.toHaveBeenCalled();
    });

    it("reflects the pin in --explain output (only the pinned lane is selectable)", async () => {
      const routerDeps = fakeRouterDeps({
        available: new Set<ProviderId>(["ollama", "litellm"]),
      });
      const out: string[] = [];
      await runAskCommand({
        prompt: "",
        provider: "litellm",
        explain: true,
        emitJson: true,
        out: (l) => out.push(l),
        err: () => undefined,
        routerDeps,
      });
      const parsed = JSON.parse(out[0] ?? "");
      expect(parsed.selectedProvider).toBe("litellm");
      expect(parsed.fallbackProviders).toEqual([]);
      // Every other lane is reported as "not present in the active
      // router's listProviders() result" — the renderer's defensive
      // branch for pinned routing.
      for (const id of PROVIDER_ORDER) {
        if (id === "litellm") continue;
        const row = parsed.providers.find((r: { id: string }) => r.id === id);
        expect(row).toBeDefined();
        expect(row.isSelected).toBe(false);
      }
    });

    it("fails clearly when the pinned provider is unavailable", async () => {
      // Pin to litellm, but litellm probes as unavailable; nothing else
      // is eligible because of the pin.
      const routerDeps = fakeRouterDeps({ available: new Set<ProviderId>(["ollama"]) });
      const err: string[] = [];
      const result = await runAskCommand({
        prompt: "p",
        model: "x",
        provider: "litellm",
        emitJson: false,
        out: () => undefined,
        err: (l) => err.push(l),
        routerDeps,
      });
      expect(result.ok).toBe(false);
      // The user-facing line should not mention 'ollama' — the pin
      // explicitly removed it from consideration.
      expect(err[0]).not.toContain("ollama");
      expect(err[0]).toContain("litellm");
    });
  });

  it("does not surface the internal error class names in user-facing text", async () => {
    const err: string[] = [];
    await runAskCommand({
      prompt: "p",
      model: "ghost",
      emitJson: false,
      out: () => undefined,
      err: (l) => err.push(l),
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async () => {
        throw new OllamaModelMissingError("ghost");
      }),
    });
    expect(err.join("\n")).not.toContain("OllamaModelMissingError");
    await runAskCommand({
      prompt: "p",
      model: "x",
      emitJson: false,
      out: () => undefined,
      err: (l) => err.push(l),
      registryDeps: registryDeps(null),
      routerDeps: fakeOllamaRouterDeps(async () => {
        throw new OllamaDaemonUnavailableError("no daemon");
      }),
    });
    expect(err.join("\n")).not.toContain("OllamaDaemonUnavailableError");
  });
});
