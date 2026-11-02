import { describe, expect, it } from "vitest";
import { runConvertCommand } from "../../src/commands/convert.ts";
import { runInventoryCommand } from "../../src/commands/inventory.ts";
import { setActiveMilestone } from "../../src/lib/policy.ts";

describe("inventory command", () => {
  it("prints starter config without touching the filesystem", async () => {
    setActiveMilestone("M7");
    const lines: string[] = [];
    const code = await runInventoryCommand({
      mode: "print-config",
      emitJson: false,
      out: (line) => lines.push(line),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain('"approvedFolder": "tests/fixtures/docs"');
  });

  it("rejects scan when capability is out of scope", async () => {
    setActiveMilestone("M6");
    const errLines: string[] = [];
    await expect(
      runInventoryCommand({
        mode: "scan",
        emitJson: false,
        out: () => {},
        err: (line) => errLines.push(line),
      }),
    ).rejects.toThrow(/documents.*M7/);
    setActiveMilestone("M7");
  });
});

describe("convert command", () => {
  it("requires --path or --all", async () => {
    setActiveMilestone("M7");
    const errLines: string[] = [];
    const code = await runConvertCommand({
      mode: "single",
      emitJson: false,
      out: () => {},
      err: (line) => errLines.push(line),
    });
    expect(code).toBe(1);
    expect(errLines.join("\n")).toMatch(/Specify --path|--all/);
  });
});
