import { describe, expect, it, vi } from "vitest";
import {
  type ChatGenerateParams,
  type ChatSessionDeps,
  runChatSession,
} from "../../src/repl/session.ts";

async function* linesOf(lines: readonly string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function run(lines: string[], route: string | undefined, extra: Partial<ChatSessionDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const generate = vi.fn(async (_p: ChatGenerateParams) => ({
    ok: true,
    response: "ANSWER",
    ...(route !== undefined ? { route } : {}),
  }));
  const done = runChatSession({
    lines: linesOf(lines),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    generate,
    isClaudeModel: (n) => ["sonnet", "opus"].includes(n),
    checkModel: (n) => {
      if (n.startsWith("qwen3")) throw new Error(`${n} is a reasoning model`);
    },
    routeTable: async (pinned) => `TABLE pinned=${pinned ?? "none"}`,
    frontDoor: async () => "Domains: irreversible",
    skills: () => [{ command: "council", id: "expert-council", description: "d" }],
    skillPrompt: () => ({ id: "expert-council", body: "BODY", loaded: [], task: "reason" }),
    ...extra,
  });
  return { done, out, err, generate };
}

describe("the session on lanes", () => {
  it("each turn says which lane answered, and passes the task and the front door", async () => {
    const s = run(["hello", "/council should I", "/exit"], "claude-code · sonnet (reason)");
    await s.done;
    expect(s.generate.mock.calls[0]?.[0]).toMatchObject({
      task: "brief",
      frontDoor: "Domains: irreversible",
    });
    expect(s.generate.mock.calls[1]?.[0]).toMatchObject({ task: "reason", prompt: "BODY" });
    const text = s.out.join("\n");
    expect(text).toContain("· claude-code · sonnet (reason)");
    expect(text).toContain("· model output: a prompt to check, never a record.");
  });

  it("a local answer keeps the local-model warning", async () => {
    const s = run(["/council x", "/exit"], "ollama · llama3.1:latest (reason)");
    await s.done;
    expect(s.out.join("\n")).toContain("· local-model output: a prompt to check");
  });

  it("/model shows the route table, pins Claude or local, refuses a reasoning model, and resets", async () => {
    const s = run(
      [
        "/model",
        "/model opus",
        "/model",
        "hi",
        "/model qwen3:4b",
        "/model llama3.1",
        "/model default",
        "/exit",
      ],
      undefined,
    );
    await s.done;
    const text = s.out.join("\n");
    expect(text).toContain("model: (routed per task — config/routing.yaml)");
    expect(text).toContain("TABLE pinned=none");
    expect(text).toContain("model → opus on the claude-code lane for every turn");
    expect(text).toContain("TABLE pinned=opus");
    expect(s.generate.mock.calls[0]?.[0]).toMatchObject({ model: "opus" });
    expect(s.err.join("\n")).toContain("qwen3:4b is a reasoning model");
    expect(text).toContain("model → llama3.1 on the local lane for every turn");
    expect(text).toContain("model → routed per task");
  });
});

describe("the session's /check and the folded /lanes", () => {
  it("/check prints the health report; /lanes prints the /model route table; both out of the way when unwired", async () => {
    const s = run(["/check", "/lanes", "/help", "/exit"], undefined, {
      check: async () => "HEALTH REPORT",
    });
    await s.done;
    const text = s.out.join("\n");
    expect(text).toContain("HEALTH REPORT");
    expect(text).toContain("TABLE pinned=none");
    expect(text).toContain("/check");
    const bare = run(["/check", "/exit"], undefined, { check: undefined as never });
    await bare.done;
    expect(bare.err.join("\n")).toContain("/check is not available");
  });
});
