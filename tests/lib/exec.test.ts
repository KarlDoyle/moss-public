import { describe, expect, it } from "vitest";
import {
  ExecCommandNotAllowedError,
  ExecFailedError,
  isCommandAllowed,
  listAllowedCommands,
  run,
  runDetached,
} from "../../src/lib/exec.ts";

describe("exec.run", () => {
  it("lists the allowlist", () => {
    const allowed = listAllowedCommands();
    expect(allowed).toContain("git");
    expect(allowed).toContain("gh");
    expect(allowed).toContain("ollama");
    expect(allowed).toContain("pnpm");
    // `node` is intentionally NOT allowlisted: no production path spawns it.
    expect(allowed).not.toContain("node");
  });

  it("isCommandAllowed returns false for disallowed commands", () => {
    expect(isCommandAllowed("rm")).toBe(false);
    expect(isCommandAllowed("curl")).toBe(false);
    expect(isCommandAllowed("git")).toBe(true);
  });

  it("rejects disallowed commands without spawning a process", async () => {
    await expect(run("rm", ["-rf", "/"])).rejects.toBeInstanceOf(ExecCommandNotAllowedError);
  });

  it("runs an allowlisted command and returns stdout", async () => {
    const result = await run("pnpm", ["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+/);
  });

  it("throws ExecFailedError when an allowlisted command exits non-zero", async () => {
    await expect(run("pnpm", ["run", "moss-exec-test-nonexistent-script"])).rejects.toBeInstanceOf(
      ExecFailedError,
    );
  });

  it("respects allowFailure and returns the non-zero result", async () => {
    const result = await run("pnpm", ["run", "moss-exec-test-nonexistent-script"], {
      allowFailure: true,
    });
    expect(result.exitCode).not.toBe(0);
  });
});

describe("session subprocesses", () => {
  it("allowlists bash (Taisce hooks) and aider (/edit)", async () => {
    const { listAllowedCommands } = await import("../../src/lib/exec.ts");
    expect(listAllowedCommands()).toEqual(
      expect.arrayContaining(["aider", "bash", "gh", "git", "ollama", "pnpm"]),
    );
  });

  it("runDetached permits only the Ollama daemon command", () => {
    expect(() => runDetached("curl", ["http://example.com"])).toThrow(ExecCommandNotAllowedError);
    expect(() => runDetached("security", ["dump-keychain"])).toThrow(ExecCommandNotAllowedError);
    expect(() => runDetached("pkill", ["-9", "-f", "."])).toThrow(ExecCommandNotAllowedError);
    expect(() => runDetached("ollama", ["ps"])).toThrow(ExecCommandNotAllowedError);
  });

  it("run() feeds stdin via input", async () => {
    const { run } = await import("../../src/lib/exec.ts");
    const result = await run("bash", ["-s"], { input: "printf hello" });
    expect(result.stdout).toBe("hello");
  });
});

describe("Claude lanes (unified router, 2026-09-18)", () => {
  it("allowlists claude and security", () => {
    expect(listAllowedCommands()).toEqual(expect.arrayContaining(["claude", "security"]));
  });

  it("admits `security` only as a single-item Keychain read", async () => {
    for (const args of [
      ["dump-keychain"],
      ["find-generic-password"],
      ["add-generic-password", "-w", "x"],
      [],
    ]) {
      await expect(run("security", args)).rejects.toBeInstanceOf(ExecCommandNotAllowedError);
    }
  });
});

describe("moss check's read-only commands", () => {
  it("admits brew, softwareupdate, launchctl and npm only in their read-only form", async () => {
    for (const [cmd, args] of [
      ["brew", ["upgrade"]],
      ["brew", ["install", "x"]],
      ["softwareupdate", ["-ia"]],
      ["launchctl", ["bootstrap", "gui/501", "x.plist"]],
      ["launchctl", ["bootout", "gui/501/x"]],
      ["npm", ["install", "-g", "x"]],
    ] as const) {
      await expect(run(cmd, args)).rejects.toBeInstanceOf(ExecCommandNotAllowedError);
    }
    expect(listAllowedCommands()).toEqual(
      expect.arrayContaining(["brew", "softwareupdate", "launchctl", "npm"]),
    );
  });
});
