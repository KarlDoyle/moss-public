import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gatesIn,
  isTaskType,
  lanesFor,
  loadRoutingPolicy,
  settingsFor,
  taskForSkill,
} from "../../../src/lib/lanes/policy.ts";
import { policy } from "./fixtures.ts";

describe("config/routing.yaml", () => {
  it("routes down by default and up by stakes, as the plan says", () => {
    expect(lanesFor(policy, "route")).toEqual(["ollama"]);
    expect(lanesFor(policy, "brief")).toEqual(["ollama"]);
    expect(lanesFor(policy, "embed")).toEqual(["ollama"]);
    expect(lanesFor(policy, "vision")).toEqual(["ollama"]);
    expect(lanesFor(policy, "reason")).toEqual(["claude-code", "anthropic-api", "ollama"]);
    expect(lanesFor(policy, "edit")).toEqual(["claude-code", "anthropic-api", "ollama"]);
    expect(policy.caps["anthropic-api"].daily_eur).toBe(2);
    expect(policy.caps["claude-code"].sonnet_first).toBe(true);
    expect(policy.stakes.gates).toEqual(["irreversible", "external-facing"]);
  });

  it("gives each lane its settings, and a forced lane borrows the first row that has it", () => {
    expect(settingsFor(policy, "edit", "ollama")).toMatchObject({
      editor_model: "qwen2.5-coder:7b",
    });
    expect(settingsFor(policy, "brief", "claude-code")).toEqual({ model: "sonnet" });
    expect(settingsFor(policy, "route", "litellm")).toBeUndefined();
  });

  it("maps skills to tasks; a SKILL.md metadata task wins", () => {
    expect(taskForSkill(policy, "capture")).toBe("brief");
    expect(taskForSkill(policy, "context-router")).toBe("route");
    expect(taskForSkill(policy, "expert-council")).toBe("reason");
    expect(taskForSkill(policy, "never-heard-of-it")).toBe("brief");
    expect(
      taskForSkill(policy, "capture", "---\nname: c\nmetadata:\n  task: reason\n---\nbody"),
    ).toBe("reason");
    expect(taskForSkill(policy, "capture", "---\nmetadata:\n  task: nonsense\n---\n")).toBe(
      "brief",
    );
  });

  it("reads gates from the front door's Domains line only", () => {
    expect(gatesIn(policy, "Domains: external-facing · irreversible\nGate: x")).toEqual([
      "irreversible",
      "external-facing",
    ]);
    expect(gatesIn(policy, "Domains: finance\nBoundary: irreversible words here")).toEqual([]);
    expect(gatesIn(policy, null)).toEqual([]);
    expect(isTaskType("edit")).toBe(true);
    expect(isTaskType("ask")).toBe(false);
  });

  it("refuses an invalid file with the reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-routing-"));
    const bad = join(dir, "r.yaml");
    writeFileSync(bad, "last_reviewed: yesterday\n");
    expect(() => loadRoutingPolicy(bad)).toThrow("config/routing.yaml is invalid");
    const missingLane = join(dir, "m.yaml");
    writeFileSync(
      missingLane,
      [
        'last_reviewed: "2026-09-18"',
        "review_frequency: monthly",
        "tasks: { route: { lanes: [ollama, claude-code], ollama: { model: m } } }",
        "caps: { anthropic-api: { daily_eur: 2 }, claude-code: { sonnet_first: true } }",
        'fx: { usd_to_eur: 0.9, checked: "x" }',
        "stakes: { gates: [irreversible], best_order: [ollama] }",
        "skills: {}",
      ].join("\n"),
    );
    expect(() => loadRoutingPolicy(missingLane)).toThrow(
      "lane claude-code is listed but has no settings",
    );
  });
});
