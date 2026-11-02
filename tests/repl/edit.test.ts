import { describe, expect, it, vi } from "vitest";
import {
  diffPaths,
  type EditContext,
  type EditRoute,
  runEdit,
  type SessionEditDeps,
} from "../../src/repl/edit.ts";
import type { ChatGenerateParams } from "../../src/repl/session.ts";

const DIFF = "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 0\n+x = 1\n";
const claude: EditRoute = {
  lane: "claude-code",
  model: "sonnet",
  stageOnly: false,
  summary: "claude-code · sonnet (edit)",
};
const local: EditRoute = {
  lane: "ollama",
  model: "llama3.1:latest",
  editorModel: "qwen2.5-coder:7b",
  stageOnly: false,
  summary: "ollama",
};

function setup(route: EditRoute, answers: string[], overrides: Partial<SessionEditDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const applyPatch = vi.fn(async (_r: string, _d: string, _check: boolean) => ({
    ok: true,
    output: "",
  }));
  const aider = vi.fn(async (_r: string, o: { dryRun: boolean }) => ({
    exitCode: 0,
    output: o.dryRun ? "dry" : "applied",
  }));
  const claudeDiff = vi.fn(async () => ({ ok: true, diff: DIFF }));
  const edit: SessionEditDeps = {
    resolveRepo: async () => "/repo",
    trackedFiles: async () => ["a.py", "b.py"],
    checkFiles: () => undefined,
    coderModel: () => "coder",
    aider,
    diffStat: async () => " a.py | 2 +-",
    buildPlanPrompt: (ask) => `PLAN FOR ${ask}`,
    parsePlan: () => ({ files: "a.py", plan: "set x to 1" }),
    pickFiles: (text, tracked) => tracked.filter((f) => text.includes(f)),
    route: async () => route,
    claudeDiff,
    applyPatch,
    ...overrides,
  };
  const generate = vi.fn(async (_p: ChatGenerateParams) => ({
    ok: true,
    response: "FILES: a.py\nPLAN: set x to 1",
  }));
  const queue = [...answers];
  const ctx: EditContext = {
    edit,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    generate,
    system: "RULES",
    model: undefined,
    nextLine: async () => queue.shift(),
  };
  return { ctx, out, err, applyPatch, aider, claudeDiff, generate };
}

describe("/edit on a Claude lane", () => {
  it("plans on the edit lane, shows the diff, checks it, and applies exactly that diff on go", async () => {
    const s = setup(claude, ["y"]);
    await runEdit(s.ctx, "set x in a.py");
    expect(s.generate.mock.calls[0]?.[0]).toMatchObject({ task: "edit", system: "RULES" });
    expect(s.out.join("\n")).toContain("+x = 1");
    expect(s.applyPatch.mock.calls.map((c) => c[2])).toEqual([true, false]);
    expect(s.applyPatch.mock.calls[1]?.[1]).toBe(DIFF);
    expect(s.out.join("\n")).toContain("Applied exactly the diff shown above");
  });

  it("anything but yes applies nothing", async () => {
    const s = setup(claude, ["n"]);
    await runEdit(s.ctx, "set x in a.py");
    expect(s.applyPatch.mock.calls.map((c) => c[2])).toEqual([true]);
    expect(s.out.join("\n")).toContain("not applied");
  });

  it("refuses a diff that strays outside the plan, or does not apply cleanly, or is empty", async () => {
    const stray = setup(claude, ["y"], {
      claudeDiff: async () => ({ ok: true, diff: `${DIFF}${DIFF.replaceAll("a.py", "b.py")}` }),
    });
    await runEdit(stray.ctx, "set x in a.py");
    expect(stray.err[0]).toContain("outside the plan (b.py)");
    expect(stray.applyPatch).not.toHaveBeenCalled();
    const dirty = setup(claude, ["y"], {
      applyPatch: async () => ({ ok: false, output: "patch does not apply" }),
    });
    await runEdit(dirty.ctx, "set x in a.py");
    expect(dirty.err[0]).toContain("patch does not apply");
    const empty = setup(claude, [], {
      claudeDiff: async () => ({ ok: false, error: "logged out" }),
    });
    await runEdit(empty.ctx, "set x in a.py");
    expect(empty.err[0]).toContain("no diff from claude-code: logged out");
  });

  it("stage-only shows the checked diff and never asks go?", async () => {
    const s = setup({ ...claude, stageOnly: true }, ["y"]);
    await runEdit(s.ctx, "set x in a.py");
    expect(s.out.join("\n")).toContain("STAGE-ONLY");
    expect(s.out.join("\n")).not.toContain("go?");
    expect(s.applyPatch.mock.calls.map((c) => c[2])).toEqual([true]);
  });

  it("says so when the lane is not wired for edits", async () => {
    const s = setup(claude, []);
    s.ctx = {
      ...s.ctx,
      edit: {
        ...(s.ctx.edit as SessionEditDeps),
        claudeDiff: undefined,
      } as unknown as SessionEditDeps,
    };
    await runEdit(s.ctx, "set x in a.py");
    expect(s.err[0]).toContain("not wired for edits");
  });
});

describe("/edit on the local lane", () => {
  it("runs Aider architect → editor, dry run then real on go", async () => {
    const s = setup(local, ["go"]);
    await runEdit(s.ctx, "set x in a.py");
    expect(s.aider.mock.calls.map((c) => c[1])).toEqual([
      {
        message: "set x to 1",
        files: ["a.py"],
        model: "llama3.1:latest",
        editorModel: "qwen2.5-coder:7b",
        dryRun: true,
      },
      {
        message: "set x to 1",
        files: ["a.py"],
        model: "llama3.1:latest",
        editorModel: "qwen2.5-coder:7b",
        dryRun: false,
      },
    ]);
    expect(s.out.join("\n")).toContain("architect llama3.1:latest → editor qwen2.5-coder:7b");
    expect(s.out.join("\n")).toContain("second generation");
  });

  it("stage-only stops after the dry run", async () => {
    const s = setup({ ...local, stageOnly: true }, ["y"]);
    await runEdit(s.ctx, "set x in a.py");
    expect(s.aider).toHaveBeenCalledTimes(1);
    expect(s.out.join("\n")).toContain("STAGE-ONLY");
  });

  it("reports no lane at all", async () => {
    const s = setup({ lane: null, model: null, stageOnly: false, summary: "· ollama: down" }, []);
    await runEdit(s.ctx, "set x in a.py");
    expect(s.err[0]).toBe("/edit: no lane can edit right now — · ollama: down");
  });
});

describe("diffPaths", () => {
  it("lists text modifications and refuses creation headers", () => {
    expect(diffPaths(DIFF)).toEqual(["a.py"]);
    expect(() => diffPaths(`${DIFF}--- /dev/null\n+++ b/new.py\n`)).toThrow();
  });
});
