import { describe, expect, it, vi } from "vitest";
import type { EditRoute, SessionEditDeps } from "../../src/repl/edit.ts";
import {
  type ChatGenerateResult,
  type ChatSessionDeps,
  runChatSession,
} from "../../src/repl/session.ts";

const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

function setup(lane: EditRoute["lane"] = "claude-code") {
  const out: string[] = [];
  const err: string[] = [];
  const onBatchFailure = vi.fn();
  const route: EditRoute = { lane, model: null, stageOnly: false, summary: "fixture" };
  const edit: SessionEditDeps = {
    resolveRepo: async () => "/fixture",
    trackedFiles: async () => ["a.txt"],
    checkFiles: () => undefined,
    coderModel: () => "fixture",
    aider: vi.fn(async () => ({ exitCode: 0, output: "fixture" })),
    diffStat: vi.fn(async () => "a.txt | 2 +-"),
    buildPlanPrompt: (ask) => ask,
    parsePlan: () => ({ files: "a.txt", plan: "change a.txt" }),
    pickFiles: () => ["a.txt"],
    route: async () => route,
    claudeDiff: async () => ({ ok: true, diff: DIFF }),
    applyPatch: vi.fn(async () => ({ ok: true, output: "" })),
  };
  const generate = vi.fn(
    async (): Promise<ChatGenerateResult> => ({
      ok: true,
      response: "fixture plan",
    }),
  );
  async function run(
    overrides: Partial<SessionEditDeps> = {},
    lines = ["/edit change a.txt", "y"],
    batchMode = true,
  ) {
    const deps: ChatSessionDeps = {
      lines: (async function* () {
        yield* lines;
      })(),
      generate,
      edit: { ...edit, ...overrides },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      batchMode,
      onBatchFailure,
    };
    await runChatSession(deps);
  }
  return { run, out, err, onBatchFailure, edit, generate, route };
}

const rejection = async (): Promise<never> => {
  throw new Error("fixture rejection");
};

describe("edit failure outcomes in piped sessions", () => {
  it("reports deprecated local edits as batch failure without generation or application", async () => {
    const s = setup("ollama");
    await s.run({}, ["/edit change a.txt", "/exit"]);
    expect(s.err.join("\n")).toContain("deprecated and disabled");
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.edit.aider).not.toHaveBeenCalled();
    expect(s.edit.applyPatch).not.toHaveBeenCalled();
    expect(s.onBatchFailure).toHaveBeenCalledOnce();
  });

  it.each([false, true])("marks planning failure (throws=%s) at EOF", async (throws) => {
    const s = setup();
    s.generate.mockImplementationOnce(
      throws ? rejection : async () => ({ ok: false, error: "fixture planning failure" }),
    );
    await s.run({}, ["/edit change a.txt"]);
    expect(s.err.join("\n")).toContain(throws ? "fixture rejection" : "fixture planning failure");
    expect(s.edit.aider).not.toHaveBeenCalled();
    expect(s.onBatchFailure).toHaveBeenCalledOnce();
  });

  it.each(["claude-code", "anthropic-api"] as const)(
    "marks %s apply failure and preserves partial-change diagnosis",
    async (lane) => {
      const s = setup(lane);
      await s.run({
        aider: async (_repo, options) => ({
          exitCode: options.dryRun ? 0 : 23,
          output: "failed apply",
        }),
        applyPatch: async (_repo, _diff, check) => ({ ok: check, output: "failed apply" }),
      });
      expect(s.err.join("\n")).toMatch(/changed some files|changes were partial/);
      expect(s.out.join("\n")).not.toContain("Not committed.");
      expect(s.edit.diffStat).not.toHaveBeenCalled();
      expect(s.onBatchFailure).toHaveBeenCalledOnce();
    },
  );

  it.each(["claude-code", "anthropic-api"] as const)(
    "marks thrown %s apply failure",
    async (lane) => {
      const s = setup(lane);
      await s.run({
        aider: async (_repo, options) =>
          options.dryRun ? { exitCode: 0, output: "dry" } : rejection(),
        applyPatch: async (_repo, _diff, check) => (check ? { ok: true, output: "" } : rejection()),
      });
      expect(s.err.join("\n")).toContain("fixture rejection");
      expect(s.err.join("\n")).toContain("inspect git diff");
      expect(s.edit.diffStat).not.toHaveBeenCalled();
      expect(s.onBatchFailure).toHaveBeenCalledOnce();
    },
  );

  it.each(["claude-code", "anthropic-api"] as const)(
    "marks %s summary failure after a successful apply",
    async (lane) => {
      const s = setup(lane);
      await s.run({ diffStat: rejection });
      expect(s.err.join("\n")).toContain("changes were applied");
      expect(s.err.join("\n")).toContain("could not read the diff summary");
      expect(s.out.join("\n")).not.toContain("Not committed.");
      expect(s.onBatchFailure).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["repo lookup", { resolveRepo: rejection }],
    ["route", { route: rejection }],
    ["diff generation", { claudeDiff: async () => ({ ok: false, error: "failed diff" }) }],
    ["patch check", { applyPatch: async () => ({ ok: false, output: "failed check" }) }],
  ] satisfies [string, Partial<SessionEditDeps>][])(
    "marks %s failure on /exit",
    async (_label, overrides) => {
      const s = setup();
      await s.run(overrides, ["/edit change a.txt", "/exit"]);
      expect(s.err.length).toBeGreaterThan(0);
      expect(s.onBatchFailure).toHaveBeenCalledOnce();
    },
  );

  it("keeps a piped failure sticky after a later successful turn", async () => {
    const s = setup();
    s.generate.mockImplementationOnce(async () => ({ ok: false, error: "planning failure" }));
    await s.run({}, ["/edit change a.txt", "hello", "/exit"]);
    expect(s.out).toContain("fixture plan");
    expect(s.onBatchFailure).toHaveBeenCalledOnce();
  });

  it("keeps an interactive session usable after an edit exception", async () => {
    const s = setup();
    await s.run(
      { resolveRepo: rejection },
      ["/edit change a.txt", "hello", "/help", "/exit"],
      false,
    );
    expect(s.err.join("\n")).toContain("fixture rejection");
    expect(s.out).toContain("fixture plan");
    expect(s.out).toContain("commands:");
    expect(s.onBatchFailure).not.toHaveBeenCalled();
  });

  it.each(["claude-code", "anthropic-api"] as const)(
    "successful %s edits with accounting warnings remain successful",
    async (lane) => {
      const s = setup(lane);
      s.generate.mockImplementationOnce(async () => ({
        ok: true,
        response: "plan",
        warnings: ["fixture planning accounting warning"],
      }));
      await s.run({
        claudeDiff: async () => ({
          ok: true,
          diff: DIFF,
          warnings: ["fixture diff accounting warning"],
        }),
      });
      expect(s.err).toContain("fixture planning accounting warning");
      expect(s.err).toContain("fixture diff accounting warning");
      expect(s.out.join("\n")).toContain("Not committed.");
      expect(s.onBatchFailure).not.toHaveBeenCalled();
    },
  );

  it.each(["claude-code", "anthropic-api"] as const)(
    "declined and stage-only %s edits remain successful",
    async (lane) => {
      for (const stageOnly of [false, true]) {
        const s = setup(lane);
        await s.run({ route: async () => ({ ...s.route, stageOnly }) }, [
          "/edit change a.txt",
          "n",
        ]);
        expect(s.onBatchFailure).not.toHaveBeenCalled();
        expect(s.edit.diffStat).not.toHaveBeenCalled();
        expect(s.edit.applyPatch).toHaveBeenCalledOnce();
      }
    },
  );
});
