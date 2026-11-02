import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { explainInvocation, splitArgs } from "../../src/commands/explain.ts";
import { runTaisceSkill, type TaisceRunDeps } from "../../src/commands/run-taisce.ts";
import type { ProviderStatus } from "../../src/lib/providers/types.ts";
import { lanes, policy } from "../lib/lanes/fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "moss-run-taisce-"));
const put = (rel: string, body: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
};
put("Library/skills/capture/SKILL.md", "---\nname: capture\n---\n# Capture\n");
put("Library/skills/expert-council/SKILL.md", "---\nname: expert-council\n---\n# Council\n");
put("System/04-privacy-and-sensitivity-rules.md", "# Rules\n");
put("Sources/Health/x.md", "secret");

const saved = process.env.TAISCE_ROOT;
beforeEach(() => {
  process.env.TAISCE_ROOT = root;
});
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "TAISCE_ROOT");
  else process.env.TAISCE_ROOT = saved;
});

function deps(
  status: Partial<Record<string, ProviderStatus>>,
  frontDoor: string | null = null,
  spent = 0,
) {
  const dispatch = vi.fn(
    async (_p: unknown, choice: { lane: string | null; model: string | null }) => ({
      providerId: choice.lane as never,
      model: choice.model ?? "",
      response: "THE ANSWER",
    }),
  );
  const d: TaisceRunDeps = {
    policy: () => policy,
    select: () => lanes(status, undefined, spent),
    plan: { frontDoor: async () => frontDoor },
    dispatch,
  };
  return { d, dispatch };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, o: (l: string) => out.push(l), e: (l: string) => err.push(l) };
}

describe("moss run <taisce-skill> — routed", () => {
  it("capture is a brief task and runs local; the lane and model are printed", async () => {
    const { d, dispatch } = deps({ ollama: "available", "claude-code": "available" });
    const s = io();
    const ok = await runTaisceSkill(
      { skillId: "capture", input: "paid the gas bill", emitJson: false, out: s.o, err: s.e },
      d,
    );
    expect(ok).toBe(true);
    const [, choice, prompt] = dispatch.mock.calls[0] as unknown as [
      unknown,
      { lane: string; task: string },
      string,
    ];
    expect(choice).toMatchObject({ lane: "ollama", task: "brief" });
    expect(prompt).toContain("paid the gas bill");
    expect(s.out[0]).toContain("lane:         ollama");
    expect(s.out[0]).toContain("THE ANSWER");
  });

  it("a gate in the input forces the best lane and marks the output stage-only", async () => {
    const { d } = deps({ "claude-code": "available" }, "Domains: external-facing\nGate: x");
    const s = io();
    await runTaisceSkill(
      { skillId: "capture", input: "post this", emitJson: true, out: s.o, err: s.e },
      d,
    );
    expect(JSON.parse(s.out[0] as string)).toMatchObject({
      lane: "claude-code",
      stageOnly: true,
      task: "brief",
    });
  });

  it("--explain prints the route and dispatches nothing", async () => {
    const { d, dispatch } = deps({ "claude-code": "unauthenticated", ollama: "available" });
    const s = io();
    await runTaisceSkill(
      { skillId: "council", emitJson: false, explainOnly: true, out: s.o, err: s.e },
      d,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(s.out[0]).toContain("task:   reason");
    expect(s.out[0]).toContain("· skipped claude-code");
    expect(s.out[0]).toContain("nothing was run (--explain)");
  });

  it("no lane → an error with the whole explanation; a failed dispatch is reported", async () => {
    const none = io();
    expect(
      await runTaisceSkill(
        { skillId: "capture", emitJson: false, out: none.o, err: none.e },
        deps({}).d,
      ),
    ).toBe(false);
    expect(none.err[0]).toContain("no lane can run 'capture'");
    const failing = deps({ ollama: "available" });
    failing.d = {
      ...failing.d,
      dispatch: async () => Promise.reject(new Error("daemon went away")),
    };
    const f = io();
    expect(
      await runTaisceSkill({ skillId: "capture", emitJson: false, out: f.o, err: f.e }, failing.d),
    ).toBe(false);
    expect(f.err[0]).toBe("moss run: daemon went away");
  });

  it("returns undefined for an unknown skill and refuses a gated context file", async () => {
    const s = io();
    expect(
      await runTaisceSkill({ skillId: "nope", emitJson: false, out: s.o, err: s.e }, deps({}).d),
    ).toBeUndefined();
    expect(
      await runTaisceSkill(
        {
          skillId: "capture",
          contextFile: "Sources/Health/x.md",
          emitJson: false,
          out: s.o,
          err: s.e,
        },
        deps({}).d,
      ),
    ).toBe(false);
    expect(s.err[0]).toContain("guard-reads");
  });

  it("--model opus pins the Claude lane", async () => {
    const { d, dispatch } = deps({ "claude-code": "available" });
    await runTaisceSkill(
      {
        skillId: "capture",
        model: "opus",
        emitJson: false,
        out: () => undefined,
        err: () => undefined,
      },
      d,
    );
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ lane: "claude-code", model: "opus" });
  });
});

describe("moss --explain <command>", () => {
  const explainDeps = (
    status: Partial<Record<string, ProviderStatus>>,
    frontDoor: string | null = null,
  ) => ({
    policy: () => policy,
    select: () => lanes(status),
    frontDoor: async () => frontDoor,
    taisce: deps(status, frontDoor).d,
  });

  it("splits words from flags", () => {
    expect(splitArgs(["a", "--model", "opus", "b", "--json", "--task=reason"])).toEqual({
      words: ["a", "b"],
      flags: { model: "opus", json: "true", task: "reason" },
    });
  });

  it("run, ask and chat explain; everything else says it makes no model call", async () => {
    const s = io();
    expect(
      await explainInvocation(
        ["run", "capture", "a fact"],
        s.o,
        s.e,
        explainDeps({ ollama: "available" }),
      ),
    ).toBe(0);
    expect(
      await explainInvocation(
        ["ask", "--task", "code-review", "review", "this"],
        s.o,
        s.e,
        explainDeps({ "claude-code": "available" }),
      ),
    ).toBe(0);
    expect(await explainInvocation([], s.o, s.e, explainDeps({ ollama: "available" }))).toBe(0);
    expect(await explainInvocation(["status"], s.o, s.e, explainDeps({}))).toBe(0);
    expect(await explainInvocation(["run", "code-review"], s.o, s.e, explainDeps({}))).toBe(0);
    const text = s.out.join("\n");
    expect(text).toContain("moss run capture — route");
    expect(text).toContain("moss ask — route");
    expect(text).toContain("lane:   claude-code · sonnet");
    expect(text).toContain("the session — each typed prompt routes as 'brief'");
    expect(text).toContain("moss status — no model call");
    expect(text).toContain("not a Taisce skill");
  });

  it("an ask whose prompt trips a gate is stage-only; a run with no skill is an error", async () => {
    const s = io();
    await explainInvocation(
      ["ask", "publish", "it"],
      s.o,
      s.e,
      explainDeps({ "claude-code": "available" }, "Domains: irreversible"),
    );
    expect(s.out.join("\n")).toContain("STAGE-ONLY");
    expect(await explainInvocation(["run"], s.o, s.e, explainDeps({}))).toBe(1);
    expect(await explainInvocation(["ask", "x"], s.o, s.e, explainDeps({}))).toBe(1);
  });
});

describe("moss run turns Ollama off again when it started it", () => {
  it("runs the after-run step once, on success and on failure, and says what it did", async () => {
    const ok = deps({ ollama: "available" });
    const afterRun = vi.fn(async () => "Ollama turned off (unloaded llama3.1:latest; app quit).");
    const s = io();
    await runTaisceSkill(
      { skillId: "capture", input: "x", emitJson: false, out: s.o, err: s.e },
      { ...ok.d, afterRun },
    );
    expect(afterRun).toHaveBeenCalledOnce();
    expect(s.err.at(-1)).toBe("· Ollama turned off (unloaded llama3.1:latest; app quit).");
    const failing = { ...ok.d, dispatch: async () => Promise.reject(new Error("boom")), afterRun };
    await runTaisceSkill({ skillId: "capture", emitJson: false, out: s.o, err: s.e }, failing);
    expect(afterRun).toHaveBeenCalledTimes(2);
    const quiet = { ...ok.d, afterRun: async () => null };
    const q = io();
    await runTaisceSkill({ skillId: "capture", emitJson: false, out: q.o, err: q.e }, quiet);
    expect(q.err).toEqual([]);
  });
});
