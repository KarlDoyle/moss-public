import { describe, expect, it } from "vitest";
import { runToolsCommand } from "../../src/commands/tools.ts";

describe("runToolsCommand", () => {
  it("prints starter config with --print-config", async () => {
    const out: string[] = [];
    const code = await runToolsCommand({
      mode: "print-config",
      emitJson: false,
      out: (l) => out.push(l),
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain('"enabled": false');
    expect(out.join("\n")).toContain("example-echo");
    expect(out.join("\n")).toContain("D-0016");
  });
});
