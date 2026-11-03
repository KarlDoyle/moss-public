import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeArgs,
  CLAUDE_ISOLATION_ARGS,
  type ClaudeCodeDeps,
  createClaudeCodeProvider,
  parseClaudeJson,
} from "../../../src/lib/providers/claude-code.ts";
import { classifyGenerateFailure } from "../../../src/lib/providers/failure.ts";

const now = () => new Date("2026-09-18T12:00:00Z");
const ok = (result: string) =>
  JSON.stringify({
    is_error: false,
    result,
    total_cost_usd: 0.0015,
    usage: {
      input_tokens: 389,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 1,
      output_tokens: 4,
    },
  });
const loggedOut = JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" });

function deps(stdout: string, overrides: Partial<ClaudeCodeDeps> = {}) {
  const cache = new Map<string, { at: number; status: never; reason: string }>();
  const exec = vi.fn(async () => ({ exitCode: 0, stdout, stderr: "" }));
  const d: ClaudeCodeDeps = {
    onPath: () => true,
    exec,
    readCache: (k) => cache.get(k) ?? null,
    writeCache: (k, v) => cache.set(k, v as never),
    cacheKey: () => "default",
    ...overrides,
  };
  return { d, exec };
}

describe("claude-code args", () => {
  it("isolates every call: no tools, settings, MCP, slash commands or saved session", () => {
    const args = buildClaudeArgs("sonnet", "SYS");
    expect(args.slice(0, 5)).toEqual(["-p", "--model", "sonnet", "--output-format", "json"]);
    for (const flag of CLAUDE_ISOLATION_ARGS) expect(args).toContain(flag);
    expect(args.at(-2)).toBe("--system-prompt");
    expect(args.at(-1)).toBe("SYS");
    expect(buildClaudeArgs("opus", " ").at(-1)).toContain("You have no tools");
  });
});

describe("parseClaudeJson", () => {
  it("counts cache reads/writes as input and keeps the reported cost", () => {
    expect(parseClaudeJson(ok("hi"))).toEqual({
      isError: false,
      result: "hi",
      inputTokens: 400,
      outputTokens: 4,
      costUsd: 0.0015,
    });
    expect(parseClaudeJson("not json")).toBeNull();
    expect(parseClaudeJson('{"is_error":true}')).toBeNull();
  });
});

describe("claude-code probe", () => {
  it("is not_installed without claude on PATH, and never calls it", async () => {
    const { d, exec } = deps(ok("ok"), { onPath: () => false });
    const probe = await createClaudeCodeProvider(d).probe(now);
    expect(probe.status).toBe("not_installed");
    expect(exec).not.toHaveBeenCalled();
  });

  it("is available after a 1-token probe with the cheap model, then cached", async () => {
    const { d, exec } = deps(ok("ok"));
    const provider = createClaudeCodeProvider(d);
    expect((await provider.probe(now)).status).toBe("available");
    const [args, input] = exec.mock.calls[0] as unknown as [string[], string];
    expect(args[2]).toBe("haiku");
    expect(input).toBe("ok");
    const again = await provider.probe(() => new Date("2026-09-18T12:05:00Z"));
    expect(again.status).toBe("available");
    expect(again.reason).toContain("probed 5 min ago");
    expect(exec).toHaveBeenCalledTimes(1);
    await provider.probe(() => new Date("2026-09-18T12:20:00Z"));
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("says unauthenticated, in claude's own words, when logged out", async () => {
    const probe = await createClaudeCodeProvider(deps(loggedOut).d).probe(now);
    expect(probe.status).toBe("unauthenticated");
    expect(probe.reason).toContain(
      "not logged in (claude says: Not logged in · Please run /login)",
    );
  });

  it("is unavailable on any other failure", async () => {
    const { d } = deps("", {
      exec: vi.fn(async () => ({ exitCode: 2, stdout: "", stderr: "boom\nmore" })),
    });
    const probe = await createClaudeCodeProvider(d).probe(now);
    expect(probe).toMatchObject({ status: "unavailable", reason: "claude probe failed: boom." });
  });

  it("does not mark a success-shaped response available after a failed process", async () => {
    const exec = vi.fn(async () => ({
      exitCode: 17,
      stdout: ok("misleading success"),
      stderr: "fixture failure",
    }));
    const { d } = deps(ok("misleading success"), { exec });
    const probe = await createClaudeCodeProvider(d).probe(now);
    expect(probe.status).toBe("unavailable");
    expect(exec).toHaveBeenCalledOnce();
  });
});

describe("claude-code generate", () => {
  it("sends the prompt on stdin with moss's system prompt and returns usage and cost", async () => {
    const { d, exec } = deps(ok("the answer"));
    const result = await createClaudeCodeProvider(d).generate?.({
      task: "ask",
      prompt: "PROMPT",
      system: "HEADER",
      model: "opus",
    });
    expect(result).toMatchObject({
      providerId: "claude-code",
      model: "opus",
      response: "the answer",
      inputTokens: 400,
      outputTokens: 4,
      costUsd: 0.0015,
    });
    const [args, input] = exec.mock.calls[0] as unknown as [string[], string];
    expect(args[2]).toBe("opus");
    expect(args.at(-1)).toBe("HEADER");
    expect(input).toBe("PROMPT");
  });

  it("throws a retryable dispatch error on a logged-out or unreadable reply", async () => {
    const p1 = createClaudeCodeProvider(deps(loggedOut).d).generate?.({ task: "ask", prompt: "x" });
    await expect(p1).rejects.toThrow("Not logged in");
    const p2 = createClaudeCodeProvider(deps("garbage").d).generate?.({ task: "ask", prompt: "x" });
    const error = await p2?.catch((e: unknown) => e);
    expect(String(error)).toContain("unreadable output");
    expect(classifyGenerateFailure(error)).toBe("retryable");
  });

  it("rejects a success-shaped JSON result when the subprocess exits nonzero", async () => {
    const { d } = deps(ok("must not be accepted"), {
      exec: vi.fn(async () => ({
        exitCode: 17,
        stdout: ok("must not be accepted"),
        stderr: "fixture failure",
      })),
    });
    await expect(
      createClaudeCodeProvider(d).generate?.({ task: "ask", prompt: "fixture" }),
    ).rejects.toThrow(/process exited 17/);
  });

  it("passes the requested timeout and cancellation signal to the subprocess seam", async () => {
    const controller = new AbortController();
    const { d, exec } = deps(ok("answer"));
    await createClaudeCodeProvider(d).generate?.({
      task: "ask",
      prompt: "fixture",
      timeoutMs: 1234,
      signal: controller.signal,
    });
    const call = exec.mock.calls[0] as unknown as [readonly string[], string, number, AbortSignal?];
    expect(call[2]).toBe(1234);
    expect(call[3]).toBe(controller.signal);
  });
});
