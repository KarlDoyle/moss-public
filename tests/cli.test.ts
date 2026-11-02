import { describe, expect, it } from "vitest";
import { buildCli } from "../src/cli.ts";
import { MOSS_VERSION } from "../src/version.ts";

describe("buildCli", () => {
  it("uses the moss name", () => {
    const program = buildCli();
    expect(program.name()).toBe("moss");
  });

  it("reports the MOSS_VERSION", () => {
    const program = buildCli();
    expect(program.version()).toBe(MOSS_VERSION);
  });

  it("includes a --json global option", () => {
    const program = buildCli();
    const opt = program.options.find((o) => o.long === "--json");
    expect(opt).toBeDefined();
  });

  it("registers no commands when registerCommands=false", () => {
    const program = buildCli({ registerCommands: false });
    expect(program.commands.length).toBe(0);
  });

  it("registers the active commands when registerCommands defaults true", () => {
    const program = buildCli();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual([
      "api",
      "ask",
      "auth",
      "bench",
      "chat",
      "check",
      "compact",
      "context",
      "convert",
      "cost",
      "credits",
      "doctor",
      "forget",
      "inventory",
      "litellm",
      "local",
      "models",
      "off",
      "plan",
      "recall",
      "remember",
      "run",
      "skills",
      "status",
      "sub",
      "tools",
    ]);
  });

  it("rejects an unknown command with exitOverride enabled", () => {
    const program = buildCli({ exitOverride: true, registerCommands: false });
    expect(() =>
      program.parse(["node", "moss", "definitely-not-a-command"], { from: "node" }),
    ).toThrow();
  });
});

describe("global --explain and the parked commands", () => {
  it("takes --explain from anywhere, except where ask and models own it", async () => {
    const { globalExplainArgs } = await import("../src/cli.ts");
    expect(globalExplainArgs(["--explain", "run", "capture"])).toEqual(["run", "capture"]);
    expect(globalExplainArgs(["run", "council", "x", "--explain"])).toEqual([
      "run",
      "council",
      "x",
    ]);
    expect(globalExplainArgs(["ask", "--explain"])).toBeNull();
    expect(globalExplainArgs(["models", "--explain", "ask"])).toBeNull();
    expect(globalExplainArgs(["status"])).toBeNull();
  });

  it("hides parked commands from --help unless showAll, and still registers them", async () => {
    const { PARKED_COMMANDS } = await import("../src/cli.ts");
    const hidden = (showAll: boolean) =>
      buildCli({ showAll })
        .commands.filter((c) => (c as unknown as { _hidden: boolean })._hidden)
        .map((c) => c.name())
        .sort();
    expect(hidden(false)).toEqual([...PARKED_COMMANDS].sort());
    expect(hidden(true)).toEqual([]);
    expect(buildCli().commands.map((c) => c.name())).toContain("litellm");
  });
});
