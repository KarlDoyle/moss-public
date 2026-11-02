import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyPatch,
  claudeDiff,
  editRoute,
  extractDiff,
  type LaneSessionDeps,
  routedGenerate,
  routeTable,
} from "../../src/commands/chat-lanes.ts";
import type { ProviderStatus } from "../../src/lib/providers/types.ts";
import { lanes, policy } from "../lib/lanes/fixtures.ts";

function deps(status: Partial<Record<string, ProviderStatus>>, reply = "ANSWER", fail?: Error) {
  const dispatch = vi.fn(
    async (_p: unknown, choice: { lane: string | null; model: string | null }, _i: unknown) => {
      if (fail !== undefined) throw fail;
      return { providerId: choice.lane as never, model: choice.model ?? "", response: reply };
    },
  );
  const d: LaneSessionDeps = { policy: () => policy, select: () => lanes(status), dispatch };
  return { d, dispatch };
}

describe("routedGenerate — a session turn on the routed lane", () => {
  it("a typed prompt is a brief task on the local lane, and says which lane answered", async () => {
    const { d, dispatch } = deps({ ollama: "available", "claude-code": "available" });
    const r = await routedGenerate({ prompt: "hi", system: "RULES" }, d);
    expect(r).toEqual({
      ok: true,
      response: "ANSWER",
      model: "llama3.1:latest",
      route: "ollama · llama3.1:latest (brief)",
    });
    expect(dispatch.mock.calls[0]?.[2]).toEqual({ prompt: "hi", system: "RULES", command: "chat" });
  });

  it("a reasoning skill goes to Claude; a gated prompt is stage-only", async () => {
    const { d } = deps({ "claude-code": "available" });
    expect((await routedGenerate({ prompt: "x", task: "reason" }, d)).route).toBe(
      "claude-code · sonnet (reason)",
    );
    const gated = await routedGenerate(
      { prompt: "x", frontDoor: "Domains: irreversible" },
      deps({ "claude-code": "available" }).d,
    );
    expect(gated.route).toContain("STAGE-ONLY (gate: irreversible)");
  });

  it("a pinned model wins; a pinned reasoning model on the local lane is refused", async () => {
    expect(
      (await routedGenerate({ prompt: "x", model: "opus" }, deps({ "claude-code": "available" }).d))
        .route,
    ).toContain("claude-code · opus");
    const r = await routedGenerate(
      { prompt: "x", model: "qwen3:4b" },
      deps({ ollama: "available" }).d,
    );
    expect(r.ok).toBe(false);
  });

  it("no lane, or a failed lane, is an honest error", async () => {
    const none = await routedGenerate(
      { prompt: "x", task: "vision" },
      deps({ ollama: "available" }).d,
    );
    expect(none.error).toContain("no lane can answer right now");
    const failed = await routedGenerate(
      { prompt: "x" },
      deps({ ollama: "available" }, "", new Error("daemon gone")).d,
    );
    expect(failed.error).toBe("ollama: daemon gone");
  });
});

describe("editRoute", () => {
  it("names the lane, the architect/editor pair, and why", async () => {
    const localRoute = await editRoute(
      "x",
      undefined,
      null,
      deps({ "claude-code": "unauthenticated", ollama: "available" }).d,
    );
    expect(localRoute).toMatchObject({
      lane: "ollama",
      model: "llama3.1:latest",
      editorModel: "qwen2.5-coder:7b",
      stageOnly: false,
    });
    expect(localRoute.summary).toContain("· claude-code: claude-code is unauthenticated.");
    const none = await editRoute("x", undefined, "Domains: external-facing", deps({}).d);
    expect(none).toMatchObject({ lane: null, stageOnly: true });
  });
});

describe("extractDiff", () => {
  it("takes the fenced diff, or everything from the first header", () => {
    expect(extractDiff("Here:\n```diff\n--- a/x\n+++ b/x\n```\nbye")).toBe("--- a/x\n+++ b/x\n");
    expect(extractDiff("sure\ndiff --git a/x b/x\n--- a/x")).toBe("diff --git a/x b/x\n--- a/x\n");
  });
});

describe("claudeDiff + applyPatch against a real repo", () => {
  const repo = mkdtempSync(join(tmpdir(), "moss-edit-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, "a.py"), "x = 0\n");
  git("add", "a.py");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

  it("sends the planned files on the routed lane and applies exactly the returned diff", async () => {
    const diff = "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 0\n+x = 1\n";
    const { d, dispatch } = deps({ "claude-code": "available" }, `\`\`\`diff\n${diff}\`\`\``);
    const made = await claudeDiff(
      repo,
      "set x to 1",
      ["a.py"],
      { lane: "claude-code", model: "opus", stageOnly: false, summary: "" },
      d,
    );
    expect(made).toEqual({ ok: true, diff });
    const [, choice, input] = dispatch.mock.calls[0] as unknown as [
      unknown,
      { lane: string; model: string },
      { prompt: string },
    ];
    expect(choice).toMatchObject({ lane: "claude-code", model: "opus" });
    expect(input.prompt).toContain("FILE a.py\n```\nx = 0\n");
    expect((await applyPatch(repo, diff, true)).ok).toBe(true);
    expect(readFileSync(join(repo, "a.py"), "utf8")).toBe("x = 0\n");
    expect((await applyPatch(repo, diff, false)).ok).toBe(true);
    expect(readFileSync(join(repo, "a.py"), "utf8")).toBe("x = 1\n");
    const again = await applyPatch(repo, diff, true);
    expect(again.ok).toBe(false);
    expect(again.output).toContain("patch does not apply");
  });

  it("refuses a path outside the repo, and reports a failed lane", async () => {
    const route = { lane: "claude-code" as const, model: "sonnet", stageOnly: false, summary: "" };
    await expect(
      claudeDiff(repo, "p", ["../../etc/passwd"], route, deps({ "claude-code": "available" }).d),
    ).rejects.toThrow();
    const failed = await claudeDiff(
      repo,
      "p",
      ["a.py"],
      route,
      deps({ "claude-code": "available" }, "", new Error("logged out")).d,
    );
    expect(failed).toEqual({ ok: false, error: "logged out" });
  });
});

describe("routeTable", () => {
  it("lists every task's lane now, or why none", async () => {
    const text = await routeTable(
      undefined,
      deps({ ollama: "available", "claude-code": "available" }).d,
    );
    expect(text).toContain("reason  → claude-code · sonnet");
    expect(text).toContain("brief   → ollama · llama3.1:latest");
    expect(text).toContain("vision  → none — gemma4:12b is not pulled");
  });
});
