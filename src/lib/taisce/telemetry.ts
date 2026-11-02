// Taisce telemetry files moss appends to — the ONE place moss writes outside its own root.
//
// Two append-only JSONL files under Taisce's System/telemetry/, both metadata only (never a
// prompt, a response or a key):
//   model-bench.jsonl  — one line per model per `moss bench` run
//   lane-usage.jsonl   — one line per model call, per lane (the budget ledger)
//
// Each file has an env override so tests (and a dry run) never touch the real checkout.
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveTaisceRoot } from "../paths.ts";

export const TELEMETRY_FILES = {
  "model-bench": { file: "model-bench.jsonl", env: "MOSS_BENCH_FILE" },
  "lane-usage": { file: "lane-usage.jsonl", env: "MOSS_LANE_USAGE_FILE" },
} as const;

export type TelemetryName = keyof typeof TELEMETRY_FILES;

export function telemetryPath(
  name: TelemetryName,
  env: NodeJS.ProcessEnv = process.env,
  root: string = resolveTaisceRoot(),
): string {
  const spec = TELEMETRY_FILES[name];
  const override = env[spec.env]?.trim();
  if (override !== undefined && override.length > 0) return override;
  return join(root, "System", "telemetry", spec.file);
}

export async function appendTelemetry(path: string, record: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

// Tolerant read: a missing file is empty, a malformed line is skipped (a hand edit must
// never break `moss status` or the budget check).
export function readTelemetry(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object")
        out.push(parsed as Record<string, unknown>);
    } catch {
      // skipped
    }
  }
  return out;
}
