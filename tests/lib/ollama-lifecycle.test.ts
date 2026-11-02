import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecCommandNotAllowedError, run } from "../../src/lib/exec.ts";
import {
  ensureOllama,
  type LifecycleDeps,
  ollamaUse,
  otherOllamaUsers,
  parseOllamaPs,
  resetOllamaUse,
  turnOffOllama,
} from "../../src/lib/ollama-lifecycle.ts";

function deps(opts: { up?: boolean[]; ps?: string; pgrep?: string; app?: boolean }) {
  const ups = [...(opts.up ?? [true])];
  const calls: string[] = [];
  const startServe = vi.fn();
  const d: LifecycleDeps = {
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "ollama" && args[0] === "ps")
        return { exitCode: 0, stdout: opts.ps ?? "NAME ID SIZE\n" };
      if (command === "pgrep") return { exitCode: 0, stdout: opts.pgrep ?? "" };
      return { exitCode: 0, stdout: "" };
    },
    startServe,
    reachable: async () => (ups.length > 1 ? (ups.shift() as boolean) : (ups[0] as boolean)),
    appInstalled: () => opts.app ?? true,
    wait: async () => undefined,
    pid: 100,
  };
  return { d, calls, startServe };
}

const PS =
  "NAME               ID    SIZE\nllama3.1:latest    46e   6.9 GB\ngemma4:12b    4eb   8.0 GB\n";

beforeEach(() => resetOllamaUse());

describe("Ollama on demand", () => {
  it("starts nothing when it is already up", async () => {
    const { d, calls } = deps({ up: [true] });
    expect(await ensureOllama(d)).toBe(true);
    expect(calls).toEqual([]);
    expect(ollamaUse.started).toBe(false);
  });

  it("opens the app when down, waits for it, and remembers it started it", async () => {
    const { d, calls } = deps({ up: [false, false, true] });
    expect(await ensureOllama(d)).toBe(true);
    expect(calls).toEqual(["open -a Ollama"]);
    expect(ollamaUse.started).toBe(true);
  });

  it("falls back to `ollama serve` without the app, and reports a daemon that never comes up", async () => {
    const { d, startServe } = deps({ up: [false], app: false });
    expect(await ensureOllama(d)).toBe(false);
    expect(startServe).toHaveBeenCalledOnce();
    expect(ollamaUse.started).toBe(false);
  });
});

describe("turning it off", () => {
  it("unloads every model, then SIGTERMs the app, and confirms it stopped answering", async () => {
    const { d, calls } = deps({ up: [true, true, false], ps: PS });
    expect(await turnOffOllama({}, d)).toEqual({
      off: true,
      message: "Ollama turned off (unloaded llama3.1:latest, gemma4:12b; stopped).",
    });
    expect(calls).toEqual([
      "pgrep -fl moss.*src/cli\\.ts|/aider( |$)",
      "ollama ps",
      "ollama stop llama3.1:latest",
      "ollama stop gemma4:12b",
      "pkill -TERM -x Ollama",
    ]);
  });

  it("leaves it running while another moss or Aider uses it — unless forced", async () => {
    const pgrep =
      "100 node moss/src/cli.ts\n200 node /Users/k/Dev/moss/src/cli.ts run x\n300 /opt/homebrew/bin/aider --model x\n";
    const busy = deps({ up: [true], pgrep });
    expect(await turnOffOllama({}, busy.d)).toEqual({
      off: false,
      message:
        "Ollama left running — in use by another moss and aider (moss off --force to stop it anyway).",
    });
    expect(busy.calls).not.toContain("pkill -TERM -x Ollama");
    expect(await otherOllamaUsers(deps({ pgrep: "100 node moss/src/cli.ts\n" }).d)).toEqual([]);
    expect((await turnOffOllama({ force: true }, deps({ up: [true, false], pgrep }).d)).off).toBe(
      true,
    );
  });

  it("says so when already off, stops a bare `ollama serve`, and says when it will not stop", async () => {
    expect(await turnOffOllama({}, deps({ up: [false] }).d)).toEqual({
      off: true,
      message: "Ollama is already off.",
    });
    const bare = deps({ up: [true, false], app: false });
    expect((await turnOffOllama({}, bare.d)).off).toBe(true);
    expect(bare.calls).toContain("pkill -TERM -x ollama");
    expect((await turnOffOllama({}, deps({ up: [true] }).d)).message).toContain("still answering");
  });

  it("parses `ollama ps`", () => {
    expect(parseOllamaPs(PS)).toEqual(["llama3.1:latest", "gemma4:12b"]);
    expect(parseOllamaPs("NAME ID\n")).toEqual([]);
  });
});

describe("the exec allowlist admits exactly these forms", () => {
  it("refuses every other open/pkill/pgrep form, and osascript entirely", async () => {
    for (const [cmd, args] of [
      ["osascript", ["-e", 'quit app "Ollama"']],
      ["open", ["-a", "Terminal"]],
      ["open", ["-a", "Ollama", "--args", "x"]],
      ["pkill", ["-9", "-x", "Ollama"]],
      ["pkill", ["-TERM", "-x", "Finder"]],
      ["pkill", ["-TERM", "-x", "Ollama", "-f", "x"]],
      ["pkill", ["-TERM", "-f", "ollama"]],
      ["pgrep", ["-f", "x"]],
    ] as const) {
      await expect(run(cmd, args)).rejects.toBeInstanceOf(ExecCommandNotAllowedError);
    }
  });
});

describe("the test suite can never start or stop the real Ollama", () => {
  it("refuses on the default deps while MOSS_NO_OLLAMA_LIFECYCLE=1 (set by vitest.config.ts)", async () => {
    expect(process.env.MOSS_NO_OLLAMA_LIFECYCLE).toBe("1");
    expect(await turnOffOllama()).toEqual({
      off: false,
      message: "Ollama lifecycle disabled (MOSS_NO_OLLAMA_LIFECYCLE=1).",
    });
  });
});
