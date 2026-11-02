import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock("../../src/lib/exec.ts", () => ({ run: runMock }));

import { defaultAiderRunner } from "../../src/lib/aider.ts";

describe("default Aider process boundary", () => {
  it("uses a private temporary home, strips inherited variables, and cleans it after a mock run", async () => {
    process.env.MOSS_AIDER_TEST_SECRET = "synthetic-only";
    runMock.mockResolvedValue({
      exitCode: 0,
      stdout: "controlled output",
      stderr: "",
    });
    try {
      await expect(defaultAiderRunner(["--dry-run"], "/synthetic/repository")).resolves.toEqual({
        exitCode: 0,
        output: "controlled output",
      });
      const call = runMock.mock.calls[0] as [
        string,
        readonly string[],
        {
          env: Record<string, string>;
          unsetEnv: readonly string[];
        },
      ];
      expect(call[0]).toBe("aider");
      const privateHome = call[2].env.HOME;
      const configHome = call[2].env.XDG_CONFIG_HOME;
      if (privateHome === undefined || configHome === undefined) {
        throw new Error("private home/config environment was not provided");
      }
      expect(privateHome).toMatch(/moss-aider-home-/);
      expect(configHome).toContain(privateHome);
      expect(call[2].env.OLLAMA_API_BASE).toBeTruthy();
      expect(call[2].unsetEnv).toContain("MOSS_AIDER_TEST_SECRET");
      expect(existsSync(privateHome)).toBe(false);
    } finally {
      Reflect.deleteProperty(process.env, "MOSS_AIDER_TEST_SECRET");
      runMock.mockReset();
    }
  });
});
