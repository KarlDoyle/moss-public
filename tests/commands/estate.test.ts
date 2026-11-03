import { describe, expect, it, vi } from "vitest";
import type { DoctorReport } from "../../src/commands/doctor.ts";
import {
  CREDITS_TEXT,
  formatStatus,
  type LocalDeps,
  runLocal,
  shellOnlyMessage,
  tierLabel,
} from "../../src/commands/estate.ts";

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    ok: true,
    node: { version: "22.0.0", satisfiesMin: true },
    pnpm: { available: true },
    git: { available: true },
    github: { authed: true },
    ollama: {
      reachable: true,
      models: [{ name: "qwen2.5-coder:7b" }, { name: "qwen3:4b" }, { name: "llama3.1:latest" }],
    },
    projectRoot: { expected: "/m", actual: "/m", matches: true },
    tier: { active: "subscription-or-credits", apiKeyPresent: false, localReady: true },
    taisce: { root: "/Users/x/Dev/Taisce", present: true, divergence: { left: 0, right: 2 } },
    warnings: [],
    ...overrides,
  };
}

describe("moss status — the rows estate-mode status printed", () => {
  it("matches estate-mode's rows and wording", () => {
    expect(formatStatus(report())).toBe(
      [
        "moss status",
        "  active tier:     Tier 0/1 — subscription or usage credits",
        "  api key set:     no",
        "  ollama:          running",
        "  models pulled:   qwen2.5-coder:7b, qwen3:4b, llama3.1:latest",
        "  local (Tier 3):  ready",
        "  taisce root:     /Users/x/Dev/Taisce",
        "  taisce git:      behind 0, ahead 2 (origin/main...HEAD)",
      ].join("\n"),
    );
  });

  it("reports Tier 2, a down daemon, no models and unknown divergence", () => {
    const text = formatStatus(
      report({
        tier: { active: "api-key", apiKeyPresent: true, localReady: false },
        ollama: { reachable: false, models: [] },
        taisce: { root: "/t", present: false, divergence: null },
      }),
    );
    expect(text).toContain("active tier:     Tier 2 — API key");
    expect(text).toContain("api key set:     yes");
    expect(text).toContain("ollama:          not running");
    expect(text).toContain("models pulled:   none");
    expect(text).toContain("local (Tier 3):  not ready");
    expect(text).toContain("taisce git:      unknown");
  });

  it("uses the same tier words as the shell banner", () => {
    expect(tierLabel(false)).toBe("Tier 0/1 — subscription or usage credits");
    expect(tierLabel(true)).toBe("Tier 2 — API key");
  });
});

describe("api / sub / credits", () => {
  it("api and sub explain they need the shell function and never touch the key", () => {
    for (const sub of ["api", "sub"] as const) {
      const text = shellOnlyMessage(sub);
      expect(text).toContain("child process cannot");
      expect(text).toContain("The key never passes through moss");
    }
  });

  it("credits prints the claude.ai steps", () => {
    expect(CREDITS_TEXT).toContain("Settings -> Usage");
  });
});

describe("moss local", () => {
  function deps(overrides: Partial<LocalDeps> = {}): LocalDeps {
    return {
      report: async () => report(),
      startOllama: vi.fn(),
      aiderInstalled: async () => true,
      wait: async () => undefined,
      env: {},
      ...overrides,
    };
  }

  it("with everything present: no daemon start, lists chat models without reasoning ones", async () => {
    const out: string[] = [];
    const d = deps();
    expect(
      await runLocal(
        (l) => out.push(l),
        () => undefined,
        d,
      ),
    ).toBe(true);
    expect(d.startOllama).not.toHaveBeenCalled();
    const text = out.join("\n");
    expect(text).toContain("ollama already running");
    expect(text).toContain("chat model:  qwen2.5-coder:7b, llama3.1:latest");
    expect(text).not.toMatch(/chat model:.*qwen3/);
    expect(text).toContain("Aider support is deprecated and disabled");
    expect(text).toContain("Next: moss");
  });

  it("needs neither Aider nor a coder model for local chat and never probes Aider", async () => {
    const aiderInstalled = vi.fn(async () => {
      throw new Error("must not probe");
    });
    const d = deps({
      report: async () =>
        report({ ollama: { reachable: true, models: [{ name: "llama3.1:latest" }] } }),
      aiderInstalled,
    });
    expect(
      await runLocal(
        () => undefined,
        () => undefined,
        d,
      ),
    ).toBe(true);
    expect(aiderInstalled).not.toHaveBeenCalled();
  });

  it("starts ollama with the context length set, then waits for it", async () => {
    let calls = 0;
    const d = deps({
      report: async () =>
        ++calls < 3 ? report({ ollama: { reachable: false, models: [] } }) : report(),
      env: { OLLAMA_CONTEXT_LENGTH: "8192" },
    });
    const out: string[] = [];
    expect(
      await runLocal(
        (l) => out.push(l),
        () => undefined,
        d,
      ),
    ).toBe(true);
    expect(d.startOllama).toHaveBeenCalledWith(8192);
    expect(out.join("\n")).toContain("OLLAMA_CONTEXT_LENGTH=8192");
  });

  it("gives up when the daemon never comes up", async () => {
    const err: string[] = [];
    const d = deps({ report: async () => report({ ollama: { reachable: false, models: [] } }) });
    expect(
      await runLocal(
        () => undefined,
        (l) => err.push(l),
        d,
      ),
    ).toBe(false);
    expect(err.join("\n")).toContain("did not come up");
  });

  it("names — never runs — the install/pull commands for what is missing", async () => {
    const err: string[] = [];
    const d = deps({
      report: async () => report({ ollama: { reachable: true, models: [{ name: "qwen3:4b" }] } }),
      aiderInstalled: async () => false,
    });
    expect(
      await runLocal(
        () => undefined,
        (l) => err.push(l),
        d,
      ),
    ).toBe(false);
    const text = err.join("\n");
    expect(text).toContain("no non-reasoning model is pulled");
    expect(text).not.toContain("brew install aider");
  });

  it("reports a failed daemon start", async () => {
    const err: string[] = [];
    const d = deps({
      report: async () => report({ ollama: { reachable: false, models: [] } }),
      startOllama: () => {
        throw new Error("ENOENT");
      },
    });
    expect(
      await runLocal(
        () => undefined,
        (l) => err.push(l),
        d,
      ),
    ).toBe(false);
    expect(err.join("\n")).toContain("could not start ollama");
  });
});

describe("registered commands", () => {
  it("credits prints; api and sub refuse with exit code 1", async () => {
    const { buildCli } = await import("../../src/cli.ts");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await buildCli({ exitOverride: true }).parseAsync(["node", "moss", "credits"]);
      expect(String(out.mock.calls.at(-1)?.[0])).toContain("Settings -> Usage");
      for (const sub of ["api", "sub"]) {
        process.exitCode = undefined;
        await buildCli({ exitOverride: true }).parseAsync(["node", "moss", sub]);
        expect(process.exitCode).toBe(1);
        expect(String(err.mock.calls.at(-1)?.[0])).toContain("child process cannot");
      }
    } finally {
      process.exitCode = undefined;
      out.mockRestore();
      err.mockRestore();
    }
  });
});
