import { describe, expect, it } from "vitest";
import {
  recordUsageBestEffort,
  type UsageLogDeps,
  writeUsageEntry,
} from "../../../src/lib/usage/log.ts";
import { UsageEntrySchema } from "../../../src/lib/usage/types.ts";

function capture(): { deps: UsageLogDeps; lines: { path: string; data: string }[] } {
  const lines: { path: string; data: string }[] = [];
  const deps: UsageLogDeps = {
    appendFile: async (path, data) => {
      lines.push({ path, data });
    },
    now: () => new Date("2026-06-15T00:00:00.000Z"),
    mossVersion: "0.0.0-test",
  };
  return { deps, lines };
}

describe("writeUsageEntry", () => {
  it("appends one schema-valid JSONL line with provenance and all fields", async () => {
    const { deps, lines } = capture();
    const entry = await writeUsageEntry(
      {
        command: "ask",
        providerId: "ollama",
        model: "llama3.2:3b",
        task: "ask",
        inputTokens: 42,
        outputTokens: 7,
        durationMs: 1234,
      },
      deps,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.path).toMatch(/output\/usage\/usage\.jsonl$/);
    expect(lines[0]?.data.endsWith("\n")).toBe(true);
    const parsed = UsageEntrySchema.parse(JSON.parse(lines[0]?.data ?? "{}"));
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      timestamp: "2026-06-15T00:00:00.000Z",
      command: "ask",
      providerId: "ollama",
      model: "llama3.2:3b",
      task: "ask",
      inputTokens: 42,
      outputTokens: 7,
      durationMs: 1234,
      recordedBy: "moss@0.0.0-test",
    });
    expect(entry.recordedBy).toBe("moss@0.0.0-test");
  });

  it("omits optional fields when they are not provided", async () => {
    const { deps, lines } = capture();
    await writeUsageEntry({ command: "ask", providerId: "ollama", model: "m" }, deps);
    const parsed = JSON.parse(lines[0]?.data ?? "{}");
    expect(parsed.inputTokens).toBeUndefined();
    expect(parsed.outputTokens).toBeUndefined();
    expect(parsed.durationMs).toBeUndefined();
    expect(parsed.task).toBeUndefined();
    expect(parsed.skill).toBeUndefined();
  });

  it("never records prompt or response content (metadata only)", async () => {
    const { deps, lines } = capture();
    await writeUsageEntry({ command: "ask", providerId: "ollama", model: "m" }, deps);
    const keys = Object.keys(JSON.parse(lines[0]?.data ?? "{}"));
    expect(keys).not.toContain("prompt");
    expect(keys).not.toContain("response");
  });
});

describe("recordUsageBestEffort", () => {
  it("returns true and writes on success", async () => {
    const { deps, lines } = capture();
    const ok = await recordUsageBestEffort(
      { command: "ask", providerId: "ollama", model: "m" },
      deps,
    );
    expect(ok).toBe(true);
    expect(lines).toHaveLength(1);
  });

  it("swallows writer errors and returns false (logging never fails the caller)", async () => {
    const failing: UsageLogDeps = {
      appendFile: async () => {
        throw new Error("disk full");
      },
      now: () => new Date("2026-06-15T00:00:00.000Z"),
      mossVersion: "test",
    };
    const ok = await recordUsageBestEffort(
      { command: "ask", providerId: "ollama", model: "m" },
      failing,
    );
    expect(ok).toBe(false);
  });
});
