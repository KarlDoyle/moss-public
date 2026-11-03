import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  eurSpent,
  ledgerPath,
  localDay,
  readLedger,
  recordLaneUsage,
} from "../../../src/lib/lanes/ledger.ts";

describe("lane-usage ledger", () => {
  it("appends one metadata-only line per call and sums today's metered spend", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "moss-ledger-")), "lane-usage.jsonl");
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    await recordLaneUsage(
      {
        ts: now.toISOString(),
        lane: "anthropic-api",
        model: "sonnet",
        task: "reason",
        cost: "eur",
        eur: 0.5,
      },
      file,
    );
    await recordLaneUsage(
      {
        ts: now.toISOString(),
        lane: "anthropic-api",
        model: "sonnet",
        task: "edit",
        cost: "eur",
        eur: 0.25,
      },
      file,
    );
    await recordLaneUsage(
      {
        ts: yesterday.toISOString(),
        lane: "anthropic-api",
        model: "sonnet",
        task: "edit",
        cost: "eur",
        eur: 9,
      },
      file,
    );
    await recordLaneUsage(
      {
        ts: now.toISOString(),
        lane: "ollama",
        model: "llama3.1:latest",
        task: "brief",
        cost: "local",
      },
      file,
    );
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      lane: "anthropic-api",
      cost: "eur",
      by: "moss",
    });
    const entries = readLedger(file);
    expect(eurSpent(entries, "anthropic-api", localDay(now))).toBeCloseTo(0.75);
    expect(eurSpent(entries, "ollama", localDay(now))).toBe(0);
  });

  it("never fails the call it records, and honours the env override", async () => {
    expect(
      await recordLaneUsage(
        { ts: "x", lane: "l", model: "m", task: "t", cost: "local" },
        "/dev/null/nope.jsonl",
      ),
    ).toBe(false);
    expect(ledgerPath({ MOSS_LANE_USAGE_FILE: "/tmp/x.jsonl" })).toBe("/tmp/x.jsonl");
    expect(localDay(new Date(2026, 8, 3))).toBe("2026-09-03");
  });
});

describe("every call reaches the ledger", () => {
  it("the pre-router usage path appends a lane line (default deps only)", async () => {
    const { recordUsageBestEffort } = await import("../../../src/lib/usage/log.ts");
    const lines: unknown[] = [];
    const ok = await recordUsageBestEffort(
      {
        command: "ask",
        providerId: "claude-code",
        model: "sonnet",
        task: "ask",
        inputTokens: 1_000_000,
        outputTokens: 0,
      },
      {
        appendFile: async () => undefined,
        now: () => new Date("2026-09-18T12:00:00Z"),
        mossVersion: "t",
        recordLane: async (entry) => {
          lines.push(entry);
          return true;
        },
      },
    );
    expect(ok).toBe(true);
    expect(lines).toEqual([
      {
        ts: "2026-09-18T12:00:00.000Z",
        lane: "claude-code",
        model: "sonnet",
        task: "ask",
        command: "ask",
        tokens_in: 1_000_000,
        tokens_out: 0,
        cost: "sub",
        usd_list: 2,
      },
    ]);
    await recordUsageBestEffort(
      { command: "run", providerId: "somewhere-else", model: "x", skill: "code-review" },
      {
        appendFile: async () => undefined,
        now: () => new Date(),
        mossVersion: "t",
        recordLane: async (entry) => {
          lines.push(entry);
          return true;
        },
      },
    );
    expect(lines[1]).toMatchObject({
      lane: "somewhere-else",
      task: "code-review",
      cost: "unknown",
    });
  });

  it("the claude-code probe is logged as a sub call", async () => {
    const { createClaudeCodeProvider } = await import("../../../src/lib/providers/claude-code.ts");
    const record: unknown[] = [];
    await createClaudeCodeProvider({
      onPath: () => true,
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          is_error: false,
          result: "ok",
          total_cost_usd: 0.0015,
          usage: { input_tokens: 389, output_tokens: 1 },
        }),
        stderr: "",
      }),
      readCache: () => null,
      writeCache: () => undefined,
      cacheKey: () => "k",
      record: async (entry) => {
        record.push(entry);
        return true;
      },
    }).probe();
    expect(record[0]).toMatchObject({
      lane: "claude-code",
      task: "probe",
      model: "haiku",
      cost: "sub",
      usd_list: 0.0015,
    });
  });
});
