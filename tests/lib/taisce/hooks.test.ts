import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  defaultHookRunner,
  FRONT_DOOR_REL,
  type HookRunner,
  parseSessionStartOutput,
  runFrontDoorHook,
  runSessionStartHook,
  SESSION_START_REL,
} from "../../../src/lib/taisce/hooks.ts";

const root = mkdtempSync(join(tmpdir(), "moss-hooks-test-"));
mkdirSync(join(root, "scripts", "hooks"), { recursive: true });
writeFileSync(join(root, SESSION_START_REL), "#!/usr/bin/env bash\n");
writeFileSync(join(root, FRONT_DOOR_REL), "#!/usr/bin/env bash\n");
const empty = mkdtempSync(join(tmpdir(), "moss-hooks-empty-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

describe("parseSessionStartOutput", () => {
  it("reads additionalContext from the hook JSON", () => {
    const json = JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: " BRIEF " },
    });
    expect(parseSessionStartOutput(json)).toBe("BRIEF");
  });

  it("accepts the plain-text fallback and treats empty as nothing", () => {
    expect(parseSessionStartOutput("plain brief\n")).toBe("plain brief");
    expect(parseSessionStartOutput("   ")).toBeNull();
    expect(parseSessionStartOutput("{}")).toBeNull();
  });
});

describe("running the Taisce hooks by path", () => {
  it("session-start: runs the script in the Taisce root and parses its JSON", async () => {
    const runner = vi.fn<HookRunner>(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "the brief" } }),
    }));
    expect(await runSessionStartHook(root, runner)).toBe("the brief");
    const [script, input, opts] = runner.mock.calls[0] ?? [];
    expect(script).toBe(join(root, SESSION_START_REL));
    expect(JSON.parse(input as string).hook_event_name).toBe("SessionStart");
    expect(opts?.cwd).toBe(root);
  });

  it("front-door: sends the prompt as the hook's stdin JSON and returns its lines", async () => {
    const runner = vi.fn<HookRunner>(async () => ({ exitCode: 0, stdout: "Domains: finance\n" }));
    expect(await runFrontDoorHook("my runway", root, runner)).toBe("Domains: finance");
    expect(JSON.parse(runner.mock.calls[0]?.[1] as string).prompt).toBe("my runway");
  });

  it("front-door: silence means nothing matched", async () => {
    const runner: HookRunner = async () => ({ exitCode: 0, stdout: "" });
    expect(await runFrontDoorHook("hello", root, runner)).toBeNull();
  });

  it("never throws: a crash, a non-zero exit or a missing script is null", async () => {
    const crash: HookRunner = async () => {
      throw new Error("boom");
    };
    const nonZero: HookRunner = async () => ({ exitCode: 2, stdout: "x" });
    const never = vi.fn<HookRunner>();
    expect(await runSessionStartHook(root, crash)).toBeNull();
    expect(await runFrontDoorHook("x", root, nonZero)).toBeNull();
    expect(await runSessionStartHook(empty, never)).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it("the default runner runs a real script with bash, stdin and CLAUDE_PROJECT_DIR", async () => {
    const script = join(root, "echo.sh");
    writeFileSync(script, 'read -r line; printf "%s|%s" "$line" "$CLAUDE_PROJECT_DIR"\n');
    const result = await defaultHookRunner(script, "hi\n", { cwd: root, timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`hi|${root}`);
  });
});
