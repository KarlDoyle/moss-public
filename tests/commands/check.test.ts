import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allChecks,
  healthReportPath,
  reportMarkdown,
  runCheckCommand,
} from "../../src/commands/check.ts";
import type { Check } from "../../src/lib/health/types.ts";

const fake: Check[] = [
  {
    group: "machine",
    name: "a",
    run: async () => ({ group: "machine", name: "a", status: "PASS", detail: "fine" }),
  },
  {
    group: "estate",
    name: "b",
    run: async () => ({ group: "estate", name: "b", status: "WARN", detail: "meh", fix: "do b" }),
  },
];

describe("moss check", () => {
  const saved = process.env.MOSS_HEALTH_DIR;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "MOSS_HEALTH_DIR");
    else process.env.MOSS_HEALTH_DIR = saved;
  });

  it("assembles every group, and --report writes a Taisce brief with the verdict first", async () => {
    const groups = new Set(allChecks().map((c) => c.group));
    expect([...groups]).toEqual(["machine", "AI tools", "scheduler + backup", "estate"]);
    const dir = mkdtempSync(join(tmpdir(), "moss-health-"));
    process.env.MOSS_HEALTH_DIR = dir;
    const out: string[] = [];
    const results = await runCheckCommand(
      { deep: false, report: true, json: false },
      (s) => out.push(s),
      fake,
    );
    expect(results.map((r) => r.status)).toEqual(["PASS", "WARN"]);
    expect(out[0]).toContain("fix: do b");
    const path = healthReportPath(new Date());
    expect(out[1]).toBe(`report written: ${path}`);
    const md = readFileSync(path, "utf8");
    expect(md.startsWith('---\ntitle: "Health check — ')).toBe(true);
    expect(md).toContain("\nHEALTH: 0 FAIL · 1 WARN · 1 PASS\n");
    expect(md).toContain('review_frequency: "weekly"');
  });

  it("--json emits the results; the report path defaults to Taisce System/briefs", async () => {
    const out: string[] = [];
    await runCheckCommand({ deep: false, report: false, json: true }, (s) => out.push(s), fake);
    expect(JSON.parse(out[0] as string)).toMatchObject({ summary: "0 FAIL · 1 WARN · 1 PASS" });
    expect(healthReportPath(new Date("2026-09-18T10:00:00Z"), {})).toMatch(
      /System\/briefs\/health--2026-09-18\.md$/,
    );
    expect(reportMarkdown([], new Date("2026-09-18T10:00:00Z"))).toContain(
      'last_reviewed: "2026-09-18"',
    );
  });
});
