import { describe, expect, it, vi } from "vitest";
import type { ProviderId } from "../../src/lib/providers/index.ts";
import {
  buildContextHeader,
  type ChatGenerateParams,
  type ChatGenerateResult,
  type ChatSessionDeps,
  estimateTokens,
  runChatSession,
  type SessionEditDeps,
  synthesisePrompt,
} from "../../src/repl/session.ts";

async function* linesOf(lines: readonly string[]): AsyncGenerator<string> {
  for (const line of lines) {
    yield line;
  }
}

interface Harness {
  readonly out: string[];
  readonly err: string[];
  readonly generate: ReturnType<typeof vi.fn>;
  readonly deps: ChatSessionDeps;
}

function harness(
  scriptedLines: readonly string[],
  generateImpl: (params: ChatGenerateParams) => Promise<ChatGenerateResult>,
  extra: Partial<ChatSessionDeps> = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const generate = vi.fn(generateImpl);
  const deps: ChatSessionDeps = {
    lines: linesOf(scriptedLines),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    generate,
    ...extra,
  };
  return { out, err, generate, deps };
}

const echo = async (params: ChatGenerateParams): Promise<ChatGenerateResult> => ({
  ok: true,
  response: `echo: ${params.prompt}`,
  model: "stub-model",
});

describe("synthesisePrompt", () => {
  it("returns the bare input when there is no prior context", () => {
    expect(synthesisePrompt([], "hello")).toBe("hello");
  });

  it("prepends the transcript when there are prior turns", () => {
    const prompt = synthesisePrompt(
      [
        { role: "user", content: "what is 2+2" },
        { role: "assistant", content: "4" },
      ],
      "and times 3?",
    );
    expect(prompt).toContain("User: what is 2+2");
    expect(prompt).toContain("Assistant: 4");
    expect(prompt.endsWith("User: and times 3?")).toBe(true);
  });
});

describe("runChatSession", () => {
  it("prints a banner and the help list, then exits on /exit", async () => {
    const h = harness(["/help", "/exit"], echo);
    await runChatSession(h.deps);
    const text = h.out.join("\n");
    expect(text).toContain("moss chat");
    expect(text).toContain("/help");
    expect(text).toContain("/model");
    // /provider and /lanes still work but are out of /help (superseded by /model, --explain).
    expect(text).not.toContain("/provider");
    expect(text).not.toContain("/lanes");
    expect(text).toContain("/status");
    expect(text).toContain("bye.");
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("/lanes renders the injected route explanation for the pinned provider", async () => {
    const explainRoute = vi.fn(async (provider: ProviderId | undefined) => `ROUTE for ${provider}`);
    const h = harness(["/provider ollama", "/lanes", "/exit"], echo, { explainRoute });
    await runChatSession(h.deps);
    expect(explainRoute).toHaveBeenCalledWith("ollama");
    expect(h.out.join("\n")).toContain("ROUTE for ollama");
    // Read-only: no model turn was executed.
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("/lanes passes undefined when the provider is on auto-route", async () => {
    const explainRoute = vi.fn(async () => "AUTO ROUTE");
    const h = harness(["/lanes", "/exit"], echo, { explainRoute });
    await runChatSession(h.deps);
    expect(explainRoute).toHaveBeenCalledWith(undefined);
    expect(h.out.join("\n")).toContain("AUTO ROUTE");
  });

  it("/lanes reports unavailable when no explainRoute dependency is wired", async () => {
    const h = harness(["/lanes", "/exit"], echo);
    await runChatSession(h.deps);
    expect(h.err.join("\n")).toContain("route explanation is not available");
  });

  it("/context sets a profile that is threaded into the next generate call", async () => {
    const h = harness(["/context career", "hello", "/context off", "again", "/exit"], echo);
    await runChatSession(h.deps);
    // First real turn carried the profile; after /context off it is cleared.
    expect(h.generate.mock.calls[0]?.[0].contextProfile).toBe("career");
    expect(h.generate.mock.calls[1]?.[0].contextProfile).toBeUndefined();
    expect(h.out.join("\n")).toContain("context → profile 'career'");
  });

  it("sends a plain line as a prompt and prints the response", async () => {
    const h = harness(["hello there", "/exit"], echo);
    await runChatSession(h.deps);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0].prompt).toBe("hello there");
    expect(h.out.join("\n")).toContain("echo: hello there");
  });

  it("carries prior turns into the next prompt (multi-turn context)", async () => {
    const h = harness(["first question", "second question", "/exit"], echo);
    await runChatSession(h.deps);
    expect(h.generate).toHaveBeenCalledTimes(2);
    const secondPrompt = h.generate.mock.calls[1]?.[0].prompt as string;
    expect(secondPrompt).toContain("User: first question");
    expect(secondPrompt).toContain("Assistant: echo: first question");
    expect(secondPrompt.endsWith("User: second question")).toBe(true);
  });

  it("/clear drops carried context so the next prompt is bare", async () => {
    const h = harness(["remember this", "/clear", "fresh start", "/exit"], echo);
    await runChatSession(h.deps);
    expect(h.out.join("\n")).toContain("context cleared.");
    const lastPrompt = h.generate.mock.calls.at(-1)?.[0].prompt as string;
    expect(lastPrompt).toBe("fresh start");
  });

  it("/model sets and clears the session model passed to generate", async () => {
    const h = harness(["/model llama3.1", "hi", "/model default", "hi again", "/exit"], echo);
    await runChatSession(h.deps);
    expect(h.generate.mock.calls[0]?.[0].model).toBe("llama3.1");
    expect(h.generate.mock.calls[1]?.[0].model).toBeUndefined();
  });

  it("/provider pins a valid lane and rejects an unknown one", async () => {
    const h = harness(["/provider ollama", "go", "/provider bogus", "/exit"], echo);
    await runChatSession(h.deps);
    expect(h.generate.mock.calls[0]?.[0].provider).toBe("ollama");
    expect(h.err.join("\n")).toContain('unknown provider "bogus"');
  });

  it("/status reports model, provider, turns and context size", async () => {
    const h = harness(["hello", "/status", "/exit"], echo, {
      projectRoot: () => "/Users/test/Dev/moss",
    });
    await runChatSession(h.deps);
    const text = h.out.join("\n");
    expect(text).toContain("turns:    2");
    expect(text).toContain("context:");
    expect(text).toContain("/Users/test/Dev/moss");
  });

  it("skips empty lines without calling generate", async () => {
    const h = harness(["", "   ", "/exit"], echo);
    await runChatSession(h.deps);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("surfaces a generation error without storing a turn", async () => {
    const failing = async (): Promise<ChatGenerateResult> => ({
      ok: false,
      error: "daemon unreachable",
    });
    const h = harness(["please answer", "follow up", "/exit"], failing);
    await runChatSession(h.deps);
    expect(h.err.join("\n")).toContain("daemon unreachable");
    // The failed turn left no context, so the follow-up prompt is still bare.
    const secondPrompt = h.generate.mock.calls[1]?.[0].prompt as string;
    expect(secondPrompt).toBe("follow up");
  });

  it("reports an unknown slash command", async () => {
    const h = harness(["/nope", "/exit"], echo);
    await runChatSession(h.deps);
    expect(h.err.join("\n")).toContain('unknown command "/nope"');
  });

  it("ends cleanly at EOF without an explicit /exit", async () => {
    const h = harness(["one"], echo);
    await expect(runChatSession(h.deps)).resolves.toBeUndefined();
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("evicts oldest turns to keep the transcript within the byte budget", async () => {
    // 200-byte budget; each turn pair is well over that, so only the most
    // recent turn(s) survive — the carried prompt must never grow unbounded.
    const big = "x".repeat(150);
    const bigEcho = async (_p: ChatGenerateParams): Promise<ChatGenerateResult> => ({
      ok: true,
      response: big,
      model: "stub-model",
    });
    const h = harness([big, big, big, "/status", "/exit"], bigEcho, {
      maxContextBytes: 200,
    });
    await runChatSession(h.deps);
    // Without eviction the transcript would hold 6 turns (900 bytes); the
    // budget keeps only the most recent turn.
    expect(h.out.join("\n")).toContain("turns:    1");
    const statusLine = h.out.find((l) => l.startsWith("context:")) ?? "";
    const kib = Number(statusLine.match(/~([0-9.]+) KiB/)?.[1]);
    expect(kib).toBeLessThanOrEqual(0.2);
  });
});

// ---------------------------------------------------------------------------------------
// The Taisce session: brief, front door, privacy rules, skills, /read, /edit.
// ---------------------------------------------------------------------------------------

const RULES = "Raw balances stay local-only.";

function taisce(extra: Partial<ChatSessionDeps> = {}): Partial<ChatSessionDeps> {
  return {
    brief: async () => "SESSION BRIEF: 3 things due",
    frontDoor: async (prompt) => (/balance/.test(prompt) ? "Domains: finance" : null),
    guardrails: () => RULES,
    skills: () => [
      { command: "standup", id: "standup", description: "the PA brief" },
      { command: "route", id: "context-router", description: "where X lives" },
    ],
    skillPrompt: (command, input) => ({
      id: command === "route" ? "context-router" : command,
      body: `SKILL ${command} INPUT ${input}`,
      loaded: [`Library/skills/${command}/SKILL.md`],
    }),
    readFile: (rel) => {
      if (rel.startsWith("Sources/Health")) throw new Error("Blocked by guard-reads: gated");
      return `contents of ${rel}`;
    },
    checkModel: (name) => {
      if (name.startsWith("qwen3")) throw new Error(`'${name}' is a reasoning model`);
    },
    numCtx: 16384,
    ...extra,
  };
}

describe("buildContextHeader", () => {
  it("is empty when nothing is wired, so plain chat is unchanged", () => {
    expect(
      buildContextHeader({ privacy: null, brief: undefined, frontDoor: null, files: [] }),
    ).toBe("");
  });

  it("orders privacy rules, brief, front door, then files", () => {
    const header = buildContextHeader({
      privacy: "RULES",
      brief: "BRIEF",
      frontDoor: "DOOR",
      files: [{ path: "a.md", content: "FILE" }],
    });
    const at = (t: string) => header.indexOf(t);
    expect(at("RULES")).toBeLessThan(at("BRIEF"));
    expect(at("BRIEF")).toBeLessThan(at("DOOR"));
    expect(at("DOOR")).toBeLessThan(at("FILE"));
  });

  it("estimates tokens at ~4 chars each", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("the Taisce session", () => {
  it("opens with the banner and the session-start brief", async () => {
    const h = harness(["/exit"], echo, taisce({ banner: "moss — Taisce session" }));
    await runChatSession(h.deps);
    expect(h.out[0]).toBe("moss — Taisce session");
    expect(h.out.join("\n")).toContain("SESSION BRIEF: 3 things due");
  });

  it("says so when the brief hook produced nothing", async () => {
    const h = harness(["/exit"], echo, taisce({ brief: async () => null }));
    await runChatSession(h.deps);
    expect(h.out.join("\n")).toContain("no session brief");
  });

  it("sends privacy rules, brief and front door as the system prompt; the typed line as the prompt", async () => {
    const h = harness(["what is my balance?", "/exit"], echo, taisce());
    await runChatSession(h.deps);
    const params = h.generate.mock.calls[0]?.[0] as ChatGenerateParams;
    expect(params.prompt).toBe("what is my balance?");
    expect(params.system).toContain(RULES);
    expect(params.system).toContain("SESSION BRIEF: 3 things due");
    expect(params.system).toContain("Domains: finance");
    // Visible, every turn.
    const text = h.out.join("\n");
    expect(text).toContain("privacy rules applied");
    expect(text).toContain("front door: finance");
  });

  it("omits the front-door block when nothing matched", async () => {
    const h = harness(["hello", "/exit"], echo, taisce());
    await runChatSession(h.deps);
    expect(h.generate.mock.calls[0]?.[0].system).not.toContain("FRONT DOOR");
  });

  it("flags missing privacy rules loudly", async () => {
    const h = harness(["hello", "/exit"], echo, taisce({ guardrails: () => null }));
    await runChatSession(h.deps);
    expect(h.out.join("\n")).toContain("privacy rules: MISSING");
  });

  it("/help lists the live skills with their descriptions", async () => {
    const h = harness(["/help", "/exit"], echo, taisce());
    await runChatSession(h.deps);
    const text = h.out.join("\n");
    expect(text).toMatch(/\/standup\s+the PA brief/);
    expect(text).toMatch(/\/route\s+where X lives/);
    expect(text).toContain("/read <path>");
  });

  it("/<skill> runs the skill prompt with the session header and marks the output", async () => {
    const h = harness(["/route where does my CV live", "/exit"], echo, taisce());
    await runChatSession(h.deps);
    const params = h.generate.mock.calls[0]?.[0] as ChatGenerateParams;
    expect(params.prompt).toBe("SKILL route INPUT where does my CV live");
    expect(params.system).toContain(RULES);
    const text = h.out.join("\n");
    expect(text).toContain("· skill context-router — Library/skills/route/SKILL.md");
    expect(text).toContain("never a record");
  });

  it("a skill that cannot be built reports why and sends nothing", async () => {
    const h = harness(
      ["/standup", "/exit"],
      echo,
      taisce({
        skillPrompt: () => {
          throw new Error("Blocked by guard-reads");
        },
      }),
    );
    await runChatSession(h.deps);
    expect(h.err.join("\n")).toContain("Blocked by guard-reads");
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("/read loads a file into every turn, and guard-reads refusals surface", async () => {
    const h = harness(
      ["/read Sources/Health/x.md", "/read System/pulse.md", "hi", "/context", "/exit"],
      echo,
      taisce(),
    );
    await runChatSession(h.deps);
    expect(h.err.join("\n")).toContain("Blocked by guard-reads");
    expect(h.generate.mock.calls[0]?.[0].system).toContain("contents of System/pulse.md");
    const text = h.out.join("\n");
    expect(text).toContain("file System/pulse.md");
    expect(text).toMatch(/total\s+~[\d,]+ tok of a 16,384-token window/);
  });

  it("/model refuses a reasoning model and keeps the previous one", async () => {
    const h = harness(["/model qwen3:4b", "hi", "/exit"], echo, taisce());
    await runChatSession(h.deps);
    expect(h.err.join("\n")).toContain("reasoning model");
    expect(h.generate.mock.calls[0]?.[0].model).toBeUndefined();
  });

  it("/model with no argument lists pulled models", async () => {
    const h = harness(["/model", "/exit"], echo, taisce({ listModels: async () => ["a", "b"] }));
    await runChatSession(h.deps);
    expect(h.out.join("\n")).toContain("pulled: a, b");
  });

  it("/status prints doctor + tier before the session lines", async () => {
    const h = harness(["/status", "/exit"], echo, taisce({ status: async () => "DOCTOR+TIER" }));
    await runChatSession(h.deps);
    const text = h.out.join("\n");
    expect(text.indexOf("DOCTOR+TIER")).toBeLessThan(text.indexOf("turns:"));
  });

  it("/clear also drops files loaded with /read", async () => {
    const h = harness(["/read a.md", "/clear", "hi", "/exit"], echo, taisce());
    await runChatSession(h.deps);
    expect(h.generate.mock.calls[0]?.[0].system).not.toContain("contents of a.md");
  });
});

describe("/edit — plan, dry-run diff, go?, apply, diff --stat", () => {
  function editDeps(overrides: Partial<SessionEditDeps> = {}) {
    const aider = vi.fn(async (_repo: string, o: { dryRun: boolean }) => ({
      exitCode: 0,
      output: o.dryRun ? "+def sub\nDid not apply edit (--dry-run)" : "Applied edit to calc.py",
    }));
    const diffStat = vi.fn(async () => " calc.py | 3 +++");
    const deps: SessionEditDeps = {
      resolveRepo: async () => "/repo",
      trackedFiles: async () => ["calc.py", "README.md"],
      checkFiles: () => undefined,
      coderModel: () => "qwen2.5-coder:7b",
      aider,
      diffStat,
      buildPlanPrompt: (ask) => `PLAN FOR ${ask}`,
      parsePlan: (text) => ({ files: "calc.py", plan: text }),
      pickFiles: (text, tracked) => tracked.filter((f) => text.includes(f)),
      ...overrides,
    };
    return { deps, aider, diffStat };
  }

  it("stops at go? and writes nothing on anything but yes", async () => {
    const { deps, aider, diffStat } = editDeps();
    const h = harness(["/edit add sub to calc.py", "n", "/exit"], echo, taisce({ edit: deps }));
    await runChatSession(h.deps);
    expect(aider).toHaveBeenCalledTimes(1);
    expect(aider.mock.calls[0]?.[1]).toMatchObject({ dryRun: true, files: ["calc.py"] });
    const text = h.out.join("\n");
    expect(text).toContain("Did not apply edit (--dry-run)");
    expect(text).toContain("go? [y/N]");
    expect(text).toContain("not applied. Nothing was written.");
    expect(diffStat).not.toHaveBeenCalled();
    // The planning turn carried the privacy rules.
    expect(h.generate.mock.calls[0]?.[0].system).toContain(RULES);
  });

  it("EOF at go? is a no", async () => {
    const { deps, aider } = editDeps();
    const h = harness(["/edit add sub to calc.py"], echo, taisce({ edit: deps }));
    await runChatSession(h.deps);
    expect(aider).toHaveBeenCalledTimes(1);
  });

  it("on go, applies without --dry-run and prints git diff --stat — never commits", async () => {
    const { deps, aider, diffStat } = editDeps();
    const h = harness(["/edit add sub to calc.py", "go", "/exit"], echo, taisce({ edit: deps }));
    await runChatSession(h.deps);
    expect(aider).toHaveBeenCalledTimes(2);
    expect(aider.mock.calls[1]?.[1]).toMatchObject({ dryRun: false });
    expect(diffStat).toHaveBeenCalledWith("/repo");
    const text = h.out.join("\n");
    expect(text).toContain("calc.py | 3 +++");
    expect(text).toContain("Not committed");
  });

  it("refuses when the plan names no tracked file", async () => {
    const { deps, aider } = editDeps({ parsePlan: () => ({ files: "nope.py", plan: "x" }) });
    const h = harness(["/edit do something", "/exit"], echo, taisce({ edit: deps }));
    await runChatSession(h.deps);
    expect(h.err.join("\n")).toContain("named no file tracked");
    expect(aider).not.toHaveBeenCalled();
  });

  it("refuses a sensitivity-gated file before Aider ever sees it", async () => {
    const { deps, aider } = editDeps({
      checkFiles: () => {
        throw new Error("Blocked by guard-reads: 'Projects/home-reset/x.md'");
      },
    });
    const h = harness(["/edit fix calc.py", "/exit"], echo, taisce({ edit: deps }));
    await runChatSession(h.deps);
    expect(h.err.join("\n")).toContain("Blocked by guard-reads");
    expect(aider).not.toHaveBeenCalled();
  });

  it("does not ask go? when the dry run fails", async () => {
    const { deps } = editDeps({ aider: vi.fn(async () => ({ exitCode: 1, output: "boom" })) });
    const h = harness(["/edit fix calc.py", "/exit"], echo, taisce({ edit: deps }));
    await runChatSession(h.deps);
    expect(h.err.join("\n")).toContain("nothing was applied");
    expect(h.out.join("\n")).not.toContain("go?");
  });

  it("reports a failed planning turn, an empty ask, no repo, and no /edit wiring", async () => {
    const failing = async (): Promise<ChatGenerateResult> => ({ ok: false, error: "no model" });
    const a = harness(["/edit fix calc.py", "/exit"], failing, taisce({ edit: editDeps().deps }));
    await runChatSession(a.deps);
    expect(a.err.join("\n")).toContain("no model");

    const b = harness(["/edit", "/exit"], echo, taisce({ edit: editDeps().deps }));
    await runChatSession(b.deps);
    expect(b.err.join("\n")).toContain("usage: /edit");

    const c = harness(
      ["/edit x", "/exit"],
      echo,
      taisce({ edit: editDeps({ resolveRepo: async () => null }).deps }),
    );
    await runChatSession(c.deps);
    expect(c.err.join("\n")).toContain("no git repo");

    const d = harness(["/edit x", "/exit"], echo);
    await runChatSession(d.deps);
    expect(d.err.join("\n")).toContain("/edit is not available");
  });
});
