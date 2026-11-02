import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendTelemetry,
  readTelemetry,
  telemetryPath,
} from "../../../src/lib/taisce/telemetry.ts";

const dir = mkdtempSync(join(tmpdir(), "moss-telemetry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("telemetry files", () => {
  it("resolve under Taisce System/telemetry, or the env override", () => {
    expect(telemetryPath("lane-usage", {}, "/T")).toBe("/T/System/telemetry/lane-usage.jsonl");
    expect(telemetryPath("model-bench", {}, "/T")).toBe("/T/System/telemetry/model-bench.jsonl");
    expect(telemetryPath("lane-usage", { MOSS_LANE_USAGE_FILE: "/x.jsonl" }, "/T")).toBe(
      "/x.jsonl",
    );
  });

  it("append one JSON line each, and read back tolerantly", async () => {
    const file = join(dir, "sub", "f.jsonl");
    await appendTelemetry(file, { a: 1 });
    await appendTelemetry(file, { a: 2 });
    expect(readFileSync(file, "utf8")).toBe('{"a":1}\n{"a":2}\n');
    writeFileSync(file, '{"a":1}\nnot json\n\n42\n');
    expect(readTelemetry(file)).toEqual([{ a: 1 }]);
    expect(readTelemetry(join(dir, "missing.jsonl"))).toEqual([]);
  });
});
