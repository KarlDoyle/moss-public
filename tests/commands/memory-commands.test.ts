import { describe, expect, it } from "vitest";
import { runCompactCommand } from "../../src/commands/compact.ts";
import { runForgetCommand } from "../../src/commands/forget.ts";
import { runRecallCommand } from "../../src/commands/recall.ts";
import { runRememberCommand } from "../../src/commands/remember.ts";
import {
  assertCapability,
  CapabilityOutOfScopeError,
  setActiveMilestone,
} from "../../src/lib/policy.ts";

describe("memory commands", () => {
  it("rejects remember when memory capability is out of scope", () => {
    setActiveMilestone("M7");
    expect(() => assertCapability("memory")).toThrow(CapabilityOutOfScopeError);
    setActiveMilestone("M8");
  });

  it("remember requires content", async () => {
    setActiveMilestone("M8");
    const errLines: string[] = [];
    const code = await runRememberCommand({
      tags: [],
      emitJson: false,
      out: () => {},
      err: (line) => errLines.push(line),
    });
    expect(code).toBe(1);
    expect(errLines.join("\n")).toMatch(/provide note text/i);
  });

  it("aliases remember --type milestone to canonical fact", async () => {
    setActiveMilestone("M8");
    const lines: string[] = [];
    const code = await runRememberCommand({
      content: "v0.1.1 shipped",
      type: "milestone",
      tags: ["moss"],
      emitJson: true,
      out: (line) => lines.push(line),
      err: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.entry.type).toBe("fact");
    expect(parsed.entry.tags).toEqual(["moss"]);
  });

  it("explains invalid memory types with a release-friendly example", async () => {
    setActiveMilestone("M8");
    const errLines: string[] = [];
    const code = await runRememberCommand({
      content: "release note",
      type: "project",
      tags: [],
      emitJson: false,
      out: () => {},
      err: (line) => errLines.push(line),
    });
    expect(code).toBe(1);
    const message = errLines.join("\n");
    expect(message).toContain("Valid memory types");
    expect(message).toContain("--type fact --tag milestone");
  });

  it("emits structured JSON for invalid memory types in JSON mode", async () => {
    setActiveMilestone("M8");
    const errLines: string[] = [];
    const code = await runRememberCommand({
      content: "release note",
      type: "project",
      tags: [],
      emitJson: true,
      out: () => {},
      err: (line) => errLines.push(line),
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(errLines.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.validTypes).toContain("fact");
    expect(parsed.example).toContain("--type fact --tag milestone");
  });

  it("recall accepts empty filters", async () => {
    setActiveMilestone("M8");
    const lines: string[] = [];
    const code = await runRecallCommand({
      emitJson: true,
      out: (line) => lines.push(line),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, count: expect.any(Number) });
  });

  it("compact requires tag and output via command wrapper", async () => {
    setActiveMilestone("M8");
    const errLines: string[] = [];
    const code = await runCompactCommand({
      tag: "missing-tag-with-no-entries",
      outputName: "missing-summary",
      emitJson: false,
      out: () => {},
      err: (line) => errLines.push(line),
    });
    expect(code).toBe(1);
    expect(errLines.join("\n")).toMatch(/No active memory entries/i);
  });

  it("forget reports missing ids clearly", async () => {
    setActiveMilestone("M8");
    const errLines: string[] = [];
    const code = await runForgetCommand({
      id: "mem-does-not-exist",
      emitJson: false,
      out: () => {},
      err: (line) => errLines.push(line),
    });
    expect(code).toBe(1);
    expect(errLines.join("\n")).toMatch(/not found/i);
  });
});
