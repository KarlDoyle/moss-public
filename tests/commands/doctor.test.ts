import { describe, expect, it, vi } from "vitest";
import {
  type DoctorDependencies,
  gatherDiagnostics,
  runDoctorCommand,
} from "../../src/commands/doctor.ts";
import type { ExecResult } from "../../src/lib/exec.ts";
import type { FetchResult } from "../../src/lib/net.ts";

function makeExecResult(
  partial: Partial<ExecResult> & Pick<ExecResult, "exitCode" | "stdout" | "stderr">,
): ExecResult {
  return {
    command: partial.command ?? "mock",
    args: partial.args ?? [],
    exitCode: partial.exitCode,
    stdout: partial.stdout,
    stderr: partial.stderr,
  };
}

function fakeDeps(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    execRun: vi.fn(async (command: string): Promise<ExecResult> => {
      if (command === "pnpm") {
        return makeExecResult({ exitCode: 0, stdout: "10.22.0\n", stderr: "" });
      }
      if (command === "gh") {
        return makeExecResult({
          exitCode: 0,
          stdout: "",
          stderr:
            "github.com\n  ✓ Logged in to github.com account KarlDoyle (keyring)\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n",
        });
      }
      return makeExecResult({ exitCode: 127, stdout: "", stderr: "not found" });
    }),
    gitVersion: vi.fn(async () => "git version 2.54.0"),
    netFetch: vi.fn(
      async (): Promise<FetchResult> => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          models: [
            { name: "llama3.1:latest", size: 4920753328 },
            { name: "llama3.2:3b", size: 2000000000 },
          ],
        }),
      }),
    ),
    cwd: () => "/Users/test/Dev/moss",
    nodeVersion: () => "v22.18.0",
    projectRoot: () => "/Users/test/Dev/moss",
    ...overrides,
  };
}

describe("doctor.gatherDiagnostics", () => {
  it("returns ok=true when every check passes", async () => {
    const report = await gatherDiagnostics(fakeDeps());
    expect(report.ok).toBe(true);
    expect(report.node.satisfiesMin).toBe(true);
    expect(report.pnpm.available).toBe(true);
    expect(report.pnpm.version).toBe("10.22.0");
    expect(report.git.available).toBe(true);
    expect(report.git.version).toBe("git version 2.54.0");
    expect(report.github.authed).toBe(true);
    expect(report.github.account).toBe("KarlDoyle");
    expect(report.github.scopes).toEqual(["gist", "read:org", "repo", "workflow"]);
    expect(report.ollama.reachable).toBe(true);
    expect(report.ollama.models).toHaveLength(2);
    expect(report.warnings).toEqual([]);
  });

  it("reports Node below 22 as not satisfying min and adds a warning", async () => {
    const deps = fakeDeps({ nodeVersion: () => "v20.10.0" });
    const report = await gatherDiagnostics(deps);
    expect(report.node.satisfiesMin).toBe(false);
    expect(report.warnings.some((w) => w.includes("Node 20"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("flags unreachable Ollama daemon", async () => {
    const deps = fakeDeps({
      netFetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:11434");
      }),
    });
    const report = await gatherDiagnostics(deps);
    expect(report.ollama.reachable).toBe(false);
    expect(report.ollama.error).toContain("ECONNREFUSED");
    expect(report.warnings.some((w) => w.includes("Ollama"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("flags a reachable daemon with zero models", async () => {
    const deps = fakeDeps({
      netFetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({ models: [] }),
      })),
    });
    const report = await gatherDiagnostics(deps);
    expect(report.ollama.reachable).toBe(true);
    expect(report.ollama.models).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes("no models are installed"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("reports github unauthenticated when gh exits non-zero", async () => {
    const deps = fakeDeps({
      execRun: vi.fn(async (command: string): Promise<ExecResult> => {
        if (command === "gh") {
          return makeExecResult({ exitCode: 1, stdout: "", stderr: "not authed" });
        }
        if (command === "pnpm") {
          return makeExecResult({ exitCode: 0, stdout: "10.22.0\n", stderr: "" });
        }
        return makeExecResult({ exitCode: 127, stdout: "", stderr: "" });
      }),
    });
    const report = await gatherDiagnostics(deps);
    expect(report.github.authed).toBe(false);
    expect(report.warnings.some((w) => w.includes("GitHub CLI is not authenticated"))).toBe(true);
  });

  it("treats a project-root mismatch as informational, not an issue", async () => {
    // Running the installed `moss` from outside the checkout is normal: the
    // project root resolves from the module's location, so registry/output/usage
    // are unaffected, and for a skill the cwd is meant to be the target repo.
    const deps = fakeDeps({ cwd: () => "/elsewhere" });
    const report = await gatherDiagnostics(deps);
    expect(report.projectRoot.matches).toBe(false);
    expect(report.warnings.some((w) => w.includes("Working directory"))).toBe(false);
    // Everything else passing → still READY despite the cwd difference.
    expect(report.ok).toBe(true);
  });

  it("does not include the gh token in any field", async () => {
    const deps = fakeDeps({
      execRun: vi.fn(async (command: string): Promise<ExecResult> => {
        if (command === "gh") {
          return makeExecResult({
            exitCode: 0,
            stdout: "",
            stderr:
              "github.com\n  ✓ Logged in to github.com account KarlDoyle (keyring)\n  - Token: gho_PRETEND_SECRET_DO_NOT_LEAK\n  - Token scopes: 'repo'\n",
          });
        }
        if (command === "pnpm") {
          return makeExecResult({ exitCode: 0, stdout: "10.22.0\n", stderr: "" });
        }
        return makeExecResult({ exitCode: 127, stdout: "", stderr: "" });
      }),
    });
    const report = await gatherDiagnostics(deps);
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain("PRETEND_SECRET");
    expect(serialised).not.toContain("gho_");
  });
});

describe("doctor.runDoctorCommand", () => {
  it("emits JSON when emitJson=true", async () => {
    const lines: string[] = [];
    const report = await runDoctorCommand(
      { emitJson: true, out: (line) => lines.push(line) },
      fakeDeps(),
    );
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.ok).toBe(report.ok);
    expect(parsed.github.account).toBe("KarlDoyle");
  });

  it("emits human text when emitJson=false", async () => {
    const lines: string[] = [];
    await runDoctorCommand({ emitJson: false, out: (line) => lines.push(line) }, fakeDeps());
    expect(lines).toHaveLength(1);
    const text = lines[0] ?? "";
    expect(text).toContain("moss doctor — READY");
    expect(text).toContain("node:");
    expect(text).toContain("github:");
    expect(text).toContain("ollama daemon:");
  });

  it("stays READY and notes the working dir when run outside the moss home", async () => {
    const lines: string[] = [];
    await runDoctorCommand(
      { emitJson: false, out: (line) => lines.push(line) },
      fakeDeps({ cwd: () => "/elsewhere" }),
    );
    const text = lines[0] ?? "";
    expect(text).toContain("moss doctor — READY");
    expect(text).toContain("moss home:");
    expect(text).toContain("running from /elsewhere");
  });
});

describe("doctor.gatherDiagnostics — fallback-ladder tier + Taisce section", () => {
  it("reports Tier 2 (api-key) active when ANTHROPIC_API_KEY is present, without leaking it", async () => {
    const deps = fakeDeps({ hasApiKey: () => true });
    const report = await gatherDiagnostics(deps);
    expect(report.tier.active).toBe("api-key");
    expect(report.tier.apiKeyPresent).toBe(true);
    expect(JSON.stringify(report)).not.toContain("ANTHROPIC_API_KEY");
  });

  it("reports subscription-or-credits when no API key is present", async () => {
    const deps = fakeDeps({ hasApiKey: () => false });
    const report = await gatherDiagnostics(deps);
    expect(report.tier.active).toBe("subscription-or-credits");
    expect(report.tier.apiKeyPresent).toBe(false);
  });

  it("tier.localReady is true only when Ollama is reachable AND a model is pulled", async () => {
    const ready = await gatherDiagnostics(fakeDeps());
    expect(ready.tier.localReady).toBe(true);

    const notReady = await gatherDiagnostics(
      fakeDeps({
        netFetch: async () => ({ ok: true, status: 200, body: JSON.stringify({ models: [] }) }),
      }),
    );
    expect(notReady.tier.localReady).toBe(false);
  });

  it("falls back to present:false when the Taisce root does not exist", async () => {
    const deps = fakeDeps({ taisceRoot: () => "/definitely/not/a/real/path/for/moss/tests" });
    const report = await gatherDiagnostics(deps);
    expect(report.taisce.present).toBe(false);
    expect(report.taisce.divergence).toBeNull();
  });

  it("reports the Taisce divergence when the dependency resolves one", async () => {
    const deps = fakeDeps({
      taisceRoot: () => "/tmp", // any existing directory — existsSync is all gatherDiagnostics checks
      taisceDivergence: async () => ({ left: 2, right: 5 }),
    });
    const report = await gatherDiagnostics(deps);
    expect(report.taisce.present).toBe(true);
    expect(report.taisce.divergence).toEqual({ left: 2, right: 5 });
  });

  it("never crashes gatherDiagnostics when tier/taisce deps are omitted (real defaults apply)", async () => {
    // fakeDeps() already omits hasApiKey/taisceRoot/taisceDivergence by
    // default — this just asserts the shape is always present in the report.
    const report = await gatherDiagnostics(fakeDeps());
    expect(report.tier).toBeDefined();
    expect(report.taisce).toBeDefined();
  });

  it("human report includes the fallback-tier and taisce lines", async () => {
    const lines: string[] = [];
    await runDoctorCommand(
      { emitJson: false, out: (line) => lines.push(line) },
      fakeDeps({
        taisceRoot: () => "/tmp",
        taisceDivergence: async () => ({ left: 0, right: 3 }),
      }),
    );
    const text = lines[0] ?? "";
    expect(text).toContain("fallback tier:");
    expect(text).toContain("taisce:");
    expect(text).toContain("ahead 3");
  });
});
