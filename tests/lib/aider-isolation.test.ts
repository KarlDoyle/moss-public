import { describe, expect, it, vi } from "vitest";

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock("../../src/lib/exec.ts", () => ({ run: runMock }));

import { defaultAiderRunner } from "../../src/lib/aider.ts";

describe("deprecated Aider execution", () => {
  it.each(["--dry-run", "--no-dry-run"])("refuses %s without spawning a child", async (mode) => {
    await expect(defaultAiderRunner([mode], "/synthetic/repository")).rejects.toThrow(
      "deprecated and disabled",
    );
    expect(runMock).not.toHaveBeenCalled();
  });
});
