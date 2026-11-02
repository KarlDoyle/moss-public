import { describe, expect, it } from "vitest";
import { BENCH_NUM_PREDICT, benchModel, formatBenchTable, lastBench } from "../../src/lib/bench.ts";

const now = () => new Date("2026-09-18T10:00:00Z");
const reply =
  (body: object, status = 200) =>
  async () => ({
    status,
    ok: status < 400,
    body: JSON.stringify(body),
  });

describe("benchModel", () => {
  it("computes tok/s and load from Ollama's counters, capped and with think off", async () => {
    let sent: Record<string, unknown> = {};
    const record = await benchModel(
      { role: "brief", model: "llama3.1:latest" },
      now,
      async (_u, o) => {
        sent = JSON.parse(o.body) as Record<string, unknown>;
        return reply({
          response: "A worktree is a second checkout.",
          eval_count: 40,
          eval_duration: 2e9,
          prompt_eval_count: 300,
          prompt_eval_duration: 1.5e9,
          load_duration: 4.2e9,
          total_duration: 8e9,
        })();
      },
    );
    expect(record).toMatchObject({
      ok: true,
      tok_s: 20,
      prompt_tok_s: 200,
      load_ms: 4200,
      total_ms: 8000,
    });
    expect(sent.think).toBe(false);
    expect((sent.options as Record<string, unknown>).num_predict).toBe(BENCH_NUM_PREDICT);
  });

  it("fails honestly on an error, a bad body, a thrown fetch, and an empty answer", async () => {
    const t = { role: "x", model: "m" };
    expect((await benchModel(t, now, reply({ error: "model not found" }, 404))).error).toBe(
      "model not found",
    );
    expect(
      (await benchModel(t, now, async () => ({ status: 500, ok: false, body: "nope" }))).error,
    ).toContain("unparseable");
    expect((await benchModel(t, now, async () => Promise.reject(new Error("refused")))).error).toBe(
      "refused",
    );
    expect(await benchModel(t, now, reply({ response: " " }))).toMatchObject({
      ok: false,
      error: "empty response",
    });
  });
});

describe("formatBenchTable / lastBench", () => {
  it("renders PASS and FAIL rows, and finds the newest run", () => {
    const rows = [
      { ts: "a", role: "r", model: "m1", ok: true, tok_s: 9, by: "moss bench" as const },
      { ts: "b", role: "r", model: "m2", ok: false, error: "down", by: "moss bench" as const },
    ];
    const text = formatBenchTable(rows);
    expect(text).toContain("PASS");
    expect(text).toContain("FAIL — down");
    expect(lastBench(rows)).toEqual({ ts: "b", models: 1, passed: 0 });
    expect(lastBench([{ other: 1 }])).toBeNull();
  });
});
